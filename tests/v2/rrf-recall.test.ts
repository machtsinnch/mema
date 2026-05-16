// v2.10.0+ RRF fusion in /v2/recall end-to-end.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact } from "../../src/v2/layer2-semantic";
import { recall } from "../../src/v2/layer5-retrieval";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-rrf-recall-"));
  initAudit(dir);
  initVectorStore(dir);
  return dir;
}

describe("recall fusion strategies", () => {
  test("weighted is the default", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "alpha beta gamma", actor: "t", owner: "ardin" });
    recordFact(vault, {
      subject: "alpha", predicate: "is_a", object: "letter",
      derived_from: [ep.id], confidence: 0.9, actor: "t", owner: "ardin",
    });
    const r = await recall(vault, {
      query: "alpha", owner: "ardin", actor: "t", purpose: "test",
      use_vector: false,
    });
    expect(r.hits.length).toBeGreaterThan(0);
    // weighted mode: score_components has NO rrf field
    expect(r.hits[0].score_components).not.toHaveProperty("rrf");
    rmSync(vault, { recursive: true, force: true });
  });

  test("fusion=rrf injects an rrf score_component", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "alpha beta gamma", actor: "t", owner: "ardin" });
    recordFact(vault, {
      subject: "alpha", predicate: "is_a", object: "letter",
      derived_from: [ep.id], confidence: 0.9, actor: "t", owner: "ardin",
    });
    const r = await recall(vault, {
      query: "alpha", owner: "ardin", actor: "t", purpose: "test",
      use_vector: false, fusion: "rrf",
    });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].score_components).toHaveProperty("rrf");
    expect(r.hits[0].score_components.rrf).toBeGreaterThan(0);
    // RRF score replaces the weighted score
    expect(r.hits[0].score).toBe(r.hits[0].score_components.rrf as number);
    rmSync(vault, { recursive: true, force: true });
  });

  test("both modes return the same hit set (ordering may differ)", async () => {
    const vault = fresh();
    for (let i = 0; i < 5; i++) {
      const ep = observe(vault, {
        kind: "document", content: `doc ${i} alpha beta`,
        actor: "t", owner: "ardin",
      });
      recordFact(vault, {
        subject: `doc${i}`, predicate: "contains", object: "alpha",
        derived_from: [ep.id], confidence: 0.9, actor: "t", owner: "ardin",
      });
    }
    const w = await recall(vault, { query: "alpha", owner: "ardin", actor: "t", purpose: "t", use_vector: false });
    const rrf = await recall(vault, { query: "alpha", owner: "ardin", actor: "t", purpose: "t", use_vector: false, fusion: "rrf" });
    const wIds = new Set(w.hits.map(h => h.id));
    const rIds = new Set(rrf.hits.map(h => h.id));
    expect(wIds.size).toBe(rIds.size);
    for (const id of wIds) expect(rIds.has(id)).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });
});
