// v2.16.0 — consensus extraction: N parallel passes per chunk, majority
// vote on normalized triples. Stabilizes the one nondeterministic step in
// L1→L2 (the same document yielded 4 facts on one run, 25 on the next).

import { describe, expect, test } from "bun:test";
import { consensusMerge, type ExtractionResult } from "../../src/v2/llm-extractor";

const pass = (facts: Array<[string, string, string, number?, (string | null)?]>, entities: Array<[string, string]> = []): ExtractionResult => ({
  facts: facts.map(([subject, predicate, object, confidence, event_date]) => ({
    subject, predicate, object, confidence: confidence ?? 0.9, event_date: event_date ?? null,
  })),
  entities: entities.map(([name, type]) => ({ name, type })),
});

describe("consensusMerge — fact voting", () => {
  test("2-of-3 triples survive, 1-of-3 dropped, votes recorded", () => {
    const merged = consensusMerge([
      pass([["Marcel", "works_at", "Google"], ["Team", "is_a", "machine"]]),
      pass([["Marcel", "works_at", "Google"]]),
      pass([["marcel", "works_at", "GOOGLE"]]),  // normalization: case-insensitive
    ]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].subject).toBe("Marcel");
    expect(merged.facts[0].votes).toBe(3);
    expect(merged.facts[0].passes).toBe(3);
  });

  test("confidence is the mean of agreeing passes", () => {
    const merged = consensusMerge([
      pass([["A", "uses", "B", 0.95]]),
      pass([["A", "uses", "B", 0.85]]),
      pass([]),
    ]);
    expect(merged.facts[0].confidence).toBeCloseTo(0.9);
    expect(merged.facts[0].votes).toBe(2);
  });

  test("duplicate triple within ONE pass counts as one vote", () => {
    const merged = consensusMerge([
      pass([["A", "uses", "B"], ["A", "uses", "B"]]),
      pass([]),
      pass([]),
    ]);
    expect(merged.facts.length).toBe(0);  // 1 vote < threshold 2
  });

  test("single successful pass → threshold 1, everything kept", () => {
    const merged = consensusMerge([pass([["A", "uses", "B"]])]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].votes).toBe(1);
    expect(merged.facts[0].passes).toBe(1);
  });
});

describe("consensusMerge — event_date needs its own majority", () => {
  test("date agreed by 2 of 3 passes is kept", () => {
    const merged = consensusMerge([
      pass([["MS", "works_at", "Google", 0.9, "2020-03"]]),
      pass([["MS", "works_at", "Google", 0.9, "2020-03"]]),
      pass([["MS", "works_at", "Google", 0.9, null]]),
    ]);
    expect(merged.facts[0].event_date).toBe("2020-03");
  });

  test("date hallucinated by a single pass is dropped from an agreed triple", () => {
    const merged = consensusMerge([
      pass([["MS", "works_at", "Google", 0.9, "2019-01"]]),  // outlier date
      pass([["MS", "works_at", "Google", 0.9, null]]),
      pass([["MS", "works_at", "Google", 0.9, null]]),
    ]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].event_date).toBeNull();
  });
});

describe("consensusMerge — entity voting and rescue", () => {
  test("majority entities kept, 1-vote unreferenced entity dropped", () => {
    const merged = consensusMerge([
      pass([], [["Google", "organization"], ["Noise Corp", "organization"]]),
      pass([], [["Google", "organization"]]),
      pass([], [["Google", "organization"]]),
    ]);
    expect(merged.entities.map(e => e.name)).toEqual(["Google"]);
  });

  test("1-vote entity referenced by a surviving fact is rescued", () => {
    const merged = consensusMerge([
      pass([["Marcel", "works_at", "Google"]], [["Marcel", "person"]]),
      pass([["Marcel", "works_at", "Google"]], []),
      pass([], []),
    ]);
    expect(merged.facts.length).toBe(1);
    expect(merged.entities.map(e => e.name)).toContain("Marcel");
  });
});
