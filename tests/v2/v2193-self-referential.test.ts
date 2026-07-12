// v2.19.3 — self-referential triple guard (Arachne replay finding).

import { describe, expect, test } from "bun:test";
import { isSelfReferentialTriple } from "../../src/v2/llm-extractor";

describe("isSelfReferentialTriple", () => {
  test("subject that is a name-subset of the object (or vice versa) is self-referential", () => {
    expect(isSelfReferentialTriple("Arachne", "Arachne runtime")).toBe(true);
    expect(isSelfReferentialTriple("Arachne runtime", "Arachne")).toBe(true);
    expect(isSelfReferentialTriple("TSMC", "TSMC")).toBe(true);
    expect(isSelfReferentialTriple("mema", "the MEMA")).toBe(true);
  });

  test("genuinely different things pass", () => {
    expect(isSelfReferentialTriple("Arachne", "Datomic")).toBe(false);
    expect(isSelfReferentialTriple("Datomic Free", "Datomic variant")).toBe(false);
    expect(isSelfReferentialTriple("Ardin", "Netcloud AG")).toBe(false);
  });

  test("empty/punctuation-only strings never match", () => {
    expect(isSelfReferentialTriple("", "Arachne")).toBe(false);
    expect(isSelfReferentialTriple("—", "Arachne")).toBe(false);
  });

  // v2.22.12 (l2-extract finding): the ASCII-only tokenizer /[^a-z0-9]+/
  // fragmented accented words ("Zürich" -> {"z","rich"}), so an unrelated side
  // that equalled an ASCII fragment ("Rich") looked like a token SUBSET and a
  // valid distinct triple was dropped as a tautology at the write boundary.
  test("an accented word is not fragmented into an ASCII side (Rich lives in Zürich)", () => {
    // The bug: tokens("Zürich") => {"z","rich"} ⊇ tokens("Rich") => {"rich"}.
    expect(isSelfReferentialTriple("Rich", "Zürich")).toBe(false);
    expect(isSelfReferentialTriple("Zürich", "Rich")).toBe(false);
    // Same shape for other Swiss/German/French/Nordic names this user ingests.
    expect(isSelfReferentialTriple("Genf", "Genève")).toBe(false);
    expect(isSelfReferentialTriple("Mun", "München")).toBe(false);
    expect(isSelfReferentialTriple("Malm", "Malmö")).toBe(false);
    // The no-accent control was already correct before the fix.
    expect(isSelfReferentialTriple("Rich", "Zurich")).toBe(false);
  });

  test("genuine subsets still match after the unicode-aware tokenizer", () => {
    // Accents must not DEFEAT real subset detection either.
    expect(isSelfReferentialTriple("Malmö", "Malmö FF")).toBe(true);
    expect(isSelfReferentialTriple("Genève", "Genève Aéroport")).toBe(true);
    expect(isSelfReferentialTriple("Zürich", "Zürich HB")).toBe(true);
  });
});
