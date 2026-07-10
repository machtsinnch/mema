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

describe("v2.16.5 — result diversification", () => {
  test("sibling facts from one source cannot fill every slot", async () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "bike shop list", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "I own four bikes now after buying the gravel bike.", actor: "t", owner: "o" });
    // 8 sibling facts from ep1, all matching "bike"
    for (let i = 0; i < 8; i++) {
      recordFact(vault, {
        subject: `Bike Shop ${i}`, predicate: "offers", object: "bike rentals",
        derived_from: [ep1.id], actor: "t", owner: "o",
      });
    }
    const r = await recall(vault, {
      query: "bike", owner: "o", actor: "t",
      purpose: "test", use_vector: false, limit: 6,
    } as any);
    // The guarantee: diverse records are never crowded out. In the primary
    // ranking at most 3 sibling facts per source compete; remaining slots
    // may refill with capped facts only when nothing else is left.
    const firstFive = r.hits.slice(0, 5);
    const ep1FactsInTop5 = firstFive.filter(h =>
      h.kind === "fact" && h.payload?.derived_from?.[0] === ep1.id).length;
    expect(ep1FactsInTop5).toBeLessThanOrEqual(3);
    // BOTH episodes must survive into the results despite the fact swarm.
    expect(r.hits.filter(h => h.kind === "episode").length).toBe(2);
    // provenance is inlined on fact hits
    const f = r.hits.find(h => h.kind === "fact");
    expect(f?.payload?.derived_from?.[0]).toBe(ep1.id);
    rmSync(vault, { recursive: true, force: true });
  });
});
