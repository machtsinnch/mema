// Internet fact-check runner (v2.18.1) — Layer 2 enrichment.
//
// Checks WORLD claims that several documents agree on (default:
// corroboration_sources >= 2, the annotation reflection writes) against
// the web via the claude CLI, and stamps the verdict onto every fact
// carrying the claim. One CLI call per DISTINCT claim, sequential —
// deliberately quota-gentle. Facts are never deleted; contradicted ones
// sink in retrieval.
//
// Usage:
//   bun scripts/fact-check.ts <owner> [--limit N] [--min-sources M] [--vault PATH] [--dry]

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { SemanticFact } from "../src/v2/types";
import { canonicalPredicate } from "../src/v2/predicates";
import { checkClaimWithCLI, claimSentence } from "../src/v2/layer2-factcheck";
import { annotateFactVerification } from "../src/v2/layer2-semantic";
import { initAudit } from "../src/v2/layer6-audit";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const owner = process.argv[2];
if (!owner || owner.startsWith("--")) throw new Error("usage: bun scripts/fact-check.ts <owner> [--limit N] [--min-sources M] [--vault PATH] [--dry]");
const vault = arg("--vault", join(import.meta.dir, "..", "data"));
const limit = Number(arg("--limit", "5"));
const minSources = Number(arg("--min-sources", "2"));
const dry = process.argv.includes("--dry");

initAudit(vault);

const dir = join(vault, "facts", owner);
if (!existsSync(dir)) throw new Error(`no facts for owner ${owner} under ${vault}`);
const facts: SemanticFact[] = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".md")) continue;
  try {
    const fm = matter(readFileSync(join(dir, f), "utf8")).data as SemanticFact;
    if ((fm.status ?? "approved") !== "approved") continue;
    if (fm.invalidated_at || fm.superseded_by) continue;
    facts.push(fm);
  } catch { /* skip malformed */ }
}

// Group corroborated facts by claim; each claim is checked once.
interface ClaimGroup { subject: string; predicate: string; object: string; as_of?: string; factIds: string[]; already?: string }
const groups = new Map<string, ClaimGroup>();
for (const f of facts) {
  if ((f.corroboration_sources ?? 0) < minSources) continue;
  const key = `${(f.subject ?? "").trim().toLowerCase()}|${canonicalPredicate(f.predicate)}|${(f.object ?? "").trim().toLowerCase()}`;
  const g = groups.get(key) ?? {
    subject: f.subject, predicate: f.predicate, object: f.object,
    ...(f.valid_from && f.valid_from.length <= 10 ? { as_of: f.valid_from } : {}),
    factIds: [],
  };
  g.factIds.push(f.id);
  if (f.verification) g.already = f.verification;
  groups.set(key, g);
}

const queue = [...groups.values()].filter(g => !g.already).slice(0, limit);
const skipped = [...groups.values()].filter(g => g.already);
console.log(`${groups.size} corroborated claim(s); ${skipped.length} already checked; checking ${queue.length} (limit ${limit})${dry ? " [dry run]" : ""}`);

const results: Array<{ claim: string; verdict: string; note: string; sources: string[]; facts: number }> = [];
for (const g of queue) {
  const sentence = claimSentence(g);
  if (dry) { console.log(`would check: ${sentence} → ${g.factIds.length} fact(s)`); continue; }
  console.log(`checking: ${sentence} ...`);
  try {
    const r = await checkClaimWithCLI(g);
    let stamped = 0;
    for (const id of g.factIds) {
      if (annotateFactVerification(vault, owner, id, r, "fact-check-script")) stamped++;
    }
    results.push({ claim: sentence, verdict: r.verdict, note: r.note, sources: r.sources, facts: stamped });
    console.log(`  → ${r.verdict}: ${r.note} (${stamped} fact file(s) stamped)`);
  } catch (e) {
    console.log(`  → ERROR: ${(e as Error).message}`);
    results.push({ claim: sentence, verdict: "error", note: (e as Error).message, sources: [], facts: 0 });
  }
}
console.log(JSON.stringify(results, null, 2));
