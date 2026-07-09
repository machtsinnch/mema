// v2.16.3 — query expansion in keyword retrieval: morphological variants
// ("build" finds "built") and relation-class expansion ("employer" finds
// works_at facts). Motivated by the 2026-07-09 personal-corpus battery
// where both facts EXISTED in L2 but never surfaced.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { morphVariants, recall } from "../../src/v2/layer5-retrieval";
import { relationVariants } from "../../src/v2/predicates";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact } from "../../src/v2/layer2-semantic";
import { initAudit } from "../../src/v2/layer6-audit";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2163-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("expansion primitives", () => {
  test("morphVariants covers irregulars and suffixes", () => {
    expect(morphVariants("build")).toContain("built");
    expect(morphVariants("holds")).toContain("held");
    expect(morphVariants("deploy")).toContain("deployed");
    expect(morphVariants("using")).toContain("use");
  });
  test("relationVariants maps role words to predicate surface forms", () => {
    expect(relationVariants("employer")).toContain("works_at");
    expect(relationVariants("employer")).toContain("employed_by");
    expect(relationVariants("built")).toContain("created");
    expect(relationVariants("banana")).toEqual([]);
  });
});

describe("recall through expansions (keyword path, vector off)", () => {
  test("'build' query finds a 'built' fact", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "cv", actor: "t", owner: "o" });
    recordFact(vault, {
      subject: "Ardin Ibraimi", predicate: "built", object: "Managed Cloud Foundation",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = await recall(vault, {
      query: "what did Ardin build", owner: "o", actor: "t",
      purpose: "test", use_vector: false, limit: 5,
    } as any);
    const factHit = r.hits.find(h => h.kind === "fact");
    expect(factHit?.payload?.object).toBe("Managed Cloud Foundation");
    rmSync(vault, { recursive: true, force: true });
  });

  test("'employer' query finds a works_at fact", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "cv", actor: "t", owner: "o" });
    recordFact(vault, {
      subject: "Ardin Ibraimi", predicate: "works_at", object: "Netcloud AG",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = await recall(vault, {
      query: "who is the current employer of Ardin", owner: "o", actor: "t",
      purpose: "test", use_vector: false, limit: 5,
    } as any);
    const factHit = r.hits.find(h => h.kind === "fact");
    expect(factHit?.payload?.object).toBe("Netcloud AG");
    rmSync(vault, { recursive: true, force: true });
  });

  test("episode excerpt is body content, not frontmatter", async () => {
    const vault = fresh();
    observe(vault, {
      kind: "document",
      content: "Ardin prepared thoroughly for the interview.",
      actor: "prep-actor", owner: "o",
    });
    const r = await recall(vault, {
      query: "interview preparation", owner: "o", actor: "t",
      purpose: "test", use_vector: false, limit: 5,
    } as any);
    const ep = r.hits.find(h => h.kind === "episode");
    expect(ep).toBeDefined();
    expect(ep!.excerpt.startsWith("actor:")).toBe(false);
    expect(ep!.excerpt.startsWith("owner:")).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });
});
