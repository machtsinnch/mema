// Layer 2 — Entity management (companion to layer2-semantic.ts).
// Entities are the canonical referents that facts subject/object can point at.
// Aliases let "Marcel", "Marcel R.", "marcel@machtsinn.ai" all resolve to the
// same entity.
//
// Storage: data/entities/{owner}/{entity_id}.md — filesystem-truth invariant.

import { ulid } from "ulid";
import {
  mkdirSync, readFileSync, existsSync, readdirSync,
} from "node:fs";
import { atomicWriteFile } from "./atomic";
import { join } from "node:path";
import matter from "gray-matter";
import type { Entity, RecordStatus } from "./types";
import { slugify, recordFilename, idFromFilename } from "./types";
import { appendAudit } from "./layer6-audit";

export interface CreateEntityInput {
  name: string;
  type: string;                // person | organization | concept | place | system | document
  aliases?: string[];
  actor: string;
  owner: string;
  // v2.7+ acceptance lifecycle. Omitting status defaults to "approved" so
  // existing direct-API callers keep their current semantics.
  status?: RecordStatus;
  evidence_excerpt?: string;
  proposed_by?: string;
  derived_from?: string[];     // episode IDs that supported this entity (for evidence)
}

export function createEntity(vaultRoot: string, input: CreateEntityInput): Entity {
  const id = ulid();
  const now = new Date().toISOString();
  const status: RecordStatus = input.status ?? "approved";
  const entity: Entity = {
    id,
    name: input.name,
    aliases: [...new Set([input.name, ...(input.aliases ?? [])])],
    type: input.type,
    first_seen: now,
    last_seen: now,
    owner: input.owner,
    status,
    ...(input.evidence_excerpt ? { evidence_excerpt: input.evidence_excerpt.slice(0, 500) } : {}),
    ...(input.proposed_by ? { proposed_by: input.proposed_by, proposed_at: now } : {}),
  };
  const dir = join(vaultRoot, "v2-entities", input.owner);
  mkdirSync(dir, { recursive: true });
  const body = `# ${entity.name}\n\nType: ${entity.type}\nAliases: ${entity.aliases.join(", ")}`;
  const slug = slugify(`${entity.type}-${entity.name}`, "entity");
  const file = matter.stringify(body, {
    id: entity.id,
    slug,
    name: entity.name,
    aliases: entity.aliases,
    type: entity.type,
    first_seen: entity.first_seen,
    last_seen: entity.last_seen,
    owner: entity.owner,
    status: entity.status,
    ...(entity.evidence_excerpt ? { evidence_excerpt: entity.evidence_excerpt } : {}),
    ...(entity.proposed_by ? { proposed_by: entity.proposed_by, proposed_at: entity.proposed_at } : {}),
    ...(input.derived_from && input.derived_from.length ? { derived_from: input.derived_from } : {}),
    links: [],
  });
  atomicWriteFile(join(dir, recordFilename(slug, id)), file);

  appendAudit({
    op: status === "draft" ? "PROPOSE" : "EXTRACT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    reason: `entity_${status === "draft" ? "proposed" : "created"}:${entity.type}`,
  });

  return entity;
}

// v2.7+ acceptance lifecycle — approve a draft entity.
export function approveEntity(
  vaultRoot: string,
  entityId: string,
  owner: string,
  actor: string,
  reason?: string,
): Entity | null {
  const path = entityPath(vaultRoot, owner, entityId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  if (fm.status === "approved") return fm as Entity;
  fm.status = "approved";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  if (reason) fm.review_reason = reason;
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "APPROVE",
    actor,
    owner,
    record_ids: [entityId],
    reason,
  });
  return fm as Entity;
}

// v2.7+ acceptance lifecycle — reject a draft entity.
export function rejectEntity(
  vaultRoot: string,
  entityId: string,
  owner: string,
  actor: string,
  reason: string,
): Entity | null {
  const path = entityPath(vaultRoot, owner, entityId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  if (fm.status === "rejected") return fm as Entity;
  fm.status = "rejected";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  fm.review_reason = reason;
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "REJECT",
    actor,
    owner,
    record_ids: [entityId],
    reason,
  });
  return fm as Entity;
}

