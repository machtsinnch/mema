#!/usr/bin/env bun
// Migrate PAI's filesystem-based memory store into mema as v2 cognitive records.
//
// Source: ~/.claude/projects/-Users-ardin-Documents-pai/memory/
// Layout per memory file (markdown + frontmatter):
//   ---
//   name: project-machtsinn-memory
//   description: "..."
//   metadata:
//     type: user|feedback|project|reference
//     originSessionId: <uuid>
//   ---
//   body... may contain [[wikilinks]] to other memories by name-slug
//
// Mapping (per docs/PAI-MIGRATION.md):
//   user      → cognitive belief
//   feedback  → cognitive belief
//   project   → cognitive observation
//   reference → cognitive observation
//
// Idempotency: each migrated record carries `source: pai-memory:{slug}` so
// re-runs skip records that already exist.
//
// Two passes:
//   1. POST /v2/cognitive for each file, collect {slug → mema_id} map
//   2. POST /v2/cognitive/:id/derived-from to wire [[slug]] wikilink refs
//
// Originals stay on disk — rollback path preserved during a 2-week soak.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

interface Args {
  source: string;
  api: string;
  key: string;
  owner: string;
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
    source: String(flags.source ?? `${process.env.HOME}/.claude/projects/-Users-ardin-Documents-pai/memory`),
    api: String(flags.api ?? process.env.MACHTSINN_URL ?? "http://localhost:3001"),
    key: String(flags.key ?? process.env.MACHTSINN_KEY ?? "dev-ardin"),
    owner: String(flags.owner ?? "ardin"),
    dryRun: !!flags["dry-run"],
  };
}

interface PaiMemory {
  filename: string;
  slug: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference" | "unknown";
  originSessionId?: string;
  body: string;
}

function readPaiMemory(path: string): PaiMemory | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }
  const parsed = matter(raw);
  const fm: any = parsed.data;
  const slug = fm.name as string | undefined;
  if (!slug) return null;
  const type = (fm.metadata?.type ?? "unknown") as PaiMemory["type"];
  return {
    filename: path,
    slug,
    description: (fm.description as string) ?? "",
    type,
    originSessionId: fm.metadata?.originSessionId as string | undefined,
    body: parsed.content.trim(),
  };
}

function mapKind(t: PaiMemory["type"]): "belief" | "observation" {
  // feedback + user are explicit claims the agent holds → beliefs.
  // project + reference are observed states / pointers → observations.
  return t === "feedback" || t === "user" ? "belief" : "observation";
}

// Extract `[[slug]]` references from body. PAI wikilinks reference other
// memories by their name-slug.
function extractWikilinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([a-z0-9-]+)\]\]/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

