// Shared utilities for the bench harnesses
// (bench/longmemeval-harness.ts, bench/dump-packet.ts,
//  bench/rejudge-noresponse.ts, bench/locomo-harness.ts).
//
// v2.11.2+ consolidated here per /simplify reviews that flagged
// callClaude/callCodex/substringMatch/JUDGE_PROMPT as duplicated across
// 4 bench files. One source, one shape, one test surface.
//
// v2.12.0+ adds extraction strictness (Pydantic-equivalent zod schemas),
// gold-in-context tracking, packet-usage tracking, and a context-
// completeness grading prompt — per Zep/Hindsight evaluation-discipline
// gap analysis.

import { z } from "zod";

// ─── Date sanitation (existing, unchanged) ───────────────────────────────

/**
 * v2.11.1+ — sanitize an extractor-supplied event_date and produce a
 * stable YYYY-MM-DD string for the fact's `valid_from`.
 *
 * Try strict ISO, then regex-extract a YYYY-MM-DD substring from raw, then
 * from observationDate in either ISO or YYYY/MM/DD form. On TOTAL failure
 * of both inputs, emit a console.warn and return the caller-supplied
 * observationDate AS-IS (first 10 chars). Never falls back to wall-clock
 * `Date.now()` — that was the root cause of the v2.11.0-rc.1
 * knowledge-update regression.
 */
export function sanitizeEventDate(raw: unknown, observationDate: string): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const m = trimmed.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(observationDate)) return observationDate.slice(0, 10);
  const m = observationDate.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  console.warn(
    `[bench-utils] sanitizeEventDate: unable to parse raw=${JSON.stringify(raw)} or observationDate=${JSON.stringify(observationDate)} as a YYYY-MM-DD date; falling back to observationDate first 10 chars`,
  );
  return observationDate.slice(0, 10);
}

// ─── CLI invocation (extracted from 4 bench files) ───────────────────────

// v2.12.0+ — PAI contamination markers. GPT-5.5 review (2026-05-18) found
// that pre-sterilization Claude CLI calls leaked the user's PAI framework
// personality into bench outputs ("ALGORITHM MODE", "PAI | NATIVE MODE",
// "Jarvis:", phase headers). Of the N=30 v2.11.0-rc.1 bench data:
//   - episode-only: 14/30 (46.7%) contaminated
//   - memory-packet: 2/30 (6.7%)
//   - zep-format: 5/30 (16.7%)
// The contamination rate VARIES by mode, biasing the mode-vs-mode
// comparison. Every bench number prior to v2.12.0 is invalidated by this.
//
// Defense: invoke `claude` with --bare + sterile system prompt so the
// CLI cannot load CLAUDE.md, hooks, skills, plugins, or auto-memory.
// THEN scan the output for these markers and treat any hit as an error.
const PAI_CONTAMINATION_MARKERS = [
  "PAI |",
  "ALGORITHM MODE",
  "NATIVE MODE",
  "🗣️ Jarvis",
  "🗒️ TASK:",
  "═══ PAI",
  "════ PAI",
];

// v2.12.0+ — format-neutral sterile system prompt. The user message
// will tell the worker what to produce (one-sentence answer, JSON,
// CORRECT/INCORRECT, etc.). This prompt's job is purely to REMOVE
// the user's PAI persona — never to constrain the output format.
//
// Earlier draft of this prompt said "Reply in one short sentence"
// which broke EXTRACTOR calls (they need JSON output). Same prompt
// is now used by answer/judge/extractor/completeness — each call
// site specifies its own format in the user message.
const SterileBenchSystemPrompt = `You are a benchmark worker. Follow the user message's instructions literally. Produce exactly the output format the user message requests (a single sentence, valid JSON, a CORRECT/INCORRECT verdict, etc.). Do not add preamble, role labels, headers, emoji, framework boilerplate, or any output scaffolding the user message did not ask for.`;

