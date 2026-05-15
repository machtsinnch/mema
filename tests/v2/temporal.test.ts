// v2.7.4+ temporal comparison (W8): epoch-ms compare instead of string
// compare. Tests robustness across mixed ISO formats and edge cases.

import { describe, expect, test } from "bun:test";
import { toEpochMs, factValidAt, factValidSince } from "../../src/v2/temporal";

describe("toEpochMs", () => {
  test("parses ISO-8601 UTC", () => {
    expect(toEpochMs("2026-05-15T10:00:00Z")).toBeGreaterThan(0);
  });
  test("parses ISO-8601 with offset", () => {
    expect(toEpochMs("2026-05-15T10:00:00+02:00")).toBeGreaterThan(0);
  });
  test("parses date-only", () => {
    expect(toEpochMs("2026-05-15")).toBeGreaterThan(0);
  });
  test("null for empty/null/undefined", () => {
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs("")).toBeNull();
  });
  test("null for unparseable", () => {
    expect(toEpochMs("not a date")).toBeNull();
  });
});

describe("factValidAt — mixed-format robustness", () => {
  test("same instant in different ISO formats compares equal", () => {
    // 10:00:00 +02:00 == 08:00:00 UTC
    const utc = "2026-05-15T08:00:00Z";
    const cet = "2026-05-15T10:00:00+02:00";
    // Fact valid from CET instant, query at UTC instant → should be valid.
    expect(factValidAt({ valid_from: cet, valid_to: null }, utc)).toBe(true);
  });

  test("query before valid_from → not valid", () => {
    const fact = { valid_from: "2026-05-15T10:00:00Z", valid_to: null };
    expect(factValidAt(fact, "2026-05-15T09:00:00Z")).toBe(false);
  });

  test("query after valid_to → not valid", () => {
    const fact = {
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: "2026-05-15T10:00:00Z",
    };
    expect(factValidAt(fact, "2026-05-15T11:00:00Z")).toBe(false);
  });

  test("invalidated_at lte semantics: invalidated AT query time = not valid", () => {
    const fact = {
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: null,
      invalidated_at: "2026-05-15T10:00:00Z",
    };
    expect(factValidAt(fact, "2026-05-15T10:00:00Z", "lte")).toBe(false);
    expect(factValidAt(fact, "2026-05-15T09:59:59Z", "lte")).toBe(true);
  });

  test("invalidated_at lt semantics: invalidated AT query time = still valid", () => {
    const fact = {
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: null,
      invalidated_at: "2026-05-15T10:00:00Z",
    };
    expect(factValidAt(fact, "2026-05-15T10:00:00Z", "lt")).toBe(true);
    expect(factValidAt(fact, "2026-05-15T10:00:01Z", "lt")).toBe(false);
  });

  test("open-ended valid_to (null) = no expiry", () => {
    const fact = { valid_from: "2020-01-01T00:00:00Z", valid_to: null };
    expect(factValidAt(fact, "2099-01-01T00:00:00Z")).toBe(true);
  });

  test("unparseable timestamps are conservative — never crash", () => {
    expect(factValidAt({ valid_from: "garbage", valid_to: null }, "2026-05-15T10:00:00Z")).toBe(true);
    expect(factValidAt({ valid_from: "2026-05-15T10:00:00Z" }, "garbage")).toBe(false);
  });

  test("date-only timestamps work alongside full ISO timestamps", () => {
    // valid_from is a bare date; query is full ISO. The bare date parses as
    // midnight UTC, so 12:00 UTC same day is after that.
    const fact = { valid_from: "2026-05-15", valid_to: null };
    expect(factValidAt(fact, "2026-05-15T12:00:00Z")).toBe(true);
    expect(factValidAt(fact, "2026-05-14T23:59:59Z")).toBe(false);
  });
});

describe("factValidSince", () => {
  test("fact created after cutoff = included", () => {
    expect(factValidSince({ valid_from: "2026-05-15T10:00:00Z" }, "2026-05-14T00:00:00Z")).toBe(true);
  });
  test("fact created before cutoff = excluded", () => {
    expect(factValidSince({ valid_from: "2026-05-13T10:00:00Z" }, "2026-05-14T00:00:00Z")).toBe(false);
  });
  test("equal timestamps = included (>= semantics)", () => {
    expect(factValidSince({ valid_from: "2026-05-14T00:00:00Z" }, "2026-05-14T00:00:00Z")).toBe(true);
  });
});
