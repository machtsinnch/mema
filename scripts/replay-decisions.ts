// Replay a folder of decision documents (ADRs) through mema (v2.19.1).
//
// The validation Ardin designed (2026-07-10): feed a real project's
// decision history in chronological order and check that mema rebuilds
// the same design story — facts in Layer 2, one judgment per document in
// Layer 3, supersession chains with the documents' own reasons, and
// review flags when later facts touch earlier decisions.
//
// Per document, in order:
//   1. POST /v2/observe          — episode + consensus fact/entity extraction
//   2. extractJudgmentFromDocument — one CLI call; proposal or null
//   3. recordJudgment            — based_on = episode + its extracted facts
//   4. resolve "supersedes ADR-N" refs against earlier judgments in this
//      run and apply supersedeJudgment with the document's own reason
//
// Usage:
//   bun scripts/replay-decisions.ts <owner> <folder> [--limit N] [--port 3011] [--vault PATH]

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import type { SemanticFact } from "../src/v2/types";
import { extractJudgmentFromDocument } from "../src/v2/llm-judgment-extractor";
import { recordJudgment, supersedeJudgment, listJudgments } from "../src/v2/layer3-judgment";
import { initAudit } from "../src/v2/layer6-audit";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const owner = process.argv[2];
const folder = process.argv[3];
if (!owner || !folder) throw new Error("usage: bun scripts/replay-decisions.ts <owner> <folder> [--limit N] [--port 3011] [--vault PATH]");
const limit = Number(arg("--limit", "999"));
const port = arg("--port", "3011");
const vault = arg("--vault", join(import.meta.dir, "..", "data"));
const apiKey = process.env.MEMA_API_KEY ?? "dev-ardin";

initAudit(vault);

const files = readdirSync(folder).filter(f => f.endsWith(".md")).sort().slice(0, limit);
console.log(`replaying ${files.length} document(s) as owner "${owner}" via port ${port}`);

// "ADR-15" / "adr-015" → "15" (for resolving supersedes references).
const refKey = (s: string): string | null => {
  const m = s.match(/(\d{1,4})/);
  return m ? String(Number(m[1])) : null;
};
const judgmentByRef = new Map<string, string>();   // "15" → judgment id

function factsOfEpisode(epId: string): SemanticFact[] {
  const dir = join(vault, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const fm = matter(readFileSync(join(dir, f), "utf8")).data as SemanticFact;
      if ((fm.derived_from ?? []).includes(epId)) out.push(fm);
    } catch { /* skip */ }
  }
  return out;
}

for (const file of files) {
  const path = join(folder, file);
  const text = readFileSync(path, "utf8");
  console.log(`\n── ${file} (${text.length} chars)`);

  // 1. Ingest via the server (episode + consensus extraction). curl, not
  //    fetch: Bun fetch has a hidden ~5-min timeout (learned the hard way).
  const payload = JSON.stringify({
    kind: "document", content: text,
    source: `arachne:${basename(file)}`,
  });
  const proc = Bun.spawnSync([
    "curl", "-s", "--max-time", "3600",
    "-X", "POST", `http://localhost:${port}/v2/observe`,
    "-H", "content-type: application/json",
    "-H", `x-api-key: ${apiKey}`,
    "-H", `x-owner: ${owner}`,
    "-H", "x-actor: replay-script",
    "--data-binary", "@-",
  ], { stdin: Buffer.from(payload) });
  const resp = JSON.parse(new TextDecoder().decode(proc.stdout));
  if (!resp.episode?.id) { console.log(`  INGEST FAILED: ${JSON.stringify(resp).slice(0, 300)}`); continue; }
  const ep = resp.episode.id as string;
  console.log(`  episode ${ep} — facts: ${resp.extracted?.fact_count}, entities: ${resp.extracted?.entity_count}, status: ${resp.extraction_status}`);

  // 2. One judgment per decision document.
  let proposal;
  try { proposal = await extractJudgmentFromDocument(text); }
  catch (e) { console.log(`  JUDGMENT EXTRACTION ERROR: ${(e as Error).message}`); continue; }
  if (!proposal) { console.log("  no decision found in this document"); continue; }

  // 3. Foundations: the episode + the facts extracted from it (capped so
  //    the watch-list stays focused).
  const facts = factsOfEpisode(ep).slice(0, 12);
  const judgment = recordJudgment(vault, {
    question: proposal.question,
    decision: proposal.decision,
    rationale: proposal.rationale,
    alternatives: proposal.alternatives,
    consequences: proposal.consequences,
    judgment_status: proposal.status,
    based_on: [ep, ...facts.map(f => f.id)],
    actor: "replay-script",
    owner,
    proposed_by: "llm-judgment-extractor:claude-cli:sonnet",
  });
  const myRef = refKey(file);
  if (myRef) judgmentByRef.set(myRef, judgment.id);
  console.log(`  judgment ${judgment.id} [${proposal.status}] — ${proposal.decision.slice(0, 90)}`);

  // 4. Supersession chain, with the document's own reason.
  for (const ref of proposal.supersedes_refs) {
    const key = ref ? refKey(ref) : null;
    const oldId = key ? judgmentByRef.get(key) : undefined;
    if (!oldId) { console.log(`  supersedes ${ref} — NOT RESOLVED (no earlier judgment in this run)`); continue; }
    const reason = proposal.supersession_reason ?? `superseded by ${basename(file)}`;
    const ok = supersedeJudgment(vault, owner, oldId, judgment.id, reason, "replay-script");
    console.log(`  supersedes ${ref} → ${ok ? "chain written" : "FAILED"}: ${reason.slice(0, 80)}`);
  }
}

const active = listJudgments(vault, owner);
const all = listJudgments(vault, owner, { include_superseded: true });
const flagged = listJudgments(vault, owner, { flagged: true });
console.log(`\ndone: ${all.length} judgment(s) total, ${active.length} active, ${all.length - active.length} superseded, ${flagged.length} flagged for review`);
