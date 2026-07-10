// Layer 2 enrichment: internet fact-checking of world claims (v2.18.1).
//
// Ardin's design (2026-07-10): verification against serious sources is
// what MAKES Layer 2 the truth layer — extraction alone only proves "a
// document said this", never "this is true". The stamp goes ON the fact
// (verdict + sources + when); contradicted facts are demoted in retrieval
// (layer5) but never deleted. Layer 3 never fact-checks — world claims
// don't live there (see layer3-reflection Rule A).
//
// Transport: the locally-installed `claude` CLI with WebSearch allowed —
// works on an OAuth/Max login, no API key needed (same reasoning as
// ClaudeCLIExtractor in llm-extractor.ts). One claim = one CLI call, so
// callers must batch deliberately; scripts/fact-check.ts groups facts by
// claim and checks each claim once.

import type { FactCheckVerdict } from "./types";

export interface FactCheckClaim {
  subject: string;
  predicate: string;
  object: string;
  /** World date the claim is anchored to (fact.valid_from), if any. */
  as_of?: string;
}

export interface FactCheckResult {
  verdict: FactCheckVerdict;
  note: string;                // one plain-English sentence
  sources: string[];           // URLs the checker consulted
}

const SYSTEM_PROMPT = `You are a strict fact-checker for a memory system.
You get ONE claim extracted from a private document. Use web search to
check it against serious, independent sources (news agencies, official
company/government pages, established reference works). Never treat the
claim itself as evidence.

Answer ONLY a single JSON object, no prose, no markdown fences:
{"verdict":"confirmed"|"contradicted"|"unverifiable","note":"one short plain-English sentence explaining the verdict","sources":["url",...]}

Rules:
- "confirmed": at least one serious source supports the claim.
- "contradicted": serious sources dispute it. Say what is true instead in the note.
- "unverifiable": nothing solid either way (private, too vague, or no coverage). Say why in the note.
- If the claim is ambiguous (e.g. "sold X" could mean shares or the whole company), check the most plausible reading and state which reading you checked in the note.
- sources: the URLs you actually relied on, max 3. Empty array only for "unverifiable".`;

export function claimSentence(c: FactCheckClaim): string {
  const when = c.as_of ? ` (as of ${c.as_of})` : "";
  return `${c.subject} ${c.predicate.replace(/_/g, " ")} ${c.object}${when}`;
}

// Lenient JSON extraction: the CLI answer should be bare JSON, but survive
// fences or stray prose around it.
export function parseFactCheck(raw: string): FactCheckResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`fact-check: no JSON object in CLI output: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<FactCheckResult>;
  const verdict = parsed.verdict;
  if (verdict !== "confirmed" && verdict !== "contradicted" && verdict !== "unverifiable") {
    throw new Error(`fact-check: bad verdict "${String(verdict)}"`);
  }
  return {
    verdict,
    note: typeof parsed.note === "string" ? parsed.note.slice(0, 500) : "",
    sources: Array.isArray(parsed.sources)
      ? parsed.sources.filter((s): s is string => typeof s === "string").slice(0, 3)
      : [],
  };
}

export async function checkClaimWithCLI(
  claim: FactCheckClaim,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<FactCheckResult> {
  const model = opts.model ?? "claude-sonnet-5";
  // Web search needs real time: searches + reads can take a couple of
  // minutes. Generous default, hard-killed on breach.
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const proc = Bun.spawn([
    "claude",
    "--model", model,
    "--no-session-persistence",
    "--disable-slash-commands",
    // ONLY web search — no file system, no bash, no MCP.
    "--allowedTools", "WebSearch",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--system-prompt", SYSTEM_PROMPT,
    "-p", `Fact-check this claim: ${claimSentence(claim)}`,
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
    throw new Error(`fact-check CLI timed out after ${timeoutMs}ms`);
  }
  return parseFactCheck(result as string);
}
