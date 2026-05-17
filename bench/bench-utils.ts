// Shared utilities for the LongMemEval bench harnesses
// (bench/longmemeval-harness.ts, bench/dump-packet.ts, future bench files).

/**
 * v2.11.1+ — sanitize an extractor-supplied event_date and produce a
 * stable YYYY-MM-DD string for the fact's `valid_from`.
 *
 * Path B from the v2.11.1 self-consistency vote: try strict ISO, then
 * regex-extract a YYYY-MM-DD substring from raw, then from observationDate
 * in either ISO or YYYY/MM/DD form. On TOTAL failure of both inputs,
 * emit a console.warn and return the caller-supplied observationDate AS-IS
 * (first 10 chars). Never falls back to wall-clock `Date.now()` — that
 * was the root cause of the v2.11.0-rc.1 knowledge-update regression and
 * silently stamping facts with today's date defeats the whole fix.
 */
export function sanitizeEventDate(raw: unknown, observationDate: string): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const m = trimmed.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(observationDate)) return observationDate.slice(0, 10);
  const m = observationDate.match(/(\d{4})[\/-](\d{2})[\/-](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // BOTH inputs are unparseable. Surface this — silent fallback to today
  // is exactly the bug we're trying to fix. Use observationDate's prefix
  // so a downstream isCurrent(fact, question_date) at least has a chance
  // of working, instead of wall-clock now.
  console.warn(
    `[bench-utils] sanitizeEventDate: unable to parse raw=${JSON.stringify(raw)} or observationDate=${JSON.stringify(observationDate)} as a YYYY-MM-DD date; falling back to observationDate first 10 chars`,
  );
  return observationDate.slice(0, 10);
}