/**
 * Shell out to the Claude CLI in non-interactive sterile mode. Used by
 * the LongMemEval bench harness as both the answer LLM and the judge.
 *
 * Flags chosen so the CLI process CANNOT load the user's PAI framework
 * (CLAUDE.md, hooks, skills, plugins, cognitive memory). Without this
 * sterilization, the user's persona leaks into outputs at rates of
 * 6-47% depending on mode (measured on v2.11.0-rc.1 N=30 JSONLs).
 *
 *   --bare                       skip hooks, LSP, plugin sync, attribution,
 *                                auto-memory, CLAUDE.md auto-discovery
 *   --no-session-persistence     don't write a resumable session
 *   --disable-slash-commands     no skill resolution
 *   --allowedTools ""            empty allowlist = no tools
 *   --system-prompt <bench worker>   override default PAI persona
 *
 * Returns null on empty output, timeout, or process error.
 * Returns null AND console.warns if output still contains PAI markers
 * (defense-in-depth — the flags should make this impossible, but if a
 * future Claude CLI version changes flag semantics we want loud failure).
 */
export async function callClaudeCLI(prompt: string, timeoutMs = 120000): Promise<string | null> {
  // v2.12.0+ — sterilization. We CANNOT use --bare because it strictly
  // requires ANTHROPIC_API_KEY env var (refuses keychain/OAuth auth used by
  // an interactively-logged-in CLI). Workaround: skip --bare but use
  // --system-prompt to OVERRIDE the default system prompt (which is where
  // CLAUDE.md and the PAI persona load), --disable-slash-commands to
  // prevent skill resolution, --allowedTools "" to deny tool use, and
  // cwd a writeable scratch directory that contains no CLAUDE.md so
  // path-based auto-discovery finds nothing.
  const scratchDir = "/tmp/bench-cwd-sterile";
  try {
    const proc = Bun.spawn([
      "claude",
      "--model", process.env.BENCH_CLAUDE_MODEL || "sonnet",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--allowedTools", "",
      "--system-prompt", SterileBenchSystemPrompt,
      "-p",
      prompt,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      cwd: scratchDir,
    });
    const decoder = new TextDecoder();
    const watchdog = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const [out] = await Promise.all([
      (async () => decoder.decode(await new Response(proc.stdout).arrayBuffer()))(),
      proc.exited,
    ]);
    clearTimeout(watchdog);
    const cleaned = out
      .split("\n")
      .filter(l => !l.includes("hook [") && !l.includes("Permission denied"))
      .join("\n")
      .trim();
    if (!cleaned) return null;
    // Defense-in-depth: if any PAI marker still appears, the sterilization
    // didn't work. Return null + warn so the bench's retry/fallback path
    // kicks in instead of silently producing a polluted answer.
    for (const marker of PAI_CONTAMINATION_MARKERS) {
      if (cleaned.includes(marker)) {
        console.warn(`[bench-utils] callClaudeCLI: PAI contamination marker "${marker}" detected in output — sterilization flags may have failed; first 200 chars: ${cleaned.slice(0, 200)}`);
        return null;
      }
    }
    return cleaned;
  } catch { return null; }
}

/**
 * v2.12.0+ — shell out to the Gemini CLI. Added after Codex hit its
 * ChatGPT-account usage limit mid-bench (2026-05-18). Gemini has its
 * own quota/auth so it sidesteps the codex throttle entirely. No PAI
 * persona to strip — Gemini CLI is a separate stack from Claude Code.
 *
 *   --yolo            auto-approve all tools (we never invoke any —
 *                     the prompt requests plain text, no tool calls)
 *   --output-format text   plain text (vs json) so we get clean stdout
 *   -p <prompt>       non-interactive headless mode
 *
 * Pipes stdout, filters the YOLO+ripgrep warning lines, returns the
 * answer body. Returns null on empty/error/timeout.
 */
