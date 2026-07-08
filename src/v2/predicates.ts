// v2.16.1 — Canonical predicate normalization.
//
// The 2026-07-08 stability measurement showed exact-string matching defeats
// both consensus voting and supersession: three extraction passes agreed
// "Princeton made CoALA" but phrased it developed/created/founded — three
// 1-vote strangers instead of one 3-vote fact, all dropped. Same failure in
// supersession: "employed_by Google" and "works_at Anthropic" never met.
//
// This table maps synonym predicates onto one canonical form. It is used for
// MATCHING ONLY (vote keys, supersession candidate scans, functional-
// predicate checks) — the stored fact keeps its original surface predicate.
//
// Deliberately conservative: only classes where the relation is genuinely
// the same are merged. A wrong merge silently destroys facts (the v2.14.0
// supersession lesson); a missed merge only costs a vote. When in doubt, a
// predicate stays its own class (e.g. `published` ≠ `created`,
// `built_on` ≠ `uses`).

const SYNONYM_CLASSES: Record<string, string[]> = {
  // act of creation (past or ongoing — same relation for identity purposes)
  created: ["created", "creates", "developed", "develops", "founded", "built", "authored", "invented", "designed"],
  // functional dependency / usage
  uses: ["uses", "used", "depends_on", "requires", "relies_on", "utilizes"],
  // classification / definition (incl. acronym expansion)
  is_a: ["is_a", "stands_for", "acronym_for", "type_of", "kind_of"],
  // employment (aligns with FUNCTIONAL_PREDICATES in layer4-supersession)
  works_at: ["works_at", "works_for", "employed_by", "employed_at"],
  // personal residence
  lives_in: ["lives_in", "lives_at", "resides_in"],
  // organizational/physical location
  based_in: ["based_in", "located_in", "located_at", "headquartered_in"],
  // people management
  manages: ["manages", "leads", "heads", "oversees"],
  // ownership
  owns: ["owns", "owned_by_reverse_never_merge_placeholder"],
};

const CANON = new Map<string, string>();
for (const [canonical, variants] of Object.entries(SYNONYM_CLASSES)) {
  for (const v of variants) CANON.set(v, canonical);
}

// Normalize a predicate for matching: lowercase, trim, spaces→underscores,
// then synonym-class lookup. Unknown predicates pass through normalized —
// they simply form their own class.
export function canonicalPredicate(predicate: string): string {
  const p = (predicate ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  return CANON.get(p) ?? p;
}
