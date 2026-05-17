// v2.11.1+ — Tests for bench/bench-utils.ts sanitizeEventDate.
//
// The function's behavior is load-bearing for temporal grounding: it must
// NEVER return wall-clock now() (that was the root cause of the
// v2.11.0-rc.1 knowledge-update regression). Tests cover the fall-through
// chain end-to-end, including the "bad raw + bad observationDate" path.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { sanitizeEventDate } from "../../bench/bench-utils";

describe("sanitizeEventDate", () => {
  let warnCalls: string[] = [];
  let origWarn: typeof console.warn;

  beforeEach(() => {
    warnCalls = [];
    origWarn = console.warn;
    console.warn = (msg: any) => { warnCalls.push(String(msg)); };
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  test("returns raw as-is when raw is strict ISO YYYY-MM-DD", () => {
    expect(sanitizeEventDate("2023-05-25", "2026-01-01")).toBe("2023-05-25");
  });

  test("extracts ISO substring from a longer raw string", () => {
    expect(sanitizeEventDate("on 2023-05-25 the user said...", "2026-01-01")).toBe("2023-05-25");
  });

  test("trims whitespace from strict ISO raw", () => {
    expect(sanitizeEventDate("  2023-05-25  ", "2026-01-01")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is undefined", () => {
    expect(sanitizeEventDate(undefined, "2023-05-25")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is null", () => {
    expect(sanitizeEventDate(null, "2023-05-25")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is a non-string type", () => {
    expect(sanitizeEventDate(123 as any, "2023-05-25")).toBe("2023-05-25");
  });

  test("falls back to observationDate when raw is a prose date with no ISO substring", () => {
    expect(sanitizeEventDate("yesterday morning", "2023-05-25")).toBe("2023-05-25");
  });

  test("coerces YYYY/MM/DD observationDate (LongMemEval format) to YYYY-MM-DD", () => {
    expect(sanitizeEventDate(null, "2023/05/25 (Thu) 20:21")).toBe("2023-05-25");
  });

  test("trims observationDate's leading ISO to 10 chars even with trailing junk", () => {
    expect(sanitizeEventDate(null, "2023-05-25T12:34:56Z")).toBe("2023-05-25");
  });

  test("warns + returns observationDate prefix when both inputs are unparseable", () => {
    const result = sanitizeEventDate("totally bad", "May 25 2023");
    expect(result).toBe("May 25 202");  // first 10 chars
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]).toContain("unable to parse");
  });

  test("NEVER returns wall-clock today's date — even when both inputs are nonsense, falls back to observationDate prefix",
    () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = sanitizeEventDate("nope", "garbage-input-string");
    // The 10-char prefix of "garbage-input-string" is "garbage-in" — clearly
    // not today's date. The point: we'd rather propagate the caller's
    // (potentially garbage) intent than silently stamp today, which was the
    // v2.11.0-rc.1 bug.
    expect(result).not.toBe(today);
    expect(result).toBe("garbage-in");
  });
});
