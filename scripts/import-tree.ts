#!/usr/bin/env bun
// Multi-entity importer. Walks a source tree, splits content into entities,
// applies strict filters to skip infrastructure/build artifacts.
//
// Usage:
//   bun scripts/import-tree.ts <source-root> [--api ...] [--key ...] [--dry-run]
//
// Entity assignment rules (for /Users/ardin/Documents):
//   - <source-root>/finance-plan/*           → entity "finance-plan"
//   - <source-root>/machtsinn/*              → entity "machtsinn"
//   - <source-root>/memory-investigation/*   → entity "memory-investigation"
//   - Other top-level dirs                   → entity = dir name
//
// Filters (always skipped):
//   - node_modules, .git, dist, build, .next, .venv, .pulumi, .nuxt, target
//   - machtsinn/ai/Packs        (Fabric pattern templates)
//   - machtsinn/ai/Releases     (old PAI version archives)
//   - cloned-repo source code   (cognee/, memory-graph/src, EverOS/methods/EverCore/src etc.)
//
// Per file:
//   - .md only, size >= 200 bytes
//   - Skip files that already start with `---\n` and contain `\nid:` (already vault-format)
//   - Derive alias from first H1 or filename
//   - Derive tags from filename + capitalized terms in body

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";

interface Args {
  source: string;
  entityOverride?: string;
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
    } else positional.push(a);
  }
  if (!positional[0]) {
    console.error("usage: bun scripts/import-tree.ts <source-root> [--api URL] [--key KEY] [--dry-run]");
    process.exit(1);
  }
  return {
    source: positional[0],
    entityOverride: flags.entity ? String(flags.entity) : undefined,
    api: String(flags.api ?? process.env.MACHTSINN_URL ?? "http://localhost:3001"),
    key: String(flags.key ?? process.env.MACHTSINN_KEY ?? "dev-ardin"),
    dryRun: !!flags["dry-run"],
  };
}

// Top-level path → entity name. We use the first segment after the source root
// as the entity unless it's an excluded location.
function entityFor(absPath: string, sourceRoot: string, override?: string): string | null {
  if (override) return override;
  const rel = relative(sourceRoot, absPath);
  if (!rel || rel.startsWith("..")) return null;
  const top = rel.split("/")[0];
  if (!top || top.startsWith(".")) return null;
  return top;
}

const HARD_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".venv", ".pulumi",
  ".nuxt", "target", ".vscode", ".idea", "out", "coverage", ".cache",
  ".turbo", ".pytest_cache", "__pycache__", "site-packages",
  ".claude",            // Claude Code infrastructure (SKILL.md etc.) — not user content
  ".github",            // CI workflows — not user content
]);

const PATH_SKIP_PATTERNS = [
  /\/machtsinn\/ai\/Packs(\/|$)/,
  /\/machtsinn\/ai\/Releases(\/|$)/,
  /\/memory-investigation\/cognee\/(?!README|cognee-mcp\/README|docs\/)/,
  /\/memory-investigation\/memory-graph\/(?!README|CHANGELOG|RELEASE_NOTES|docs\/)/,
  /\/memory-investigation\/EverOS\/(?!README|methods\/EverCore\/README|methods\/EverCore\/docs\/)/,
  /\/SKILL\.md$/,        // skill definition files
  /\/AGENTS?\.md$/,      // agent registry
  /\/CLAUDE\.md$/,       // claude project config
  /\/GEMINI\.md$/,       // gemini config
  /\/CHANGELOG\.md$/i,   // changelogs aren't knowledge
  /\/CONTRIBUTING\.md$/i,
  /\/LICENSE/,
  /\/SECURITY\.md$/,
  /\/CODE_OF_CONDUCT\.md$/i,
];

function shouldSkip(absPath: string): boolean {
  const parts = absPath.split("/");
  for (const p of parts) if (HARD_SKIP_DIRS.has(p)) return true;
  for (const re of PATH_SKIP_PATTERNS) if (re.test(absPath)) return true;
  return false;
}

