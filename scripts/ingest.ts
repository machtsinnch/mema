// scripts/ingest.ts — v2.16.2-native folder ingestion.
//
// Replaces scripts/v214-test-ingest.ts, which predates extraction-mandatory
// /v2/observe (v2.14.1) and therefore ran its OWN client-side extraction:
// it misreported server-side success as EXTRACTOR_NULL (2026-07-09 run) and,
// had its legacy path succeeded, would have double-written facts without
// consensus. This script trusts the server contract:
//
//   POST /v2/observe → server chunks, runs N-pass consensus extraction,
//   links entities, supersedes — and reports exactly what happened via
//   extraction_status / extracted.{fact_count, entity_count, rejected_count,
//   extractor, chunks}.
//
// Usage:
//   bun scripts/ingest.ts <source-root> --owner NAME [--api URL] [--key KEY]
//                         [--limit N] [--start N] [--dry-run]
//
// Files are sent SEQUENTIALLY (consensus extraction saturates the extractor;
// parallel observes only queue behind each other and risk client timeouts),
// with a 30-minute per-file ceiling so no realistic document times out
// client-side while the server is still working.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", ".pulumi",
  ".claude", ".agents", ".github", "shared", "out", "tmp", "vendor",
  "test", "tests", ".obsidian", "coverage",
]);

interface Args {
  source: string; owner: string; api: string; key: string;
  limit: number | null; start: number | null; dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const source = argv.find(a => !a.startsWith("--"));
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  if (!source || !flags.owner) {
    console.error("usage: bun scripts/ingest.ts <source-root> --owner NAME [--api URL] [--key KEY] [--limit N] [--start N] [--dry-run]");
    process.exit(1);
  }
  return {
    source: source.replace(/\/+$/, ""),
    owner: String(flags.owner),
    api: String(flags.api ?? "http://localhost:3011"),
    key: String(flags.key ?? "dev-ardin"),
    limit: flags.limit ? parseInt(String(flags.limit), 10) : null,
    start: flags.start ? parseInt(String(flags.start), 10) : null,
    dryRun: !!flags["dry-run"],
  };
}

function walk(root: string): string[] {
  const out: string[] = [];
  const recur = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries.sort()) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(e) && !e.startsWith(".")) recur(p);
        continue;
      }
      if (!e.endsWith(".md")) continue;
      if (st.size < 200) continue;      // tiny stubs
      if (st.size > 200_000) continue;  // one-observe blast guard
      out.push(p);
    }
  };
  recur(root);
  return out;
}

async function main() {
  const args = parseArgs();
  console.log(`Source: ${args.source}\nOwner:  ${args.owner}\nAPI:    ${args.api}\n`);

  const files = walk(args.source);
  console.log(`Found ${files.length} .md files (after filters)\n`);
  const startIdx = args.start ? args.start - 1 : 0;
  let slice = files.slice(startIdx);
  if (args.limit) slice = slice.slice(0, args.limit);

  const totals = { episodes: 0, facts: 0, entities: 0, rejected: 0, partial: 0, failed: 0 };
  const t0 = Date.now();

  for (let i = 0; i < slice.length; i++) {
    const f = slice[i];
    const rel = f.replace(args.source + "/", "");
    process.stdout.write(`[${startIdx + i + 1}/${files.length}] ${rel.slice(0, 64).padEnd(64)} `);
    if (args.dryRun) { console.log("(dry-run)"); continue; }

    try {
      // Via curl, NOT fetch: Bun's fetch enforces its own ~5-minute timeout
      // that an AbortSignal cannot extend — it produced phantom OBSERVE_FAILs
      // on both 2026-07-09 ingestion runs while the server completed every
      // file. curl waits exactly as long as told.
      const payload = JSON.stringify({
        kind: "document",
        content: readFileSync(f, "utf8"),
        source: rel,
      });
      const proc = Bun.spawn([
        "curl", "-sS", "--max-time", "3600",
        "-X", "POST", `${args.api}/v2/observe`,
        "-H", `x-api-key: ${args.key}`,
        "-H", `x-owner: ${args.owner}`,
        "-H", "content-type: application/json",
        "--data-binary", "@-",
      ], { stdin: Buffer.from(payload), stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const exit = await proc.exited;
      if (exit !== 0) {
        console.log(`OBSERVE_FAIL: curl exit ${exit}`);
        totals.failed++;
        continue;
      }
      const d = JSON.parse(out) as {
        extraction_status: string;
        extracted?: {
          fact_count: number; entity_count: number; rejected_count: number;
          extractor?: string; chunks?: { total: number; failed: number }; error?: string;
        };
      };
      totals.episodes++;
      const x = d.extracted;
      if (!x || d.extraction_status === "pending_retry" || d.extraction_status === "failed") {
        console.log(`EXTRACTION_${d.extraction_status.toUpperCase()}${x?.error ? `: ${x.error.slice(0, 60)}` : ""}`);
        totals.failed++;
        continue;
      }
      totals.facts += x.fact_count;
      totals.entities += x.entity_count;
      totals.rejected += x.rejected_count;
      if (d.extraction_status === "partial") totals.partial++;
      const chunkNote = x.chunks ? ` chunks ${x.chunks.total - x.chunks.failed}/${x.chunks.total}` : "";
      console.log(`${d.extraction_status.toUpperCase()} facts=${x.fact_count} ents=${x.entity_count} rej=${x.rejected_count}${chunkNote} [${x.extractor ?? "?"}]`);
    } catch (e: any) {
      console.log(`OBSERVE_FAIL: ${String(e?.message ?? e).slice(0, 60)}`);
      totals.failed++;
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`Ingestion complete (${secs}s)`);
  console.log(`Episodes: ${totals.episodes} | Facts: ${totals.facts} | Entities: ${totals.entities} | Rejected: ${totals.rejected}`);
  console.log(`Partial extractions: ${totals.partial} | Failures: ${totals.failed}`);
}

main();
