// Layer 2: Temporal Semantic — facts extracted from episodes with bi-temporal validity.
// Inspired by Zep/Graphiti's bi-temporal model. Facts have:
//   valid_from / valid_to  : when the fact is/was true in the world
//   invalidated_at         : when WE learned the fact was wrong (epistemic)
//   superseded_by          : newer fact that replaces this one
//
// v2.0 is caller-supplied (no auto-extraction). v2.1 will add LLM extraction in
// a SEPARATE ingestion pipeline (NOT on every write — principle preserved).

import { ulid } from "ulid";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { atomicWriteFile } from "./atomic";
import { join } from "node:path";
import matter from "gray-matter";
import type { SemanticFact, RecordStatus } from "./types";
import { clampConfidence, toWikilinks, slugify, recordFilename, idFromFilename, isWikilinkSafeId } from "./types";
import { appendAudit } from "./layer6-audit";
import { factValidAt } from "./temporal";
import { classifyOnWrite, type SupersessionDecision } from "./layer4-supersession";
import { canonicalPredicate } from "./predicates";
import { readEntity, findEntityByName } from "./layer2-entities";

export interface RecordFactInput {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;         // defaults to now
  valid_to?: string | null;
  derived_from: string[];      // episode IDs
  confidence?: number;
  actor: string;
  owner: string;
  // v2.15.1 — fact↔entity links, resolved by the caller (observe path uses
  // exact name/alias match against the owner's entity records).
  subject_entity_id?: string | null;
  object_entity_id?: string | null;
  // v2.7+ acceptance lifecycle. Omitting status defaults to "approved" so
  // existing direct-API callers keep their current semantics. LLM extractors
  // and other untrusted producers should pass "draft" + evidence_excerpt.
  status?: RecordStatus;
  evidence_excerpt?: string;
  proposed_by?: string;
}

export function recordFact(vaultRoot: string, input: RecordFactInput): SemanticFact {
  const id = ulid();
  const now = new Date().toISOString();
  const status: RecordStatus = input.status ?? "approved";
  const fact: SemanticFact = {
    id,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    valid_from: input.valid_from ?? now,
    valid_to: input.valid_to ?? null,
    invalidated_at: null,
    superseded_by: null,
    derived_from: input.derived_from,
    confidence: clampConfidence(input.confidence ?? 0.8),
    owner: input.owner,
    status,
    ...(input.subject_entity_id ? { subject_entity_id: input.subject_entity_id } : {}),
    ...(input.object_entity_id ? { object_entity_id: input.object_entity_id } : {}),
    ...(input.evidence_excerpt ? { evidence_excerpt: input.evidence_excerpt.slice(0, 500) } : {}),
    ...(input.proposed_by ? { proposed_by: input.proposed_by, proposed_at: now } : {}),
  };

  const dir = join(vaultRoot, "facts", input.owner);
  mkdirSync(dir, { recursive: true });
  const body = `# ${fact.subject} ${fact.predicate} ${fact.object}\n\nFact derived from ${fact.derived_from.length} episode(s).`;
  // Obsidian graph: wikilinks for every supporting episode + supersession edge
  // + (v2.15.1) the subject/object entity records, so facts and entities are
  // connected in the graph view instead of floating as separate islands.
  // toWikilinks validates and dedupes — caller errors (dup IDs in derived_from)
  // don't propagate to disk.
  const links = toWikilinks([
    ...fact.derived_from,
    ...(fact.superseded_by ? [fact.superseded_by] : []),
    ...(fact.subject_entity_id ? [fact.subject_entity_id] : []),
    ...(fact.object_entity_id ? [fact.object_entity_id] : []),
  ]);
  // Readable filename: `{subject}-{predicate}-{object}--{ulid}.md`
  const slug = slugify(`${fact.subject}-${fact.predicate}-${fact.object}`, "fact");
  const file = matter.stringify(body, {
    id: fact.id,
    slug,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    valid_from: fact.valid_from,
    valid_to: fact.valid_to,
    invalidated_at: fact.invalidated_at,
    superseded_by: fact.superseded_by,
    derived_from: fact.derived_from,
    confidence: fact.confidence,
    owner: fact.owner,
    status: fact.status,
    ...(fact.subject_entity_id ? { subject_entity_id: fact.subject_entity_id } : {}),
    ...(fact.object_entity_id ? { object_entity_id: fact.object_entity_id } : {}),
    ...(fact.evidence_excerpt ? { evidence_excerpt: fact.evidence_excerpt } : {}),
    ...(fact.proposed_by ? { proposed_by: fact.proposed_by, proposed_at: fact.proposed_at } : {}),
    links,
  });
  atomicWriteFile(join(dir, recordFilename(slug, id)), file);

  // Audit op: PROPOSE for drafts (untrusted), EXTRACT for approved (direct writes).
  appendAudit({
    op: status === "draft" ? "PROPOSE" : "EXTRACT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    evidence_chain: input.derived_from,
    ...(input.proposed_by ? { reason: `proposed_by:${input.proposed_by}` } : {}),
  });

  return fact;
}

