// Layer 2 — Entity management (companion to layer2-semantic.ts).
// Entities are the canonical referents that facts subject/object can point at.
// Aliases let "Marcel", "Marcel R.", "marcel@machtsinn.ai" all resolve to the
// same entity.
//
// Storage: data/entities/{owner}/{entity_id}.md — filesystem-truth invariant.

import { ulid } from "ulid";
import {
  writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Entity } from "./types";
import { appendAudit } from "./layer6-audit";

export interface CreateEntityInput {
  name: string;
  type: string;                // person | organization | concept | place | system | document
  aliases?: string[];
  actor: string;
  owner: string;
}

export function createEntity(vaultRoot: string, input: CreateEntityInput): Entity {
  const id = ulid();
  const now = new Date().toISOString();
  const entity: Entity = {
    id,
    name: input.name,
    aliases: [...new Set([input.name, ...(input.aliases ?? [])])],
    type: input.type,
    first_seen: now,
    last_seen: now,
    owner: input.owner,
  };
  const dir = join(vaultRoot, "v2-entities", input.owner);
  mkdirSync(dir, { recursive: true });
  const body = `# ${entity.name}\n\nType: ${entity.type}\nAliases: ${entity.aliases.join(", ")}`;
  const file = matter.stringify(body, {
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases,
    type: entity.type,
    first_seen: entity.first_seen,
    last_seen: entity.last_seen,
    owner: entity.owner,
    // Obsidian graph: entities have no outgoing edges until they're merged
    // or referenced; merge operation appends the keeper-link below.
    links: [],
  });
  writeFileSync(join(dir, `${id}.md`), file, "utf8");

  appendAudit({
    op: "EXTRACT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    reason: `entity_created:${entity.type}`,
  });

  return entity;
}

export function readEntity(vaultRoot: string, owner: string, id: string): Entity | null {
  const path = join(vaultRoot, "v2-entities", owner, `${id}.md`);
  if (!existsSync(path)) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  return parsed.data as Entity;
}

// Find an entity by name OR by alias match (case-insensitive).
export function findEntityByName(vaultRoot: string, owner: string, query: string): Entity | null {
  const dir = join(vaultRoot, "v2-entities", owner);
  if (!existsSync(dir)) return null;
  const q = query.toLowerCase().trim();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const e = parsed.data as Entity;
      if (e.name.toLowerCase() === q) return e;
      if (e.aliases.some(a => a.toLowerCase() === q)) return e;
    } catch { /* skip malformed */ }
  }
  return null;
}

export function listEntities(vaultRoot: string, owner: string, type?: string): Entity[] {
  const dir = join(vaultRoot, "v2-entities", owner);
  if (!existsSync(dir)) return [];
  const out: Entity[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const e = parsed.data as Entity;
      if (type && e.type !== type) continue;
      out.push(e);
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

// Merge two entities that turn out to be the same referent. The "keeper" survives
// with both name + alias unions. The "merged" entity becomes a redirect-only
// stub with merged_into pointing at the keeper. Existing facts pointing at the
// merged entity stay valid because the keeper retains the merged entity's aliases.
export function mergeEntities(
  vaultRoot: string,
  owner: string,
  actor: string,
  keeperId: string,
  mergedId: string,
): Entity | null {
  const keeper = readEntity(vaultRoot, owner, keeperId);
  const merged = readEntity(vaultRoot, owner, mergedId);
  if (!keeper || !merged) return null;
  const unionAliases = [...new Set([...keeper.aliases, ...merged.aliases, merged.name])];
  const updated: Entity = {
    ...keeper,
    aliases: unionAliases,
    last_seen: new Date().toISOString(),
  };
  // Rewrite keeper
  const keeperPath = join(vaultRoot, "v2-entities", owner, `${keeperId}.md`);
  const keeperFile = matter.stringify(
    `# ${updated.name}\n\nType: ${updated.type}\nAliases: ${updated.aliases.join(", ")}`,
    updated,
  );
  writeFileSync(keeperPath, keeperFile, "utf8");

  // Replace merged entity file with a redirect stub
  const mergedPath = join(vaultRoot, "v2-entities", owner, `${mergedId}.md`);
  const stubBody = `# ${merged.name} (merged)\n\nRedirected to entity ${keeperId} on ${new Date().toISOString()}.`;
  const stub = matter.stringify(stubBody, {
    id: mergedId,
    name: merged.name,
    aliases: merged.aliases,
    type: merged.type,
    first_seen: merged.first_seen,
    last_seen: new Date().toISOString(),
    owner: merged.owner,
    merged_into: keeperId,
    // Obsidian graph: redirect stub links to its keeper.
    links: [`[[${keeperId}]]`],
  });
  writeFileSync(mergedPath, stub, "utf8");

  appendAudit({
    op: "EXTRACT",
    actor,
    owner,
    record_ids: [keeperId, mergedId],
    reason: "entity_merge",
  });

  return updated;
}

// Bump last_seen on an entity (e.g., when a new fact references it).
// CRITICAL: reads raw frontmatter and merges only `last_seen` in place. The
// previous implementation reconstructed the entity from the typed Entity
// interface, silently dropping any frontmatter fields (links, merged_into,
// asset metadata) not in the type. This regressed every entity that had been
// backfilled with Obsidian links or wrapped as an asset.
export function touchEntity(vaultRoot: string, owner: string, id: string): void {
  const path = join(vaultRoot, "v2-entities", owner, `${id}.md`);
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  if (parsed.data.owner !== owner) return;        // owner check
  parsed.data.last_seen = new Date().toISOString();
  for (const k of Object.keys(parsed.data)) {
    if (parsed.data[k] === undefined) delete parsed.data[k];
  }
  writeFileSync(path, matter.stringify(parsed.content.trim(), parsed.data), "utf8");
}
