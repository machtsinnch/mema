// Tests for bench/temporal-expansion.ts — the v2.13.2 time-aware
// query expansion module (mema-original implementation per Codex spec).

import { describe, test, expect } from "bun:test";
import {
  detectTemporal,
  resolveTemporal,
  expandQuery,
  type DetectedMarker,
} from "../../bench/temporal-expansion";

describe("detectTemporal", () => {
  test("detects RELATIVE_DAY", () => {
    expect(detectTemporal("What happened yesterday?").some(m => m.category === "RELATIVE_DAY")).toBe(true);
    expect(detectTemporal("Where am I today?").some(m => m.category === "RELATIVE_DAY")).toBe(true);
  });

  test("detects weekday anchors", () => {
    expect(detectTemporal("What did I do last Monday?").some(m => m.category === "RELATIVE_DAY")).toBe(true);
    expect(detectTemporal("Where will I be this Friday?").some(m => m.category === "RELATIVE_DAY")).toBe(true);
  });

  test("detects RELATIVE_WEEK", () => {
    expect(detectTemporal("Where did I go last week?").some(m => m.category === "RELATIVE_WEEK")).toBe(true);
    expect(detectTemporal("What's planned this weekend?").some(m => m.category === "RELATIVE_WEEK")).toBe(true);
  });

  test("detects AGO (the high-leverage Codex finding)", () => {
    expect(detectTemporal("3 days ago I had a meeting").some(m => m.category === "AGO")).toBe(true);
    expect(detectTemporal("a few months ago we discussed this").some(m => m.category === "AGO")).toBe(true);
    expect(detectTemporal("several weeks ago").some(m => m.category === "AGO")).toBe(true);
  });

  test("detects SINCE", () => {
    expect(detectTemporal("Where have I been since March?").some(m => m.category === "SINCE")).toBe(true);
    expect(detectTemporal("Ever since 2023 I have").some(m => m.category === "SINCE")).toBe(true);
  });

  test("detects ORDER markers", () => {
    expect(detectTemporal("What was my first project?").some(m => m.category === "ORDER")).toBe(true);
    expect(detectTemporal("Which came first?").some(m => m.category === "ORDER")).toBe(true);
    expect(detectTemporal("Show me the latest update").some(m => m.category === "ORDER")).toBe(true);
  });

  test("detects NAMED_MONTH with optional year", () => {
    expect(detectTemporal("What did I do in March?").some(m => m.category === "NAMED_MONTH")).toBe(true);
    expect(detectTemporal("Meetings in March 2024").some(m => m.category === "NAMED_MONTH")).toBe(true);
  });

  test("detects ABSOLUTE_DATE", () => {
    expect(detectTemporal("Where was I on 2024-03-15?").some(m => m.category === "ABSOLUTE_DATE")).toBe(true);
  });

  test("detects EVENT_ANCHOR (resolves to null in resolver, but detection works)", () => {
    expect(detectTemporal("Before my divorce I had").some(m => m.category === "EVENT_ANCHOR")).toBe(true);
    expect(detectTemporal("Back when I lived in Boston").some(m => m.category === "EVENT_ANCHOR")).toBe(true);
  });

  test("detects HOLIDAY", () => {
    expect(detectTemporal("At Christmas we went").some(m => m.category === "HOLIDAY")).toBe(true);
    expect(detectTemporal("During the pandemic").some(m => m.category === "HOLIDAY")).toBe(true);
  });

  test("returns empty array for question with no temporal marker", () => {
    expect(detectTemporal("What is the user's favorite color?")).toEqual([]);
    expect(detectTemporal("Recommend a good book")).toEqual([]);
  });
});

