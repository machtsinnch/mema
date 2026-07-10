// v2.17.0 — rebuilt L2→L3 reflection: corroboration + current-state rules,
// idempotency via claim_key, abstention on undated ambiguity (Ardin's
// "better silent than wrong" rule, 2026-07-10), no filler strategies.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reflect } from "../../src/v2/layer3-reflection";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, recordFactWithSupersession } from "../../src/v2/layer2-semantic";
import { initAudit } from "../../src/v2/layer6-audit";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v217-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

describe("RULE A — corroboration", () => {
  test("same claim from 2 documents becomes a belief; single-source does not", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    // Corroborated across ep1+ep2 (synonym predicates + case variance):
    recordFact(vault, { subject: "Princeton", predicate: "developed", object: "CoALA", derived_from: [ep1.id], actor: "t", owner: "o" });
    recordFact(vault, { subject: "princeton", predicate: "created", object: "coala", derived_from: [ep2.id], actor: "t", owner: "o" });
    // Single-source claim — must NOT become a belief:
    recordFact(vault, { subject: "Zep", predicate: "uses", object: "Neo4j", derived_from: [ep1.id], actor: "t", owner: "o" });

    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r.cognitive_records_created).toBe(1);
    expect(r.records[0].kind).toBe("belief");
    expect(r.records[0].content).toContain("independently stated in 2 documents");
    expect(r.records[0].content.toLowerCase()).toContain("princeton");
    rmSync(vault, { recursive: true, force: true });
  });

  test("one document corroborating itself does NOT make a belief", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    recordFact(vault, { subject: "A", predicate: "uses", object: "B", derived_from: [ep.id], actor: "t", owner: "o" });
    recordFact(vault, { subject: "a", predicate: "depends_on", object: "b", derived_from: [ep.id], actor: "t", owner: "o" });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r.cognitive_records_created).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("RULE B — current state, dates required", () => {
  test("undated multiple candidates → abstain, visibly, with reason", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "cv", actor: "t", owner: "o" });
    for (const org of ["AUDI", "MHP", "Netcloud"]) {
      recordFact(vault, { subject: "Ardin", predicate: "works_at", object: org, derived_from: [ep.id], actor: "t", owner: "o" });
    }
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r.cognitive_records_created).toBe(0);
    expect(r.abstained?.length).toBe(1);
    expect(r.abstained?.[0].reason).toContain("refusing to guess");
    rmSync(vault, { recursive: true, force: true });
  });

  test("dated supersession history → clean current-state belief", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Marcel", predicate: "works_at", object: "Google", valid_from: "2020-03", derived_from: [ep.id], actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Marcel", predicate: "works_at", object: "Anthropic", valid_from: "2026-01", derived_from: [ep.id], actor: "t", owner: "o" });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    const belief = r.records.find(x => x.content.includes("currently"));
    expect(belief).toBeDefined();
    expect(belief!.content).toContain("Anthropic");
    expect(belief!.content).toContain("since 2026-01");
    expect(belief!.content).toContain("replaced 1 earlier");
    expect(r.abstained?.length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("lone undated fact without history → no photocopy belief", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFact(vault, { subject: "Marcel", predicate: "works_at", object: "Google", derived_from: [ep.id], actor: "t", owner: "o" });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r.cognitive_records_created).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("idempotency", () => {
  test("second run over unchanged evidence creates nothing", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    recordFact(vault, { subject: "Princeton", predicate: "created", object: "CoALA", derived_from: [ep1.id], actor: "t", owner: "o" });
    recordFact(vault, { subject: "Princeton", predicate: "developed", object: "CoALA", derived_from: [ep2.id], actor: "t", owner: "o" });

    const r1 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r1.cognitive_records_created).toBe(1);
    const r2 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r2.cognitive_records_created).toBe(0);
    expect(r2.unchanged).toBe(1);
    rmSync(vault, { recursive: true, force: true });
  });

  test("changed current state supersedes the old belief, keeps history", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Marcel", predicate: "works_at", object: "Google", valid_from: "2020-03", derived_from: [ep.id], actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Marcel", predicate: "works_at", object: "Anthropic", valid_from: "2024-01", derived_from: [ep.id], actor: "t", owner: "o" });
    const r1 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    const b1 = r1.records.find(x => x.content.includes("currently"))!;

    // New truth arrives: Marcel moves on.
    recordFactWithSupersession(vault, { subject: "Marcel", predicate: "works_at", object: "OpenPipe", valid_from: "2026-05", derived_from: [ep.id], actor: "t", owner: "o" });
    const r2 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    const b2 = r2.records.find(x => x.content.includes("OpenPipe"));
    expect(b2).toBeDefined();
    expect(b2!.id).not.toBe(b1.id);
    expect(r2.cognitive_records_created).toBe(1);  // superseding record
    rmSync(vault, { recursive: true, force: true });
  });
});
