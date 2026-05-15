// v2.9.0+ entity resolution (NEW — Zep-gap closer).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntity, resolveEntity } from "../../src/v2/layer2-entities";
import { initAudit } from "../../src/v2/layer6-audit";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-resolve-"));
  initAudit(dir);
  return dir;
}

describe("resolveEntity", () => {
  test("returns empty when no entities", () => {
    const vault = fresh();
    expect(resolveEntity(vault, "ardin", { name: "Marcel" }).length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("exact match returns score 1.0", () => {
    const vault = fresh();
    createEntity(vault, { name: "Marcel", type: "person", actor: "t", owner: "ardin" });
    const cs = resolveEntity(vault, "ardin", { name: "Marcel" });
    expect(cs.length).toBe(1);
    expect(cs[0].score).toBe(1);
    rmSync(vault, { recursive: true, force: true });
  });

  test("alias match resolves", () => {
    const vault = fresh();
    createEntity(vault, { name: "machtsinn AG", type: "organization", aliases: ["machtsinn", "machtsinn.ai"], actor: "t", owner: "ardin" });
    const cs = resolveEntity(vault, "ardin", { name: "machtsinn.ai" });
    expect(cs.length).toBe(1);
    expect(cs[0].score).toBe(1);
    rmSync(vault, { recursive: true, force: true });
  });

  test("substring containment resolves with score >= 0.7", () => {
    const vault = fresh();
    createEntity(vault, { name: "machtsinn AG", type: "organization", actor: "t", owner: "ardin" });
    const cs = resolveEntity(vault, "ardin", { name: "machtsinn" });
    expect(cs.length).toBe(1);
    expect(cs[0].score).toBeGreaterThanOrEqual(0.7);
    expect(cs[0].match_reason).toContain("substring");
    rmSync(vault, { recursive: true, force: true });
  });

  test("typo within Levenshtein 2 resolves", () => {
    const vault = fresh();
    createEntity(vault, { name: "Cosmos DB", type: "system", actor: "t", owner: "ardin" });
    const cs = resolveEntity(vault, "ardin", { name: "Cosmos DBs" });  // 1 char off
    expect(cs.length).toBe(1);
    expect(cs[0].match_reason).toMatch(/edit-distance|substring/);
    rmSync(vault, { recursive: true, force: true });
  });

  test("type filter excludes wrong-type matches", () => {
    const vault = fresh();
    createEntity(vault, { name: "Azure", type: "system", actor: "t", owner: "ardin" });
    const cs = resolveEntity(vault, "ardin", { name: "Azure", type: "person" });
    expect(cs.length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("drafts are excluded by default; include via flag", () => {
    const vault = fresh();
    createEntity(vault, { name: "DraftCo", type: "organization", actor: "t", owner: "ardin", status: "draft" });
    expect(resolveEntity(vault, "ardin", { name: "DraftCo" }).length).toBe(0);
    expect(resolveEntity(vault, "ardin", { name: "DraftCo" }, { includeDrafts: true }).length).toBe(1);
    rmSync(vault, { recursive: true, force: true });
  });

  test("unrelated names below threshold are not returned", () => {
    const vault = fresh();
    createEntity(vault, { name: "Marcel", type: "person", actor: "t", owner: "ardin" });
    expect(resolveEntity(vault, "ardin", { name: "Unrelated" }).length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });
});