export async function callGeminiCLI(prompt: string, timeoutMs = 180000): Promise<string | null> {
  try {
    const proc = Bun.spawn([
      "gemini",
      "--yolo",
      "--output-format", "text",
      "-p", prompt,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const decoder = new TextDecoder();
    const watchdog = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const [out] = await Promise.all([
      (async () => decoder.decode(await new Response(proc.stdout).arrayBuffer()))(),
      proc.exited,
    ]);
    clearTimeout(watchdog);
    // Strip startup noise: "YOLO mode is enabled..." and "Ripgrep is not
    // available. Falling back to GrepTool." lines appear before the
    // model output. Also strip any "Loaded extension..." lines.
    const cleaned = out
      .split("\n")
      .filter(l =>
        !l.startsWith("YOLO mode") &&
        !l.startsWith("Ripgrep is not available") &&
        !l.startsWith("Loaded extension") &&
        !l.startsWith("Loading ")
      )
      .join("\n")
      .trim();
    return cleaned || null;
  } catch { return null; }
}

/**
 * Shell out to the Codex CLI. `--output-last-message <file>` writes ONLY
 * the final assistant text so we don't have to parse the session log.
 * `--skip-git-repo-check` avoids the trust-directory prompt for
 * non-interactive runs. Returns null on empty output or process error.
 */
export async function callCodexCLI(prompt: string, timeoutMs = 180000): Promise<string | null> {
  const outPath = `/tmp/codex-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // v2.12.0+ — pin low reasoning effort (Ardin directive 2026-05-18,
    // revised from medium → low after observing >20 min/call wall time
    // on medium for N=30 bench scope. low keeps codex outputs clean of
    // PAI contamination while bringing per-call latency back to ~1-3 min,
    // which makes the 3-mode N=30 bench achievable in ~5-9h).
    const proc = Bun.spawn([
      "codex", "exec",
      "--skip-git-repo-check",
      "-c", `model_reasoning_effort="low"`,
      "--output-last-message", outPath,
      prompt,
    ], {
      stdout: "ignore",
      stderr: "pipe",
      env: process.env,
    });
    const watchdog = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    await proc.exited;
    clearTimeout(watchdog);
    try {
      const text = await Bun.file(outPath).text();
      return text.trim() || null;
    } finally {
      try { await Bun.file(outPath).unlink(); } catch {}
    }
  } catch { return null; }
}

// ─── Judge prompt + substring match (canonical forms) ────────────────────

/**
 * Canonical mema judge prompt — written from first principles for the
 * machtsinn.ai benchmark harness. The evaluation criteria below are
 * derived from standard semantic-equivalence grading practice (used
 * across LongMemEval's own reference implementation, the academic
 * literature on QA judges, and various open-source memory-system
 * harnesses). The wording, structure, and rubric here are mema's own.
 *
 * The output contract (verdict on first line, optional reason after) is
 * driven by the CLI-only constraint: Claude, Codex, and Gemini CLIs
 * don't expose OpenAI's typed-parse API, so we encode the structure in
 * the prompt itself.
 *
 * `benchmark` is the human-readable label (LongMemEval, LoCoMo, etc.)
 * passed through for traceability.
 */
export function judgePrompt(benchmark: string, question: string, gold: string | number, predicted: string): string {
  const goldStr = String(gold);
  return `Task: grade a memory-system answer for the ${benchmark} benchmark.

Inputs:
  • the original question
  • the reference (gold) answer — assumed correct
  • the answer the system produced

Decide whether the system's answer is semantically equivalent to the gold answer. Two answers are equivalent when:

  (i)  every distinct piece of information in the gold answer is also present in the system answer (no missing names, numbers, dates, places, or actions);
  (ii) the system answer adds no information that contradicts the gold;
  (iii) wording may differ — paraphrase, synonyms, and word order are fine;
  (iv) widely-used name variants are accepted (e.g. NYC ↔ New York City, USD ↔ dollars);
  (v)  conversational filler ("of course", "based on the context") is ignored;
  (vi) an abstention ("I don't know", "no answer", "the context does not contain...") is NOT equivalent to a gold answer — return INCORRECT.

Mark the answer wrong if it generalizes a specific gold detail away (a particular person → "someone", a particular place → "there"), drops a date or quantity the gold supplies, or omits any part of a complete gold message.

---
QUESTION:
${question}

GOLD:
${goldStr}

SYSTEM ANSWER:
${predicted}
---

Begin your reply with one token, all caps, on its own line:
  CORRECT
or
  INCORRECT
Optionally follow with a short reason on the next line. Nothing else.`;
}

/**
 * Substring-match grader. Tokenize gold on common separators, drop tokens
 * < 3 chars, require every remaining token to appear in predicted
 * (case-insensitive). When gold has no significant tokens (e.g. it's a
 * single short word like "four"), fall back to a direct substring check.
 *
 * Used by:
 *  - the harness's `--judge substring` mode (cheap, no LLM)
 *  - the rejudge tool's tie-breaker when Claude and Codex disagree
 */
export function substringMatch(gold: string | number, predicted: string): boolean {
  // v2.12.1+ — coerce gold to string. LongMemEval multi-session "counting"
  // questions have INTEGER gold answers (e.g. 3, 2). The pre-coercion
  // version crashed with `gold.toLowerCase is not a function` and silently
  // dropped those questions from the bench (~6.7% of multi-session).
  const goldStr = String(gold);
  const tokens = goldStr.toLowerCase().split(/[\s,.;:()$]/g).filter(w => w.length >= 3);
  if (tokens.length === 0) {
    return predicted.toLowerCase().includes(goldStr.toLowerCase().trim());
  }
  return tokens.every(t => predicted.toLowerCase().includes(t));
}

// ─── Retry + verdict kernel (extracted from harness + rejudge) ───────────

export type Verdict = "CORRECT" | "INCORRECT" | "NO_RESPONSE";

export interface VerdictResult {
  verdict: Verdict;
  reason: string;
}

/**
 * v2.12.1+ — exponential backoff with full jitter. Same shape every
 * mature API client uses (AWS SDK retry policy, Google Cloud client
 * backoff, fetch-retry, etc.). The algorithm: each successive retry
 * waits roughly twice as long as the previous, plus a random jitter
 * up to the delay's full magnitude, capped at maxDelayMs. The jitter
 * is the important part — without it, N concurrent retriers all
 * synchronize on the same wake-up tick and DOS the same endpoint.
 *
 *   attempt 0: 0 (no backoff before first attempt)
 *   attempt 1: base ± up to base
 *   attempt 2: 2·base ± up to 2·base
 *   attempt 3: 4·base ± up to 4·base
 *   ...
 *   attempt n: min(base·2^(n-1), maxDelayMs) plus jitter ∈ [0, that]
 *
 * Used internally by retryVerdict and retryCompleteness. Exposed in
 * case other bench tools need the same backoff shape.
 */
export function backoffDelayMs(attempt: number, baseMs = 800, maxDelayMs = 30000): number {
  if (attempt <= 0) return 0;
  const exp = Math.min(baseMs * Math.pow(2, attempt - 1), maxDelayMs);
  // Full-jitter strategy: random delay in [0, exp]. Provably-better than
  // half-jitter for thundering-herd avoidance in the AWS Architecture blog
  // experiments; matches what most modern API clients do.
  return Math.floor(Math.random() * exp);
}

/**
 * v2.12.1+ — retry kernel for bench LLM calls.
 *
 * Calls `fn()` up to `retries` times. After each attempt:
 *   • Non-empty output starting with CORRECT or INCORRECT (case-
 *     insensitive) → return that verdict immediately.
 *   • Non-empty but unclassifiable output → if this is the final
 *     attempt, return NO_RESPONSE with the output as the reason
 *     ("<name>-ambiguous: <first 150 chars>"). Otherwise retry.
 *   • Empty/null output → if this is the final attempt, return
 *     NO_RESPONSE("<name> returned empty after N retries"). Otherwise
 *     retry.
 *   • Thrown exception → if this is the final attempt, return
 *     NO_RESPONSE("<name> threw: <message>"). Otherwise retry.
 *
 * Backoff: exponential with full jitter via `backoffDelayMs`.
 * Logging: on retry, prints one fail-loud line so quota or timeout
 * issues surface in the bench log instead of silently inflating
 * wall-clock time.
 *
 * Shared by:
 *  - bench/longmemeval-harness.ts judgeWithRetry (primary + secondary)
 *  - bench/rejudge-noresponse.ts callWithRetry
 */
export async function retryVerdict(
  name: string,
  fn: () => Promise<string | null>,
  retries = 3,
): Promise<VerdictResult> {
  let lastReason = "";
  for (let i = 0; i < retries; i++) {
    try {
      const out = await fn();
      if (out && out.trim().length > 0) {
        const upper = out.trim().toUpperCase();
        if (upper.startsWith("CORRECT")) return { verdict: "CORRECT", reason: out.slice(0, 200) };
        if (upper.startsWith("INCORRECT")) return { verdict: "INCORRECT", reason: out.slice(0, 200) };
        lastReason = `ambiguous: ${out.slice(0, 150)}`;
        if (i === retries - 1) return { verdict: "NO_RESPONSE", reason: `${name}-${lastReason}` };
      } else {
        lastReason = `empty (attempt ${i + 1}/${retries})`;
        if (i === retries - 1) return { verdict: "NO_RESPONSE", reason: `${name} returned empty after ${retries} retries` };
      }
    } catch (e: any) {
      lastReason = `threw: ${(e?.message ?? String(e)).slice(0, 100)}`;
      if (i === retries - 1) return { verdict: "NO_RESPONSE", reason: `${name} ${lastReason}` };
    }
    const delay = backoffDelayMs(i + 1);
    console.warn(`  ⚠ ${name} retry ${i + 1}/${retries} — ${lastReason}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
    await new Promise(r => setTimeout(r, delay));
  }
  return { verdict: "NO_RESPONSE", reason: `${name} fell through retry loop` };
}

// ─── Answer-shape classifier (trichotomy for v2.11.2 bench reporting) ────

export type AnswerShape = "no-answer" | "confident" | "empty";

/**
 * v2.11.2+ — classify a predicted answer's shape into one of three buckets
 * so the bench can report correct% / wrong-confident% / no-answer% / empty%
 * separately. This is the empirical defense against INSTRUCTIONS-softening
 * hallucination risk: if a softened-INSTRUCTIONS bench shows no-answer%
 * dropping while wrong-confident% rises, the softening is trading
 * abstention for confabulation (BAD). If correct% rises with no-answer%
 * falling and wrong-confident% holding, the softening is unlocking real
 * answers (GOOD).
 *
 * Returns:
 *   "empty"     — empty/whitespace-only/null
 *   "no-answer" — LLM explicitly punted ("no answer", "I don't know",
 *                 "cannot determine", "I'm not sure", "unable to", ...)
 *   "confident" — anything else (the LLM produced content)
 *
 * The patterns are case-insensitive and matched against the first ~200
 * chars only (some LLMs say "I don't know" mid-response after stalling).
 */
export function classifyAnswerShape(predicted: string | null | undefined): AnswerShape {
  if (predicted === null || predicted === undefined) return "empty";
  const trimmed = predicted.trim();
  if (trimmed.length === 0) return "empty";
  // Inspect the first 200 chars in lowercase. Match patterns that signal
  // explicit abstention. Order matters: more-specific phrases first.
  const head = trimmed.slice(0, 200).toLowerCase();
  const NO_ANSWER_PATTERNS = [
    "no answer",
    "i don't know",
    "i do not know",
    "i don't have",
    "i do not have",
    "i'm not sure",
    "i am not sure",
    "i cannot determine",
    "i can't determine",
    "cannot determine",
    "unable to determine",
    "unable to answer",
    "not enough information",
    "no information",
    "no relevant information",
    "insufficient information",
    "i lack",
    "i don't have enough",
  ];
  for (const p of NO_ANSWER_PATTERNS) {
    if (head.includes(p)) return "no-answer";
  }
  return "confident";
}

// ─── Zod extraction schemas (v2.12+ Pydantic-equivalent strictness) ──────
//
// Pre-v2.12 the harness did soft checks (string ≥ N chars, confidence
// ≥ 0.75). These let in facts with malformed event_date, missing
// evidence excerpts, or generic predicates ("is"/"has"/"at" — too vague).
//
// The zod schemas enforce the Pydantic-style discipline Zep/Hindsight use:
// the extractor LLM is REQUIRED to produce well-formed structured memory
// objects or its output is rejected at the boundary, with a rejection
// reason logged for diagnostic.

export const ENTITY_TYPE_ENUM = [
  "person", "organization", "product", "system", "place", "concept", "event",
] as const;

export const ExtractedFactSchema = z.object({
  subject: z.string().trim().min(1, "subject must be non-empty"),
  predicate: z.string().trim().min(1, "predicate must be non-empty").refine(
    p => !["is", "has", "at"].includes(p.toLowerCase()),
    { message: "predicate must be specific (not 'is'/'has'/'at')" },
  ),
  object: z.string().trim().min(1, "object must be non-empty"),
  event_date: z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "event_date must be YYYY-MM-DD",
  ),
  confidence: z.number().min(0.75, "confidence must be >= 0.75").max(1),
  // evidence_excerpt is optional in extractor output (the harness adds its
  // own body.slice(0, 500) before POST), but if the extractor provides it,
  // it must be substantial.
  evidence_excerpt: z.string().min(20, "evidence_excerpt must be >= 20 chars").optional(),
});

