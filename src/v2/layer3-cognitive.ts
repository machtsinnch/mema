// Layer 3: Cognitive — experiences, observations, beliefs the agent holds.
// Inspired by Hindsight's epistemic separation. Records here are derived from
// L1 episodes and/or L2 facts via *reflection* (which can be triggered manually
// or scheduled, never on every write).
//
// v2.0: caller-driven reflection. Pass derived_from IDs and a content summary.
// v2.1: spawn a reflection agent that synthesizes cognitive records from new
//       episodes nightly.

import { ulid } from "ulid";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { atomicWriteFile } from "./atomic";
import { join } from "node:path";
import matter from "gray-matter";
import type { CognitiveRecord, CognitiveKind } from "./types";
import { clampConfidence, toWikilinks, slugify, recordFilename, idFromFilename } from "./types";

// Resolve a cognitive record's on-disk path by ULID, regardless of kind
// (belief/observation/experience) and regardless of slug schema. Returns
// null when not found.
export function pathForCognitive(vaultRoot: string, owner: string, id: string): string | null {
  for (const kind of ["belief", "observation", "experience"]) {
    const kindDir = join(vaultRoot, "cognitive", owner, kind);
    if (!existsSync(kindDir)) continue;
    const legacy = join(kindDir, `${id}.md`);
    if (existsSync(legacy)) return legacy;
    for (const f of readdirSync(kindDir)) {
      if (idFromFilename(f) === id) return join(kindDir, f);
    }
  }
  return null;
}
import { appendAudit } from "./layer6-audit";

export interface RecordCognitiveInput {
  kind: CognitiveKind;
  content: string;
  confidence: number;
  derived_from: string[];      // episode or fact IDs
  actor: string;
  owner: string;
}

export function recordCognitive(vaultRoot: string, input: RecordCognitiveInput): CognitiveRecord {
  const id = ulid();
  const record: CognitiveRecord = {
    id,
    kind: input.kind,
    content: input.content,
    confidence: clampConfidence(input.confidence),
    derived_from: input.derived_from,
    reflected_at: new Date().toISOString(),
    superseded_by: null,
    owner: input.owner,
  };

  const dir = join(vaultRoot, "cognitive", input.owner, input.kind);
  mkdirSync(dir, { recursive: true });
  const body = record.content;
  // Obsidian graph: wikilinks for derived_from chain + supersession edge.
  const links = toWikilinks([
    ...record.derived_from,
    ...(record.superseded_by ? [record.superseded_by] : []),
  ]);
  // Readable filename: `{kind}-{first-words}--{ulid}.md`
  const contentSlug = record.content.trim().split(/\s+/).slice(0, 8).join(" ");
  const slug = slugify(`${record.kind}-${contentSlug}`, record.kind);
  const file = matter.stringify(body, {
    id: record.id,
    slug,
    kind: record.kind,
    confidence: record.confidence,
    derived_from: record.derived_from,
    reflected_at: record.reflected_at,
    superseded_by: record.superseded_by,
    owner: record.owner,
    links,
  });
  atomicWriteFile(join(dir, recordFilename(slug, id)), file);

  appendAudit({
    op: "REFLECT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    evidence_chain: input.derived_from,
  });

  return record;
}

// Append IDs to an existing cognitive record's derived_from chain (dedup'd)
// and rebuild its links frontmatter. Used by the PAI migration to add
// cross-memory references after every record exists. Owner-scoped: caller's
// owner must match the record's owner.
export function addDerivedFrom(
  vaultRoot: string,
  owner: string,
  id: string,
  newIds: string[],
  actor: string,
): CognitiveRecord | null {
  const path = pathForCognitive(vaultRoot, owner, id);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  if (parsed.data.owner !== owner) return null;
  const existing = (parsed.data.derived_from ?? []) as string[];
  const merged = [...new Set([...existing, ...newIds])];
  if (merged.length === existing.length) {
    // Nothing new — idempotent no-op
    return parsed.data as CognitiveRecord;
  }
  parsed.data.derived_from = merged;
  parsed.data.links = toWikilinks([
    ...merged,
    ...(parsed.data.superseded_by ? [parsed.data.superseded_by as string] : []),
  ]);
  for (const k of Object.keys(parsed.data)) {
    if (parsed.data[k] === undefined) delete parsed.data[k];
  }
  atomicWriteFile(path, matter.stringify(parsed.content.trim(), parsed.data));
  appendAudit({
    op: "REFLECT",
    actor,
    owner,
    record_ids: [id],
    evidence_chain: newIds,
    reason: "add_derived_from",
  });
  return parsed.data as CognitiveRecord;
}

// Soft-supersede an older belief with a newer one. The old record stays in the
// vault (audit trail), just points to its successor and stops being authoritative.
export function supersedeBelief(
  vaultRoot: string,
  oldId: string,
  newId: string,
  owner: string,
  actor: string,
): CognitiveRecord | null {
  for (const kind of ["belief", "observation", "experience"] as const) {
    const kindDir = join(vaultRoot, "cognitive", owner, kind);
    if (!existsSync(kindDir)) continue;
    let path: string | null = null;
    const legacy = join(kindDir, `${oldId}.md`);
    if (existsSync(legacy)) path = legacy;
    else {
      for (const f of readdirSync(kindDir)) {
        if (idFromFilename(f) === oldId) { path = join(kindDir, f); break; }
      }
    }
    if (!path) continue;
    const parsed = matter(readFileSync(path, "utf8"));
    parsed.data.superseded_by = newId;
    // Rebuild Obsidian links to include the new supersession edge.
    parsed.data.links = toWikilinks([
      ...((parsed.data.derived_from ?? []) as string[]),
      newId,
    ]);
    atomicWriteFile(path, matter.stringify(parsed.content, parsed.data));
    appendAudit({
      op: "REFLECT",
      actor,
      owner,
      record_ids: [oldId, newId],
      reason: "superseded",
    });
    return parsed.data as CognitiveRecord;
  }
  return null;
}