// v2.9.0+ entity evidence check (P0-C from second external review).
// Mirror of layer2-semantic's evidenceCheck but for entities — verify
// that the entity name or one of its aliases actually appears in the
// cited source episode body. Also rejects fragment-shaped names that
// the LLM extractor sometimes proposes despite the prompt rules:
//   - pure numbers ("42", "100,000")
//   - pure currency amounts ("CHF 22", "$1.5M", "EUR 299")
//   - pure dates ("2026-05-15", "April 15")
//   - single-character or empty names
//   - names that look like punctuation/symbols
// Override path: callers can pass `force: true` to approveEntity to bypass
// (with mandatory reason).
const PURE_NUMERIC = /^[\d.,\s]+$/;
const PURE_CURRENCY = /^(CHF|EUR|USD|GBP|JPY|CNY|\$|€|£|¥)\s*[\d.,]+[KMB]?\/?(month|year|day|hour|deal|tx|user|seat|node|api|month|yr|y|m)?$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.+-]+)?$/;
const MONTH_DAY = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(,\s*\d{4})?$/i;
const PUNCT_ONLY = /^[^a-zA-Z0-9]+$/;

export function entityNameLooksLikeFragment(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;
  if (PUNCT_ONLY.test(trimmed)) return true;
  if (PURE_NUMERIC.test(trimmed)) return true;
  if (PURE_CURRENCY.test(trimmed)) return true;
  if (ISO_DATE.test(trimmed)) return true;
  if (MONTH_DAY.test(trimmed)) return true;
  return false;
}

export interface EntityEvidenceResult {
  ok: boolean;
  missing?: string[];  // reasons it failed: "fragment_name" | "name_not_in_source" | "no_alias_in_source"
}

export function entityEvidenceCheck(
  entityName: string,
  aliases: string[],
  episodeBody: string,
): EntityEvidenceResult {
  const missing: string[] = [];
  if (entityNameLooksLikeFragment(entityName)) missing.push("fragment_name");
  const haystack = episodeBody.toLowerCase();
  const candidates = [entityName, ...aliases].filter(Boolean).map(s => s.toLowerCase());
  const anyMatch = candidates.some(c => c.length >= 2 && haystack.includes(c));
  if (!anyMatch) missing.push("name_not_in_source");
  return missing.length ? { ok: false, missing } : { ok: true };
}

// v2.9.0+ entity resolution (NEW — closes the Zep "entity resolution" gap).
// Find existing entities that LIKELY refer to the same real-world referent
// as the candidate name + aliases. Uses three signals:
//   1. Case-insensitive name OR alias exact match
//   2. Substring containment (e.g. "machtsinn" ⊂ "machtsinn AG")
//   3. Levenshtein distance ≤ 2 on tokens of length ≥ 4 (typo tolerance)
// Returns ranked candidates with a fused score in [0,1]. Callers decide
// whether to merge (mergeEntities API) or surface the suggestion for
// human review.
export interface EntityResolutionCandidate {
  entity_id: string;
  name: string;
  aliases: string[];
  type: string;
  score: number;          // 0..1; >=0.9 = strong match
  match_reason: string;   // human-readable why it matched
}

function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
    }
    prev = curr;
  }
  return prev[b.length];
}

