// LLM-assisted judgment extraction from decision documents (v2.19.1).
//
// Ardin's "both ways" decision (2026-07-10): judgments are created either
// explicitly (POST /v2/judgment) or extracted from decision-style
// documents (ADRs, arc42 §9 design decisions, RFCs). This module is the
// document path: one CLI call per document, strict JSON out, and the
// caller (scripts/replay-decisions.ts, later the ingest pipeline) turns
// the proposal into a real judgment record with links.
//
// Same transport rationale as ClaudeCLIExtractor: the locally-installed
// `claude` CLI works on an OAuth/Max login, no API key. No tools allowed
// — extraction reads ONLY the document (fact-checking is a separate,
// Layer 2 concern).

export interface JudgmentProposal {
  question: string;
  decision: string;
  rationale: string;
  alternatives: Array<{ option: string; reason_rejected: string }>;
  consequences: string[];
  status: "proposed" | "accepted";
  /** identifiers of earlier decisions this document SAYS it replaces,
   *  verbatim-ish (e.g. "ADR-15") — resolved to judgment IDs by the caller */
  supersedes_refs: string[];
  supersession_reason: string | null;
}

const SYSTEM_PROMPT = `You extract THE architecture decision from a single decision-style document (ADR, arc42 design-decision chapter, RFC).

Answer ONLY one JSON object, no prose, no markdown fences:
{"found":true,"question":"...","decision":"...","rationale":"...","alternatives":[{"option":"...","reason_rejected":"..."}],"consequences":["..."],"status":"proposed"|"accepted","supersedes_refs":["ADR-15"],"supersession_reason":"..."|null}
or {"found":false} if the document records no decision.

Rules:
- question: what was being decided, one sentence, plain language.
- decision: the conclusion itself, one or two sentences, faithful to the document.
- rationale: the WHY in one to three sentences, plain language, taken from the document's own reasoning.
- alternatives: ONLY options the document itself considered and rejected, each with the document's reason. Empty array if none are discussed.
- consequences: the trade-offs the document explicitly accepts. Empty array if none listed.
- status: map the document's status section (PROPOSED -> "proposed"; ACCEPTED/FINAL/no status section -> "accepted").
- supersedes_refs: identifiers of earlier decisions this document says it replaces or supersedes (copy the identifier style used, e.g. "ADR-15"). Empty array if none.
- supersession_reason: the document's stated reason for replacing them, one sentence; null when supersedes_refs is empty.
- Never invent content that is not in the document.`;

export function parseJudgmentProposal(raw: string): JudgmentProposal | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`judgment extractor: no JSON in CLI output: ${raw.slice(0, 200)}`);
  }
  const p = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  if (p.found === false) return null;
  for (const field of ["question", "decision", "rationale"] as const) {
    if (typeof p[field] !== "string" || !(p[field] as string).trim()) {
      throw new Error(`judgment extractor: missing/empty "${field}"`);
    }
  }
  const status = p.status === "proposed" ? "proposed" : "accepted";
  const alternatives = Array.isArray(p.alternatives)
    ? (p.alternatives as Array<Record<string, unknown>>)
        .filter(a => typeof a?.option === "string" && typeof a?.reason_rejected === "string")
        .map(a => ({ option: a.option as string, reason_rejected: a.reason_rejected as string }))
    : [];
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    question: (p.question as string).trim(),
    decision: (p.decision as string).trim(),
    rationale: (p.rationale as string).trim(),
    alternatives,
    consequences: strings(p.consequences),
    status,
    supersedes_refs: strings(p.supersedes_refs),
    supersession_reason: typeof p.supersession_reason === "string" && p.supersession_reason.trim()
      ? p.supersession_reason.trim() : null,
  };
}

export async function extractJudgmentFromDocument(
  text: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<JudgmentProposal | null> {
  const model = opts.model ?? "claude-sonnet-5";
  const timeoutMs = opts.timeoutMs ?? 240_000;
  // Decision docs are small; cap defensively so one runaway document
  // can't blow the prompt.
  const doc = text.length > 24_000 ? `${text.slice(0, 24_000)}\n[...document truncated]` : text;
  const proc = Bun.spawn([
    "claude",
    "--model", model,
    "--no-session-persistence",
    "--disable-slash-commands",
    "--allowedTools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--system-prompt", SYSTEM_PROMPT,
    "-p", `Extract the decision from this document:\n\n${doc}`,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MACHTSINN_PORT: "65535" },
    cwd: "/tmp",
  });
  const timer = new Promise<"__timeout__">(resolve =>
    setTimeout(() => resolve("__timeout__"), timeoutMs));
  const reader = (async () => {
    if (!proc.stdout) return "";
    return new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  })();
  const result = await Promise.race([reader, timer]);
  if (result === "__timeout__") {
    try { proc.kill(); } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill(9); } catch { /* already gone */ } }, 2000);
    throw new Error(`judgment extractor timed out after ${timeoutMs}ms`);
  }
  return parseJudgmentProposal(result as string);
}