// v2.7+ acceptance lifecycle — approve a draft fact, promoting it to
// "approved" so it surfaces in retrieval. The actor and reason are
// recorded both on the record and in the audit chain.
export function approveFact(
  vaultRoot: string,
  factId: string,
  owner: string,
  actor: string,
  reason?: string,
): { fact: SemanticFact | null; supersededIds: string[] } {
  const path = factPath(vaultRoot, owner, factId);
  if (!path) return { fact: null, supersededIds: [] };
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return { fact: null, supersededIds: [] };
  // Idempotent: re-approving an approved record is a no-op + no audit churn.
  if (fm.status === "approved") return { fact: fm as SemanticFact, supersededIds: [] };
  fm.status = "approved";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  if (reason) fm.review_reason = reason;
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "APPROVE",
    actor,
    owner,
    record_ids: [factId],
    evidence_chain: (fm.derived_from ?? []) as string[],
    reason,
  });
  // v2.21.0 — approval IS the write into approved space: run the
  // supersession check that was deliberately deferred while this fact was
  // a draft (drafts never supersede — see recordFactWithSupersession).
  // v2.21.1 — breaker findings: use the SAME candidate gathering as the
  // direct write path (synonym predicates + entity aliases were escaping),
  // merge provenance on duplicate (the approved fact stays — never
  // silently skipped — but the survivor still learns the new sources),
  // and report what was superseded instead of doing it silently.
  const supersededIds: string[] = [];
  try {
    const probe = {
      subject: String(fm.subject ?? ""),
      predicate: String(fm.predicate ?? ""),
      object: String(fm.object ?? ""),
      subject_entity_id: (fm.subject_entity_id as string | undefined) ?? null,
    };
    const fullCandidates = gatherSupersessionCandidates(vaultRoot, owner, probe, factId);
    const subjType = fm.subject_entity_id
      ? (readEntity(vaultRoot, owner, String(fm.subject_entity_id))?.type ?? null)
      : null;
    const decision = classifyOnWrite(
      {
        subject: probe.subject,
        predicate: probe.predicate,
        object: probe.object,
        event_date: String(fm.valid_from ?? new Date().toISOString()),
      },
      fullCandidates,
      subjType,
    );
    if (decision.kind === "UPDATE") {
      for (const old of decision.superseded) {
        if (invalidateFact(vaultRoot, old.id, owner, actor, factId)) supersededIds.push(old.id);
      }
    } else if (decision.kind === "NONE") {
      const normObj = probe.object.trim().toLowerCase();
      const dPrefix = String(fm.valid_from ?? "").slice(0, 10);
      const mergedInto: string[] = [];
      for (const c of fullCandidates) {
        if (c.object?.trim().toLowerCase() !== normObj) continue;
        const cPrefix = (c.valid_from ?? "").slice(0, 10);
        if (decision.reason === "duplicate" && cPrefix !== dPrefix) continue;
        if (decision.reason === "stale" && cPrefix < dPrefix) continue;
        if (mergeFactProvenance(vaultRoot, owner, c.id, (fm.derived_from as string[]) ?? [])) {
          mergedInto.push(c.id);
        }
      }
      // v2.22.1 (round-2 finding): the direct write path audits its
      // duplicate-merge; the approval path must too (no silent record
      // mutation in a hash-chained-audit product).
      if (mergedInto.length > 0) {
        appendAudit({
          op: "EXTRACT", actor, owner, record_ids: mergedInto,
          evidence_chain: (fm.derived_from as string[]) ?? [],
          reason: `provenance_merge_on_approve:${factId}`,
        });
      }
    }
  } catch (e) {
    console.warn(`[approve-supersession] ${factId}: ${e}`);
  }
  return { fact: readFact(vaultRoot, owner, factId), supersededIds };
}