export function resolveEntity(
  vaultRoot: string,
  owner: string,
  candidate: { name: string; aliases?: string[]; type?: string },
  options: { includeDrafts?: boolean; maxLevenshtein?: number } = {},
): EntityResolutionCandidate[] {
  const dir = join(vaultRoot, "v2-entities", owner);
  if (!existsSync(dir)) return [];
  const maxLev = options.maxLevenshtein ?? 2;
  const queryTerms = new Set<string>();
  queryTerms.add(candidate.name.toLowerCase().trim());
  for (const a of candidate.aliases ?? []) queryTerms.add(a.toLowerCase().trim());

  const out: EntityResolutionCandidate[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const e = parsed.data as Entity;
      const status = e.status ?? "approved";
      if (status === "rejected") continue;
      if (status === "draft" && !options.includeDrafts) continue;
      if (candidate.type && e.type && candidate.type !== e.type) continue;
      const existingTerms = new Set<string>();
      existingTerms.add(e.name.toLowerCase());
      for (const a of e.aliases ?? []) existingTerms.add(String(a).toLowerCase());

      let best = { score: 0, reason: "" };
      for (const q of queryTerms) {
        for (const x of existingTerms) {
          if (q === x) {
            if (1 > best.score) best = { score: 1, reason: `exact match: "${q}"` };
          } else if (q.length >= 3 && x.length >= 3) {
            if (q.includes(x) || x.includes(q)) {
              const s = Math.min(q.length, x.length) / Math.max(q.length, x.length);
              if (s > best.score) best = { score: 0.7 + 0.2 * s, reason: `substring: "${q}" ~ "${x}"` };
            } else if (q.length >= 4 && x.length >= 4) {
              const d = lev(q, x);
              if (d <= maxLev) {
                const s = 1 - d / Math.max(q.length, x.length);
                if (s > best.score) best = { score: 0.5 + 0.4 * s, reason: `edit-distance ${d}: "${q}" ~ "${x}"` };
              }
            }
          }
        }
      }
      if (best.score >= 0.5) {
        out.push({
          entity_id: e.id,
          name: e.name,
          aliases: e.aliases ?? [],
          type: e.type,
          score: best.score,
          match_reason: best.reason,
        });
      }
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => b.score - a.score);
}

// v2.7+ list all drafts for an owner (used by review CLI + endpoints).
export function listDraftEntities(vaultRoot: string, owner: string): Entity[] {
  const dir = join(vaultRoot, "v2-entities", owner);
  if (!existsSync(dir)) return [];
  const out: Entity[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      if (parsed.data.status === "draft") out.push(parsed.data as Entity);
    } catch { /* skip malformed */ }
  }
  return out;
}

export function pathForEntity(vaultRoot: string, owner: string, id: string): string | null {
  return entityPath(vaultRoot, owner, id);
}
function entityPath(vaultRoot: string, owner: string, id: string): string | null {
  const dir = join(vaultRoot, "v2-entities", owner);
  if (!existsSync(dir)) return null;
  const legacy = join(dir, `${id}.md`);
  if (existsSync(legacy)) return legacy;
  for (const f of readdirSync(dir)) {
    if (idFromFilename(f) === id) return join(dir, f);
  }
  return null;
}

export function readEntity(vaultRoot: string, owner: string, id: string): Entity | null {
  const path = entityPath(vaultRoot, owner, id);
  if (!path) return null;
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

// v2.7+: by default excludes drafts and rejected entities. Set
// includeDrafts=true to include drafts (review tools), or pass status
// filter to scope.
export function listEntities(
  vaultRoot: string,
  owner: string,
  type?: string,
  includeDrafts = false,
): Entity[] {
  const dir = join(vaultRoot, "v2-entities", owner);
  if (!existsSync(dir)) return [];
  const out: Entity[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const e = parsed.data as Entity;
      // Acceptance lifecycle filter. Missing status = approved (back-compat).
      const status = e.status ?? "approved";
      if (status === "rejected") continue;
      if (status === "draft" && !includeDrafts) continue;
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
  const keeperPath = entityPath(vaultRoot, owner, keeperId);
  if (!keeperPath) return null;
  const keeperFile = matter.stringify(
    `# ${updated.name}\n\nType: ${updated.type}\nAliases: ${updated.aliases.join(", ")}`,
    updated,
  );
  atomicWriteFile(keeperPath, keeperFile);

  // Replace merged entity file with a redirect stub
  const mergedPath = entityPath(vaultRoot, owner, mergedId);
  if (!mergedPath) return null;
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
  atomicWriteFile(mergedPath, stub);

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
  const path = entityPath(vaultRoot, owner, id);
  if (!path) return;
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  if (parsed.data.owner !== owner) return;        // owner check
  parsed.data.last_seen = new Date().toISOString();
  for (const k of Object.keys(parsed.data)) {
    if (parsed.data[k] === undefined) delete parsed.data[k];
  }
  atomicWriteFile(path, matter.stringify(parsed.content.trim(), parsed.data));
}