function walk(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (shouldSkip(full)) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".md")) results.push(full);
    }
  }
  return results.sort();
}

function deriveAlias(filePath: string, body: string): string {
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1 && h1.length <= 120) return h1;
  return basename(filePath, ".md");
}

function deriveTags(filePath: string, body: string): string[] {
  const tags = new Set<string>();
  const base = basename(filePath, ".md").toLowerCase();
  const slug = base.replace(/^[0-9]+[a-z]?[-_]/, "");
  for (const tok of slug.split(/[-_]+/)) {
    if (tok.length >= 4 && tok.length <= 24) tags.add(tok);
  }
  // Hashtags in body
  for (const t of (body.match(/#([a-z][a-z0-9-]{3,24})/gi) ?? []).slice(0, 8)) {
    tags.add(t.slice(1).toLowerCase());
  }
  // First-line / heading top words (last resort)
  return [...tags].slice(0, 10);
}

async function post(args: Args, path: string, body: any): Promise<any> {
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
  console.log(`Source root:  ${args.source}`);
  console.log(`API:          ${args.api}`);
  console.log(`Dry run:      ${args.dryRun ? "yes" : "no"}\n`);

  const files = walk(args.source);
  console.log(`Found ${files.length} .md files after filters.\n`);

  const byEntity: Record<string, number> = {};
  const start = Date.now();
  let imported = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const ent = entityFor(file, args.source, args.entityOverride);
    if (!ent) { skipped++; continue; }
    byEntity[ent] = (byEntity[ent] ?? 0) + 1;

    const st = statSync(file);
    if (st.size < 200) { skipped++; continue; }

    // Strip any existing YAML frontmatter from the body — js-yaml chokes on stray null
    // bytes that can appear in untrusted skill/agent definitions. We only persist the
    // markdown body, our own frontmatter, and the original source path.
    let raw = readFileSync(file, "utf8");
    // Remove BOM and null bytes that would break YAML serialization downstream.
    raw = raw.replace(/^\uFEFF/, "").replace(/\u0000/g, "");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const body = fmMatch ? fmMatch[2] : raw;

    if (body.startsWith("---\n") && body.includes("\nid:")) { skipped++; continue; }
    if (body.trim().length < 100) { skipped++; continue; }

    const tags = deriveTags(file, body);
    const alias = deriveAlias(file, body);

    // path within the entity = dir relative to <source>/<entity>/
    const entityBase = args.entityOverride
      ? basename(args.source)        // when overriding, use the source-root basename as relative anchor
      : ent;
    const entityRoot = join(args.source, args.entityOverride ? "" : entityBase);
    const rel = args.entityOverride
      ? relative(args.source, file)
      : relative(join(args.source, entityBase), file);
    const subdir = dirname(rel);
    const path = subdir === "." ? undefined : subdir;

    const payload = {
      content: body,
      type: "semantic",
      scope: "entity",
      entity: ent,
      path,
      aliases: [alias],
      tags,
      source: `imported:${file}`,
      visibility: "project",
      trust: 0.75,
    };

    if (args.dryRun) {
      console.log(`  [${ent}] would write: ${rel}  (${st.size}B, tags=${tags.length})`);
      imported++;
      continue;
    }
    try {
      const r = await post(args, "/v1/remember", payload);
      imported++;
      if (imported % 20 === 0) process.stdout.write(`  …${imported} imported\n`);
    } catch (e: any) {
      failed++;
      console.error(`  ✗ ${rel}: ${e.message}`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${imported} imported, ${skipped} skipped, ${failed} failed`);
  console.log(`\nBy entity:`);
  for (const [e, n] of Object.entries(byEntity).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${e.padEnd(24)} ${n}`);
  }
}

main().catch(err => { console.error("fatal:", err.message); process.exit(1); });