// v2.7+ acceptance lifecycle — reject a draft fact. Sets status="rejected"
// and records the reviewer + reason. Rejected records remain on disk for
// audit, but retrieval excludes them.
export function rejectFact(
  vaultRoot: string,
  factId: string,
  owner: string,
  actor: string,
  reason: string,
): SemanticFact | null {
  const path = factPath(vaultRoot, owner, factId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  if (fm.status === "rejected") return fm as SemanticFact;
  fm.status = "rejected";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  fm.review_reason = reason;
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "REJECT",
    actor,
    owner,
    record_ids: [factId],
    evidence_chain: (fm.derived_from ?? []) as string[],
    reason,
  });
  return fm as SemanticFact;
}

// Mark a fact as invalidated (we now know it was wrong, or it's no longer true).
// Optionally point to the fact that supersedes it.
// Find a fact file path by ULID; tolerates legacy ULID-only filenames AND
// the new slug--ulid filenames. Exported so tests + asset/erase callers
// can find the file without knowing the naming schema.
export function pathForFact(vaultRoot: string, owner: string, id: string): string | null {
  return factPath(vaultRoot, owner, id);
}
function factPath(vaultRoot: string, owner: string, id: string): string | null {
  // v2.22.0 SECURITY (round-2 finding): reject ids that aren't a plain
  // record id — a "../<owner>/<file>" id would escape into another owner's
  // directory via the legacy join below. Legitimate ids are always
  // wikilink-safe (no slashes, no "..").
  if (!isWikilinkSafeId(id)) return null;
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return null;
  const legacy = join(dir, `${id}.md`);
  if (existsSync(legacy)) return legacy;
  for (const f of readdirSync(dir)) {
    if (idFromFilename(f) === id) return join(dir, f);
  }
  return null;
}

export function invalidateFact(
  vaultRoot: string,
  factId: string,
  owner: string,
  actor: string,
  supersededBy?: string,
): SemanticFact | null {
  const path = factPath(vaultRoot, owner, factId);
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  // v2.21.1 — breaker finding: idempotent, first-wins. Re-invalidating
  // (the approve-supersedes route did it twice) must not re-stamp the
  // epistemic timestamp, double-audit, or overwrite the original
  // superseded_by pointer.
  if (parsed.data.invalidated_at) return readFact(vaultRoot, owner, factId);
  parsed.data.invalidated_at = new Date().toISOString();
  if (supersededBy) parsed.data.superseded_by = supersededBy;
  // Rebuild Obsidian links to include the new supersession edge.
  // v2.21.0 — general-review fix: keep the ENTITY edges too; the old
  // rebuild dropped subject/object entity links, silently disconnecting
  // every superseded fact from its entities in the graph.
  parsed.data.links = toWikilinks([
    ...((parsed.data.derived_from ?? []) as string[]),
    ...(parsed.data.superseded_by ? [parsed.data.superseded_by] : []),
    ...(parsed.data.subject_entity_id ? [parsed.data.subject_entity_id] : []),
    ...(parsed.data.object_entity_id ? [parsed.data.object_entity_id] : []),
  ]);
  atomicWriteFile(path, matter.stringify(parsed.content, parsed.data));
  appendAudit({
    op: "INVALIDATE",
    actor,
    owner,
    record_ids: [factId],
    evidence_chain: supersededBy ? [supersededBy] : undefined,
  });
  return readFact(vaultRoot, owner, factId);
}

export function readFact(vaultRoot: string, owner: string, id: string): SemanticFact | null {
  const path = factPath(vaultRoot, owner, id);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  return parsed.data as SemanticFact;
}

