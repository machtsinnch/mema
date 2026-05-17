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

const SterileBenchSystemPrompt = `You are a benchmark worker. Answer ONLY the question asked by the user, using ONLY the supplied context. Reply in one short sentence, with no preamble, no headers, no emoji, no formatting scaffolds, no role labels. If the context doesn't support an answer, reply exactly: no answer`;

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
 * Shell out to the Codex CLI. `--output-last-message <file>` writes ONLY
 * the final assistant text so we don't have to parse the session log.
 * `--skip-git-repo-check` avoids the trust-directory prompt for
 * non-interactive runs. Returns null on empty output or process error.
 */
export async function callCodexCLI(prompt: string, timeoutMs = 180000): Promise<string | null> {
  const outPath = `/tmp/codex-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const proc = Bun.spawn([
      "codex", "exec",
      "--skip-git-repo-check",
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
 * Canonical judge prompt. `benchmark` is the human-readable label
 * (LongMemEval, LoCoMo, etc.) that callers pass through for traceability.
 * Replies must start with CORRECT or INCORRECT to be machine-parseable.
 */
export function judgePrompt(benchmark: string, question: string, gold: string, predicted: string): string {
  return `You are a strict grading assistant for the ${benchmark} benchmark. Decide if the predicted answer matches the gold answer SEMANTICALLY for the given question.

QUESTION: ${question}
GOLD ANSWER:      ${gold}
PREDICTED ANSWER: ${predicted}

Reply with EXACTLY one of:
  CORRECT
  INCORRECT
Followed by an optional one-line reason.`;
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
export function substringMatch(gold: string, predicted: string): boolean {
  const tokens = gold.toLowerCase().split(/[\s,.;:()$]/g).filter(w => w.length >= 3);
  if (tokens.length === 0) {
    return predicted.toLowerCase().includes(gold.toLowerCase().trim());
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
 * v2.11.2+ — call a string-returning async function with retry-on-empty
 * AND verdict classification. Shared by:
 *
 *  - bench/longmemeval-harness.ts judgeWithRetry (3-retry primary +
 *    2-retry secondary fallback)
 *  - bench/rejudge-noresponse.ts callWithRetry (3-retry per judge)
 *
 * Behavior:
 *  - Calls `fn()` up to `retries` times
 *  - Each attempt: if output is non-empty and starts with CORRECT or
 *    INCORRECT (case-insensitive), return that verdict immediately
 *  - On the LAST attempt: if output is non-empty but doesn't classify,
 *    return NO_RESPONSE with reason "ambiguous"
 *  - On exception: return NO_RESPONSE with reason "<name> threw: ..."
 *  - Backoff between retries: 1s, 2s, 3s (linear)
 */
export async function retryVerdict(
  name: string,
  fn: () => Promise<string | null>,
  retries = 3,
): Promise<VerdictResult> {
  for (let i = 0; i < retries; i++) {
    try {
      const out = await fn();
      if (out && out.trim().length > 0) {
        const upper = out.trim().toUpperCase();
        if (upper.startsWith("CORRECT")) return { verdict: "CORRECT", reason: out.slice(0, 200) };
        if (upper.startsWith("INCORRECT")) return { verdict: "INCORRECT", reason: out.slice(0, 200) };
        if (i === retries - 1) return { verdict: "NO_RESPONSE", reason: `${name}-ambiguous: ${out.slice(0, 150)}` };
      } else if (i === retries - 1) {
        return { verdict: "NO_RESPONSE", reason: `${name} returned empty after ${retries} retries` };
      }
    } catch (e: any) {
      if (i === retries - 1) {
        return { verdict: "NO_RESPONSE", reason: `${name} threw: ${(e?.message ?? String(e)).slice(0, 100)}` };
      }
    }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
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
export function goldInContext(gold: string, context: string): boolean {
  if (!gold || !context) return false;
  const g = gold.toLowerCase().trim();
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
  for (let i = 0; i < retries; i++) {
    try {
      const out = await fn();
      if (out && out.trim().length > 0) {
        const verdict = parseCompletenessVerdict(out);
        if (verdict !== "judge-failed") {
          return { verdict, reason: out.slice(0, 200) };
        }
        if (i === retries - 1) {
          return { verdict: "judge-failed", reason: `${name}-ambiguous: ${out.slice(0, 150)}` };
        }
      } else if (i === retries - 1) {
        return { verdict: "judge-failed", reason: `${name} returned empty after ${retries} retries` };
      }
    } catch (e: any) {
      if (i === retries - 1) {
        return { verdict: "judge-failed", reason: `${name} threw: ${(e?.message ?? String(e)).slice(0, 100)}` };
      }
    }
    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  return { verdict: "judge-failed", reason: `${name} fell through retry loop` };
}
