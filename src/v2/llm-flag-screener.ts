// Relevance screening for judgment review flags (v2.19.2).
//
// Ardin's call (2026-07-10): structural watching stays WIDE (a new fact
// about a watched subject always becomes a candidate flag — better to
// over-catch than miss a real "Pulumi lacks native testing" moment), and
// a small model call then decides per judgment which candidates actually
// bear on the decision. Noise found in Arachne batch 1: in a one-project
// corpus every judgment watches the project entity, so unrelated facts
// flagged the ADR-process decision.
//
// One CLI call screens ALL of a judgment's candidate flags at once.

export interface FlagCandidate {
  fact_id: string;
  because: string;             // "new fact: <subject> <predicate> <object>"
}

export interface FlagVerdict {
  fact_id: string;
  relevant: boolean;
  reason: string;
}

export interface JudgmentSummary {
  question: string;
  decision: string;
  rationale: string;
}

const SYSTEM_PROMPT = `You judge whether newly learned facts are relevant to an existing architecture/craft decision.

You get the decision (question, decision, rationale) and a list of new facts. Answer ONLY one JSON object, no prose, no fences:
{"verdicts":[{"fact_id":"...","relevant":true|false,"reason":"one short plain-English sentence"}]}

relevant=true ONLY if the fact could plausibly CHANGE whether this decision still stands: a new constraint, a contradiction, a capability appearing or disappearing, a cost/risk change.
relevant=false for facts that merely mention the same project or product without bearing on THIS decision.
relevant=false for facts that CONFIRM, support, reinforce, or are consistent with the decision — agreement is not a reason to re-open a decision. If your reason would contain words like "confirms", "consistent with", "reinforces", "supports", or "aligns with", the verdict is false.
Example: decision "use Datomic-style schema"; fact "project uses Datomic" → relevant=false (confirmation). Fact "Datomic license terms changed" → relevant=true (new risk).
Return a verdict for EVERY fact_id you were given.`;

export function parseFlagVerdicts(raw: string): FlagVerdict[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`flag screener: no JSON in CLI output: ${raw.slice(0, 200)}`);
  }
  const p = JSON.parse(raw.slice(start, end + 1)) as { verdicts?: unknown };
  if (!Array.isArray(p.verdicts)) throw new Error("flag screener: missing verdicts array");
  return (p.verdicts as Array<Record<string, unknown>>)
    .filter(v => typeof v?.fact_id === "string" && typeof v?.relevant === "boolean")
    .map(v => ({
      fact_id: v.fact_id as string,
      relevant: v.relevant as boolean,
      reason: typeof v.reason === "string" ? (v.reason as string).slice(0, 300) : "",
    }));
}

export async function screenFlagsWithCLI(
  judgment: JudgmentSummary,
  candidates: FlagCandidate[],
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<FlagVerdict[]> {
  const model = opts.model ?? "claude-sonnet-5";
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const prompt = [
    `Decision under review:`,
    `Question: ${judgment.question}`,
    `Decision: ${judgment.decision}`,
    `Why: ${judgment.rationale}`,
    ``,
    `New facts:`,
    ...candidates.map(c => `- fact_id ${c.fact_id}: ${c.because}`),
  ].join("\n");
  const proc = Bun.spawn([
    "claude",
    "--model", model,
    "--no-session-persistence",
    "--disable-slash-commands",
    "--allowedTools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--system-prompt", SYSTEM_PROMPT,
    "-p", prompt,
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
    throw new Error(`flag screener timed out after ${timeoutMs}ms`);
  }
  return parseFlagVerdicts(result as string);
}