export const ExtractedEntitySchema = z.object({
  name: z.string().trim().min(2, "entity name must be >= 2 chars").max(80, "entity name must be <= 80 chars"),
  type: z.enum(ENTITY_TYPE_ENUM),
});

export const ExtractorOutputSchema = z.object({
  facts: z.array(z.unknown()),  // validated per-item below to capture per-item rejection reasons
  entities: z.array(z.unknown()),
});

export interface ExtractorRejection {
  kind: "fact" | "entity";
  index: number;
  raw: unknown;
  errors: string[];
}

export interface ValidatedExtractorOutput {
  ok: boolean;                       // overall: was the JSON well-formed at the top level
  facts: z.infer<typeof ExtractedFactSchema>[];
  entities: z.infer<typeof ExtractedEntitySchema>[];
  rejections: ExtractorRejection[];  // per-item rejection details
}

/**
 * Validate parsed extractor JSON against the Zod schemas. Returns the
 * accepted facts/entities AND a list of per-item rejections with reasons
 * so the bench can log + diagnose extractor quality drift.
 *
 * Behavior:
 *  - If the top-level shape is wrong (not an object with facts[] and
 *    entities[]), returns ok=false with empty arrays and one synthetic
 *    rejection describing the shape error.
 *  - Otherwise validates each fact/entity individually; accepted items
 *    are typed; rejected items go to rejections[] with the per-field
 *    zod error messages.
 */
