// Smoke test for the six-layer architecture. End-to-end flow:
//   1. OBSERVE an episode
//   2. EXTRACT a semantic fact from it
//   3. REFLECT into a cognitive record (belief)
//   4. Attach governance to a record
//   5. RECALL via hybrid retrieval
//   6. AUDIT — verify hash chain over the operations
//
// Uses a fresh isolated vault per test to avoid polluting the user's actual data.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { observe, pathForEpisode } from "../../src/v2/layer1-episodic";
import { recordFact, invalidateFact, getFactsValidAt } from "../../src/v2/layer2-semantic";
import { recordCognitive } from "../../src/v2/layer3-cognitive";
import { buildGovernance, policyCheck, hardErase } from "../../src/v2/layer4-governance";
import { recall } from "../../src/v2/layer5-retrieval";
import { initAudit, appendAudit, queryAudit, verifyChain } from "../../src/v2/layer6-audit";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2-"));
  initAudit(dir);
  return dir;
}

describe("Six-layer end-to-end", () => {
  test("L1 → L2 → L3 → L4 → L5 → L6 full flow", async () => {
    const vault = fresh();

    // L1: Observe a raw episode (a conversation note)
    const ep = observe(vault, {
      kind: "conversation",
      content: "Ardin decided to use sqlite-vec for embeddings in mema v1.1 because it preserves filesystem-truth.",
      actor: "ardin:claude-code",
      owner: "ardin",
      source: "session:2026-05-15",
    });
    expect(ep.id).toBeDefined();
    expect(ep.kind).toBe("conversation");

    // L2: Extract a semantic fact from that episode
    const fact = recordFact(vault, {
      subject: "mema",
      predicate: "embeddings_backend",
      object: "sqlite-vec",
      derived_from: [ep.id],
      confidence: 0.95,
      actor: "ardin:claude-code",
      owner: "ardin",
    });
    expect(fact.derived_from).toContain(ep.id);
    expect(fact.invalidated_at).toBeNull();

    // Facts valid at "now" should include our fact
    const validNow = getFactsValidAt(vault, "ardin", new Date().toISOString());
    expect(validNow.length).toBe(1);
    expect(validNow[0].id).toBe(fact.id);

    // L3: Reflect into a belief
    const belief = recordCognitive(vault, {
      kind: "belief",
      content: "Filesystem-truth + embeddings (via sqlite-vec) can co-exist without violating the v1.0 invariants.",
      confidence: 0.85,
      derived_from: [ep.id, fact.id],
      actor: "ardin:claude-code",
      owner: "ardin",
    });
    expect(belief.kind).toBe("belief");
    expect(belief.derived_from).toContain(fact.id);

    // L4: Build governance for a hypothetical sensitive record
    const gov = buildGovernance({
      source_content: "Customer X has confidential strategy Y.",
      actor: "ardin",
      purpose: ["customer-support", "compliance"],
      jurisdiction: "CH",
      data_classes: ["confidential"],
    });
    expect(gov.evidence.source_hash).toHaveLength(64);  // SHA-256 hex
    expect(gov.purpose).toContain("customer-support");

    // Policy check: allowed purpose
    const ok = policyCheck(gov, { actor: "ardin", purpose: "customer-support" });
    expect(ok.allowed).toBe(true);
    // Policy check: disallowed purpose
    const denied = policyCheck(gov, { actor: "ardin", purpose: "marketing" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("purpose_not_allowed");

    // L5: Recall — should find our episode + fact + belief by keyword
    const result = await recall(vault, {
      query: "sqlite-vec embeddings filesystem-truth",
      owner: "ardin",
      actor: "ardin:claude-code",
      purpose: "engineering-decision",
      limit: 10,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.evidence_chain.length).toBeGreaterThan(0);
    expect(result.audit_id).toBeDefined();

    // L6: Audit chain should be valid
    const verify = verifyChain();
    expect(verify.valid).toBe(true);
    expect(verify.entries_checked).toBeGreaterThanOrEqual(4);  // OBSERVE+EXTRACT+REFLECT+RECALL

    // Audit log should have a RECALL entry with our evidence chain
    const recalls = queryAudit({ owner: "ardin", op: "RECALL" });
    expect(recalls.length).toBeGreaterThanOrEqual(1);
    expect(recalls[0].evidence_chain).toBeDefined();
    expect(recalls[0].record_ids.length).toBeGreaterThan(0);

    rmSync(vault, { recursive: true, force: true });
  });

  test("L4 hard erase produces tombstone and audit entry", async () => {
    const vault = fresh();
    // Create a record to erase
    const ep = observe(vault, {
      kind: "document",
      content: "Personally identifiable info that must be erasable on request.",
      actor: "ardin",
      owner: "ardin",
    });
    // Find its path
    const path = pathForEpisode(vault, "ardin", ep.id)!;
    const r = hardErase({
      vaultRoot: vault,
      owner: "ardin",
      record_path: path,
      actor: "ardin",
      reason: "GDPR DSAR erasure request from data subject",
    });
    expect(r.erased).toBe(true);
    expect(r.tombstone_id).toBeDefined();

    // The audit log records the erasure
    const erasures = queryAudit({ owner: "ardin", op: "ERASE" });
    expect(erasures.length).toBe(1);
    expect(erasures[0].reason).toContain("GDPR");

    // Chain still valid after erase
    expect(verifyChain().valid).toBe(true);

    rmSync(vault, { recursive: true, force: true });
  });

  test("L2 fact invalidation flips epistemic state", async () => {
    const vault = fresh();
    const ep = observe(vault, {
      kind: "observation",
      content: "Ardin lives in Zurich.",
      actor: "ardin", owner: "ardin",
    });
    const f1 = recordFact(vault, {
      subject: "ardin",
      predicate: "lives_in",
      object: "Zurich",
      derived_from: [ep.id],
      confidence: 0.9,
      actor: "ardin", owner: "ardin",
    });
    expect(getFactsValidAt(vault, "ardin", new Date().toISOString()).length).toBe(1);

    // Later we learn it was wrong (or he moved)
    const ep2 = observe(vault, {
      kind: "observation",
      content: "Ardin lives in Lausanne now.",
      actor: "ardin", owner: "ardin",
    });
    const f2 = recordFact(vault, {
      subject: "ardin",
      predicate: "lives_in",
      object: "Lausanne",
      derived_from: [ep2.id],
      confidence: 0.95,
      actor: "ardin", owner: "ardin",
    });
    invalidateFact(vault, f1.id, "ardin", "ardin", f2.id);

    const valid = getFactsValidAt(vault, "ardin", new Date().toISOString());
    expect(valid.length).toBe(1);
    expect(valid[0].id).toBe(f2.id);

    rmSync(vault, { recursive: true, force: true });
  });
});
