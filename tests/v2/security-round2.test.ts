// Round-2 security hardening tests — cover the second adversarial review's
// findings:
//
//   1. listAnchors is owner-scoped (closes cross-tenant anchor leak)
//   2. External witness file catches sqlite_sequence tampering
//   3. Confidence clamping at write boundary (NaN/Infinity/negative)
//   4. parseUAL rejects more pathological inputs
//   5. appendAudit atomicity smoke (sequential)
//
// All must pass before shipping to a Swiss enterprise.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { initAudit, appendAudit, verifyChain } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore, anchorAsset, listAnchors, wrapRecordAsAsset, parseUAL } from "../../src/v2/layer7-assets";
import { observe, pathForEpisode } from "../../src/v2/layer1-episodic";
import { recordFact } from "../../src/v2/layer2-semantic";
import { recordCognitive } from "../../src/v2/layer3-cognitive";
import { clampConfidence } from "../../src/v2/types";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-r2-"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("Round 2 — listAnchors is owner-scoped (no cross-tenant leak)", () => {
  test("Tenant B cannot see Tenant A's anchors via listAnchors(\"\")", () => {
    const v = fresh();

    // Tenant A creates and anchors an asset
    const epA = observe(v, { kind: "document", content: "tenant A secret data", actor: "alice", owner: "alice" });
    const pathA = pathForEpisode(v, "alice", epA.id)!;
    wrapRecordAsAsset(pathA, { owner: "alice", kind: "episode", scope: "document", id: epA.id });
    anchorAsset({ vaultRoot: v, filePath: pathA, target: "local" });

    // Tenant B creates and anchors their own
    const epB = observe(v, { kind: "document", content: "tenant B data", actor: "bob", owner: "bob" });
    const pathB = pathForEpisode(v, "bob", epB.id)!;
    wrapRecordAsAsset(pathB, { owner: "bob", kind: "episode", scope: "document", id: epB.id });
    anchorAsset({ vaultRoot: v, filePath: pathB, target: "local" });

    // Total anchors in DB = 2. But each tenant sees only their own.
    const aliceSees = listAnchors("alice");
    const bobSees = listAnchors("bob");
    expect(aliceSees.length).toBe(1);
    expect(bobSees.length).toBe(1);
    expect(aliceSees[0].ual).toContain("/owner/alice/");
    expect(bobSees[0].ual).toContain("/owner/bob/");

    // Empty owner returns zero (deny-by-default).
    expect(listAnchors("").length).toBe(0);

    rmSync(v, { recursive: true, force: true });
  });
});

describe("Round 2 — External witness catches sqlite_sequence tampering", () => {
  test("verifyChain detects sqlite_sequence reset + row deletion combo", () => {
    const v = fresh();
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r1"] });
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r2"] });
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r3"] });
    expect(verifyChain().valid).toBe(true);

    // Witness file should exist with 3 lines
    const witnessPath = join(v, "_meta", "audit-witness.log");
    expect(existsSync(witnessPath)).toBe(true);
    const witness = readFileSync(witnessPath, "utf8").trim();
    expect(witness.split("\n").length).toBe(3);

    // Insider attempts the "delete row + reset sqlite_sequence" attack
    const dbPath = join(v, "_meta", "audit.sqlite");
    const db = new Database(dbPath);
    db.exec(`DELETE FROM audit WHERE seq = 3`);
    db.exec(`UPDATE sqlite_sequence SET seq = 2 WHERE name = 'audit'`);
    db.close();
    initAudit(v);

    // sqlite_sequence check would pass — but witness check should fail
    const r = verifyChain();
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("witness_suffix_drop");

    rmSync(v, { recursive: true, force: true });
  });
});

describe("Round 2 — Confidence clamping at write boundary", () => {
  test("clampConfidence converts NaN to 0.5", () => {
    expect(clampConfidence(NaN)).toBe(0.5);
    expect(clampConfidence(Infinity)).toBe(0.5);
    expect(clampConfidence(-Infinity)).toBe(0.5);
  });

  test("clampConfidence clamps negative to 0", () => {
    expect(clampConfidence(-0.5)).toBe(0);
    expect(clampConfidence(-1e10)).toBe(0);
  });

  test("clampConfidence clamps over-1 to 1", () => {
    expect(clampConfidence(1.5)).toBe(1);
    expect(clampConfidence(1e308)).toBe(1);
  });

  test("clampConfidence accepts strings that parse to valid numbers", () => {
    expect(clampConfidence("0.7")).toBe(0.7);
    expect(clampConfidence("not a number")).toBe(0.5);
  });

  test("recordFact stores clamped confidence", () => {
    const v = fresh();
    const f = recordFact(v, {
      subject: "x", predicate: "y", object: "z",
      derived_from: [], confidence: NaN as any,
      actor: "a", owner: "a",
    });
    expect(f.confidence).toBe(0.5);
    rmSync(v, { recursive: true, force: true });
  });

  test("recordCognitive stores clamped confidence", () => {
    const v = fresh();
    const c = recordCognitive(v, {
      kind: "belief", content: "x", confidence: 99 as any,
      derived_from: [], actor: "a", owner: "a",
    });
    expect(c.confidence).toBe(1);
    rmSync(v, { recursive: true, force: true });
  });
});

describe("Round 2 — parseUAL pathological inputs", () => {
  test("rejects empty UAL", () => {
    expect(parseUAL("")).toBeNull();
  });
  test("rejects wrong scheme", () => {
    expect(parseUAL("http://owner/x/y/z/memory/a")).toBeNull();
  });
  test("rejects extra path segments", () => {
    expect(parseUAL("mema://owner/x/y/z/memory/a/extra")).toBeNull();
  });
  test("rejects missing memory keyword", () => {
    expect(parseUAL("mema://owner/x/y/z/notmemory/a")).toBeNull();
  });
  test("rejects malformed percent encoding", () => {
    // %ZZ is not valid percent-encoding
    expect(parseUAL("mema://owner/al%ZZice/fact/scope/memory/01")).toBeNull();
  });
});

describe("Round 2 — appendAudit atomicity smoke", () => {
  test("100 sequential appends maintain a valid chain", () => {
    const v = fresh();
    for (let i = 0; i < 100; i++) {
      appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: [`r${i}`] });
    }
    const r = verifyChain();
    expect(r.valid).toBe(true);
    expect(r.entries_checked).toBe(100);
    rmSync(v, { recursive: true, force: true });
  });
});