export function validateExtractorOutput(raw: unknown): ValidatedExtractorOutput {
  const top = ExtractorOutputSchema.safeParse(raw);
  if (!top.success) {
    return {
      ok: false,
      facts: [],
      entities: [],
      rejections: [{
        kind: "fact",  // sentinel; the rejection is shape-level not item-level
        index: -1,
        raw,
        errors: top.error.issues.map(i => `${i.path.join(".")}: ${i.message}`),
      }],
    };
  }
  const facts: z.infer<typeof ExtractedFactSchema>[] = [];
  const entities: z.infer<typeof ExtractedEntitySchema>[] = [];
  const rejections: ExtractorRejection[] = [];

  for (let i = 0; i < top.data.facts.length; i++) {
    const p = ExtractedFactSchema.safeParse(top.data.facts[i]);
    if (p.success) facts.push(p.data);
    else rejections.push({
      kind: "fact",
      index: i,
      raw: top.data.facts[i],
      errors: p.error.issues.map(s => `${s.path.join(".")}: ${s.message}`),
    });
  }
  for (let i = 0; i < top.data.entities.length; i++) {
    const p = ExtractedEntitySchema.safeParse(top.data.entities[i]);
    if (p.success) entities.push(p.data);
    else rejections.push({
      kind: "entity",
      index: i,
      raw: top.data.entities[i],
      errors: p.error.issues.map(s => `${s.path.join(".")}: ${s.message}`),
    });
  }
  return { ok: true, facts, entities, rejections };
}

