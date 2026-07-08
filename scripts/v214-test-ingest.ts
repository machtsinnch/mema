#!/usr/bin/env bun
// v2.14.0 real-data ingestion test.
//
// Walks a source tree, calls /v2/observe to create episodes, then runs
// the bench's extractor (same prompt as the LongMemEval harness uses)
// to produce facts. Each fact is posted via /v2/fact, which exercises
// the v2.14.0 recordFactWithSupersession wrapper end-to-end.
//
// Usage:
//   bun scripts/v214-test-ingest.ts <source-root> --owner <name> \
//     [--api http://localhost:3001] [--key dev-ardin] [--limit N] [--dry-run]
//
// Example for Ardin's data:
//   bun scripts/v214-test-ingest.ts ~/Documents/pai \
//     --owner ardin-v214test --limit 20
//
// Notes:
//   - Uses scoped owner (e.g. "ardin-v214test") to keep this test
//     isolated from production data without wiping anything.
//   - LLM backend: claude via callClaudeCLI (same as the bench).
//     Free if you're on OAuth, but uses Sonnet quota.
//   - Each source file → 1 episode + N facts (N depends on content
//     density; typically 3-10 per substantive file).
//   - The extractor prompt rejects vague claims, so very short files
//     may produce 0 facts.
//   - Skips: node_modules, .git, dist, build, .next, .venv, etc. — same
//     filter as import-tree.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { callClaudeCLI } from "../bench/bench-utils";
import { buildExtractorPrompt } from "../bench/extractor-prompt";

interface Args {
  source: string;
  owner: string;
  api: string;
  key: string;
  limit: number | null;
  /** v2.14.3+ — 1-indexed resume point. --start 53 skips the first 52
   *  files (which already ingested) and begins at file 53. Relies on the
   *  walk order being deterministic for an unchanged source tree, which
   *  it is on APFS. */
  start: number | null;
  dryRun: boolean;
  /** v2.14.0+ — skip the LLM extractor entirely; observe-only ingestion.
   *  Used overnight 2026-05-17→18 when the bench-utils callClaudeCLI was
   *  observed to hang for 18min on a single 20KB source file. Allows
   *  episode-only ingestion as a fallback so retrieval testing works
   *  without waiting on the extractor pipeline to be fixed. */
  skipExtract: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", ".pulumi",
  ".nuxt", "target", "Packs", "Releases", "test-results", "playwright-report",
  ".claude", ".agents", ".github", "shared",
  // v2.14test ingestion: skip the noisy repo-internals; the user's
  // qualitative test cares about CONTENT (spaces/, docs/, top-level .md)
  // not infra/test code.
  "test", "tests", "node_modules", "out", "tmp", "vendor",
]);

const SKIP_FILES = new Set([
  ".DS_Store", "package-lock.json", "bun.lockb", "yarn.lock", "pnpm-lock.yaml",
]);

/** v2.14test scope filter — for owner=ardin-v214test ingestion, apply
 *  stricter path-based skips on machtsinn's deeper trees to keep the
 *  ingestion bounded (~250 files instead of 6115). */
function inV214TestScope(path: string): boolean {
  // Outside the user's pai dir → no extra filter
  if (!path.includes("/Documents/pai/machtsinn/")) return true;
  // For macht-foundation-engine: only depth ≤ 3 (top-level READMEs +
  // key docs, not the deep azure-bicep + portal trees)
  if (path.includes("/macht-foundation-engine/")) {
    const sub = path.split("/macht-foundation-engine/")[1] ?? "";
    if (sub.split("/").length > 3) return false;
  }
  // For macht-notion-aibrain: skip shared/, .claude/, .agents/, .github/
  // but keep spaces/, docs/, registry/, Plans/, and top-level *.md
  if (path.includes("/macht-notion-aibrain/")) {
    if (/\/macht-notion-aibrain\/(shared|\.claude|\.agents|\.github|\.git)\//.test(path)) return false;
  }
  // Skip the other macht-* repos for the v214test scope (they're code
  // repos, not knowledge content)
  if (
    path.includes("/macht-azure-foundation/") ||
    path.includes("/macht-azure-foundation-infrastructure/") ||
    path.includes("/macht-partner-center/") ||
    path.includes("/machtsinn-mcp-foundation/") ||
    path.includes("/machtsinn-website/")
  ) return false;
  return true;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  if (!argv[0] || argv[0].startsWith("--")) {
    console.error("usage: bun scripts/v214-test-ingest.ts <source-root> --owner NAME [--api URL] [--key KEY] [--limit N] [--dry-run]");
    process.exit(2);
  }
  const source = argv[0];
  const flags: Record<string, any> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") { flags["dry-run"] = true; continue; }
    if (a === "--skip-extract") { flags["skip-extract"] = true; continue; }
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[++i];
    }
  }
  return {
    source,
    owner: String(flags.owner ?? "v214test"),
    api: String(flags.api ?? "http://localhost:3001"),
    key: String(flags.key ?? "dev-ardin"),
    limit: flags.limit ? parseInt(flags.limit, 10) : null,
    start: flags.start ? parseInt(flags.start, 10) : null,
    dryRun: !!flags["dry-run"],
    skipExtract: !!flags["skip-extract"],
  };
}

function walk(root: string): string[] {
  const out: string[] = [];
  function recur(dir: string) {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith(".")) continue;
        recur(join(dir, e.name));
      } else if (e.isFile()) {
        if (SKIP_FILES.has(e.name)) continue;
        if (!e.name.endsWith(".md")) continue;
        const p = join(dir, e.name);
        try {
          const stat = statSync(p);
          if (stat.size < 200) continue;       // tiny stubs
          if (stat.size > 200000) continue;     // skip huge files (one observe blast)
          if (!inV214TestScope(p)) continue;    // v214test path filter
          out.push(p);
        } catch { /* skip unreadable */ }
      }
    }
  }
  recur(root);
  return out;
}