// Get all facts for an owner that were valid at a given point in time.
// Skips facts invalidated before `at`, or whose valid_to is before `at`.
// v2.7+: skips drafts and rejected records unless includeDrafts is true.
// v2.21.0 — merge additional source-episode IDs into an existing fact's
// derived_from (duplicate-skip provenance; see recordFactWithSupersession).
// Returns true when the file changed.
export function mergeFactProvenance(
  vaultRoot: string,
  owner: string,
  factId: string,
  episodeIds: string[],
): boolean {
  if (!episodeIds.length) return false;
  const path = pathForFact(vaultRoot, owner, factId);
  if (!path) return false;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  if (fm.owner !== owner) return false;
  const before = (fm.derived_from as string[]) ?? [];
  const merged = [...new Set([...before, ...episodeIds])];
  if (merged.length === before.length) return false;
  fm.derived_from = merged;
  fm.links = toWikilinks([
    ...merged,
    ...(fm.superseded_by ? [String(fm.superseded_by)] : []),
    ...(fm.subject_entity_id ? [String(fm.subject_entity_id)] : []),
    ...(fm.object_entity_id ? [String(fm.object_entity_id)] : []),
  ]);
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  return true;
}

// v2.18.0 — world claims stay in Layer 2 (Ardin's boundary rule,
// 2026-07-10). When reflection finds the same WORLD claim independently
// stated in several documents, it must NOT create a Layer 3 belief
// (internal repetition ≠ truth — the France rule). Instead the agreement
// is recorded HERE, on the facts themselves, as a corroboration
// annotation. The later fact-check pass adds the actual truth stamp.
// Idempotent: re-running reflection with the same count writes nothing.
export function annotateFactCorroboration(
  vaultRoot: string,
  owner: string,
  factId: string,
  sources: number,
  actor: string,
): boolean {
  const path = pathForFact(vaultRoot, owner, factId);
  if (!path) return false;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  if (fm.owner !== owner) return false;
  if (fm.corroboration_sources === sources) return false;
  fm.corroboration_sources = sources;
  fm.corroboration_updated_at = new Date().toISOString();
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "EXTRACT",
    actor,
    owner,
    record_ids: [factId],
    reason: `corroboration_annotate:${sources}_sources`,
  });
  return true;
}

// v2.18.1 — write the internet fact-check verdict onto a fact record.
// Companion to annotateFactCorroboration above; see layer2-factcheck.ts
// for how verdicts are produced. Skips the write when the stamp is
// identical (idempotent re-runs). Contradicted facts are demoted by
// retrieval (layer5), never deleted — the audit trail records the stamp.
export function annotateFactVerification(
  vaultRoot: string,
  owner: string,
  factId: string,
  check: { verdict: string; note: string; sources: string[] },
  actor: string,
): boolean {
  const path = pathForFact(vaultRoot, owner, factId);
  if (!path) return false;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  if (fm.owner !== owner) return false;
  if (
    fm.verification === check.verdict
    && fm.verification_note === check.note
    && JSON.stringify(fm.verification_sources ?? []) === JSON.stringify(check.sources)
  ) return false;
  fm.verification = check.verdict;
  fm.verification_note = check.note;
  fm.verification_sources = check.sources;
  fm.verification_checked_at = new Date().toISOString();
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "EXTRACT",
    actor,
    owner,
    record_ids: [factId],
    reason: `fact_check:${check.verdict}`,
  });
  return true;
}

export function getFactsValidAt(
  vaultRoot: string,
  owner: string,
  at: string,
  includeDrafts = false,
): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      // Acceptance lifecycle filter. Missing status = approved (back-compat).
      const status = fact.status ?? "approved";
      if (status === "rejected") continue;
      if (status === "draft" && !includeDrafts) continue;
      // v2.7.4+ epoch-ms temporal comparison (W8). Uses "lte" semantics for
      // invalidated_at: a fact invalidated AT the query timestamp is treated
      // as already-known-wrong by then — same as the prior string-compare.
      if (!factValidAt(fact, at, "lte")) continue;
      out.push(fact);
    } catch { /* skip malformed */ }
  }
  return out;
}

// v2.9.0+ contradiction detection (NEW — closes the Zep "contradiction
// handling" gap). A new fact contradicts an existing fact when they share
// the same (subject, predicate) but have different objects AND both are
// currently valid (status=approved, not invalidated, not superseded, and
// their valid_from/valid_to windows overlap).
//
// Returns an array of contradicting fact IDs. Callers (the LLM extractor,
// /v2/fact endpoint, review CLI) can then surface this to a reviewer and
// optionally auto-invalidate the older fact when the new one is approved.
export interface ContradictionCandidate {
  fact_id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string;
  confidence: number;
}

