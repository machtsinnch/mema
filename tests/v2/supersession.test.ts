// Tests for src/v2/layer4-supersession.ts — the v2.14.0 write-time
// supersession classifier.
//
// Per Ardin's architectural commitment (2026-05-17): every layer is
// mandatory and deterministic in contract. classifyOnWrite is the pure
// function at the core of that determinism for facts — given the new
// candidate and the pre-filtered same-(subject,predicate) candidate set,
// the decision is purely structural.

import { describe, test, expect } from "bun:test";
import { classifyOnWrite, type NewFactCandidate } from "../../src/v2/layer4-supersession";
import type { SemanticFact } from "../../src/v2/types";

// Tiny fixture helper — only the fields classifyOnWrite reads.
function fact(
  id: string,
  subject: string,
  predicate: string,
  object: string,
  valid_from: string,
  opts: Partial<SemanticFact> = {},
): SemanticFact {
  return {
    id,
    subject,
    predicate,
    object,
    valid_from,
    valid_to: opts.valid_to ?? null,
    invalidated_at: opts.invalidated_at ?? null,
    superseded_by: opts.superseded_by ?? null,
    derived_from: opts.derived_from ?? [],
    confidence: opts.confidence ?? 0.95,
    owner: opts.owner ?? "test",
    status: opts.status ?? "approved",
  };
}

const NEW = (object: string, event_date: string): NewFactCandidate => ({
  subject: "User",
  predicate: "lives_in",
  object,
  event_date,
});

