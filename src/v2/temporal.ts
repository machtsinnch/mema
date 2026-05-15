// v2.7.4+ temporal comparison helper (W8 from external review).
//
// Problem: prior versions compared valid_from / valid_to / invalidated_at as
// raw strings ("a" < "b"). That works ONLY when every timestamp is a fully
// normalized ISO-8601 UTC string with identical formatting. The moment you
// mix "2026-05-15", "2026-05-15T10:00:00+02:00", and "2026-05-15T08:00:00Z"
// the lexical comparison is wrong (e.g. "2026-05-15" sorts BEFORE
// "2026-05-15T08:00:00Z" but they refer to the same wall-clock day).
//
// Fix: parse every timestamp to epoch milliseconds at comparison time. The
// on-disk frontmatter keeps the original ISO string for human/Obsidian
// readability — only the comparison switches to numeric.
//
// NaN handling: an unparseable string in `valid_from` is treated as -Infinity
// (record is always valid since beginning); in `valid_to` / `invalidated_at`
// as +Infinity (record never expires). This is the lenient interpretation
// that preserves availability under malformed input — strict callers should
// validate at the write boundary instead.

export function toEpochMs(t: string | null | undefined): number | null {
  if (t === null || t === undefined || t === "") return null;
  const n = Date.parse(t);
  return Number.isNaN(n) ? null : n;
}

// True iff fact was valid at the given instant. Mirrors the semantics of
// the old string-comparison code but uses numeric epoch ms.
//   valid_from > at     → not yet valid (fact starts in the future)
//   valid_to   < at     → no longer valid (fact ended before query time)
//   invalidated_at <= at → we'd already learned it was wrong by then
export function factValidAt(
  fact: { valid_from: string; valid_to?: string | null; invalidated_at?: string | null },
  atIso: string,
  invalidatedComparator: "lt" | "lte" = "lt",
): boolean {
  const atMs = toEpochMs(atIso);
  if (atMs === null) return false;  // unparseable query time → conservatively exclude

  const fromMs = toEpochMs(fact.valid_from);
  // null (unparseable) valid_from → treat as -Infinity (always valid since
  // beginning). Same behavior as the old string code when valid_from is "".
  if (fromMs !== null && fromMs > atMs) return false;

  const toMs = toEpochMs(fact.valid_to ?? null);
  // null valid_to → +Infinity (open-ended) — record is still valid.
  if (toMs !== null && toMs < atMs) return false;

  const invMs = toEpochMs(fact.invalidated_at ?? null);
  if (invMs !== null) {
    if (invalidatedComparator === "lte") {
      if (invMs <= atMs) return false;
    } else {
      if (invMs < atMs) return false;
    }
  }

  return true;
}

// `since` filter for reflection: include facts created/valid since the cutoff.
export function factValidSince(
  fact: { valid_from: string },
  sinceIso: string,
): boolean {
  const sinceMs = toEpochMs(sinceIso);
  const fromMs = toEpochMs(fact.valid_from);
  if (sinceMs === null || fromMs === null) return false;
  return fromMs >= sinceMs;
}