export function findContradictions(
  vaultRoot: string,
  owner: string,
  candidate: { subject: string; predicate: string; object: string },
): ContradictionCandidate[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: ContradictionCandidate[] = [];
  const subj = candidate.subject.trim().toLowerCase();
  const pred = candidate.predicate.trim().toLowerCase();
  const obj = candidate.object.trim().toLowerCase();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      if ((fact.status ?? "approved") !== "approved") continue;
      if (fact.invalidated_at) continue;
      if (fact.superseded_by) continue;
      // v2.21.0 — a fact that already ENDED (valid_to in the past) is
      // history, not a current claim; it cannot be contradicted.
      if (fact.valid_to && String(fact.valid_to) <= new Date().toISOString()) continue;
      if (fact.subject?.trim().toLowerCase() !== subj) continue;
      if (fact.predicate?.trim().toLowerCase() !== pred) continue;
      // Same (subject, predicate) — contradiction iff object differs.
      if (fact.object?.trim().toLowerCase() === obj) continue;
      out.push({
        fact_id: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        valid_from: fact.valid_from,
        confidence: fact.confidence,
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

// v2.7+ list all draft facts for an owner (used by review CLI + endpoints).
export function listDraftFacts(vaultRoot: string, owner: string): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      if (parsed.data.status === "draft") out.push(parsed.data as SemanticFact);
    } catch { /* skip malformed */ }
  }
  return out;
}

// v2.7+ evidence check: does the proposed fact's subject AND object actually
// appear (case-insensitive substring) in the source episode body? This is
// a structural guard against LLM hallucination. Subjects and objects can be
// multiword entities like "machtsinn AG" — substring match is the right shape.
// Returns {ok: true} when both terms appear; {ok: false, missing} otherwise.
export function evidenceCheck(
  subject: string,
  object: string,
  episodeBody: string,
): { ok: true } | { ok: false; missing: string[] } {
  const haystack = episodeBody.toLowerCase();
  const missing: string[] = [];
  const s = subject.trim().toLowerCase();
  const o = object.trim().toLowerCase();
  if (s && !haystack.includes(s)) missing.push("subject");
  if (o && !haystack.includes(o)) missing.push("object");
  return missing.length ? { ok: false, missing } : { ok: true };
}

// v2.14.0+ — write-time supersession wrapper.
//
// Per Ardin's architectural commitment (2026-05-17): every fact write MUST
// be supersession-checked. No opt-out flag. The deterministic system
// behavior is what differentiates mema from a stochastic LLM stack — and
// that determinism includes "the supersession state of the graph after
// any observe is a pure function of all observes that came before it."
//
// Returns a richer result than `recordFact`:
//   { written, decision, supersededIds }
//
// Behavior:
//   - decision.kind === "ADD"  → wrote new fact, supersededIds = []
//   - decision.kind === "NONE" → did NOT write, supersededIds = [];
//     `written` is null. The audit chain logs SKIP with the reason.
//   - decision.kind === "UPDATE" → wrote new fact, then invalidated each
//     superseded candidate with invalidated_at = new.valid_from and
//     superseded_by = new.id. supersededIds[] is the list of invalidated IDs.
//     Failures during the invalidation loop are logged but do NOT roll back
//     the new fact (date-based factValidAt at read time recovers correctness
//     because the newer valid_from naturally wins via factValidAt).
//
// Reference architecture: Graphiti's resolve_edge_contradictions() in
// graphiti_core/utils/maintenance/edge_operations.py (source-verified by
// Codex 2026-05-17). NOT Mem0's ADD/UPDATE/DELETE/NONE pattern (which
// Mem0 itself abandoned in their current main branch).
export interface RecordFactWithSupersessionResult {
  written: SemanticFact | null;
  decision: SupersessionDecision;
  supersededIds: string[];
}