describe("resolveTemporal", () => {
  const QD = "2024-06-15"; // reference date for resolution tests

  test("yesterday resolves to questionDate - 1 day", () => {
    const m: DetectedMarker = { category: "RELATIVE_DAY", raw: "yesterday", groups: {} };
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-06-14", end: "2024-06-14" });
  });

  test("today resolves to questionDate", () => {
    const m: DetectedMarker = { category: "RELATIVE_DAY", raw: "today", groups: {} };
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-06-15", end: "2024-06-15" });
  });

  test("last week resolves to prior calendar week (Mon-Sun), NOT rolling 7d", () => {
    // 2024-06-15 is a Saturday. Last calendar week = Mon 2024-06-03 to Sun 2024-06-09.
    const m: DetectedMarker = { category: "RELATIVE_WEEK", raw: "last week", groups: {} };
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-06-03", end: "2024-06-09" });
  });

  test("recently resolves to 14-day window (not 30)", () => {
    const m: DetectedMarker = { category: "RELATIVE_VAGUE", raw: "recently", groups: {} };
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-06-01", end: "2024-06-15" });
  });

  test("'5 days ago' produces ±3 day window around the point", () => {
    const m: DetectedMarker = { category: "AGO", raw: "5 days ago", groups: {} };
    // 5 days before 2024-06-15 = 2024-06-10. ±3 days = 2024-06-07 to 2024-06-13.
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-06-07", end: "2024-06-13" });
  });

  test("'few months ago' resolves with default n=3", () => {
    const m: DetectedMarker = { category: "AGO", raw: "few months ago", groups: {} };
    expect(resolveTemporal(m, QD)).not.toBeNull();
  });

  test("named month with year resolves to that exact month", () => {
    const m: DetectedMarker = { category: "NAMED_MONTH", raw: "in March 2024", groups: {} };
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-03-01", end: "2024-03-31" });
  });

  test("named month without year resolves to most recent past occurrence", () => {
    const m: DetectedMarker = { category: "NAMED_MONTH", raw: "in March", groups: {} };
    // Question date is 2024-06-15; most recent past March is 2024-03.
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-03-01", end: "2024-03-31" });
  });

  test("named month without year, question in earlier month, resolves to last year", () => {
    const m: DetectedMarker = { category: "NAMED_MONTH", raw: "in November", groups: {} };
    // Question date is 2024-06-15; November is later than June, so use 2023's November.
    expect(resolveTemporal(m, "2024-06-15")).toEqual({ start: "2023-11-01", end: "2023-11-30" });
  });

  test("absolute date resolves to itself", () => {
    const m: DetectedMarker = { category: "ABSOLUTE_DATE", raw: "2024-03-15", groups: {} };
    expect(resolveTemporal(m, QD)).toEqual({ start: "2024-03-15", end: "2024-03-15" });
  });

  test("since YYYY resolves to start-of-year through questionDate", () => {
    const m: DetectedMarker = { category: "SINCE", raw: "since 2023", groups: {} };
    expect(resolveTemporal(m, QD)).toEqual({ start: "2023-01-01", end: "2024-06-15" });
  });

  test("ORDER markers return null (cannot resolve via regex)", () => {
    const m: DetectedMarker = { category: "ORDER", raw: "first", groups: {} };
    expect(resolveTemporal(m, QD)).toBeNull();
  });

  test("EVENT_ANCHOR markers return null", () => {
    const m: DetectedMarker = { category: "EVENT_ANCHOR", raw: "before my divorce", groups: {} };
    expect(resolveTemporal(m, QD)).toBeNull();
  });

  test("HOLIDAY markers return null", () => {
    const m: DetectedMarker = { category: "HOLIDAY", raw: "christmas", groups: {} };
    expect(resolveTemporal(m, QD)).toBeNull();
  });
});

describe("expandQuery (end-to-end)", () => {
  test("yesterday question expands to single-day range", () => {
    const r = expandQuery("What did I eat yesterday?", "2024-06-15");
    expect(r.ranges).toEqual([{ start: "2024-06-14", end: "2024-06-14" }]);
  });

  test("no temporal markers returns no ranges (caller falls back to plain semantic)", () => {
    const r = expandQuery("Recommend a good restaurant", "2024-06-15");
    expect(r.ranges).toEqual([]);
    expect(r.markers).toEqual([]);
  });

  test("EVENT_ANCHOR detected but produces no ranges", () => {
    const r = expandQuery("What was happening before my move?", "2024-06-15");
    expect(r.markers.some(m => m.category === "EVENT_ANCHOR")).toBe(true);
    expect(r.ranges).toEqual([]);  // fallback to plain semantic
  });

  test("multiple markers produce multiple ranges, deduped", () => {
    const r = expandQuery("What did I do yesterday and in March 2024?", "2024-06-15");
    expect(r.ranges.length).toBeGreaterThanOrEqual(2);
  });
});
