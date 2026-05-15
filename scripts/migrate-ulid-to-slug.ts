#!/usr/bin/env bun
// Rename v2 records from `{ulid}.md` → `{slug}--{ulid}.md` and rewrite every
// wikilink that targeted the old filename. Makes Obsidian's graph view
// readable: instead of `01KRHAHBP9Y1ASF2H6JS4XAW8J` you get
// `release-management-guide--01KRHAHBP9Y1ASF2H6JS4XAW8J`.
//
// Idempotent: files already in slug--ulid form are left alone.
// Wikilink update pass walks every .md in v2 directories AND v1 directories
// (entities/, generalized/, users/) so v1 records that wikilink at v2 IDs
// keep working.
//
// Usage:
//   bun scripts/migrate-ulid-to-slug.ts \
//     --vault ~/Projects/machtsinn.ai/data \
//     [--owner ardin] \
//     [--dry-run]

import {
  readdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";
import { slugify, recordFilename, idFromFilename } from "../src/v2/types";

interface Args { vault: string; owner?: string; dryRun: boolean; }

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

// Detect "this slug is just a ULID" so re-runs can re-slug files that were
// previously renamed with a poor (ULID-shaped) slug. ULIDs are 26-char base32
// strings; we use a slightly looser check (lowercase letters/digits, 24-32
// chars, no hyphens) to catch the common case.
function isUlidShaped(stem: string): boolean {
  return /^[a-z0-9]{24,32}$/.test(stem);
}

// Derive a slug from frontmatter (and optionally body), per record kind.
// For episodes, the body's first H1 is the best title — beats source-path
// basenames (which are often ULID-named themselves for v1-migrated records).
function deriveSlug(
  fm: any,
  body: string | undefined,
  kind: "episode" | "fact" | "cognitive" | "entity",
): string {
  // First H1 in body (without leading #)
  const h1 = (body ?? "").match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (h1 && h1.length >= 3 && h1.length <= 120) {
    return slugify(h1, kind);
  }

  if (kind === "episode") {
    const src = (fm.source as string) ?? "";
    const m = src.match(/^v1-migrate:(.+)$/);
    if (m) {
      const base = basename(m[1], ".md");
      // If the source filename is itself a ULID-shaped string, skip it.
      if (!isUlidShaped(base.toLowerCase())) return slugify(base, "episode");
    }
    if (src && !isUlidShaped(basename(src, ".md").toLowerCase())) {
      return slugify(basename(src, ".md"), "episode");
    }
    // Last resort: first few words of body
    const firstWords = (body ?? "").trim().split(/\s+/).slice(0, 8).join(" ");
    if (firstWords.length >= 3) return slugify(firstWords, "episode");
    return slugify(fm.kind ?? "episode", "episode");
  }
  if (kind === "fact") {
    return slugify(`${fm.subject}-${fm.predicate}-${fm.object}`, "fact");
  }
  if (kind === "cognitive") {
    // Use first words of body as the disambiguator
    const firstWords = (body ?? "").trim().split(/\s+/).slice(0, 10).join(" ");
    if (firstWords.length >= 3) return slugify(`${fm.kind}-${firstWords}`, fm.kind ?? "cognitive");
    return slugify(`${fm.kind}`, fm.kind ?? "cognitive");
  }
  if (kind === "entity") {
    return slugify(`${fm.type}-${fm.name}`, "entity");
  }
  return "item";
}

interface Rename { oldPath: string; newPath: string; id: string; oldStem: string; newStem: string; }

async function main() {
  const args = parseArgs();
  console.log(`Vault: ${args.vault}`);
  console.log(`Mode:  ${args.dryRun ? "dry-run" : "WRITE"}`);
  if (args.owner) console.log(`Owner filter: ${args.owner}`);
  console.log("");

  // ── Pass 1: collect renames ─────────────────────────────────────
  const renames: Rename[] = [];
  const targets: { dir: string; kind: "episode" | "fact" | "cognitive" | "entity" }[] = [
    { dir: join(args.vault, "episodes"), kind: "episode" },
    { dir: join(args.vault, "facts"), kind: "fact" },
    { dir: join(args.vault, "cognitive"), kind: "cognitive" },
    { dir: join(args.vault, "v2-entities"), kind: "entity" },
  ];

  for (const { dir, kind } of targets) {
    for (const path of walk(dir)) {
      const filename = basename(path);
      const stem = filename.replace(/\.md$/, "");
      const id = idFromFilename(filename);
      if (!id) continue;                         // not a ULID
      // If already slug--ulid AND slug is meaningful (not just a ULID), skip.
      // If slug IS a ULID-shaped string, re-slug using the body title.
      const sep = stem.indexOf("--");
      const currentSlug = sep >= 0 ? stem.slice(0, sep) : null;
      if (currentSlug !== null && !isUlidShaped(currentSlug)) continue;
      let parsed;
      try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
      const fm = parsed.data;
      const body = parsed.content;
      if (args.owner && fm.owner !== args.owner) continue;
      const newSlug = deriveSlug(fm, body, kind);
      if (newSlug === currentSlug) continue;     // no improvement
      const newPath = join(path.replace(/\/[^/]+$/, ""), recordFilename(newSlug, id));
      renames.push({ oldPath: path, newPath, id, oldStem: stem, newStem: `${newSlug}--${id}` });
    }
  }

  console.log(`Files to rename: ${renames.length}`);
  if (renames.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // ── Pass 2: perform renames (unless dry-run) ─────────────────────
  const idMap = new Map<string, string>();    // old wikilink target → new wikilink target
  for (const r of renames) {
    idMap.set(r.oldStem, r.newStem);
    if (!args.dryRun) {
      try {
        renameSync(r.oldPath, r.newPath);
      } catch (e: any) {
        console.error(`  ✗ ${r.oldPath} -> ${r.newPath}: ${e.message}`);
      }
    }
  }
  console.log(args.dryRun ? "  (dry-run: no files actually renamed)" : `  ${renames.length} files renamed`);

  // ── Pass 3: rewrite wikilinks in all .md files (v2 + v1) ────────
  // Wikilinks now point to {slug}--{ulid}. Walk all .md files; for each,
  // rewrite both frontmatter `links:` entries and inline body `[[ulid]]` refs.
  const allDirs = [
    join(args.vault, "episodes"),
    join(args.vault, "facts"),
    join(args.vault, "cognitive"),
    join(args.vault, "v2-entities"),
    join(args.vault, "entities"),
    join(args.vault, "generalized"),
    join(args.vault, "users"),
  ];
  let rewritten = 0;
  for (const dir of allDirs) {
    for (const path of walk(dir)) {
      let raw: string;
      try { raw = readFileSync(path, "utf8"); } catch { continue; }
      const parsed = matter(raw);
      let changed = false;

      // Rewrite frontmatter `links:`
      if (Array.isArray(parsed.data.links)) {
        const newLinks = (parsed.data.links as string[]).map(l => {
          const m = l.match(/^\[\[([^\]|]+)(\|[^\]]+)?\]\]$/);
          if (!m) return l;
          const target = m[1];
          const replacement = idMap.get(target);
          if (!replacement) return l;
          changed = true;
          return `[[${replacement}${m[2] ?? ""}]]`;
        });
        if (changed) parsed.data.links = newLinks;
      }

      // Rewrite inline body wikilinks (best-effort)
      let body = parsed.content;
      const bodyChanged = body.replace(/\[\[([A-Za-z0-9._-]+)(\|[^\]]+)?\]\]/g, (full, t, alias) => {
        const repl = idMap.get(t);
        if (!repl) return full;
        changed = true;
        return `[[${repl}${alias ?? ""}]]`;
      });
      if (bodyChanged !== body) body = bodyChanged;

      if (changed) {
        rewritten++;
        if (!args.dryRun) {
          for (const k of Object.keys(parsed.data)) {
            if (parsed.data[k] === undefined) delete parsed.data[k];
          }
          writeFileSync(path, matter.stringify(body.trim(), parsed.data), "utf8");
        }
      }
    }
  }
  console.log(`Files with wikilinks rewritten: ${rewritten}${args.dryRun ? " (dry-run)" : ""}`);

  console.log("");
  console.log("Next steps:");
  console.log("  - Restart mema server so any in-memory caches reset");
  console.log("  - Close + reopen Obsidian fully (Cmd+Q)");
  console.log("  - Cmd+G to see human-readable labels in the graph view");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
