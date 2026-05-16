// v2.11.0+ — two-channel recall contract test.
//
// The /v2/recall/packet endpoint runs two independent recall() calls with
// disjoint kinds (episodes vs facts+cognitive+entities). The contract:
// neither channel can displace the other's top hits. This test verifies
// that contract by exercising the underlying recall() logic the same way
// the endpoint does, and asserting:
//   1. evidence_channel only returns episodes
//   2. memory_channel only returns facts/cognitive/entities
//   3. evidence channel's top-K survives even when many fact hits exist
//      (this is what the v2.10.6 single-pool design broke)

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
  const dir = mkdtempSync(join(tmpdir(), "mema-v211-packet-"));
  initAudit(dir);
  return dir;
}

describe("two-channel recall contract (/v2/recall/packet)", () => {
  test("evidence_channel returns ONLY episodes; memory_channel returns ONLY non-episodes", async () => {
    const vault = fresh();
    const owner = "ardin";

    // Mixed vault: 2 episodes, 3 facts, 1 cognitive, 1 entity, all matching "alpha"
    const ep1 = observe(vault, {
      kind: "conversation",
      content: "alpha is the first Greek letter discussed by the user",
      actor: owner, owner,
    });
    const ep2 = observe(vault, {
      kind: "conversation",
      content: "the user mentioned alpha being important to their work",
      actor: owner, owner,
    });
    for (let i = 0; i < 3; i++) {
      recordFact(vault, {
        subject: "alpha", predicate: "is_a", object: `letter_${i}`,
        derived_from: [ep1.id], confidence: 0.9, actor: owner, owner,
      });
    }
    recordCognitive(vault, {
      kind: "belief", content: "user is fascinated by alpha and Greek letters",
      confidence: 0.85, derived_from: [ep1.id], actor: owner, owner,
    });
    createEntity(vault, { name: "alpha", type: "concept", actor: owner, owner });

    // The endpoint runs two parallel recall() calls — replicate here.
    const [evidence, memory] = await Promise.all([
      recall(vault, {
        query: "alpha", owner, actor: owner, purpose: "test-packet",
        kinds: ["episode"], limit: 10, use_vector: false,
      }),
      recall(vault, {
        query: "alpha", owner, actor: owner, purpose: "test-packet",
        kinds: ["fact", "cognitive", "entity"], limit: 10, use_vector: false,
      }),
    ]);

    // Channel separation contract
    expect(evidence.hits.length).toBeGreaterThan(0);
    for (const h of evidence.hits) {
      expect(h.kind).toBe("episode");
    }
    expect(memory.hits.length).toBeGreaterThan(0);
    for (const h of memory.hits) {
      expect(["fact", "cognitive", "entity"]).toContain(h.kind);
    }

    rmSync(vault, { recursive: true, force: true });
  });

  test("evidence channel top-K is NOT displaced by a flood of fact hits (the v2.10.6 bug)", async () => {
    const vault = fresh();
    const owner = "ardin";

    // The "gold" episode the answer LLM needs.
    const gold = observe(vault, {
      kind: "conversation",
      content: "the user said they currently own a Toyota Camry purchased in July 2024",
      actor: owner, owner,
    });
    // 30 fact records that all mention "Toyota" / "Camry" / "car" — under the
    // pre-2.11 single-pool design, these would crowd out the gold episode from
    // any limit=10 recall. Two-channel design keeps episodes in their own pool.
    for (let i = 0; i < 30; i++) {
      recordFact(vault, {
        subject: `Toyota_attr_${i}`, predicate: "has_property", object: `value_${i}`,
        derived_from: [gold.id], confidence: 0.9, actor: owner, owner,
      });
    }

    const [evidence, memory] = await Promise.all([
      recall(vault, {
        query: "Toyota Camry purchased", owner, actor: owner, purpose: "test",
        kinds: ["episode"], limit: 10, use_vector: false,
      }),
      recall(vault, {
        query: "Toyota Camry purchased", owner, actor: owner, purpose: "test",
        kinds: ["fact"], limit: 10, use_vector: false,
      }),
    ]);

    // Gold episode MUST be in the evidence channel — facts cannot displace it.
    const goldRetrieved = evidence.hits.some(h => h.id === gold.id);
    expect(goldRetrieved).toBe(true);
    // Memory channel filled with fact hits — independently of evidence.
    expect(memory.hits.length).toBeGreaterThan(0);

    rmSync(vault, { recursive: true, force: true });
  });
});
