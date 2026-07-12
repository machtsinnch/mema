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
import type { CognitiveRecord, CognitiveKind, BeliefKind } from "./types";
import { clampConfidence, toWikilinks, slugify, recordFilename, idFromFilename, isWikilinkSafeId } from "./types";

// Resolve a cognitive record's on-disk path by ULID, regardless of kind
// (belief/observation/experience/judgment) and regardless of slug schema.
// Returns null when not found.
export function pathForCognitive(vaultRoot: string, owner: string, id: string): string | null {
  // v2.22.0 SECURITY (round-2 finding): see factPath — reject traversal ids.
  if (!isWikilinkSafeId(id)) return null;
  for (const kind of ["belief", "observation", "experience", "judgment"]) {
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
  // v2.9.0+ acceptance lifecycle (NEW; mirrors fact/entity lifecycle).
  // LLM-driven reflection writes drafts; rule-based reflection writes
  // approved records (back-compat). Missing status = approved.
  status?: "draft" | "approved" | "rejected";
  evidence_excerpt?: string;
  proposed_by?: string;
  // v2.17.0 — stable conclusion identity (for idempotent reflection) and
  // the belief subject's entity link, mirroring what facts carry.
  claim_key?: string;
  subject_entity_id?: string | null;
  // v2.18.0 — Ardin's knowledge label (personal/opinion/judgment).
  belief_kind?: BeliefKind;
}

export function recordCognitive(vaultRoot: string, input: RecordCognitiveInput): CognitiveRecord {
  const id = ulid();
  const now = new Date().toISOString();
  const status = input.status ?? "approved";
  const record: CognitiveRecord = {
    id,
    kind: input.kind,
    content: input.content,
    confidence: clampConfidence(input.confidence),
    derived_from: input.derived_from,
    reflected_at: now,
    superseded_by: null,
    owner: input.owner,
    ...(input.claim_key ? { claim_key: input.claim_key } : {}),
    ...(input.subject_entity_id ? { subject_entity_id: input.subject_entity_id } : {}),
    ...(input.belief_kind ? { belief_kind: input.belief_kind } : {}),
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
    status,
    ...(input.claim_key ? { claim_key: input.claim_key } : {}),
    ...(input.subject_entity_id ? { subject_entity_id: input.subject_entity_id } : {}),
    ...(input.belief_kind ? { belief_kind: input.belief_kind } : {}),
    ...(input.evidence_excerpt ? { evidence_excerpt: input.evidence_excerpt.slice(0, 500) } : {}),
    ...(input.proposed_by ? { proposed_by: input.proposed_by, proposed_at: now } : {}),
    links,
  });
  atomicWriteFile(join(dir, recordFilename(slug, id)), file);

  appendAudit({
    op: status === "draft" ? "PROPOSE" : "REFLECT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    evidence_chain: input.derived_from,
    ...(input.proposed_by ? { reason: `proposed_by:${input.proposed_by}` } : {}),
  });

  return record;
}

// v2.10.0+ acceptance lifecycle on cognitive records — parity with
// fact and entity approve/reject. LLM-driven reflectLLM() writes drafts;
// these functions promote or reject them, with the same fail-closed
// evidence-gate semantics (enforced at the API layer).
export function approveCognitive(
  vaultRoot: string,
  cognitiveId: string,
  owner: string,
  actor: string,
  reason?: string,
): CognitiveRecord | null {
  const path = pathForCognitive(vaultRoot, owner, cognitiveId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  if (fm.status === "approved") return fm as CognitiveRecord;
  fm.status = "approved";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  if (reason) fm.review_reason = reason;
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "APPROVE",
    actor,
    owner,
    record_ids: [cognitiveId],
    evidence_chain: (fm.derived_from ?? []) as string[],
    reason,
  });
  return fm as CognitiveRecord;
}

export function rejectCognitive(
  vaultRoot: string,
  cognitiveId: string,
  owner: string,
  actor: string,
  reason: string,
): CognitiveRecord | null {
  const path = pathForCognitive(vaultRoot, owner, cognitiveId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  if (fm.status === "rejected") return fm as CognitiveRecord;
  fm.status = "rejected";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  fm.review_reason = reason;
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "REJECT",
    actor,
    owner,
    record_ids: [cognitiveId],
    evidence_chain: (fm.derived_from ?? []) as string[],
    reason,
  });
  return fm as CognitiveRecord;
}

// List all draft cognitive records across all three kinds (belief,
// observation, experience).
export function listDraftCognitive(vaultRoot: string, owner: string): CognitiveRecord[] {
  const out: CognitiveRecord[] = [];
  for (const kind of ["belief", "observation", "experience"]) {
    const dir = join(vaultRoot, "cognitive", owner, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const parsed = matter(readFileSync(join(dir, f), "utf8"));
        if ((parsed.data as any).status === "draft") out.push(parsed.data as CognitiveRecord);
      } catch { /* skip malformed */ }
    }
  }
  return out;
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

// ── v2.17.0 — idempotent reflection support ──────────────────────────

// Find a cognitive record by its stable claim_key (scans the owner's
// cognitive dirs). Returns the newest non-superseded match, or null.
export function findCognitiveByClaimKey(
  vaultRoot: string,
  owner: string,
  claimKey: string,
): CognitiveRecord | null {
  const base = join(vaultRoot, "cognitive", owner);
  if (!existsSync(base)) return null;
  let best: CognitiveRecord | null = null;
  for (const kind of readdirSync(base)) {
    const dir = join(base, kind);
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      try {
        const parsed = matter(readFileSync(join(dir, f), "utf8"));
        // content lives in the BODY, not the frontmatter — attach it so
        // callers can compare conclusions textually.
        const r = { ...(parsed.data as CognitiveRecord), content: parsed.content.trim() };
        if (r.claim_key !== claimKey) continue;
        if (r.superseded_by) continue;
        if (!best || r.reflected_at > best.reflected_at) best = r;
      } catch { /* skip malformed */ }
    }
  }
  return best;
}

// Update an existing conclusion in place (same id, same file identity):
// refresh content, confidence, support and reflected_at. Used when
// reflection re-runs and the underlying evidence changed. Audit-logged.
export function updateCognitiveSupport(
  vaultRoot: string,
  owner: string,
  id: string,
  updates: { content: string; confidence: number; derived_from: string[]; belief_kind?: BeliefKind },
  actor: string,
): CognitiveRecord | null {
  const path = pathForCognitive(vaultRoot, owner, id);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  if (fm.owner !== owner) return null;
  fm.confidence = clampConfidence(updates.confidence);
  fm.derived_from = [...new Set(updates.derived_from)];
  // v2.18.0 — also backfills the knowledge label onto pre-label records.
  if (updates.belief_kind) fm.belief_kind = updates.belief_kind;
  fm.reflected_at = new Date().toISOString();
  fm.links = toWikilinks([
    ...(fm.derived_from as string[]),
    ...(fm.superseded_by ? [String(fm.superseded_by)] : []),
  ]);
  atomicWriteFile(path, matter.stringify(updates.content, fm));
  appendAudit({
    op: "REFLECT",
    actor,
    owner,
    record_ids: [id],
    evidence_chain: fm.derived_from as string[],
    reason: "reflection_update",
  });
  return { ...(fm as unknown as CognitiveRecord), content: updates.content };
}
