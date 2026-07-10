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
import { canonicalPredicate } from "./predicates";

// Supersession policy (v2.14.3+ — codex review):
//
// The v2.14.0 default was "supersede every (subject, predicate)" which
// silently destroyed corpora using lists (contains/lacks/supports/...).
// Allow-listing multi-valued predicates was whack-a-mole (real extractor
// output includes "monthly_contributions_to", "tests_code",
// "entry_price_at", etc. that we'd have to constantly add).
//
// Inverted policy: DEFAULT to ADD. Only a small set of canonical
// FUNCTIONAL predicates supersede — those where a subject can only
// have ONE current object semantically (employment, residence, marital
// status, current ownership). Everything else accumulates.
//
// This loses some legitimate updates (e.g. "X is_now version 2" doesn't
// invalidate "X is_now version 1") in favor of never losing source
// information. Down-stream retrieval already ranks by recency via
// last_seen, so accumulated facts surface in correct order.
const FUNCTIONAL_PREDICATES = new Set<string>([
  "works_at",
  "employed_by",
  "employed_at",
  "works_for",
  "lives_in",
  "lives_at",
  "located_at",
  "based_in",
  "married_to",
  "reports_to",
  "managed_by",
  "ceo_of",
  "current_status",
  "current_version",
  "current_owner",
  // v2.17.0 — "owns" REMOVED (Ardin's decision 2026-07-10): people and
  // organizations own many things at once; treating ownership as one-value
  // silently replaced valid ownership facts and produced false "currently
  // owns" conclusions in L3. Ownership facts now accumulate.
]);

export function isFunctional(predicate: string): boolean {
  // v2.16.1 — check the canonical form too, so "works_for"/"employed_by"
  // hit the works_at gate even if the synonym table canonicalizes them.
  const raw = predicate.trim().toLowerCase();
  return FUNCTIONAL_PREDICATES.has(raw) || FUNCTIONAL_PREDICATES.has(canonicalPredicate(predicate));
}

// v2.17.0 — one-value-ness depends on WHO the subject is (Ardin's decision
// 2026-07-10): a person lives in one place, but a company is located in
// many (HQ, factories, offices) — treating location as one-value for
// organizations replaced "TSMC located_in Taiwan" with "…Germany" (the
// Dresden fab) at write time. Location predicates are functional ONLY for
// person subjects; unknown subject type → NOT functional for locations
// (better accumulate than wrongly replace). All other functional
// predicates keep their behavior regardless of type.
const PERSON_ONLY_CLASSES = new Set(["lives_in", "based_in"]);

export function isFunctionalFor(
  predicate: string,
  subjectEntityType: string | null | undefined,
): boolean {
  if (!isFunctional(predicate)) return false;
  const canon = canonicalPredicate(predicate);
  if (PERSON_ONLY_CLASSES.has(canon)) {
    return subjectEntityType === "person";
  }
  return true;
}

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
  // v2.17.1 — the resolved entity type of the fact's subject ("person",
  // "organization", ...) when the caller knows it; null/undefined = unknown.
  // Location predicates only replace for person subjects (see
  // isFunctionalFor above) — unknown subjects accumulate rather than risk
  // wrongly replacing a company's second location.
  subjectEntityType?: string | null,
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

  // 3. Functional-predicate gate. Only supersede when the predicate is in
  //    the FUNCTIONAL_PREDICATES allow-list (employment, residence, current
  //    status, etc.). For everything else, accumulate — multi-valued by
  //    default. Loses some legitimate version replacements; prevents the
  //    "13 facts deleted from one document" failure mode from codex review.
  if (!isFunctionalFor(newFact.predicate, subjectEntityType)) {
    return { kind: "ADD", reason: "non_functional_predicate" };
  }

  // 4. Update — different object, OLDER event than the new fact, still
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