async function post(args: Args, path: string, body: any): Promise<any> {
  const r = await fetch(`${args.api}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": args.key,
      // v2.14.0+ — pass x-owner so the server's owner-override (when
      // MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true) honors our isolated test
      // namespace. Without this header, writes go to the api-key's
      // mapped owner (e.g. "ardin"), polluting production data.
      "x-owner": args.owner,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function main() {
  const args = parseArgs();
  console.log(`Source:    ${args.source}`);
  console.log(`Owner:     ${args.owner}`);
  console.log(`API:       ${args.api}`);
  console.log(`Limit:     ${args.limit ?? "no limit"}`);
  console.log(`Dry run:   ${args.dryRun ? "YES (no writes)" : "no"}\n`);

  const files = walk(args.source);
  console.log(`Found ${files.length} .md files (after filters)\n`);
  const startIdx = args.start ? args.start - 1 : 0;
  let slice = files.slice(startIdx);
  if (args.limit) slice = slice.slice(0, args.limit);
  if (args.start) console.log(`Resuming at file ${args.start} (skipping first ${startIdx})\n`);

  let episodesCreated = 0;
  let factsCreated = 0;
  let factsSkippedDuplicate = 0;
  let factsSkippedStale = 0;
  let factsTriggeredSupersession = 0;
  let totalSuperseded = 0;
  let extractorFailures = 0;
  const start = Date.now();

  for (let i = 0; i < slice.length; i++) {
    const f = slice[i];
    const body = readFileSync(f, "utf8");
    const observationDate = new Date().toISOString().slice(0, 10);
    const relName = f.replace(args.source + "/", "");
    process.stdout.write(`[${startIdx + i + 1}/${files.length}] ${relName.slice(0, 70).padEnd(70)} `);

    let episodeId = "(dry-run)";
    if (!args.dryRun) {
      try {
        const obs = await post(args, "/v2/observe", {
          kind: "document",
          content: body,
          source: f,
        });
        episodeId = obs.episode?.id ?? "(unknown)";
        episodesCreated++;
      } catch (e: any) {
        console.log(`OBSERVE_FAIL: ${e.message}`);
        continue;
      }
    }

    // Run the extractor (same prompt as the bench).
    // Dry-run and --skip-extract both bypass the LLM call entirely.
    if (args.dryRun) {
      console.log(`(dry-run, skip extract)`);
      continue;
    }
    if (args.skipExtract) {
      console.log(`OBSERVED (skip-extract)`);
      continue;
    }
    const prompt = buildExtractorPrompt({
      observationDate,
      text: body.slice(0, 100000),  // cap to 100k chars per file
    });
    let raw: string | null;
    try {
      raw = await callClaudeCLI(prompt, 180000);
    } catch (e: any) {
      console.log(`EXTRACTOR_FAIL: ${e.message?.slice(0, 50)}`);
      extractorFailures++;
      continue;
    }
    if (!raw) {
      console.log(`EXTRACTOR_NULL`);
      extractorFailures++;
      continue;
    }

    // Parse JSON output. Extractor prompt requires {facts:[], entities:[]}.
    let parsed: any;
    try {
      const cleaned = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.log(`PARSE_FAIL`);
      extractorFailures++;
      continue;
    }

    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    let localCreated = 0;
    let localDup = 0;
    let localStale = 0;
    let localSupersededTotal = 0;
    let localSupersedeFires = 0;

    for (const ft of facts) {
      if (typeof ft.subject !== "string" || typeof ft.predicate !== "string" || typeof ft.object !== "string") continue;
      if (ft.predicate === "is" || ft.predicate === "has" || ft.predicate === "at") continue;
      if (typeof ft.confidence !== "number" || ft.confidence < 0.75) continue;

      if (args.dryRun) { localCreated++; continue; }

      try {
        const result = await post(args, "/v2/fact", {
          subject: ft.subject,
          predicate: ft.predicate,
          object: ft.object,
          valid_from: ft.event_date ?? observationDate,
          derived_from: [episodeId],
          confidence: ft.confidence,
          status: "approved",
        });
        if (result.fact === null) {
          if (result.decision?.reason === "duplicate") localDup++;
          else if (result.decision?.reason === "stale") localStale++;
        } else {
          localCreated++;
          if (result.superseded && result.superseded.length > 0) {
            localSupersedeFires++;
            localSupersededTotal += result.superseded.length;
          }
        }
      } catch { /* skip individual fact failures */ }
    }

    factsCreated += localCreated;
    factsSkippedDuplicate += localDup;
    factsSkippedStale += localStale;
    factsTriggeredSupersession += localSupersedeFires;
    totalSuperseded += localSupersededTotal;

    const supTag = localSupersedeFires > 0 ? ` ⚡${localSupersedeFires}sup(${localSupersededTotal})` : "";
    const skipTag = (localDup + localStale) > 0 ? ` skip(${localDup}d/${localStale}s)` : "";
    console.log(`+${localCreated}f${supTag}${skipTag}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log();
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  v2.14.0 real-data ingestion complete (${elapsed}s)`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`Source files processed:      ${slice.length}`);
  console.log(`Episodes created:            ${episodesCreated}`);
  console.log(`Facts created (new):         ${factsCreated}`);
  console.log(`Facts skipped (duplicate):   ${factsSkippedDuplicate}`);
  console.log(`Facts skipped (stale):       ${factsSkippedStale}`);
  console.log(`Files that triggered SUP:    ${factsTriggeredSupersession}`);
  console.log(`Total facts SUPERSEDED:      ${totalSuperseded}`);
  console.log(`Extractor failures:          ${extractorFailures}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
