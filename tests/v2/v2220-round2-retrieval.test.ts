// v2.22.0 — regression tests for review-round-2 retrieval + security fixes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { morphVariants } from "../../src/v2/layer5-retrieval";
import { recall } from "../../src/v2/layer5-retrieval";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, annotateFactVerification, pathForFact } from "../../src/v2/layer2-semantic";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2220-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("morphVariants: no degenerate stems", () => {
  test("short words do not emit 1-2 char stems", () => {
    for (const w of ["ring", "king", "sing", "bed", "led"]) {
      for (const v of morphVariants(w)) expect(v.length).toBeGreaterThanOrEqual(3);
    }
  });
  test("real stemming still works", () => {
    expect(morphVariants("using")).toContain("use");
    expect(morphVariants("build")).toContain("built");   // irregular
    expect(morphVariants("deployed")).toContain("deploy");
  });
});

describe("recall survives regex-metachar query tokens (R2)", () => {
  test("a token with unbalanced parens does not crash recall", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "The formula sin(x) appears here.", actor: "t", owner: "o" });
    recordFact(vault, { subject: "formula", predicate: "mentions", object: "sin", derived_from: [ep.id], actor: "t", owner: "o" });
    const r = await recall(vault, { query: "sin(x", owner: "o", actor: "t", purpose: "test" });
    expect(Array.isArray(r.hits)).toBe(true);   // no throw
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("RRF fusion still demotes contradicted facts (R4)", () => {
  test("a web-contradicted fact ranks below an equal clean one under fusion=rrf", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "chip fabs", actor: "t", owner: "o" });
    const clean = recordFact(vault, { subject: "Quorix", predicate: "headquartered_in", object: "Zug", derived_from: [ep.id], actor: "t", owner: "o" });
    const wrong = recordFact(vault, { subject: "Quorix", predicate: "headquartered_in", object: "Berlin", derived_from: [ep.id], actor: "t", owner: "o" });
    annotateFactVerification(vault, "o", wrong.id, { verdict: "contradicted", note: "HQ is Zug.", sources: ["https://x"] }, "t");
    const r = await recall(vault, { query: "Quorix headquartered", owner: "o", actor: "t", purpose: "test", fusion: "rrf" });
    const cleanHit = r.hits.find(h => h.kind === "fact" && h.id === clean.id);
    const wrongHit = r.hits.find(h => h.kind === "fact" && h.id === wrong.id);
    expect(cleanHit!.score).toBeGreaterThan(wrongHit!.score);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("IDF is owner-scoped (R5)", () => {
  test("another owner's documents do not change my idf", async () => {
    const vault = fresh();
    const epA = observe(vault, { kind: "document", content: "zorptastic widget", actor: "a", owner: "alice" });
    recordFact(vault, { subject: "zorptastic", predicate: "is_a", object: "widget", derived_from: [epA.id], actor: "a", owner: "alice" });
    const r1 = await recall(vault, { query: "zorptastic", owner: "alice", actor: "a", purpose: "test" });
    const idf1 = r1.hits.find(h => h.kind === "fact")?.score_components?.idf;
    // Bob floods the vault with the same rare term.
    for (let i = 0; i < 5; i++) {
      const epB = observe(vault, { kind: "document", content: "zorptastic zorptastic", actor: "b", owner: "bob" });
      recordFact(vault, { subject: "zorptastic", predicate: "is_a", object: `thing${i}`, derived_from: [epB.id], actor: "b", owner: "bob" });
    }
    const r2 = await recall(vault, { query: "zorptastic", owner: "alice", actor: "a", purpose: "test" });
    const idf2 = r2.hits.find(h => h.kind === "fact")?.score_components?.idf;
    expect(idf2).toBe(idf1);   // bob's docs are invisible to alice's scoring
    rmSync(vault, { recursive: true, force: true });
  });
});
