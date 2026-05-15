#!/usr/bin/env bun
// Two general fixes that make every Obsidian graph node connect when it should:
//
//   Fix A: normalize all `links:` frontmatter wikilinks to single-line quoted
//          form `'[[target]]'`. The default YAML serializer folds long lines
//          with `>-` which some Obsidian parsers don't resolve as wikilinks.
//
//   Fix B: for v1 entity records (data/entities/, data/generalized/, data/users/)
//          that have empty `links:`, populate them with wikilinks to v2
//          episodes whose `source` field references the v1 file's path.
//          This connects the imported v1 records back to their v2 episodes.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import matter from "gray-matter";

interface Args { vault: string; owner: string; dryRun: boolean; }
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
    owner: String(flags.owner ?? "ardin"),
    dryRun: !!flags["dry-run"],
  };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    try {
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walk(full));
      else if (e.endsWith(".md")) out.push(full);
    } catch { /* */ }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  console.log(`Vault: ${args.vault}`);
  console.log(`Owner: ${args.owner}`);
  console.log(`Mode:  ${args.dryRun ? "dry-run" : "WRITE"}`);
  console.log("");

  // ── Index v2 episodes by their v1-migrate source path, so we can wire
  //     v1 records back to the v2 episodes derived from them ──────────
  const v1ToV2Episode = new Map<string, string>();   // v1 abs path → v2 episode filename
  const epDir = join(args.vault, "episodes", args.owner);
  for (const path of walk(epDir)) {
    try {
      const parsed = matter(readFileSync(path, "utf8"));
      const src = parsed.data.source as string | undefined;
      if (!src) continue;
      const m = src.match(/^v1-migrate:(.+)$/);
      if (!m) continue;
      v1ToV2Episode.set(m[1], basename(path, ".md"));
    } catch { /* */ }
  }
  console.log(`v2 episodes derived from v1 records: ${v1ToV2Episode.size}`);

  // ── Custom serializer: force single-line wikilinks (no `>-` folding) ──
  // We can't change js-yaml's lineWidth from inside gray-matter cleanly, so
  // we serialize to a fresh string, then regex-fix any folded wikilink lines.
  function dumpUnfolded(content: string, data: Record<string, unknown>): string {
    const yaml = matter.stringify(content, data);
    // Replace folded wikilink:
    //   - >-
    //       [[target]]
    // with:
    //   - '[[target]]'
    return yaml.replace(
      /^(\s*)-\s*>-\s*\n\s+(\[\[[^\]]+\]\])\s*$/gm,
      (_m, indent, link) => `${indent}- '${link}'`,
    );
  }

  // ── Fix A: walk all v2 directories + entities dir, rewrite unfolded ──
  console.log("\nFix A: unfold YAML wikilinks across all .md files...");
  const allDirs = [
    join(args.vault, "episodes"),
    join(args.vault, "facts"),
    join(args.vault, "cognitive"),
    join(args.vault, "v2-entities"),
    join(args.vault, "entities"),
    join(args.vault, "generalized"),
    join(args.vault, "users"),
  ];
  let unfolded = 0;
  for (const dir of allDirs) {
    for (const path of walk(dir)) {
      let raw: string;
      try { raw = readFileSync(path, "utf8"); } catch { continue; }
      if (!/^\s*-\s*>-\s*\n\s+\[\[/m.test(raw)) continue;
      const fixed = raw.replace(
        /^(\s*)-\s*>-\s*\n\s+(\[\[[^\]]+\]\])\s*$/gm,
        (_m, indent, link) => `${indent}- '${link}'`,
      );
      if (fixed !== raw) {
        if (!args.dryRun) writeFileSync(path, fixed, "utf8");
        unfolded++;
      }
    }
  }
  console.log(`  ${unfolded} files had folded wikilinks unfolded`);

  // ── Fix B: wire v1 entity records back to their v2 episodes ─────────
  console.log("\nFix B: wire v1 entity records to v2 episodes...");
  const v1Dirs = [
    join(args.vault, "entities"),
    join(args.vault, "generalized"),
    join(args.vault, "users"),
  ];
  let v1Wired = 0;
  for (const dir of v1Dirs) {
    for (const path of walk(dir)) {
      let parsed;
      try { parsed = matter(readFileSync(path, "utf8")); } catch { continue; }
      if (parsed.data.owner !== args.owner) continue;
      if (parsed.data.forgotten === true) continue;
      // Resolve absolute path that v1-migrate used
      const absV1Path = path;   // v1-migrate stored the absolute path
      const v2Ep = v1ToV2Episode.get(absV1Path);
      if (!v2Ep) continue;
      const existing = (parsed.data.links ?? []) as string[];
      const newLink = `[[${v2Ep}]]`;
      if (existing.some(l => l === newLink || l.includes(v2Ep))) continue;
      const merged = [...existing, newLink];
      parsed.data.links = merged;
      for (const k of Object.keys(parsed.data)) {
        if (parsed.data[k] === undefined) delete parsed.data[k];
      }
      if (!args.dryRun) {
        writeFileSync(path, matter.stringify(parsed.content.trim(), parsed.data), "utf8");
      }
      v1Wired++;
    }
  }
  console.log(`  ${v1Wired} v1 records wired to their v2 episodes`);

  console.log("");
  console.log("Done. Cmd+Q + reopen Obsidian to see the new edges.");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
