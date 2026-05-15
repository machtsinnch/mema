#!/usr/bin/env bun
// Migrate v1 vault records (data/entities/, data/generalized/, data/users/) into
// the v2 episodic layer. Each v1 record becomes a v2 episode with:
//   kind: "document"
//   content: the v1 body (verbatim)
//   source: "v1-migrate:{original_path}"
//   refs: derived from v1 frontmatter.links (Obsidian wikilink IDs)
//
// Idempotent: a marker frontmatter field `v1_source_path` on each migrated
// episode lets us detect previously-migrated records and skip them on re-run.
//
// Why episode/document rather than fact/cognitive: v1 records are arbitrary
// markdown notes (mixed semantic + procedural + reference). They're closest to
// "documents the agent observed" — L1 episodic kind=document. Higher-layer
// extraction (facts via /v2/fact, beliefs via /v2/reflect) can run after.
//
// Usage:
//   bun scripts/migrate-v1-to-v2.ts \
//     --vault ~/Projects/machtsinn.ai/data \
//     --api http://localhost:3001 \
//     --key dev-ardin \
//     [--owner ardin] \
//     [--dry-run]

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

interface Args {
  vault: string;
  api: string;
  key: string;
  owner?: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[k] = next; i++; }
    else flags[k] = true;
  }
  return {
    vault: String(flags.vault ?? `${process.env.HOME}/Projects/machtsinn.ai/data`),
    api: String(flags.api ?? process.env.MACHTSINN_URL ?? "http://localhost:3001"),
    key: String(flags.key ?? process.env.MACHTSINN_KEY ?? "dev-ardin"),
    owner: flags.owner ? String(flags.owner) : undefined,
    dryRun: !!flags["dry-run"],
  };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".md")) out.push(full);
  }
  return out;
}

// Extract bracketed ULID-like ID from an Obsidian wikilink.
function parseWikilink(s: string): string | null {
  const m = s.match(/^\[\[([A-Za-z0-9._-]+)(?:\|.*)?\]\]$/);
  return m ? m[1] : null;
}

interface MigratedEpisode {
  kind: "document";
  content: string;
  source: string;
  refs: string[];
}

// Build the set of v1 source paths that have already been migrated for an
// owner. `source` is set on every migrated episode as `v1-migrate:{path}`,
// so we can detect prior runs by scanning episodes once and comparing
// `fm.source` against the candidate path. Building the set up-front (vs
// re-scanning the directory tree per v1 file) makes the migration linear
// instead of quadratic.
const _migrationCache = new Map<string, Set<string>>();   // owner → set of v1 paths
function buildMigratedSet(vaultRoot: string, owner: string): Set<string> {
  if (_migrationCache.has(owner)) return _migrationCache.get(owner)!;
  const seen = new Set<string>();
  const epDir = join(vaultRoot, "episodes", owner);
  if (!existsSync(epDir)) { _migrationCache.set(owner, seen); return seen; }
  for (const bucket of readdirSync(epDir)) {
    const bucketPath = join(epDir, bucket);
    let files: string[];
    try { files = readdirSync(bucketPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      try {
        const fm = matter(readFileSync(join(bucketPath, f), "utf8")).data;
        const src = fm.source as string | undefined;
        if (typeof src === "string" && src.startsWith("v1-migrate:")) {
          seen.add(src.slice("v1-migrate:".length));
        }
      } catch { /* skip */ }
    }
  }
  _migrationCache.set(owner, seen);
  return seen;
}
function isAlreadyMigrated(vaultRoot: string, owner: string, v1Path: string): boolean {
  return buildMigratedSet(vaultRoot, owner).has(v1Path);
}

async function postObserve(args: Args, payload: any): Promise<{ ok: boolean; status: number; body: any }> {
  const r = await fetch(`${args.api}/v2/observe`, {
    method: "POST",
    headers: {
      "x-api-key": args.key,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* */ }
  return { ok: r.ok, status: r.status, body };
}

async function main() {
  const args = parseArgs();
  console.log(`Vault:    ${args.vault}`);
  console.log(`API:      ${args.api}`);
  console.log(`Mode:     ${args.dryRun ? "dry-run" : "WRITE"}`);
  if (args.owner) console.log(`Owner filter: ${args.owner}`);
  console.log("");

  const v1Roots = ["entities", "generalized", "users"];
  let scanned = 0, migrated = 0, skipped = 0, failed = 0;
  const byOwner: Record<string, { migrated: number; skipped: number }> = {};

  for (const root of v1Roots) {
    for (const path of walk(join(args.vault, root))) {
      scanned++;
      let fm: any, body: string;
      try {
        const parsed = matter(readFileSync(path, "utf8"));
        fm = parsed.data;
        body = parsed.content.trim();
      } catch { failed++; continue; }

      const owner = fm.owner;
      if (!owner) { skipped++; continue; }
      if (args.owner && owner !== args.owner) { skipped++; continue; }
      if (fm.forgotten === true) { skipped++; continue; }

      if (isAlreadyMigrated(args.vault, owner, path)) {
        skipped++;
        continue;
      }

      // Resolve any [[wikilinks]] in v1 frontmatter.links to IDs for refs.
      const refs: string[] = [];
      for (const l of (fm.links ?? []) as string[]) {
        const id = parseWikilink(l);
        if (id) refs.push(id);
      }

      const payload: any = {
        kind: "document",
        content: body,
        source: `v1-migrate:${path}`,
        refs,
      };

      // We can't add v1_source_path via /v2/observe (no custom-field passthrough),
      // so we encode it in `source:` and rely on `source` for idempotency. The
      // isAlreadyMigrated check already does the right thing.

      byOwner[owner] = byOwner[owner] ?? { migrated: 0, skipped: 0 };
      if (args.dryRun) {
        migrated++;
        byOwner[owner].migrated++;
        continue;
      }

      // Override the key to authenticate as this v1 record's owner.
      const keyOverride = process.env[`MACHTSINN_KEY_${owner.toUpperCase()}`] ?? args.key;
      const r = await fetch(`${args.api}/v2/observe`, {
        method: "POST",
        headers: { "x-api-key": keyOverride, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        failed++;
        const text = await r.text();
        console.error(`  ✗ ${path} (owner=${owner}) → ${r.status}: ${text.slice(0, 160)}`);
        continue;
      }
      migrated++;
      byOwner[owner].migrated++;
      if (migrated % 25 === 0) process.stdout.write(`  …${migrated} migrated\n`);
    }
  }

  console.log(`\nScanned: ${scanned}`);
  console.log(`Migrated: ${migrated}`);
  console.log(`Skipped (already migrated / no owner / forgotten / owner-filter): ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`\nBy owner:`);
  for (const [o, s] of Object.entries(byOwner).sort((a, b) => b[1].migrated - a[1].migrated)) {
    console.log(`  ${o.padEnd(24)} migrated=${s.migrated}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Reindex vectors:  curl -X POST $API/v2/vector/reindex -H 'x-api-key: $KEY'");
  console.log("  2. Open Obsidian; Cmd+G to see colored layers (cyan = newly-migrated episodes)");
  console.log("  3. Optional: run /v2/reflect to synthesize cognitive records from these episodes");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
