// Shared utilities for the bench harnesses
// (bench/longmemeval-harness.ts, bench/dump-packet.ts,
//  bench/rejudge-noresponse.ts, bench/locomo-harness.ts).
//
// v2.11.2+ consolidated here per /simplify reviews that flagged
// callClaude/callCodex/substringMatch/JUDGE_PROMPT as duplicated across
// 4 bench files. One source, one shape, one test surface.

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

/**
 * Shell out to the Claude CLI in non-interactive mode (-p). Hook errors
 * are filtered from stdout (some hooks lack +x). Returns null on empty
 * output, timeout, or process error. No API key needed if the CLI is
 * already logged in.
 */
export async function callClaudeCLI(prompt: string, timeoutMs = 120000): Promise<string | null> {
  try {
    const proc = Bun.spawn(["claude", "-p", prompt], {
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
    const cleaned = out
      .split("\n")
      .filter(l => !l.includes("hook [") && !l.includes("Permission denied"))
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
