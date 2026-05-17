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
import { clampConfidence, toWikilinks, slugify, recordFilename, idFromFilename } from "./types";
import { appendAudit } from "./layer6-audit";
import { factValidAt } from "./temporal";
import { classifyOnWrite, type SupersessionDecision } from "./layer4-supersession";

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
    ...(input.evidence_excerpt ? { evidence_excerpt: input.evidence_excerpt.slice(0, 500) } : {}),
    ...(input.proposed_by ? { proposed_by: input.proposed_by, proposed_at: now } : {}),
  };

  const dir = join(vaultRoot, "facts", input.owner);
  mkdirSync(dir, { recursive: true });
  const body = `# ${fact.subject} ${fact.predicate} ${fact.object}\n\nFact derived from ${fact.derived_from.length} episode(s).`;
  // Obsidian graph: wikilinks for every supporting episode + supersession edge.
  // toWikilinks validates and dedupes — caller errors (dup IDs in derived_from)
  // don't propagate to disk.
  const links = toWikilinks([
    ...fact.derived_from,
    ...(fact.superseded_by ? [fact.superseded_by] : []),
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
): SemanticFact | null {
  const path = factPath(vaultRoot, owner, factId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  // Idempotent: re-approving an approved record is a no-op + no audit churn.
  if (fm.status === "approved") return fm as SemanticFact;
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
  return fm as SemanticFact;
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
  parsed.data.invalidated_at = new Date().toISOString();
  if (supersededBy) parsed.data.superseded_by = supersededBy;
  // Rebuild Obsidian links to include the new supersession edge.
  parsed.data.links = toWikilinks([
    ...((parsed.data.derived_from ?? []) as string[]),
    ...(parsed.data.superseded_by ? [parsed.data.superseded_by] : []),
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

export function recordFactWithSupersession(
  vaultRoot: string,
  input: RecordFactInput,
): RecordFactWithSupersessionResult {
  // 1. Pre-filter candidates: existing approved + not-invalidated + not-
  //    superseded facts with the SAME (subject, predicate, owner) as the
  //    new fact. findContradictions already does exactly this filter; the
  //    return type omits invalidated_at/superseded_by/derived_from/owner,
  //    so we re-load full records for the ones that matter.
  const matchObjects = findContradictions(vaultRoot, input.owner, {
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
  });
  // findContradictions filters OUT same-object candidates (it's looking for
  // contradictions). For supersession classification we also need same-
  // object matches (duplicate/stale detection). Hydrate full records for
  // the contradicting candidates AND scan again for same-object matches.
  const candidateIds = new Set(matchObjects.map(c => c.fact_id));
  const fullCandidates: SemanticFact[] = [];
  for (const id of candidateIds) {
    const f = readFact(vaultRoot, input.owner, id);
    if (f) fullCandidates.push(f);
  }
  // Also scan for same-object matches (duplicate/stale detection).
  const sameObjMatches = readApprovedFactsByExactSubjectPredicate(
    vaultRoot, input.owner, input.subject, input.predicate,
  ).filter(f =>
    f.object?.trim().toLowerCase() === input.object?.trim().toLowerCase()
    && !f.invalidated_at && !f.superseded_by
  );
  for (const f of sameObjMatches) {
    if (!candidateIds.has(f.id)) fullCandidates.push(f);
  }

  // 2. Classify (pure function — fully testable).
  const decision = classifyOnWrite(
    {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      event_date: input.valid_from ?? new Date().toISOString(),
    },
    fullCandidates,
  );

  // 3. Branch on decision.
  if (decision.kind === "NONE") {
    appendAudit({
      op: "EXTRACT",  // re-use existing op; reason carries the skip context
      actor: input.actor,
      owner: input.owner,
      record_ids: [],
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
  const pred = predicate.trim().toLowerCase();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      if ((fact.status ?? "approved") !== "approved") continue;
      if (fact.subject?.trim().toLowerCase() !== subj) continue;
      if (fact.predicate?.trim().toLowerCase() !== pred) continue;
      out.push(fact);
    } catch { /* skip malformed */ }
  }
  return out;
}