// v2.21.1 — breaker finding: the approval path gathered candidates only
// via findContradictions (exact predicate, no entity link), so synonym-
// predicate and entity-alias drafts escaped supersession once approved.
// ONE gathering path now serves both the direct write and approveFact:
//   1. findContradictions (exact subject+predicate, different object);
//   2. canonical-predicate scan (employed_by ≡ works_at);
//   3. subject-entity scan (Marcel ≡ Marcel Schmidt);
// all filtered to approved, current (not invalidated/superseded) and not
// CLOSED (valid_to already passed — history can't be contradicted).
function gatherSupersessionCandidates(
  vaultRoot: string,
  owner: string,
  probe: { subject: string; predicate: string; object: string; subject_entity_id?: string | null },
  excludeId?: string,
): SemanticFact[] {
  // v2.22.1 (round-2 finding): CLOSED facts (valid_to passed) are NO LONGER
  // excluded here — a restatement of a fact whose validity window already
  // ended must still be caught as duplicate/stale (classifyOnWrite steps
  // 1-2). The functional gate (step 4, isClosed) still refuses to supersede
  // a closed fact, so this cannot wrongly invalidate history.
  const usable = (f: SemanticFact): boolean =>
    !f.invalidated_at && !f.superseded_by && f.id !== excludeId;
  const out: SemanticFact[] = [];
  const seen = new Set<string>();
  const push = (f: SemanticFact | null) => {
    if (f && usable(f) && !seen.has(f.id)) { seen.add(f.id); out.push(f); }
  };
  for (const c of findContradictions(vaultRoot, owner, probe)) {
    push(readFact(vaultRoot, owner, c.fact_id));
  }
  for (const f of readApprovedFactsByExactSubjectPredicate(vaultRoot, owner, probe.subject, probe.predicate)) {
    push(f);
  }
  // v2.22.1 (round-2 finding): bridge entity aliases so supersession works
  // even when only ONE side carries subject_entity_id (e.g. a fact ingested
  // before its entity existed, then a linked fact under a different alias).
  // Resolve the subject to a single entity — from the passed id or by name —
  // then scan by the entity id AND every alias surface string.
  const entity = probe.subject_entity_id
    ? readEntity(vaultRoot, owner, probe.subject_entity_id)
    : findEntityByName(vaultRoot, owner, probe.subject);
  if (entity) {
    for (const f of readApprovedFactsBySubjectEntity(vaultRoot, owner, entity.id, probe.predicate)) {
      push(f);
    }
    for (const alias of [entity.name, ...(entity.aliases ?? [])]) {
      if (alias.trim().toLowerCase() === probe.subject.trim().toLowerCase()) continue;
      for (const f of readApprovedFactsByExactSubjectPredicate(vaultRoot, owner, alias, probe.predicate)) {
        push(f);
      }
    }
  }
  return out;
}

