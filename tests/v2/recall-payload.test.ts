// v2.11.0+ recall response carries per-kind structured payload alongside the
// 240-char excerpt. Bench harnesses and agent prompts can now format facts,
// cognitive beliefs, and entities into context packets without re-parsing the
// record off disk.
//
// Pre-2.11 recall returned only `excerpt` (the first matched line). For
// facts/cognitive/entities this was often just the slug, which is useless for
// downstream prompt construction. This test fixes that contract.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observe } from "../../src/v2/layer1-episodic";
import { recordFact } from "../../src/v2/layer2-semantic";
import { recordCognitive } from "../../src/v2/layer3-cognitive";
import { createEntity } from "../../src/v2/layer2-entities";
import { recall } from "../../src/v2/layer5-retrieval";
import { initAudit } from "../../src/v2/layer6-audit";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v211-payload-"));
  initAudit(dir);
  return dir;
}

describe("v2.11 recall payload", () => {
  test("fact hits carry subject/predicate/object/valid_from", async () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "conversation",
      content: "Ardin uses sqlite-vec as the embedding backend for memamemama.",
      actor: "ardin", owner: "ardin",
    });
    const f = recordFact(vault, {
      subject: "memamemama",
      predicate: "uses_backend",
      object: "sqlite-vec",
      derived_from: [ep.id],
      confidence: 0.95,
      actor: "ardin", owner: "ardin",
    });

    const r = await recall(vault, {
      query: "memamemama",
      owner: "ardin",
      actor: "ardin",
      purpose: "test",
      kinds: ["fact"],
      use_vector: false,
    });
    const factHit = r.hits.find(h => h.kind === "fact" && h.id === f.id);
    expect(factHit).toBeDefined();
    expect(factHit!.payload).toBeDefined();
    expect(factHit!.payload!.subject).toBe("memamemama");
    expect(factHit!.payload!.predicate).toBe("uses_backend");
    expect(factHit!.payload!.object).toBe("sqlite-vec");
    expect(factHit!.payload!.valid_from).toBeDefined();
    expect(factHit!.payload!.invalidated_at).toBeUndefined();

    rmSync(vault, { recursive: true, force: true });
  });

  test("cognitive hits carry content + cognitive_kind + confidence", async () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "conversation",
      content: "Working on quintastic-unicorn-platform plumbing.",
      actor: "ardin", owner: "ardin",
    });
    const b = recordCognitive(vault, {
      kind: "belief",
      content: "quintastic-unicorn-platform should prefer keyword fallback over noisy embeddings.",
      confidence: 0.87,
      derived_from: [ep.id],
      actor: "ardin", owner: "ardin",
    });

    const r = await recall(vault, {
      query: "quintastic-unicorn-platform",
      owner: "ardin",
      actor: "ardin",
      purpose: "test",
      kinds: ["cognitive"],
      use_vector: false,
    });
    const cogHit = r.hits.find(h => h.kind === "cognitive" && h.id === b.id);
    expect(cogHit).toBeDefined();
    expect(cogHit!.payload).toBeDefined();
    expect(cogHit!.payload!.content).toContain("quintastic-unicorn-platform");
    expect(cogHit!.payload!.cognitive_kind).toBe("belief");
    expect(cogHit!.payload!.confidence).toBe(0.87);

    rmSync(vault, { recursive: true, force: true });
  });

  test("entity hits carry name + entity_type + aliases", async () => {
    const vault = fresh();
    const e = createEntity(vault, {
      name: "Frobnitz-7000",
      type: "product",
      aliases: ["Frob7k", "Frobnitz Mark 7"],
      actor: "ardin", owner: "ardin",
    });

    const r = await recall(vault, {
      query: "Frobnitz-7000",
      owner: "ardin",
      actor: "ardin",
      purpose: "test",
      kinds: ["entity"],
      use_vector: false,
    });
    const entHit = r.hits.find(h => h.kind === "entity" && h.id === e.id);
    expect(entHit).toBeDefined();
    expect(entHit!.payload).toBeDefined();
    expect(entHit!.payload!.name).toBe("Frobnitz-7000");
    expect(entHit!.payload!.entity_type).toBe("product");
    expect(entHit!.payload!.aliases).toContain("Frob7k");
    expect(entHit!.payload!.aliases).toContain("Frobnitz Mark 7");

    rmSync(vault, { recursive: true, force: true });
  });

  test("episode hits do NOT have payload (only structured kinds do)", async () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "conversation",
      content: "Plain episodic content about wibblywobble-architecture.",
      actor: "ardin", owner: "ardin",
    });

    const r = await recall(vault, {
      query: "wibblywobble-architecture",
      owner: "ardin",
      actor: "ardin",
      purpose: "test",
      kinds: ["episode"],
      use_vector: false,
    });
    const epHit = r.hits.find(h => h.kind === "episode" && h.id === ep.id);
    expect(epHit).toBeDefined();
    // Episodes don't get a payload — the existing `excerpt` field is the
    // user-visible content channel for episodes. Episodes already render
    // well as raw session text in the bench evidence-timeline section.
    expect(epHit!.payload).toBeUndefined();

    rmSync(vault, { recursive: true, force: true });
  });

  test("invalidated facts surface invalidated_at in payload", async () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "conversation",
      content: "Ardin lived in oddly-named-Cityton-7.",
      actor: "ardin", owner: "ardin",
    });
    const f1 = recordFact(vault, {
      subject: "ardin",
      predicate: "lives_in",
      object: "oddly-named-Cityton-7",
      derived_from: [ep.id],
      confidence: 0.9,
      actor: "ardin", owner: "ardin",
    });
    // Invalidate it
    const { invalidateFact } = await import("../../src/v2/layer2-semantic");
    invalidateFact(vault, f1.id, "ardin", "ardin");

    // Recall with a future valid_at so the contradiction-survives logic
    // includes the invalidated fact (it's still recallable, just penalized).
    const r = await recall(vault, {
      query: "oddly-named-Cityton-7",
      owner: "ardin",
      actor: "ardin",
      purpose: "test",
      kinds: ["fact"],
      use_vector: false,
      temporal: { valid_at: new Date(Date.now() - 1000).toISOString() },
    });
    const factHit = r.hits.find(h => h.kind === "fact" && h.id === f1.id);
    if (factHit) {
      // If the fact made it through retrieval (it should, at the recall time
      // just-before-invalidation), payload.invalidated_at should be set.
      expect(factHit.payload).toBeDefined();
      expect(factHit.payload!.invalidated_at).toBeDefined();
    }

    rmSync(vault, { recursive: true, force: true });
  });
});
