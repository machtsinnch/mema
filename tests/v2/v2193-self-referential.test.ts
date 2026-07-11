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
});
