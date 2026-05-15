// Layer 1: Episodic memory — raw events as markdown files in data/episodes/
// Filesystem-truth invariant preserved: each episode is a .md file the user can read.

import { ulid } from "ulid";
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Episode, EpisodeKind } from "./types";
import { toWikilinks } from "./types";
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
  const file = matter.stringify(body, frontmatter);
  const path = join(dir, `${id}.md`);
  writeFileSync(path, file, "utf8");

  appendAudit({
    op: "OBSERVE",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
  });

  return episode;
}

// Read an episode by ID, walking the date buckets for the owner.
export function findEpisode(vaultRoot: string, owner: string, id: string): Episode | null {
  // Episodes are ULID-prefixed by timestamp; for v2.0 we scan the owner's
  // directory tree (small N). Imports are at the top of the module.
  const ownerDir = join(vaultRoot, "episodes", owner);
  try {
    const buckets = readdirSync(ownerDir);
    for (const b of buckets) {
      const f = join(ownerDir, b, `${id}.md`);
      try {
        const raw = readFileSync(f, "utf8");
        const parsed = matter(raw);
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
      } catch { /* not in this bucket */ }
    }
  } catch { /* no episodes yet */ }
  return null;
}