async function api(args: Args, method: "GET" | "POST", path: string, body?: any): Promise<any> {
  const res = await fetch(`${args.api}${path}`, {
    method,
    headers: { "x-api-key": args.key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Find any existing cognitive record whose body starts with our migration marker
// for this slug. We use the body's first H1 (`# pai:{slug} — ...`) for identity
// because /v2/observe is the only write path that carries an arbitrary source
// field; /v2/cognitive doesn't expose `source` directly.
function existingMemaIdForSlug(args: Args, slug: string): string | null {
  // Scan local filesystem for an existing migrated record with this slug.
  // Path: data/cognitive/{owner}/{kind}/*.md, frontmatter contains
  // pai_source: pai-memory:{slug}
  const vault = `${process.env.HOME}/Projects/machtsinn.ai/data`;
  for (const kind of ["belief", "observation", "experience"]) {
    const dir = join(vault, "cognitive", args.owner, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const fm = matter(readFileSync(join(dir, f), "utf8")).data as any;
        if (fm.pai_source === `pai-memory:${slug}`) return fm.id as string;
      } catch { /* skip */ }
    }
  }
  return null;
}

async function main() {
  const args = parseArgs();
  console.log(`Source:    ${args.source}`);
  console.log(`API:       ${args.api}`);
  console.log(`Owner:     ${args.owner}`);
  console.log(`Mode:      ${args.dryRun ? "dry-run" : "WRITE"}`);
  console.log("");

  if (!existsSync(args.source)) {
    console.error(`Source directory not found: ${args.source}`);
    process.exit(1);
  }

  // ── Discover PAI memories ──────────────────────────────────────────
  const files = readdirSync(args.source)
    .filter(f => f.endsWith(".md") && f !== "MEMORY.md")
    .map(f => join(args.source, f));

  console.log(`Found ${files.length} PAI memory files.`);

  const memories: PaiMemory[] = [];
  for (const f of files) {
    const m = readPaiMemory(f);
    if (m) memories.push(m);
    else console.warn(`  ⚠️  Could not parse: ${f}`);
  }
  console.log(`Parsed ${memories.length} memories.`);
  console.log("");

  // ── Pass 1: create cognitive records ───────────────────────────────
  const slugToId = new Map<string, string>();
  let createdCount = 0, skippedCount = 0, failedCount = 0;

  for (const mem of memories) {
    const existing = existingMemaIdForSlug(args, mem.slug);
    if (existing) {
      slugToId.set(mem.slug, existing);
      skippedCount++;
      continue;
    }

    const kind = mapKind(mem.type);
    // Prepend a human-readable header so the slug-rename script picks a good
    // filename and the body has a self-explanatory title.
    const headedBody = `# pai:${mem.slug}\n\n${mem.description ? `> ${mem.description}\n\n` : ""}${mem.body}`;

    if (args.dryRun) {
      console.log(`  [dry-run] ${mem.type} → ${kind}: ${mem.slug}`);
      createdCount++;
      slugToId.set(mem.slug, `dry-${mem.slug}`);
      continue;
    }

    try {
      const r = await api(args, "POST", "/v2/cognitive", {
        kind,
        content: headedBody,
        confidence: 0.9,
        derived_from: [],
      });
      const newId = r.record.id as string;
      slugToId.set(mem.slug, newId);
      // Stamp the file with pai_source so re-runs detect it. We patch the
      // frontmatter directly because /v2/cognitive doesn't expose arbitrary
      // frontmatter passthrough.
      const { readFileSync: rfs, writeFileSync: wfs } = await import("node:fs");
      const { default: matterMod } = await import("gray-matter");
      const { pathForCognitive } = await import("../src/v2/layer3-cognitive");
      const path = pathForCognitive(`${process.env.HOME}/Projects/machtsinn.ai/data`, args.owner, newId);
      if (path) {
        const parsed = matterMod(rfs(path, "utf8"));
        parsed.data.pai_source = `pai-memory:${mem.slug}`;
        parsed.data.pai_type = mem.type;
        if (mem.originSessionId) parsed.data.pai_origin_session = mem.originSessionId;
        for (const k of Object.keys(parsed.data)) {
          if (parsed.data[k] === undefined) delete parsed.data[k];
        }
        wfs(path, matterMod.stringify(parsed.content.trim(), parsed.data), "utf8");
      }
      createdCount++;
      console.log(`  ✓ ${mem.type} → ${kind}: ${mem.slug} → ${newId}`);
    } catch (e: any) {
      console.error(`  ✗ ${mem.slug}: ${e.message}`);
      failedCount++;
    }
  }

  console.log("");
  console.log(`Pass 1: created=${createdCount}, skipped=${skippedCount}, failed=${failedCount}`);

  // ── Pass 2: wire derived_from from [[slug]] wikilinks ──────────────
  console.log("");
  console.log("Pass 2: resolving cross-memory wikilinks...");
  let linksAdded = 0, linksSkipped = 0;

  for (const mem of memories) {
    const myId = slugToId.get(mem.slug);
    if (!myId) continue;
    const refs = extractWikilinks(mem.body);
    if (refs.length === 0) continue;
    const resolvedIds = refs
      .map(r => slugToId.get(r))
      .filter((id): id is string => !!id && !id.startsWith("dry-"));
    if (resolvedIds.length === 0) {
      console.log(`  · ${mem.slug}: ${refs.length} wikilinks, 0 resolved (skipping)`);
      linksSkipped++;
      continue;
    }
    if (args.dryRun) {
      console.log(`  [dry-run] ${mem.slug} → derived_from: ${resolvedIds.length} ids`);
      linksAdded++;
      continue;
    }
    try {
      await api(args, "POST", `/v2/cognitive/${myId}/derived-from`, { add: resolvedIds });
      linksAdded++;
      console.log(`  ✓ ${mem.slug} → derived_from: [${resolvedIds.length}]`);
    } catch (e: any) {
      console.error(`  ✗ ${mem.slug} derived-from: ${e.message}`);
    }
  }

  console.log("");
  console.log(`Pass 2: links_added=${linksAdded}, skipped=${linksSkipped}`);
  console.log("");
  console.log("Migration complete.");
  console.log("");
  console.log("Next steps:");
  console.log("  - Run /v2/vector/reindex to embed the new cognitive records");
  console.log("  - Open Obsidian; the new records appear under data/cognitive/{owner}/{kind}/");
  console.log("  - PAI memory .md files at ~/.claude/projects/.../memory/ stay on disk for rollback");
  console.log("  - Update PAI's CLAUDE.md auto-memory section to use /v2/* (separate change)");
}

main().catch(e => { console.error("fatal:", e.message); process.exit(1); });
