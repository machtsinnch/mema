// v2.9.0+ fail-closed entity approval (P0-C from second external review).
// Mirrors the fact-approval-strict guarantees, plus fragment-name detection.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "../../src/api";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";
import { entityNameLooksLikeFragment, entityEvidenceCheck } from "../../src/v2/layer2-entities";

const KEYS = { "dev-ardin": "ardin" };

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-ent-approve-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

async function req(app: any, method: string, path: string, body?: any) {
  const r = await app.request(path, {
    method,
    headers: {
      "x-api-key": "dev-ardin",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, data: JSON.parse(text || "{}") };
}

describe("entityNameLooksLikeFragment helper", () => {
  test("rejects pure numbers + currencies + dates + punctuation", () => {
    expect(entityNameLooksLikeFragment("42")).toBe(true);
    expect(entityNameLooksLikeFragment("100,000")).toBe(true);
    expect(entityNameLooksLikeFragment("CHF 22")).toBe(true);
    expect(entityNameLooksLikeFragment("EUR 299/month")).toBe(true);
    expect(entityNameLooksLikeFragment("$1.5M")).toBe(true);
    expect(entityNameLooksLikeFragment("2026-05-15")).toBe(true);
    expect(entityNameLooksLikeFragment("April 15")).toBe(true);
    expect(entityNameLooksLikeFragment("April 15, 2026")).toBe(true);
    expect(entityNameLooksLikeFragment("---")).toBe(true);
    expect(entityNameLooksLikeFragment("a")).toBe(true);
  });
  test("accepts proper entity names", () => {
    expect(entityNameLooksLikeFragment("Marcel")).toBe(false);
    expect(entityNameLooksLikeFragment("machtsinn AG")).toBe(false);
    expect(entityNameLooksLikeFragment("Azure")).toBe(false);
    expect(entityNameLooksLikeFragment("Cosmos DB")).toBe(false);
    expect(entityNameLooksLikeFragment("Claude Code")).toBe(false);
  });
});

describe("entityEvidenceCheck helper", () => {
  test("name in source = ok", () => {
    expect(entityEvidenceCheck("Marcel", [], "Marcel manages Azure.").ok).toBe(true);
  });
  test("alias in source = ok", () => {
    expect(entityEvidenceCheck("machtsinn AG", ["machtsinn"], "machtsinn ships v2.").ok).toBe(true);
  });
  test("name absent + name not fragment → name_not_in_source", () => {
    const r = entityEvidenceCheck("Bob", [], "Marcel does Azure.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("name_not_in_source");
  });
  test("fragment name → fragment_name", () => {
    const r = entityEvidenceCheck("CHF 22", [], "Pricing is CHF 22 per month.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("fragment_name");
  });
});

describe("v2.9.0 fail-closed entity approval endpoint", () => {
  test("approval succeeds for valid entity with source", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", {
      kind: "document", content: "Marcel runs Azure for machtsinn AG.", source: "t",
    });
    const ent = await req(app, "POST", "/v2/entity", {
      name: "Marcel", type: "person", status: "draft",
      derived_from: [ep.data.episode.id],
    });
    expect(ent.status).toBe(200);
    const ap = await req(app, "POST", `/v2/entity/${ent.data.entity.id}/approve`, {});
    expect(ap.status).toBe(200);
    expect(ap.data.entity.status).toBe("approved");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approval fails 422 when entity name not in source", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", {
      kind: "document", content: "An unrelated paragraph.", source: "t",
    });
    const ent = await req(app, "POST", "/v2/entity", {
      name: "Marcel", type: "person", status: "draft",
      derived_from: [ep.data.episode.id],
    });
    const ap = await req(app, "POST", `/v2/entity/${ent.data.entity.id}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.error).toBe("evidence_check_failed");
    expect(ap.data.missing).toContain("name_not_in_source");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approval fails 422 when name is a currency fragment", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", {
      kind: "document", content: "Pricing tier is CHF 22 per month.", source: "t",
    });
    const ent = await req(app, "POST", "/v2/entity", {
      name: "CHF 22", type: "concept", status: "draft",
      derived_from: [ep.data.episode.id],
    });
    const ap = await req(app, "POST", `/v2/entity/${ent.data.entity.id}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.missing).toContain("fragment_name");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approval fails 422 when derived_from is empty", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ent = await req(app, "POST", "/v2/entity", {
      name: "Floating", type: "concept", status: "draft", derived_from: [],
    });
    const ap = await req(app, "POST", `/v2/entity/${ent.data.entity.id}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.missing).toContain("derived_from");
    rmSync(vault, { recursive: true, force: true });
  });

  test("force=true requires non-empty reason (400)", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ent = await req(app, "POST", "/v2/entity", {
      name: "X", type: "concept", status: "draft", derived_from: [],
    });
    const r = await req(app, "POST", `/v2/entity/${ent.data.entity.id}/approve`, { force: true });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("force_requires_reason");
    rmSync(vault, { recursive: true, force: true });
  });

  test("force=true with reason bypasses the gate", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ent = await req(app, "POST", "/v2/entity", {
      name: "ExternallyVerified", type: "concept", status: "draft", derived_from: [],
    });
    const ap = await req(app, "POST", `/v2/entity/${ent.data.entity.id}/approve`, {
      force: true, reason: "verified via signed customer contract",
    });
    expect(ap.status).toBe(200);
    expect(ap.data.entity.status).toBe("approved");
    rmSync(vault, { recursive: true, force: true });
  });
});
