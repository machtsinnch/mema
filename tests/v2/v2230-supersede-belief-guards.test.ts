// v2.22.10 — breaker finding: supersedeBelief() accepted a self/nonexistent
// successor and silently wrote superseded_by anyway. That excluded the belief
// from retrieval with no valid successor (a self-cycle orphan) and let the
// next reflect() over the SAME evidence re-mint the belief as a live
// duplicate. supersedeJudgment had these guards; supersedeBelief did not.
// These tests reproduce the corruption and prove the guards.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordCognitive,
  supersedeBelief,
  findCognitiveByClaimKey,
} from "../../src/v2/layer3-cognitive";
import { reflect } from "../../src/v2/layer3-reflection";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact } from "../../src/v2/layer2-semantic";
import { initAudit } from "../../src/v2/layer6-audit";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2230-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

const CLAIM = "corro|princeton|created|coala";

describe("supersedeBelief guards", () => {
  test("refuses a self-successor (new_id === old_id) — no self-cycle orphan", () => {
    const vault = fresh();
    const b = recordCognitive(vault, {
      kind: "belief", content: "Princeton created CoALA", confidence: 0.9,
      derived_from: [], actor: "t", owner: "o", claim_key: CLAIM,
    });
    // A typo hands back the SAME id.
    const r = supersedeBelief(vault, b.id, b.id, "o", "t");
    expect(r).toBeNull();
    // The belief is still authoritative and retrievable.
    const found = findCognitiveByClaimKey(vault, "o", CLAIM);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(b.id);
    expect(found!.superseded_by).toBeFalsy();
    rmSync(vault, { recursive: true, force: true });
  });

  test("refuses a successor that does not resolve to an existing record", () => {
    const vault = fresh();
    const b = recordCognitive(vault, {
      kind: "belief", content: "Princeton created CoALA", confidence: 0.9,
      derived_from: [], actor: "t", owner: "o", claim_key: CLAIM,
    });
    const r = supersedeBelief(vault, b.id, "01JZZZZZZZZZZZZZZZZZZZZZZZ", "o", "t");
    expect(r).toBeNull();
    const found = findCognitiveByClaimKey(vault, "o", CLAIM);
    expect(found!.id).toBe(b.id);
    expect(found!.superseded_by).toBeFalsy();
    rmSync(vault, { recursive: true, force: true });
  });

  test("refuses to overwrite an existing supersession chain link", () => {
    const vault = fresh();
    const older = recordCognitive(vault, {
      kind: "belief", content: "Princeton created CoALA", confidence: 0.9,
      derived_from: [], actor: "t", owner: "o", claim_key: CLAIM,
    });
    const mid = recordCognitive(vault, {
      kind: "belief", content: "Princeton created CoALA (v2)", confidence: 0.92,
      derived_from: [], actor: "t", owner: "o",
    });
    const newer = recordCognitive(vault, {
      kind: "belief", content: "Princeton created CoALA (v3)", confidence: 0.95,
      derived_from: [], actor: "t", owner: "o",
    });
    // First supersession succeeds.
    expect(supersedeBelief(vault, older.id, mid.id, "o", "t")).not.toBeNull();
    // A second attempt must not fork the chain / overwrite the first link.
    expect(supersedeBelief(vault, older.id, newer.id, "o", "t")).toBeNull();
    rmSync(vault, { recursive: true, force: true });
  });

  test("a valid successor still supersedes normally", () => {
    const vault = fresh();
    const older = recordCognitive(vault, {
      kind: "belief", content: "Princeton created CoALA", confidence: 0.9,
      derived_from: [], actor: "t", owner: "o", claim_key: CLAIM,
    });
    const newer = recordCognitive(vault, {
      kind: "belief", content: "Princeton created CoALA (refined)", confidence: 0.95,
      derived_from: [], actor: "t", owner: "o",
    });
    const r = supersedeBelief(vault, older.id, newer.id, "o", "t");
    expect(r).not.toBeNull();
    expect(r!.superseded_by).toBe(newer.id);
    rmSync(vault, { recursive: true, force: true });
  });

  test("reflect() does NOT re-mint a duplicate after a rejected self-supersede", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    recordFact(vault, { subject: "Princeton", predicate: "created", object: "CoALA", derived_from: [ep1.id], actor: "t", owner: "o" });
    recordFact(vault, { subject: "princeton", predicate: "developed", object: "coala", derived_from: [ep2.id], actor: "t", owner: "o" });

    const r1 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: "2020-01-01T00:00:00Z", self_names: ["Princeton"] });
    expect(r1.cognitive_records_created).toBe(1);
    const belief = r1.records[0];

    // Client sends a typo'd self-supersede — must be rejected, belief stays live.
    expect(supersedeBelief(vault, belief.id, belief.id, "o", "t")).toBeNull();
    expect(findCognitiveByClaimKey(vault, "o", belief.claim_key!)).not.toBeNull();

    // Reflecting over the SAME evidence must not create a duplicate.
    const r2 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: "2020-01-01T00:00:00Z", self_names: ["Princeton"] });
    expect(r2.cognitive_records_created).toBe(0);
    expect(r2.unchanged).toBe(1);
    rmSync(vault, { recursive: true, force: true });
  });
});
