// Layer 1: Episodic memory — raw events as markdown files in data/episodes/
// Filesystem-truth invariant preserved: each episode is a .md file the user can read.

import { ulid } from "ulid";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "./atomic";
import { join } from "node:path";
import matter from "gray-matter";
import type { Episode, EpisodeKind } from "./types";
import { toWikilinks, slugify, recordFilename, idFromFilename } from "./types";
import { basename } from "node:path";
import { appendAudit } from "./layer6-audit";

export interface ObserveInput {
  kind: EpisodeKind;
  content: string;
  actor: string;
  owner: string;
  source?: string;
  refs?: string[];
  timestamp?: string;          // override for backfills
}

export function observe(vaultRoot: string, input: ObserveInput): Episode {
  const id = ulid();
  const ts = input.timestamp ?? new Date().toISOString();
  const dateBucket = ts.slice(0, 10);  // YYYY-MM-DD bucket for filesystem readability

  const episode: Episode = {
    id,
    timestamp: ts,
    actor: input.actor,
    owner: input.owner,
    kind: input.kind,
    content: input.content,
    source: input.source,
    refs: input.refs,
  };

  const dir = join(vaultRoot, "episodes", input.owner, dateBucket);
  mkdirSync(dir, { recursive: true });

  // Obsidian graph compatibility: surface every cross-record reference as a
  // wikilink in `links:`. toWikilinks validates each ID against a strict
  // whitelist (closes pipe/bracket/traversal injection) and dedupes.
  const refs = input.refs ?? [];
  const frontmatter: Record<string, unknown> = {
    id,
    timestamp: ts,
    actor: input.actor,
    owner: input.owner,
    kind: input.kind,
    refs,
    links: toWikilinks(refs),
  };
  if (input.source !== undefined) frontmatter.source = input.source;

  const body = input.content;
  // Human-readable filename: `{slug}--{ulid}.md` so Obsidian's file
  // explorer + graph view show meaningful labels. Slug derived from the
  // source-document basename (when imported) or the first words of content.
  let slugBase = "";
  if (input.source) {
    const m = input.source.match(/^v1-migrate:(.+)$/);
    const sourcePath = m ? m[1] : input.source;
    slugBase = basename(sourcePath, ".md");
  }
  if (!slugBase) slugBase = input.content.trim().split(/\s+/).slice(0, 8).join(" ");
  const slug = slugify(slugBase, input.kind);
  frontmatter.slug = slug;

  const file = matter.stringify(body, frontmatter);
  const path = join(dir, recordFilename(slug, id));
  atomicWriteFile(path, file);

  appendAudit({
    op: "OBSERVE",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
  });

  return episode;
}

// Resolve the on-disk path for an episode by its ULID. Returns null when
// the record isn't found. Used by tests and any caller that needs the
// file path (e.g. /v2/asset/wrap, /v2/erase) without knowing whether the
// file is on the new slug schema or the legacy ULID-only schema.
export function pathForEpisode(vaultRoot: string, owner: string, id: string): string | null {
  const ownerDir = join(vaultRoot, "episodes", owner);
  try {
    for (const bucket of readdirSync(ownerDir)) {
      const bucketDir = join(ownerDir, bucket);
      let files: string[];
      try { files = readdirSync(bucketDir); } catch { continue; }
      for (const f of files) {
        if (idFromFilename(f) === id) return join(bucketDir, f);
      }
    }
  } catch { /* dir missing */ }
  return null;
}

// Read an episode by ID. Filenames are `{slug}--{ulid}.md` (v2.3+) or
// legacy `{ulid}.md` (pre-v2.3). idFromFilename handles both.
export function findEpisode(vaultRoot: string, owner: string, id: string): Episode | null {
  const ownerDir = join(vaultRoot, "episodes", owner);
  try {
    const buckets = readdirSync(ownerDir);
    for (const b of buckets) {
      const bucketDir = join(ownerDir, b);
      let files: string[];
      try { files = readdirSync(bucketDir); } catch { continue; }
      for (const f of files) {
        if (idFromFilename(f) !== id) continue;
        try {
          const parsed = matter(readFileSync(join(bucketDir, f), "utf8"));
          return {
            id: parsed.data.id,
            timestamp: parsed.data.timestamp,
            actor: parsed.data.actor,
            owner: parsed.data.owner,
            kind: parsed.data.kind,
            content: parsed.content.trim(),
            source: parsed.data.source,
            refs: parsed.data.refs,
          };
        } catch { /* skip */ }
      }
    }
  } catch { /* no episodes yet */ }
  return null;
}
