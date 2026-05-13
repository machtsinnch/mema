#!/usr/bin/env bun
// Backfill aliases on existing memories so Obsidian shows readable labels.
// Strategy: alias = first H1 heading (≤120 chars), or filename basename derived from `source`.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";

const VAULT = join(process.env.HOME!, "Projects/machtsinn.ai/data");

function walkMd(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === "_meta" || e.name === ".obsidian") continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  }
  return out;
}

function deriveAlias(body: string, source: string | undefined, id: string): string {
  // Prefer first H1 (excluding any frontmatter inside body — gray-matter already stripped it)
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1 && h1.length >= 3 && h1.length <= 120) {
    return h1.replace(/\s+/g, " ");
  }
  // Fall back to the source filename
  if (source) {
    const src = source.replace(/^imported:/, "");
    const name = basename(src, ".md");
    if (name && name.length <= 120) {
      // Make it readable: remove numeric prefixes and dashes
      return name.replace(/^\d+[a-z]?[-_]/, "").replace(/[-_]/g, " ");
    }
  }
  return id.slice(-8);
}

let scanned = 0;
let updated = 0;
let skipped = 0;

for (const path of walkMd(VAULT)) {
  scanned++;
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch { skipped++; continue; }
  const parsed = matter(raw);
  const fm: any = parsed.data;
  if (!fm.id || fm.forgotten) { skipped++; continue; }
  if (fm.aliases && fm.aliases.length > 0) { skipped++; continue; }

  const alias = deriveAlias(parsed.content, fm.source, fm.id);
  fm.aliases = [alias];

  const out = matter.stringify(parsed.content, fm);
  writeFileSync(path, out, "utf8");
  updated++;
  if (updated % 50 === 0) process.stdout.write(`  …${updated} updated\n`);
}

console.log(`\nDone. Scanned: ${scanned}, updated: ${updated}, skipped: ${skipped}`);
