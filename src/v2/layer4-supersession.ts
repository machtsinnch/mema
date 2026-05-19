// Layer 4: Write-Time Supersession (v2.14+).
//
// Pure-function classifier for deciding what happens when a new fact arrives
// that has the same (subject, predicate) as one or more existing facts.
// Wired into the ingestion path so EVERY fact write is supersession-checked
// — no opt-out flag.
//
// Per Ardin's architectural principle (2026-05-17):
//
//   "LLMs are stochastic — mema's PURPOSE is to add a deterministic layer
//    on top. If mema's operational behavior is itself optional ('sometimes
//    extract, sometimes don't, depending on a flag'), it inherits all the
//    chaos it's meant to filter. Cannot sell stability on a stochastic
//    foundation."
//
// Per Codex sparring review (source-fetched against Graphiti's
// resolve_edge_contradictions in graphiti_core/utils/maintenance/
// edge_operations.py): this implementation uses Graphiti's pattern of
// temporal-edge invalidation, NOT Mem0's ADD/UPDATE/DELETE/NONE LLM-call
// pattern (which Mem0 itself abandoned in their current main branch).
//
// Detection strategy for v2.14.0: exact-match-only on (subject, predicate).
// Same subject + same predicate + different object = supersession candidate.
// Same object + same date = duplicate (skip). Same object + later date =
// stale (skip). No LLM call required at write time — pure structural.
//
// Semantic predicate equivalence (e.g., "lives_in" ≡ "moved_to") is real
// but deferred to v2.14.3 as a background batch with an LLM call only on
// ambiguous candidates.

import type { SemanticFact } from "./types";

/**
 * The decision a new fact triggers given the current state of same-
 * (subject, predicate) facts in the owner's vault.
 */
export type SupersessionDecision =
  | { kind: "ADD"; reason?: string }
  | { kind: "NONE"; reason: "duplicate" | "stale" }
  | { kind: "UPDATE"; superseded: SemanticFact[] };

export interface NewFactCandidate {
  subject: string;
  predicate: string;
  object: string;
  /** YYYY-MM-DD; if omitted at the API surface, callers must pass today's
   *  date (or the conversation observation date for bench/extractor flows).
   *  recordFact in layer2-semantic.ts already enforces this contract — we
   *  pass the resolved value here. */
  event_date: string;
}

/**
 * Pure function: decide what should happen when a new fact arrives, given
 * the pre-filtered candidate set (all existing approved+not-invalidated+
 * not-superseded facts in this owner's vault that share the same
 * (subject, predicate) as the new fact).
 *
 * The caller is responsible for the pre-filter (findContradictions in
 * layer2-semantic.ts already does it correctly: status === "approved",
 * !invalidated_at, !superseded_by, exact subject+predicate match).
 *
 * Returns one of:
 *   ADD     — no contradiction; just persist the new fact.
 *   NONE    — duplicate or stale; do not persist; log audit-skip.
 *   UPDATE  — supersedes one or more existing facts; persist new, then
 *             invalidate each entry in `superseded[]` with
 *             invalidated_at = new.event_date and superseded_by = new.id.
 */
export function classifyOnWrite(
  newFact: NewFactCandidate,
  candidates: SemanticFact[],
): SupersessionDecision {
  const normNewObject = newFact.object.trim().toLowerCase();
  const normNewDate = (newFact.event_date ?? "").slice(0, 10);

  // 1. Exact duplicate — same object + same date already known. Skip.
  if (candidates.some(f =>
    f.object?.trim().toLowerCase() === normNewObject
    && (f.valid_from ?? "").slice(0, 10) === normNewDate
  )) {
    return { kind: "NONE", reason: "duplicate" };
  }

  // 2. Stale — same object already known at >= the new fact's date.
  //    No new information; the existing fact already covers this state at
  //    or after the new one's claimed date. Skip.
  const sameObject = candidates.filter(f =>
    f.object?.trim().toLowerCase() === normNewObject
  );
  if (sameObject.some(f => (f.valid_from ?? "").slice(0, 10) >= normNewDate)) {
    return { kind: "NONE", reason: "stale" };
  }

  // 3. Update — different object, OLDER event than the new fact, still
  //    current. These get superseded by the new fact.
  //
  // v2.14.1: compare FULL ISO timestamps, not just YYYY-MM-DD. Earlier
  // versions sliced to date-prefix, which meant two contradicting facts
  // ingested on the same day (e.g. "John works at Google" at 07:38:10 then
  // "John works at Anthropic" at 07:38:21) failed to supersede — strict
  // `<` of identical date prefixes is false. Real-world ingestion regularly
  // gets multiple same-day updates from different documents. Full-timestamp
  // ordering preserves last-write-wins semantics.
  //
  // The duplicate check (step 1) keeps date-prefix because "same day same
  // object" really IS a duplicate semantically; only UPDATE needs precision.
  const newTs = newFact.event_date ?? "";
  const olderDifferent = candidates.filter(f =>
    f.object?.trim().toLowerCase() !== normNewObject
    && (f.valid_from ?? "") < newTs
    // The caller pre-filtered for !invalidated_at && !superseded_by, but
    // belt-and-suspenders: enforce here too.
    && !f.invalidated_at
    && !f.superseded_by
  );
  if (olderDifferent.length > 0) {
    return { kind: "UPDATE", superseded: olderDifferent };
  }

  // 4. Historical backfill — the new fact is OLDER than all current
  //    contradicting facts (or there are no contradicting facts at all).
  //    Just ADD; do NOT supersede anything. The existing newer facts remain
  //    current; the new (older) fact will read as "historical" via
  //    factValidAt date-ordering.
  return { kind: "ADD" };
}