describe("classifyOnWrite — pure structural classifier", () => {
  test("ADD when no candidates exist", () => {
    expect(classifyOnWrite(NEW("Berlin", "2025-03-01"), [])).toEqual({ kind: "ADD" });
  });

  test("NONE/duplicate when an existing fact has same object AND same date", () => {
    const candidates = [
      fact("f1", "User", "lives_in", "Berlin", "2025-03-01"),
    ];
    expect(classifyOnWrite(NEW("Berlin", "2025-03-01"), candidates)).toEqual({
      kind: "NONE",
      reason: "duplicate",
    });
  });

  test("NONE/stale when same object is already known at a LATER date", () => {
    // We're trying to add a fact dated 2024-01-01 but we already know
    // "User lives_in Berlin (2025-03-01)" — the new one is stale.
    const candidates = [
      fact("f1", "User", "lives_in", "Berlin", "2025-03-01"),
    ];
    expect(classifyOnWrite(NEW("Berlin", "2024-01-01"), candidates)).toEqual({
      kind: "NONE",
      reason: "stale",
    });
  });

  test("UPDATE marks older different-object facts as superseded", () => {
    // We're adding "User lives_in Berlin (2025-03-01)" and we already know
    // "User lives_in Munich (2023-06-15)" — Munich gets superseded.
    const candidates = [
      fact("f-munich", "User", "lives_in", "Munich", "2023-06-15"),
    ];
    const d = classifyOnWrite(NEW("Berlin", "2025-03-01"), candidates);
    expect(d.kind).toBe("UPDATE");
    if (d.kind === "UPDATE") {
      expect(d.superseded).toHaveLength(1);
      expect(d.superseded[0].id).toBe("f-munich");
    }
  });

  test("UPDATE includes ALL older different-object facts (multi-supersede)", () => {
    // Three older different-object facts: Munich (2023), Hamburg (2024-Q1),
    // Frankfurt (2024-Q3). All get superseded by Berlin (2025).
    const candidates = [
      fact("f-munich",    "User", "lives_in", "Munich",    "2023-06-15"),
      fact("f-hamburg",   "User", "lives_in", "Hamburg",   "2024-02-10"),
      fact("f-frankfurt", "User", "lives_in", "Frankfurt", "2024-08-20"),
    ];
    const d = classifyOnWrite(NEW("Berlin", "2025-03-01"), candidates);
    expect(d.kind).toBe("UPDATE");
    if (d.kind === "UPDATE") {
      expect(d.superseded).toHaveLength(3);
      expect(d.superseded.map(f => f.id).sort()).toEqual(
        ["f-frankfurt", "f-hamburg", "f-munich"]
      );
    }
  });

  test("UPDATE skips already-invalidated candidates (defense-in-depth)", () => {
    // Caller is supposed to pre-filter these via findContradictions, but
    // belt-and-suspenders: even if a stale candidate slips in, we don't
    // re-supersede it.
    const candidates = [
      fact("f-munich",  "User", "lives_in", "Munich",  "2023-06-15", {
        invalidated_at: "2024-01-01",
        superseded_by: "f-hamburg",
      }),
      fact("f-hamburg", "User", "lives_in", "Hamburg", "2024-01-01"),
    ];
    const d = classifyOnWrite(NEW("Berlin", "2025-03-01"), candidates);
    expect(d.kind).toBe("UPDATE");
    if (d.kind === "UPDATE") {
      // Only Hamburg (still current) is superseded; Munich (already
      // invalidated) is correctly skipped.
      expect(d.superseded).toHaveLength(1);
      expect(d.superseded[0].id).toBe("f-hamburg");
    }
  });

  test("ADD on historical backfill — new fact OLDER than existing newer fact", () => {
    // We already know "User lives_in Berlin (2025-03-01)". A late observation
    // arrives: "User lives_in Munich (2023-06-15)". The Munich fact is OLDER
    // than the current Berlin fact — Munich is historically true but doesn't
    // supersede Berlin. Just ADD; readers use factValidAt to surface the
    // correct one for any given query date.
    const candidates = [
      fact("f-berlin", "User", "lives_in", "Berlin", "2025-03-01"),
    ];
    expect(classifyOnWrite(NEW("Munich", "2023-06-15"), candidates)).toEqual({ kind: "ADD" });
  });

  test("case-insensitive object comparison", () => {
    // "berlin" lowercase vs "Berlin" capitalized should still be duplicate.
    const candidates = [
      fact("f1", "User", "lives_in", "Berlin", "2025-03-01"),
    ];
    expect(classifyOnWrite(NEW("berlin", "2025-03-01"), candidates)).toEqual({
      kind: "NONE",
      reason: "duplicate",
    });
  });

  test("whitespace trimming on object", () => {
    const candidates = [
      fact("f1", "User", "lives_in", "Berlin", "2025-03-01"),
    ];
    expect(classifyOnWrite(NEW("  Berlin  ", "2025-03-01"), candidates)).toEqual({
      kind: "NONE",
      reason: "duplicate",
    });
  });

  test("event_date truncation to YYYY-MM-DD (handles ISO datetimes)", () => {
    // If a caller passes "2025-03-01T10:00:00Z" we should still compare
    // it as "2025-03-01".
    const candidates = [
      fact("f1", "User", "lives_in", "Berlin", "2025-03-01"),
    ];
    expect(classifyOnWrite({
      subject: "User",
      predicate: "lives_in",
      object: "Berlin",
      event_date: "2025-03-01T10:00:00Z",
    }, candidates)).toEqual({ kind: "NONE", reason: "duplicate" });
  });

  test("missing valid_from in candidate treated as empty (sorts BEFORE any date)", () => {
    // Defensive: if a candidate has no valid_from somehow, it sorts as ""
    // which is < any YYYY-MM-DD. So it should always be considered older.
    const candidates = [
      fact("f-undated", "User", "lives_in", "Unknown", ""),
    ];
    const d = classifyOnWrite(NEW("Berlin", "2025-03-01"), candidates);
    expect(d.kind).toBe("UPDATE");
    if (d.kind === "UPDATE") {
      expect(d.superseded).toHaveLength(1);
      expect(d.superseded[0].id).toBe("f-undated");
    }
  });
});