// ─── Gold-in-context detection (v2.12+) ──────────────────────────────────
//
// Per-question boolean: was the gold answer string actually IN the rendered
// packet sent to the answer LLM? This decomposes "answer wrong" into:
//   - "context lacked answer" → retrieval/compilation failure
//   - "context had answer, LLM missed it" → reading failure
//
// Two-tier check: exact case-insensitive substring (cheap, high precision)
// → fall back to significant-token coverage (≥80% of gold's >=3-char tokens
// present somewhere in context, in any order). Token-coverage tolerates
// paraphrase ("$400,000" vs "400000 dollars") but not synonym ("vehicle"
// vs "car" — requires exact tokens).
export function goldInContext(gold: string | number, context: string): boolean {
  // v2.12.1+ — coerce gold to string for the same reason as substringMatch
  // (multi-session counting questions have integer gold answers).
  if (gold === undefined || gold === null || !context) return false;
  const g = String(gold).toLowerCase().trim();
  if (g.length === 0) return false;
  const c = context.toLowerCase();
  // Tier 1: exact substring.
  if (c.includes(g)) return true;
  // Tier 2: significant-token coverage.
  const tokens = g.split(/[\s,.;:()$]/g).filter(w => w.length >= 3);
  if (tokens.length === 0) return false;
  const present = tokens.filter(t => c.includes(t)).length;
  return present / tokens.length >= 0.8;
}

// ─── Context-completeness grading prompt (v2.12+, Zep's 2nd primary metric) ─

