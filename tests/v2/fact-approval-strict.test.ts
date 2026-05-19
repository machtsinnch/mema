// v2.9.0+ fail-closed fact approval at the API surface (P0-B from second
// external review). The /v2/fact/:id/approve endpoint must reject the
// promotion when:
//   - derived_from is empty
//   - the cited source episode is not in the vault
//   - evidenceCheck fails (subject/object missing)
// `force: true` overrides each guard but requires a non-empty `reason`.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "../../src/api";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

const KEYS = { "dev-ardin": "ardin" };

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-fact-approve-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

async function jsonReq(app: any, method: string, path: string, body?: any) {
  const r = await app.request(path, {
    method,
    headers: {
      "x-api-key": "dev-ardin",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data };
}

describe("v2.9.0 fail-closed fact approval", () => {
  test("approval succeeds when derived_from + episode + evidence all present", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await jsonReq(app, "POST", "/v2/observe", {
      kind: "document", content: "Marcel manages Azure infrastructure.", source: "t",
      skip_extraction: true,
    });
    expect(ep.status).toBe(200);
    const epId = ep.data.episode.id;

    const fact = await jsonReq(app, "POST", "/v2/fact", {
      subject: "Marcel", predicate: "manages", object: "Azure infrastructure",
      derived_from: [epId], confidence: 0.95, status: "draft",
    });
    expect(fact.status).toBe(200);
    const factId = fact.data.fact.id;

    const ap = await jsonReq(app, "POST", `/v2/fact/${factId}/approve`, { reason: "test" });
    expect(ap.status).toBe(200);
    expect(ap.data.fact.status).toBe("approved");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approval fails 422 when derived_from is empty", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fact = await jsonReq(app, "POST", "/v2/fact", {
      subject: "Marcel", predicate: "manages", object: "Azure",
      derived_from: [], confidence: 0.95, status: "draft",
    });
    expect(fact.status).toBe(200);
    const factId = fact.data.fact.id;
    const ap = await jsonReq(app, "POST", `/v2/fact/${factId}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.error).toBe("evidence_check_failed");
    expect(ap.data.missing).toContain("derived_from");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approval fails 422 when source episode is missing from vault", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fact = await jsonReq(app, "POST", "/v2/fact", {
      subject: "Marcel", predicate: "manages", object: "Azure",
      derived_from: ["01ZZZZZZZZZZZZZZZZZZZZZZZZ"],  // non-existent episode
      confidence: 0.95, status: "draft",
    });
    expect(fact.status).toBe(200);
    const factId = fact.data.fact.id;
    const ap = await jsonReq(app, "POST", `/v2/fact/${factId}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.error).toBe("evidence_check_failed");
    expect(ap.data.missing).toContain("source_episode");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approval fails 422 when subject/object absent from source body", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await jsonReq(app, "POST", "/v2/observe", {
      kind: "document", content: "An unrelated paragraph about something else.",
      source: "t", skip_extraction: true,
    });
    const fact = await jsonReq(app, "POST", "/v2/fact", {
      subject: "Marcel", predicate: "manages", object: "Azure",
      derived_from: [ep.data.episode.id], confidence: 0.95, status: "draft",
    });
    const ap = await jsonReq(app, "POST", `/v2/fact/${fact.data.fact.id}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.error).toBe("evidence_check_failed");
    expect(ap.data.missing.length).toBeGreaterThan(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("force=true requires a non-empty reason (400 otherwise)", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fact = await jsonReq(app, "POST", "/v2/fact", {
      subject: "Marcel", predicate: "manages", object: "Azure",
      derived_from: [], confidence: 0.95, status: "draft",
    });
    const noReason = await jsonReq(app, "POST", `/v2/fact/${fact.data.fact.id}/approve`, { force: true });
    expect(noReason.status).toBe(400);
    expect(noReason.data.error).toBe("force_requires_reason");

    const empty = await jsonReq(app, "POST", `/v2/fact/${fact.data.fact.id}/approve`, { force: true, reason: "   " });
    expect(empty.status).toBe(400);
    expect(empty.data.error).toBe("force_requires_reason");
    rmSync(vault, { recursive: true, force: true });
  });

  test("force=true with reason promotes a draft that fails the gate", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fact = await jsonReq(app, "POST", "/v2/fact", {
      subject: "Marcel", predicate: "manages", object: "Azure",
      derived_from: [], confidence: 0.95, status: "draft",
    });
    const ap = await jsonReq(app, "POST", `/v2/fact/${fact.data.fact.id}/approve`, {
      force: true, reason: "external verification via signed contract attached to case file CASE-2026-05-15",
    });
    expect(ap.status).toBe(200);
    expect(ap.data.fact.status).toBe("approved");
    expect(ap.data.fact.review_reason).toContain("external verification");
    rmSync(vault, { recursive: true, force: true });
  });
});
