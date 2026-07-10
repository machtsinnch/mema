// Internet fact-check runner (v2.18.1+) — Layer 2 enrichment.
//
// Manual entry point for the same engine the API triggers automatically
// after every reflection (see layer2-factcheck.ts). Checks corroborated
// world claims (corroboration_sources >= 2 by default) lacking a
// verification stamp; one CLI web-search call per DISTINCT claim,
// sequential — quota-gentle. Facts are never deleted; contradicted ones
// sink in retrieval.
//
// Usage:
//   bun scripts/fact-check.ts <owner> [--limit N] [--min-sources M] [--vault PATH] [--dry]

import { join } from "node:path";
import { listUnverifiedClaims, factCheckUnverified, claimSentence } from "../src/v2/layer2-factcheck";
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

const pending = listUnverifiedClaims(vault, owner, { minSources });
console.log(`${pending.length} unchecked corroborated claim(s); checking up to ${limit}${dry ? " [dry run]" : ""}`);
if (dry) {
  for (const g of pending.slice(0, limit)) console.log(`would check: ${claimSentence(g)} → ${g.factIds.length} fact(s)`);
  process.exit(0);
}

const result = await factCheckUnverified(vault, owner, "fact-check-script", { limit, minSources });
for (const c of result.checked) console.log(`${c.claim}\n  → ${c.verdict}: ${c.note} (${c.factsStamped} fact file(s) stamped)`);
for (const e of result.errors) console.log(`${e.claim}\n  → ERROR: ${e.error}`);
if (result.pending > 0) console.log(`${result.pending} claim(s) still pending (over --limit)`);
console.log(JSON.stringify(result, null, 2));
