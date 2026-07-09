// v2.16.2 — subject/object surface-variance normalization in consensus
// voting, anchored to the passes' own entity declarations. "Princeton" and
// "Princeton research team" must tally together; "Claude" and "Claude
// model family" (both declared entities) must NOT collapse.

import { describe, expect, test } from "bun:test";
import { consensusMerge, type ExtractionResult } from "../../src/v2/llm-extractor";

function pass(
  facts: Array<[string, string, string]>,
  entities: Array<[string, string]>,
): ExtractionResult {
  return {
    facts: facts.map(([subject, predicate, object]) => ({
      subject, predicate, object, confidence: 0.9, event_date: null,
    })),
    entities: entities.map(([name, type]) => ({ name, type })),
  };
}

const PRINCETON = [["Princeton", "organization"]] as Array<[string, string]>;

describe("surface variance unified via entity anchoring", () => {
  test("Princeton / Princeton research team / created-developed-founded → one 3/3 fact", () => {
    const merged = consensusMerge([
      pass([["Princeton", "created", "CoALA"]], PRINCETON),
      pass([["Princeton research team", "developed", "CoALA"]], PRINCETON),
      pass([["Princeton", "founded", "CoALA"]], PRINCETON),
    ]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].votes).toBe(3);
    // Display normalized to the canonical entity name.
    expect(merged.facts[0].subject).toBe("Princeton");
  });

  test("object refs normalize too", () => {
    const merged = consensusMerge([
      pass([["Sumers", "authored", "CoALA"]], [["CoALA", "concept"]]),
      pass([["Sumers", "authored", "the CoALA paper"]], [["CoALA", "concept"]]),
      pass([], [["CoALA", "concept"]]),
    ]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].votes).toBe(2);
    expect(merged.facts[0].object).toBe("CoALA");
  });
});

describe("guards — when NOT to merge", () => {
  test("exact entity names never collapse into each other", () => {
    const ents = [["Claude", "product"], ["Claude model family", "product"]] as Array<[string, string]>;
    const merged = consensusMerge([
      pass([["Anthropic", "develops", "Claude model family"]], ents),
      pass([["Anthropic", "develops", "Claude model family"]], ents),
      pass([["Anthropic", "develops", "Claude"]], ents),
    ]);
    // Two distinct candidates: family fact 2/3 kept, bare-Claude fact 1/3 dropped.
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].object).toBe("Claude model family");
    expect(merged.facts[0].votes).toBe(2);
  });

  test("ambiguous containment keeps the surface form", () => {
    const ents = [["Google", "organization"], ["Cloud", "concept"]] as Array<[string, string]>;
    const merged = consensusMerge([
      pass([["Marcel", "works_at", "Google Cloud Platform"]], ents),
      pass([["Marcel", "works_at", "Google Cloud Platform"]], ents),
      pass([], ents),
    ]);
    // Both entities are contained → ambiguous → no normalization, but the
    // two identical surface forms still tally together.
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].object).toBe("Google Cloud Platform");
  });

  test("unanchored refs keep their surface form and stay separate", () => {
    const merged = consensusMerge([
      pass([["princeton research team", "created", "CoALA"]], []),
      pass([["Princeton", "created", "CoALA"]], []),
      pass([["Princeton", "created", "CoALA"]], []),
    ]);
    // No entity anchor → the long form is its own candidate (1 vote, dropped);
    // the short form survives with 2 votes.
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].subject).toBe("Princeton");
    expect(merged.facts[0].votes).toBe(2);
  });

  test("token-boundary only — 'ai' inside 'brain' does not anchor", () => {
    const merged = consensusMerge([
      pass([["Brainstorm Inc", "uses", "Bun"]], [["AI", "concept"]]),
      pass([["Brainstorm Inc", "uses", "Bun"]], [["AI", "concept"]]),
      pass([], [["AI", "concept"]]),
    ]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].subject).toBe("Brainstorm Inc");
  });
});
