// v2.9.0+ contradiction detection (closes Zep-style contradiction-handling gap).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, findContradictions, invalidateFact, readFact } from "../../src/v2/layer2-semantic";
import { initAudit } from "../../src/v2/layer6-audit";
import { buildApi } from "../../src/api";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-contra-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("findContradictions", () => {
  test("returns empty when no facts exist", () => {
    const vault = fresh();
    const cs = findContradictions(vault, "ardin", { subject: "Ardin", predicate: "uses", object: "Bun" });
    expect(cs.length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("finds existing fact with same (subject, predicate) and different object", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "Ardin used Node initially.", actor: "t", owner: "ardin" });
    recordFact(vault, {
      subject: "Ardin", predicate: "uses", object: "Node",
      derived_from: [ep.id], confidence: 0.9,
      actor: "t", owner: "ardin",  // defaults to status=approved
    });
    const cs = findContradictions(vault, "ardin", { subject: "Ardin", predicate: "uses", object: "Bun" });
    expect(cs.length).toBe(1);
    expect(cs[0].object).toBe("Node");
    rmSync(vault, { recursive: true, force: true });
  });

  test("ignores drafts and rejected facts", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "ardin" });
    recordFact(vault, {
      subject: "S", predicate: "p", object: "O1",
      derived_from: [ep.id], confidence: 0.9, actor: "t", owner: "ardin",
      status: "draft",
    });
    recordFact(vault, {
      subject: "S", predicate: "p", object: "O2",
      derived_from: [ep.id], confidence: 0.9, actor: "t", owner: "ardin",
      status: "rejected",
    });
    const cs = findContradictions(vault, "ardin", { subject: "S", predicate: "p", object: "Onew" });
    expect(cs.length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("ignores invalidated and superseded facts", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "ardin" });
    const old = recordFact(vault, {
      subject: "S", predicate: "p", object: "O1",
      derived_from: [ep.id], confidence: 0.9, actor: "t", owner: "ardin",
    });
    invalidateFact(vault, old.id, "ardin", "t");
    const cs = findContradictions(vault, "ardin", { subject: "S", predicate: "p", object: "Onew" });
    expect(cs.length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("identical (subject, predicate, object) is not a contradiction", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "ardin" });
    recordFact(vault, {
      subject: "S", predicate: "p", object: "O1",
      derived_from: [ep.id], confidence: 0.9, actor: "t", owner: "ardin",
    });
    const cs = findContradictions(vault, "ardin", { subject: "S", predicate: "p", object: "O1" });
    expect(cs.length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });
});

const KEYS = { "dev-ardin": "ardin" };
async function req(app: any, method: string, path: string, body?: any) {
  const r = await app.request(path, {
    method,
    headers: { "x-api-key": "dev-ardin", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: JSON.parse((await r.text()) || "{}") };
}

describe("POST /v2/fact/contradictions", () => {
  test("returns the conflicting older fact", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", { kind: "document", content: "Ardin uses Node.", source: "t" });
    await req(app, "POST", "/v2/fact", {
      subject: "Ardin", predicate: "uses", object: "Node",
      derived_from: [ep.data.episode.id], confidence: 0.9,
    });
    const r = await req(app, "POST", "/v2/fact/contradictions", {
      subject: "Ardin", predicate: "uses", object: "Bun",
    });
    expect(r.status).toBe(200);
    expect(r.data.contradictions.length).toBe(1);
    expect(r.data.contradictions[0].object).toBe("Node");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("POST /v2/fact/:newId/approve-supersedes/:oldId", () => {
  test("approves new fact + invalidates old + audit captures both", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", { kind: "document", content: "Ardin uses Bun now (was Node).", source: "t" });
    const oldFact = await req(app, "POST", "/v2/fact", {
      subject: "Ardin", predicate: "uses", object: "Node",
      derived_from: [ep.data.episode.id], confidence: 0.9,
    });
    const newFact = await req(app, "POST", "/v2/fact", {
      subject: "Ardin", predicate: "uses", object: "Bun",
      derived_from: [ep.data.episode.id], confidence: 0.95,
      status: "draft",
    });
    const r = await req(
      app, "POST",
      `/v2/fact/${newFact.data.fact.id}/approve-supersedes/${oldFact.data.fact.id}`,
      { reason: "user switched runtimes" },
    );
    expect(r.status).toBe(200);
    expect(r.data.approved.status).toBe("approved");
    expect(r.data.invalidated.invalidated_at).toBeDefined();
    expect(r.data.invalidated.superseded_by).toBe(newFact.data.fact.id);

    // Verify on disk
    const reloadedOld = readFact(vault, "ardin", oldFact.data.fact.id);
    expect(reloadedOld?.invalidated_at).toBeDefined();
    expect(reloadedOld?.superseded_by).toBe(newFact.data.fact.id);
    rmSync(vault, { recursive: true, force: true });
  });

  test("rejects mismatched (subject, predicate) pair (400)", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", { kind: "document", content: "test content", source: "t" });
    const a = await req(app, "POST", "/v2/fact", {
      subject: "A", predicate: "p", object: "1",
      derived_from: [ep.data.episode.id], confidence: 0.9,
    });
    const b = await req(app, "POST", "/v2/fact", {
      subject: "B", predicate: "q", object: "2",
      derived_from: [ep.data.episode.id], confidence: 0.9,
      status: "draft",
    });
    const r = await req(
      app, "POST",
      `/v2/fact/${b.data.fact.id}/approve-supersedes/${a.data.fact.id}`,
      { reason: "test" },
    );
    expect(r.status).toBe(400);
    rmSync(vault, { recursive: true, force: true });
  });
});
