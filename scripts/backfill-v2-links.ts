#!/usr/bin/env bun
// Backfill the `links:` Obsidian wikilink array on every v2 record that was
// written before the v2.1.0 Obsidian-compatibility fix. Walks episodes/,
// facts/, cognitive/, v2-entities/ and adds:
//
//   episodes:  links from refs[]
//   facts:     links from derived_from[] + superseded_by
//   cognitive: links from derived_from[] + superseded_by
//   entities:  links from merged_into (if redirect stub)
//
// Idempotent — re-running rewrites the same value. Safe to run on a corpus
// that's already been backfilled.

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

const VAULT = process.argv[2] ?? `${process.env.HOME}/Projects/machtsinn.ai/data`;
const DRY = process.argv.includes("--dry-run");

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

interface Rewrite { path: string; before: number; after: number; }

function backfillLinks(path: string, kind: "episode" | "fact" | "cognitive" | "entity"): Rewrite | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  const parsed = matter(raw);
  const fm = parsed.data;
  if (fm.tombstone === true) return null;
  const before = ((fm.links as string[]) ?? []).length;

  let links: string[] = [];
  if (kind === "episode") {
    links = ((fm.refs as string[]) ?? []).map((r: string) => `[[${r}]]`);
  } else if (kind === "fact" || kind === "cognitive") {
    links = [
      ...((fm.derived_from as string[]) ?? []).map((id: string) => `[[${id}]]`),
      ...(fm.superseded_by ? [`[[${fm.superseded_by}]]`] : []),
    ];
  } else if (kind === "entity") {
    if (fm.merged_into) links = [`[[${fm.merged_into}]]`];
  }

  links = [...new Set(links)];
  const existing = (fm.links as string[]) ?? [];
  if (existing.length === links.length && existing.every((v, i) => v === links[i])) return null;

  if (!DRY) {
    fm.links = links;
    for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];
    writeFileSync(path, matter.stringify(parsed.content.trim(), fm), "utf8");
  }
  return { path, before, after: links.length };
}

const targets: { dir: string; kind: "episode" | "fact" | "cognitive" | "entity" }[] = [
  { dir: join(VAULT, "episodes"), kind: "episode" },
  { dir: join(VAULT, "facts"), kind: "fact" },
  { dir: join(VAULT, "cognitive"), kind: "cognitive" },
  { dir: join(VAULT, "v2-entities"), kind: "entity" },
];

let totalRewritten = 0;
let totalScanned = 0;
const byKind: Record<string, { scanned: number; rewritten: number }> = {};

for (const { dir, kind } of targets) {
  byKind[kind] = { scanned: 0, rewritten: 0 };
  for (const path of walk(dir)) {
    totalScanned++;
    byKind[kind].scanned++;
    const r = backfillLinks(path, kind);
    if (r) {
      totalRewritten++;
      byKind[kind].rewritten++;
    }
  }
}

console.log(`Vault: ${VAULT}`);
console.log(`Mode:  ${DRY ? "dry-run" : "WRITE"}`);
console.log("");
for (const [kind, stat] of Object.entries(byKind)) {
  console.log(`  ${kind.padEnd(10)} scanned=${stat.scanned}  rewritten=${stat.rewritten}`);
}
console.log("");
console.log(`Total: ${totalScanned} scanned, ${totalRewritten} ${DRY ? "would be rewritten" : "rewritten"}`);
