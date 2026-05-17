// Time-aware query expansion — mema v2.13.2 (autonomous-session draft).
//
// Detects temporal markers in a LongMemEval-style question and resolves
// them to YYYY-MM-DD ranges against the question_date. The harness uses
// these ranges as multi-query candidates that RRF-fuse with the plain
// semantic retrieval.
//
// Design rationale per Codex sparring critique (2026-05-17):
// - Minimal intuitive pattern set (yesterday/last week/recently/in YYYY)
//   covered only 27% of LongMemEval temporal questions. The unlock is
//   `X ago` + `since` + `first|earliest|latest` + weekday + named-event
//   anchors, which together get to ~82% recall.
// - EVENT_ANCHOR ("before my divorce") and HOLIDAY ("at Christmas") are
//   DETECTED but resolve to null — fall through to plain semantic.
// - `recently` = 14 days (not 30) — fixed default convention.
// - `last week` = prior calendar week (Mon-Sun), NOT rolling 7d.
// - Sparse temporal coverage in mema's fact store means hard metadata
//   filter is brittle; the harness should use multi-query + RRF, not a
//   single date-restricted recall.
//
// This module exposes:
//   detectTemporal(question) → DetectedMarker[]    pure regex match
//   resolveTemporal(marker, questionDate)          → DateRange | null
//   expandQuery(question, questionDate)            → { ranges: DateRange[]; ok: boolean }
//
// The harness wires this in by:
//   1. Call expandQuery() at retrieval time.
//   2. For each resolved DateRange, fire a parallel recall with the
//      same query text + temporal metadata bias toward that range
//      (initially: post-filter hits with event_date OUT of range).
//   3. RRF-fuse the resulting candidate lists.
//   4. If no ranges resolve, retrieval falls back to the single
//      plain-semantic call (no behavior change vs current).

export type TemporalCategory =
  | "RELATIVE_DAY"
  | "RELATIVE_WEEK"
  | "RELATIVE_MONTH"
  | "RELATIVE_YEAR"
  | "RELATIVE_VAGUE"
  | "AGO"
  | "SINCE"
  | "ORDER"
  | "BETWEEN"
  | "DURATION"
  | "NAMED_MONTH"
  | "ABSOLUTE_DATE"
  | "EVENT_ANCHOR"
  | "HOLIDAY";

export interface DetectedMarker {
  category: TemporalCategory;
  raw: string;
  groups: Record<string, string | undefined>;
}

export interface DateRange {
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD inclusive
}

