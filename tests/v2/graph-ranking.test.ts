// v2.7.5+ P7 — graph-influenced retrieval ranking tests.
// Covers: buildSupportIndex correctness, graph_support component in
// recall score_components, contradiction penalty.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, invalidateFact } from "../../src/v2/layer2-semantic";
import { recordCognitive } from "../../src/v2/layer3-cognitive";
import { recall } from "../../src/v2/layer5-retrieval";
import { buildSupportIndex } from "../../src/v2/layer5-graph";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-graph-rank-"));
  initAudit(dir);
  initVectorStore(dir);
  return dir;
}

describe("v2.7.5 buildSupportIndex (P7)", () => {
  test("counts derived_from in-degree across facts + cognitive", () => {
    const vault = fresh();
    const ep1 = observe(vault, {
      kind: "document", content: "Ardin founded machtsinn AG.",
      actor: "t", owner: "ardin",
    });
    const ep2 = observe(vault, {
      kind: "document", content: "Ardin uses Bun for runtime.",
      actor: "t", owner: "ardin",
    });
    const fact1 = recordFact(vault, {
      subject: "Ardin", predicate: "founded", object: "machtsinn AG",
      derived_from: [ep1.id], confidence: 0.95,
      actor: "t", owner: "ardin",
    });
    const fact2 = recordFact(vault, {
      subject: "Ardin", predicate: "uses", object: "Bun",
      derived_from: [ep2.id], confidence: 0.95,
      actor: "t", owner: "ardin",
    });
    recordCognitive(vault, {
      kind: "belief",
      content: "Ardin is technically deep, ships pragmatic infrastructure.",
      confidence: 0.9,
      derived_from: [ep1.id, ep2.id, fact1.id, fact2.id],
      actor: "t", owner: "ardin",
    });

    const idx = buildSupportIndex(vault, "ardin");
    // ep1 cited by fact1 + belief = 2 supports
    expect(idx.get(ep1.id)).toBe(2);
    // ep2 cited by fact2 + belief = 2 supports
    expect(idx.get(ep2.id)).toBe(2);
    // fact1 cited by belief = 1 support
    expect(idx.get(fact1.id)).toBe(1);
    expect(idx.get(fact2.id)).toBe(1);
  });

  test("supersedence increments support count too", () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Ardin uses Bun.",
      actor: "t", owner: "ardin",
    });
    const oldFact = recordFact(vault, {
      subject: "Ardin", predicate: "uses", object: "Bun",
      derived_from: [ep.id], confidence: 0.95,
      actor: "t", owner: "ardin",
    });
    const newFact = recordFact(vault, {
      subject: "Ardin", predicate: "uses", object: "Bun-with-watch",
      derived_from: [ep.id], confidence: 0.95,
      actor: "t", owner: "ardin",
    });
    invalidateFact(vault, oldFact.id, "ardin", "t", newFact.id);

    const idx = buildSupportIndex(vault, "ardin");
    // newFact supersedes oldFact → oldFact gains a superseded_by reference
    expect(idx.get(newFact.id) ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("v2.7.5 recall surfaces graph signals (P7)", () => {
  test("score_components include graph_support, recency, contradiction", async () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Marcel runs Azure infrastructure for machtsinn AG.",
      actor: "t", owner: "ardin",
    });
    const fact = recordFact(vault, {
      subject: "Marcel", predicate: "runs", object: "Azure infrastructure",
      derived_from: [ep.id], confidence: 0.95,
      actor: "t", owner: "ardin",
    });
    const result = await recall(vault, {
      query: "Marcel Azure",
      owner: "ardin",
      actor: "t",
      purpose: "test",
      kinds: ["fact"],
      use_vector: false,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    const h = result.hits[0];
    expect(h.score_components).toHaveProperty("graph_support");
    expect(h.score_components).toHaveProperty("recency");
    expect(h.score_components).toHaveProperty("contradiction");
    expect(h.score_components.contradiction).toBe(0);
    // ep is cited by fact → fact derived_from chain → ep support = 1
    // fact itself has no incoming citations → graph_support = 0
    expect(h.score_components.graph_support).toBe(0);
  });

  test("contradicted facts are de-ranked vs clean facts", async () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "document", content: "Bob uses Python and Bob uses Go.",
      actor: "t", owner: "ardin",
    });
    const cleanFact = recordFact(vault, {
      subject: "Bob", predicate: "uses", object: "Go",
      derived_from: [ep.id], confidence: 0.9,
      actor: "t", owner: "ardin",
    });
    const oldFact = recordFact(vault, {
      subject: "Bob", predicate: "uses", object: "Python",
      derived_from: [ep.id], confidence: 0.9,
      actor: "t", owner: "ardin",
    });
    invalidateFact(vault, oldFact.id, "ardin", "t");

    const result = await recall(vault, {
      query: "Bob uses",
      owner: "ardin",
      actor: "t",
      purpose: "test",
      kinds: ["fact"],
      use_vector: false,
    });
    // Both facts match (both are queryable at "now" — invalidated_at is at
    // recall time and we use "lt" semantics so it stays visible). But the
    // invalidated one should rank LOWER because of the contradiction penalty.
    const clean = result.hits.find(h => h.id === cleanFact.id);
    const old = result.hits.find(h => h.id === oldFact.id);
    if (clean && old) {
      expect(clean.score).toBeGreaterThan(old.score);
      expect(clean.score_components.contradiction).toBe(0);
      expect(old.score_components.contradiction).toBe(1);
    } else {
      // At minimum the contradicted one shouldn't rank ABOVE the clean one
      expect(result.hits[0].id).toBe(cleanFact.id);
    }
  });
});
