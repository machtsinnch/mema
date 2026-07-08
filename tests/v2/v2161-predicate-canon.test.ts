// v2.16.1 — canonical predicate normalization: synonym phrasings tally
// together in consensus voting and meet each other in supersession.
// Motivated by the 2026-07-08 stability run where "Princeton
// developed/created/founded CoALA" (3 passes, unanimous in spirit) died
// as three 1-vote strangers.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPredicate } from "../../src/v2/predicates";
import { consensusMerge, type ExtractionResult } from "../../src/v2/llm-extractor";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFactWithSupersession, readFact } from "../../src/v2/layer2-semantic";
import { initAudit } from "../../src/v2/layer6-audit";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2161-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("canonicalPredicate", () => {
  test("maps synonym classes to one canonical form", () => {
    expect(canonicalPredicate("developed")).toBe("created");
    expect(canonicalPredicate("founded")).toBe("created");
    expect(canonicalPredicate("depends_on")).toBe("uses");
    expect(canonicalPredicate("stands_for")).toBe("is_a");
    expect(canonicalPredicate("works_for")).toBe("works_at");
    expect(canonicalPredicate("employed_by")).toBe("works_at");
    expect(canonicalPredicate("located_in")).toBe("based_in");
  });
  test("normalizes case/whitespace; unknown predicates pass through", () => {
    expect(canonicalPredicate(" Depends On ")).toBe("uses");
    expect(canonicalPredicate("supersedes")).toBe("supersedes");
    expect(canonicalPredicate("published")).toBe("published");  // deliberately NOT merged with created
  });
});

describe("consensus voting through predicate synonyms", () => {
  const pass = (p: string): ExtractionResult => ({
    facts: [{ subject: "Princeton", predicate: p, object: "CoALA", confidence: 0.9, event_date: null }],
    entities: [],
  });

  test("developed/created/founded tally as ONE 3-vote fact", () => {
    const merged = consensusMerge([pass("developed"), pass("created"), pass("founded")]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].votes).toBe(3);
    // Display keeps the first surface form.
    expect(merged.facts[0].predicate).toBe("developed");
  });

  test("non-synonym predicates still form separate candidates", () => {
    const merged = consensusMerge([pass("created"), pass("published"), pass("rejected")]);
    expect(merged.facts.length).toBe(0);  // 1 vote each, threshold 2
  });
});

describe("supersession through predicate synonyms", () => {
  test("'employed_by Google' is superseded by 'works_at Anthropic'", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const old = recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "employed_by", object: "Google",
      valid_from: "2020-03-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    const next = recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "works_at", object: "Anthropic",
      valid_from: "2026-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(next.decision.kind).toBe("UPDATE");
    expect(next.supersededIds).toContain(old.written!.id);
    expect(readFact(vault, "o", old.written!.id)?.superseded_by).toBe(next.written!.id);
    rmSync(vault, { recursive: true, force: true });
  });

  test("synonym duplicate is skipped (same object, same date, different verb)", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "works_for", object: "Anthropic",
      valid_from: "2026-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    const dup = recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "works_at", object: "Anthropic",
      valid_from: "2026-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(dup.written).toBeNull();
    expect(dup.decision.kind).toBe("NONE");
    rmSync(vault, { recursive: true, force: true });
  });
});