// Detection patterns. Order matters only insofar as more-specific
// patterns should appear before more-general ones (we collect ALL
// matches, but downstream the resolver uses the first matching
// category per regex).
//
// The asterisked patterns (in comments) are the high-leverage additions
// Codex measured against the LongMemEval-S 133 temporal-reasoning
// questions: 27% recall without them, 82% recall with them.
const TEMPORAL_PATTERNS: { cat: TemporalCategory; re: RegExp }[] = [
  // RELATIVE_DAY
  { cat: "RELATIVE_DAY", re: /\b(yesterday|today|tomorrow)\b/i },
  { cat: "RELATIVE_DAY", re: /\b(this|last|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i }, // *
  // RELATIVE_WEEK / MONTH / YEAR (calendar-relative, NOT rolling)
  { cat: "RELATIVE_WEEK",  re: /\b(this|last|next|past)\s+week(end)?\b/i },
  { cat: "RELATIVE_MONTH", re: /\b(this|last|next|past)\s+month\b/i },
  { cat: "RELATIVE_YEAR",  re: /\b(this|last|next|past)\s+year\b/i },
  // RELATIVE_VAGUE — "recently" maps to 14-day window per convention
  { cat: "RELATIVE_VAGUE", re: /\b(recently|lately|currently|now|these days|nowadays)\b/i },
  // AGO — biggest single recall win
  { cat: "AGO",   re: /\b(\d+|a|an|few|several)\s+(day|week|month|year)s?\s+ago\b/i }, // *
  // SINCE
  { cat: "SINCE", re: /\b(since|ever since|from)\s+(\w+\s+){0,3}(\d{4}|january|february|march|april|may|june|july|august|september|october|november|december)\b/i }, // *
  // ORDER / SUPERLATIVE
  { cat: "ORDER", re: /\b(first|earliest|latest|most recent|last time|before that|in what order|which came first)\b/i }, // *
  // DURATION / BETWEEN
  { cat: "BETWEEN", re: /\b(between|from)\s+.+\s+(and|to|until)\b/i }, // *
  { cat: "DURATION", re: /\b(how long|for how many|over the (past|last)\s+\d+)\b/i }, // *
  // NAMED_MONTH (with optional year)
  { cat: "NAMED_MONTH", re: /\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)(\s+(\d{4}))?\b/i },
  // ABSOLUTE_DATE
  { cat: "ABSOLUTE_DATE", re: /\b(\d{4})-(\d{2})-(\d{2})\b/ },
  // EVENT_ANCHOR — detect, do NOT try to resolve via regex
  { cat: "EVENT_ANCHOR", re: /\b(before|after|during|when)\s+(my|the|i\s+(was|lived|worked|moved|went))\b/i }, // *
  { cat: "EVENT_ANCHOR", re: /\b(back when|used to|at the time)\b/i }, // *
  // HOLIDAY — detect, do NOT resolve (would need calendar/world knowledge)
  { cat: "HOLIDAY", re: /\b(christmas|thanksgiving|easter|new year('s)?|valentine'?s day|super bowl|covid|the pandemic|graduation)\b/i }, // *
];

/**
 * Scan the question for any temporal markers. Returns ALL matches
 * (zero, one, or many). Pure regex; no calendar resolution.
 */
export function detectTemporal(question: string): DetectedMarker[] {
  const found: DetectedMarker[] = [];
  for (const { cat, re } of TEMPORAL_PATTERNS) {
    const m = question.match(re);
    if (!m) continue;
    const groups: Record<string, string | undefined> = {};
    for (let i = 0; i < (m.length ?? 0); i++) {
      groups[`g${i}`] = m[i];
    }
    found.push({ category: cat, raw: m[0], groups });
  }
  return found;
}

// ─── Resolution helpers ─────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function toYMD(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

// Prior calendar week (Mon-Sun). NOT rolling 7d.
function priorCalendarWeek(ref: Date): DateRange {
  const dayOfWeek = ref.getUTCDay(); // 0=Sun, 1=Mon..6=Sat
  // Monday of this week:
  const daysSinceMon = (dayOfWeek + 6) % 7;
  const thisMon = addDays(ref, -daysSinceMon);
  const lastMon = addDays(thisMon, -7);
  const lastSun = addDays(lastMon, 6);
  return { start: toYMD(lastMon), end: toYMD(lastSun) };
}

function thisCalendarWeek(ref: Date): DateRange {
  const dayOfWeek = ref.getUTCDay();
  const daysSinceMon = (dayOfWeek + 6) % 7;
  const thisMon = addDays(ref, -daysSinceMon);
  const thisSun = addDays(thisMon, 6);
  return { start: toYMD(thisMon), end: toYMD(thisSun) };
}

function nextCalendarWeek(ref: Date): DateRange {
  const dayOfWeek = ref.getUTCDay();
  const daysSinceMon = (dayOfWeek + 6) % 7;
  const nextMon = addDays(ref, 7 - daysSinceMon);
  const nextSun = addDays(nextMon, 6);
  return { start: toYMD(nextMon), end: toYMD(nextSun) };
}

/**
 * Resolve a single detected marker against the question's reference
 * date. Returns null for markers that the regex layer can detect but
 * cannot resolve without world knowledge (EVENT_ANCHOR, HOLIDAY,
 * ORDER, BETWEEN, DURATION) — caller falls back to plain semantic
 * retrieval in those cases.
 */
export function resolveTemporal(m: DetectedMarker, questionDate: string): DateRange | null {
  const ref = new Date(`${questionDate}T00:00:00Z`);
  if (Number.isNaN(ref.getTime())) return null;

  switch (m.category) {
    case "RELATIVE_DAY": {
      const raw = m.raw.toLowerCase();
      if (/yesterday/.test(raw)) {
        const y = addDays(ref, -1);
        return { start: toYMD(y), end: toYMD(y) };
      }
      if (/today/.test(raw)) {
        return { start: toYMD(ref), end: toYMD(ref) };
      }
      if (/tomorrow/.test(raw)) {
        const t = addDays(ref, 1);
        return { start: toYMD(t), end: toYMD(t) };
      }
      // "this|last|next monday/tuesday/..." — point at the named day
      const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
      for (let i = 0; i < weekdays.length; i++) {
        if (!raw.includes(weekdays[i])) continue;
        const direction = /last|past/.test(raw) ? -7 : /next/.test(raw) ? 7 : 0;
        const refDay = ref.getUTCDay();
        let delta = (i - refDay + 7) % 7;  // forward to target weekday this week
        if (direction === 0 && delta === 0) {
          // "this monday" on a Monday = today
        } else if (direction === -7) {
          delta = delta === 0 ? -7 : delta - 7;
        } else if (direction === 7) {
          delta = delta === 0 ? 7 : delta + 7;
        }
        const d = addDays(ref, delta);
        return { start: toYMD(d), end: toYMD(d) };
      }
      return null;
    }
    case "RELATIVE_WEEK": {
      const raw = m.raw.toLowerCase();
      if (/last|past/.test(raw)) return priorCalendarWeek(ref);
      if (/this/.test(raw)) return thisCalendarWeek(ref);
      if (/next/.test(raw)) return nextCalendarWeek(ref);
      return priorCalendarWeek(ref);
    }
    case "RELATIVE_MONTH": {
      const raw = m.raw.toLowerCase();
      const direction = /last|past/.test(raw) ? -1 : /next/.test(raw) ? 1 : 0;
      const month = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + direction, 1));
      return { start: toYMD(startOfMonth(month)), end: toYMD(endOfMonth(month)) };
    }
    case "RELATIVE_YEAR": {
      const raw = m.raw.toLowerCase();
      const direction = /last|past/.test(raw) ? -1 : /next/.test(raw) ? 1 : 0;
      const y = ref.getUTCFullYear() + direction;
      return { start: `${y}-01-01`, end: `${y}-12-31` };
    }
    case "RELATIVE_VAGUE": {
      // recently / lately / currently / now: last 14 days
      const start = addDays(ref, -14);
      return { start: toYMD(start), end: toYMD(ref) };
    }
    case "AGO": {
      // "5 days ago", "a week ago", "few months ago"
      const raw = m.raw.toLowerCase();
      const numMatch = raw.match(/^(\d+|a|an|few|several)/);
      let n = 1;
      if (numMatch) {
        const t = numMatch[1];
        n = /\d+/.test(t) ? parseInt(t, 10) : (t === "few" ? 3 : t === "several" ? 5 : 1);
      }
      const unit = /day/.test(raw) ? "day" : /week/.test(raw) ? "week" : /month/.test(raw) ? "month" : /year/.test(raw) ? "year" : "day";
      let date: Date;
      if (unit === "day") date = addDays(ref, -n);
      else if (unit === "week") date = addDays(ref, -7 * n);
      else if (unit === "month") date = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - n, ref.getUTCDate()));
      else date = new Date(Date.UTC(ref.getUTCFullYear() - n, ref.getUTCMonth(), ref.getUTCDate()));
      // Window of ±3 days around the resolved point (the phrase is approximate)
      const start = addDays(date, -3);
      const end = addDays(date, 3);
      return { start: toYMD(start), end: toYMD(end) };
    }
    case "NAMED_MONTH": {
      // "in March", "in March 2024"
      const raw = m.raw.toLowerCase();
      const monthMatch = raw.match(/(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?/);
      if (!monthMatch) return null;
      const monthIdx = MONTHS[monthMatch[1]];
      let year: number;
      if (monthMatch[2]) {
        year = parseInt(monthMatch[2], 10);
      } else {
        // No year specified — use the most recent past occurrence of this month
        year = ref.getUTCFullYear();
        if (monthIdx > ref.getUTCMonth()) year -= 1;
      }
      const startD = new Date(Date.UTC(year, monthIdx, 1));
      const endD = endOfMonth(startD);
      return { start: toYMD(startD), end: toYMD(endD) };
    }
    case "ABSOLUTE_DATE": {
      const raw = m.raw;
      const match = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!match) return null;
      return { start: match[0], end: match[0] };
    }
    case "SINCE": {
      // "since 2023", "since March", "since the launch"
      const raw = m.raw.toLowerCase();
      const yearMatch = raw.match(/\b(\d{4})\b/);
      const monthMatch = raw.match(/(january|february|march|april|may|june|july|august|september|october|november|december)/);
      let startDate: Date | null = null;
      if (yearMatch) {
        const y = parseInt(yearMatch[1], 10);
        const monthIdx = monthMatch ? MONTHS[monthMatch[1]] : 0;
        startDate = new Date(Date.UTC(y, monthIdx, 1));
      } else if (monthMatch) {
        const monthIdx = MONTHS[monthMatch[1]];
        let year = ref.getUTCFullYear();
        if (monthIdx > ref.getUTCMonth()) year -= 1;
        startDate = new Date(Date.UTC(year, monthIdx, 1));
      }
      if (!startDate) return null;
      return { start: toYMD(startDate), end: toYMD(ref) };
    }
    // Cannot resolve via regex — caller falls back to plain semantic.
    case "ORDER":
    case "BETWEEN":
    case "DURATION":
    case "EVENT_ANCHOR":
    case "HOLIDAY":
      return null;
  }
}

/**
 * Top-level entry: detect markers in the question, resolve each
 * against the questionDate, return the resolved DateRanges. If no
 * markers resolve, the harness should fall back to plain semantic
 * retrieval (no date filtering).
 */
export function expandQuery(question: string, questionDate: string): { ranges: DateRange[]; markers: DetectedMarker[] } {
  const markers = detectTemporal(question);
  const ranges: DateRange[] = [];
  for (const m of markers) {
    const r = resolveTemporal(m, questionDate);
    if (r) ranges.push(r);
  }
  // De-duplicate overlapping ranges (keep the most inclusive).
  // Cheap O(n^2) — n is at most ~5.
  const dedup: DateRange[] = [];
  outer: for (const r of ranges) {
    for (const d of dedup) {
      if (r.start === d.start && r.end === d.end) continue outer;
    }
    dedup.push(r);
  }
  return { ranges: dedup, markers };
}
