#!/usr/bin/env bun
// Import a folder of .md files into machtsinn.ai via the HTTP API.
//
// Usage:
//   bun scripts/import.ts <source-dir> --entity <name> [--type semantic]
//                                       [--api http://localhost:3001]
//                                       [--key dev-ardin]
//                                       [--dry-run]
//
// For each .md file:
//   - Reads the content (full body)
//   - Derives tags from filename prefix + headings
//   - Records original path in `source` for audit
//   - POSTs to /v1/remember with the given entity + scope=entity
//
// Skips files <200 bytes and any frontmatter-already-present files (already vault-format).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";

interface Args {
  source: string;
  entity: string;
  type: string;
  api: string;
  key: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[k] = next; i++; }
      else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  if (!positional[0] || !flags.entity) {
    console.error("usage: bun scripts/import.ts <source-dir> --entity <name> [--type semantic] [--api ...] [--key ...] [--dry-run]");
    process.exit(1);
  }
  return {
    source: positional[0],
    entity: String(flags.entity),
    type: String(flags.type ?? "semantic"),
    api: String(flags.api ?? process.env.MACHTSINN_URL ?? "http://localhost:3001"),
    key: String(flags.key ?? process.env.MACHTSINN_KEY ?? "dev-ardin"),
    dryRun: !!flags["dry-run"],
  };
}

function walkMarkdown(root: string): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

function deriveTags(filename: string, body: string): string[] {
  const tags = new Set<string>();
  // Slug from filename: drop number prefix, drop .md
  const base = basename(filename, ".md").toLowerCase();
  const slug = base.replace(/^[0-9]+[a-z]?[-_]/, "");
  for (const token of slug.split(/[-_]+/)) {
    if (token.length >= 3 && token.length <= 20) tags.add(token);
  }
  // Extract first 2-3 distinct hashtags or capitalized phrases from body
  const tagMatches = body.match(/#([a-z][a-z0-9-]{2,20})/gi) ?? [];
  for (const t of tagMatches.slice(0, 5)) tags.add(t.slice(1).toLowerCase());
  return [...tags].slice(0, 8);
}

async function api(path: string, body: any, args: Args): Promise<any> {
  const res = await fetch(`${args.api}${path}`, {
    method: "POST",
    headers: { "x-api-key": args.key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const args = parseArgs();
  console.log(`Source:    ${args.source}`);
  console.log(`Entity:    ${args.entity}`);
  console.log(`Type:      ${args.type}`);
  console.log(`API:       ${args.api}`);
  console.log(`Dry-run:   ${args.dryRun ? "yes" : "no"}\n`);

  const files = walkMarkdown(args.source);
  console.log(`Found ${files.length} .md file(s).\n`);

  let imported = 0; let skipped = 0; let failed = 0;
  const startedAt = Date.now();

  for (const path of files) {
    const rel = relative(args.source, path);
    const stat = statSync(path);
    if (stat.size < 200) { console.log(`  skip (too small): ${rel}`); skipped++; continue; }

    const body = readFileSync(path, "utf8");
    // Skip files that already have frontmatter (already machtsinn-formatted)
    if (body.startsWith("---\n") && body.includes("\nid:")) {
      console.log(`  skip (already vault-formatted): ${rel}`);
      skipped++;
      continue;
    }

    const tags = deriveTags(rel, body);
    const payload = {
      content: body,
      type: args.type,
      scope: "entity",
      entity: args.entity,
      path: rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) : undefined,
      tags,
      source: `imported:${path}`,
      visibility: "project",
      trust: 0.8,
    };

    if (args.dryRun) {
      console.log(`  would write [${tags.join(",")}]: ${rel} (${stat.size}B)`);
      imported++;
      continue;
    }

    try {
      const r = await api("/v1/remember", payload, args);
      const id = r.memory.frontmatter.id;
      console.log(`  ✓ ${id}  ${rel}`);
      imported++;
    } catch (e: any) {
      console.error(`  ✗ ${rel}: ${e.message}`);
      failed++;
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s: ${imported} imported, ${skipped} skipped, ${failed} failed.`);
}

main().catch(err => { console.error("fatal:", err.message); process.exit(1); });