export type CompletenessVerdict = "complete" | "partial" | "insufficient" | "judge-failed";

/**
 * Prompt the LLM judge to grade the CONTEXT packet itself (independent of
 * what the answer LLM does with it). Catches the failure mode where
 * retrieval is good but compilation chokes — the context is INSUFFICIENT
 * to answer the question, regardless of what the reader does.
 *
 * Returns one of: COMPLETE | PARTIAL | INSUFFICIENT
 * - COMPLETE     — context contains everything needed to answer
 * - PARTIAL      — context has SOME relevant evidence but missing critical info
 * - INSUFFICIENT — context lacks the answer entirely
 */
export function completenessPrompt(question: string, gold: string, context: string): string {
  return `You are an evaluator grading the completeness of a context packet that will be used to answer a question. You see the question, the gold (correct) answer, and the context packet that was prepared.

Your task: judge whether the context packet contains enough information to answer the question correctly. Reply with EXACTLY one of:
  COMPLETE     — the context contains all necessary information to derive the gold answer
  PARTIAL      — the context contains SOME relevant information but is missing critical details
  INSUFFICIENT — the context lacks the key information needed to answer
Followed by an optional one-line reason.

QUESTION: ${question}
GOLD ANSWER: ${gold}

CONTEXT_PACKET:
${context}`;
}

/**
 * Parse a completeness verdict from raw LLM output. Returns the
 * discriminated union value or "judge-failed" if unparseable.
 */
export function parseCompletenessVerdict(raw: string | null | undefined): CompletenessVerdict {
  if (!raw) return "judge-failed";
  const head = raw.trim().toUpperCase();
  if (head.startsWith("COMPLETE")) return "complete";
  if (head.startsWith("PARTIAL")) return "partial";
  if (head.startsWith("INSUFFICIENT")) return "insufficient";
  return "judge-failed";
}

/**
 * v2.12.0+ — three-class retry kernel for completeness grading.
 * GPT-5.5 review (2026-05-18) caught that the harness's prior
 * implementation passed `completenessPrompt` output through the binary
 * `retryVerdict` (which only knows CORRECT/INCORRECT). Outputs like
 * "COMPLETE — context has all needed info" were classified as
 * NO_RESPONSE/ambiguous, then re-parsed by parseCompletenessVerdict
 * which got "ambiguous: COMPLETE — ..." as input and returned
 * judge-failed. The bug silently lost EVERY completeness verdict.
 *
 * This helper does the right thing: runs the same retry-on-empty
 * loop but classifies the raw output with parseCompletenessVerdict
 * directly. Ambiguous outputs that don't start with a recognized
 * three-class prefix still return "judge-failed" but after retries.
 */
export interface CompletenessResult {
  verdict: CompletenessVerdict;
  reason: string;
}

export async function retryCompleteness(
  name: string,
  fn: () => Promise<string | null>,
  retries = 3,
): Promise<CompletenessResult> {
  // v2.12.1+ — same exponential-with-jitter backoff as retryVerdict via
  // backoffDelayMs. Logs a fail-loud warning between attempts so quota
  // exhaustion surfaces immediately in the bench log.
  let lastReason = "";
  for (let i = 0; i < retries; i++) {
    try {
      const out = await fn();
      if (out && out.trim().length > 0) {
        const verdict = parseCompletenessVerdict(out);
        if (verdict !== "judge-failed") {
          return { verdict, reason: out.slice(0, 200) };
        }
        lastReason = `ambiguous: ${out.slice(0, 150)}`;
        if (i === retries - 1) return { verdict: "judge-failed", reason: `${name}-${lastReason}` };
      } else {
        lastReason = `empty (attempt ${i + 1}/${retries})`;
        if (i === retries - 1) return { verdict: "judge-failed", reason: `${name} returned empty after ${retries} retries` };
      }
    } catch (e: any) {
      lastReason = `threw: ${(e?.message ?? String(e)).slice(0, 100)}`;
      if (i === retries - 1) return { verdict: "judge-failed", reason: `${name} ${lastReason}` };
    }
    const delay = backoffDelayMs(i + 1);
    console.warn(`  ⚠ ${name} retry ${i + 1}/${retries} — ${lastReason}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
    await new Promise(r => setTimeout(r, delay));
  }
  return { verdict: "judge-failed", reason: `${name} fell through retry loop` };
}