export function recordFactWithSupersession(
  vaultRoot: string,
  input: RecordFactInput,
): RecordFactWithSupersessionResult {
  // v2.21.0 — CRITICAL general-review fix: drafts NEVER supersede. An
  // unreviewed fact must not invalidate approved knowledge (rejecting the
  // draft afterwards could not restore it — permanent corruption through
  // the very gate that promises fail-closed review). Drafts are written
  // as plain ADDs; the supersession decision is re-run at APPROVAL time
  // (approveFact), which is the actual write into approved space.
  if ((input.status ?? "approved") !== "approved") {
    const draft = recordFact(vaultRoot, input);
    return {
      written: draft,
      decision: { kind: "ADD", reason: "draft_supersession_deferred_to_approval" },
      supersededIds: [],
    };
  }
  const fullCandidates = gatherSupersessionCandidates(vaultRoot, input.owner, {
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    subject_entity_id: input.subject_entity_id ?? null,
  });

  // 2. Classify (pure function — fully testable).
  //
  // v2.17.1 — pass the subject's entity type when the fact is linked to a
  // resolved entity. Location predicates only replace for persons; a
  // company gaining a second location ("TSMC located_in Germany" next to
  // "...Taiwan") must ADD, not replace. Unlinked subjects stay unknown →
  // locations accumulate (safe default).
  const subjectEntityType = input.subject_entity_id
    ? (readEntity(vaultRoot, input.owner, input.subject_entity_id)?.type ?? null)
    : null;
  const decision = classifyOnWrite(
    {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      event_date: input.valid_from ?? new Date().toISOString(),
    },
    fullCandidates,
    subjectEntityType,
  );

  // 3. Branch on decision.
  if (decision.kind === "NONE") {
    // v2.21.0 — general-review fix: a skipped duplicate still carries
    // PROVENANCE. A second document independently stating the same fact
    // is exactly what corroboration counts — merge its episode IDs into
    // the surviving fact so Rule A and the auto fact-check can see every
    // source (they were structurally blind to same-wording duplicates).
    const survivorIds: string[] = [];
    const normObjForMerge = input.object.trim().toLowerCase();
    // v2.21.1 — breaker finding: merge ONLY into the candidate(s) whose
    // dates justified the skip, not every same-object fact ever recorded.
    const newDatePrefix = (input.valid_from ?? new Date().toISOString()).slice(0, 10);
    for (const c of fullCandidates) {
      if (c.object?.trim().toLowerCase() !== normObjForMerge) continue;
      const cPrefix = (c.valid_from ?? "").slice(0, 10);
      if (decision.reason === "duplicate" && cPrefix !== newDatePrefix) continue;
      if (decision.reason === "stale" && cPrefix < newDatePrefix) continue;
      if (mergeFactProvenance(vaultRoot, input.owner, c.id, input.derived_from ?? [])) {
        survivorIds.push(c.id);
      }
    }
    appendAudit({
      op: "EXTRACT",  // re-use existing op; reason carries the skip context
      actor: input.actor,
      owner: input.owner,
      record_ids: survivorIds,
      evidence_chain: input.derived_from,
      reason: `supersession_skip:${decision.reason}`,
    });
    return { written: null, decision, supersededIds: [] };
  }

  // ADD or UPDATE: persist the new fact first.
  const newFact = recordFact(vaultRoot, input);

  if (decision.kind === "ADD") {
    return { written: newFact, decision, supersededIds: [] };
  }

  // UPDATE: invalidate each superseded candidate. Best-effort — failures
  // logged, do NOT roll back the new fact. The date-based factValidAt at
  // read time recovers correctness because the newer valid_from wins.
  const supersededIds: string[] = [];
  for (const old of decision.superseded) {
    try {
      const result = invalidateFact(
        vaultRoot,
        old.id,
        input.owner,
        input.actor,
        newFact.id,
      );
      if (result) supersededIds.push(old.id);
    } catch (e) {
      console.warn(
        `[supersession] failed to mark ${old.id} as superseded by ${newFact.id}: ${e}`,
      );
    }
  }
  return { written: newFact, decision, supersededIds };
}

/** Internal helper: load all approved facts (regardless of validity status)
 *  with exact (subject, predicate, owner) match. Used by
 *  recordFactWithSupersession to detect duplicates that findContradictions
 *  filters out (because findContradictions looks for DIFFERENT objects). */
// v2.15.1 — same scan, keyed on the resolved subject entity instead of the
// surface string. Lets supersession see through aliases.
function readApprovedFactsBySubjectEntity(
  vaultRoot: string,
  owner: string,
  subjectEntityId: string,
  predicate: string,
): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  // v2.16.1 — canonical predicate match, so "employed_by" facts are found
  // when a "works_at" fact arrives about the same entity.
  const pred = canonicalPredicate(predicate);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      if ((fact.status ?? "approved") !== "approved") continue;
      if (fact.subject_entity_id !== subjectEntityId) continue;
      if (canonicalPredicate(fact.predicate ?? "") !== pred) continue;
      out.push(fact);
    } catch { /* skip malformed */ }
  }
  return out;
}

function readApprovedFactsByExactSubjectPredicate(
  vaultRoot: string,
  owner: string,
  subject: string,
  predicate: string,
): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  const subj = subject.trim().toLowerCase();
  // v2.16.1 — canonical predicate match (synonym phrasings are the same
  // relation for duplicate/stale/supersession purposes).
  const pred = canonicalPredicate(predicate);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      if ((fact.status ?? "approved") !== "approved") continue;
      if (fact.subject?.trim().toLowerCase() !== subj) continue;
      if (canonicalPredicate(fact.predicate ?? "") !== pred) continue;
      out.push(fact);
    } catch { /* skip malformed */ }
  }
  return out;
}
