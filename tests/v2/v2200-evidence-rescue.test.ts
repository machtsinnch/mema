// v2.20.0 — evidence-rescue gate: below-majority facts survive only with
// a verbatim quote from the source naming both sides of the triple.

import { describe, expect, test } from "bun:test";
import { consensusMerge, evidencePassesGate, type ExtractionResult } from "../../src/v2/llm-extractor";

const SOURCE = `Chimera supports assert-only databases for simple stores.
Chimera adapters must implement the migrate operation before use.
The weather was nice that day. Boot handles the asset pipeline since 2016.`;

const pass = (facts: ExtractionResult["facts"]): ExtractionResult =>
  ({ facts, entities: [] });

const f = (subject: string, predicate: string, object: string, evidence: string | null, extra: object = {}) =>
  ({ subject, predicate, object, confidence: 0.9, evidence, ...extra });

describe("evidencePassesGate", () => {
  test("verbatim sentence naming both sides passes; whitespace differences tolerated", () => {
    expect(evidencePassesGate(
      f("Chimera", "supports", "assert-only databases", "Chimera supports  assert-only\ndatabases for simple stores."),
      SOURCE,
    )).toBe(true);
  });

  test("paraphrase, missing side, short quote, or no evidence all fail", () => {
    expect(evidencePassesGate(f("Chimera", "supports", "assert-only databases",
      "Chimera can work with assert-only stores."), SOURCE)).toBe(false);      // paraphrase
    expect(evidencePassesGate(f("Chimera", "enjoys", "weather",
      "The weather was nice that day."), SOURCE)).toBe(false);                 // no subject in quote
    expect(evidencePassesGate(f("Chimera", "is_a", "tool", "Chimera adapters"), SOURCE)).toBe(false); // too short
    expect(evidencePassesGate(f("Chimera", "supports", "assert-only databases", null), SOURCE)).toBe(false);
  });
});

describe("consensusMerge with evidence rescue", () => {
  const p1 = pass([
    f("Chimera", "supports", "assert-only databases", "Chimera supports assert-only databases for simple stores."),
    f("Chimera adapters", "implements", "migrate", "Chimera adapters must implement the migrate operation before use."),
  ]);
  const p2 = pass([
    f("Chimera", "supports", "assert-only databases", "Chimera supports assert-only databases for simple stores."),
    f("Boot", "handles", "asset pipeline", "Boot handles the asset pipeline since 2016.", { event_date: "2016" }),
  ]);
  const p3 = pass([
    f("Chimera", "supports", "assert-only databases", "Chimera supports assert-only databases for simple stores."),
    f("Chimera", "likes", "weather", "It was widely considered a pleasant afternoon overall."),
  ]);

  test("majority facts unchanged; verbatim singletons rescued at capped confidence; junk still dies", () => {
    const r = consensusMerge([p1, p2, p3], SOURCE);
    const by = (s: string) => r.facts.find(x => x.subject === s);
    // 3/3 majority: full confidence, not marked rescued.
    expect(by("Chimera")?.votes).toBe(3);
    expect(by("Chimera")?.evidence_verified).toBeUndefined();
    expect(by("Chimera")?.confidence).toBeCloseTo(0.9);
    // 1/3 with verbatim evidence: rescued, capped, marked.
    const adapters = by("Chimera adapters")!;
    expect(adapters.evidence_verified).toBe(true);
    expect(adapters.confidence).toBeLessThanOrEqual(0.6);
    expect(adapters.votes).toBe(1);
    // 1/3 with dated verbatim evidence: date kept because year is in the quote.
    expect(by("Boot")?.event_date).toBe("2016");
    // 1/3 with non-verbatim quote: gone.
    expect(r.facts.some(x => x.predicate === "likes")).toBe(false);
  });

  test("no source text → old strict behavior (back-compat)", () => {
    const r = consensusMerge([p1, p2, p3]);
    expect(r.facts).toHaveLength(1);           // only the 3/3 fact
    expect(r.facts[0].subject).toBe("Chimera");
  });

  test("rescued fact drops a date whose year is not in the quote", () => {
    const rp = pass([
      f("Chimera adapters", "implements", "migrate",
        "Chimera adapters must implement the migrate operation before use.", { event_date: "2019" }),
    ]);
    const other = pass([f("Chimera", "supports", "assert-only databases", "Chimera supports assert-only databases for simple stores.")]);
    const r = consensusMerge([rp, other, other], SOURCE);
    const resc = r.facts.find(x => x.subject === "Chimera adapters")!;
    expect(resc.evidence_verified).toBe(true);
    expect(resc.event_date).toBeNull();
  });
});
