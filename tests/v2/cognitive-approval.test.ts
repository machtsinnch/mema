// v2.10.0+ cognitive approval lifecycle (closes v3.0 criterion).
//
// Cognitive records now have the same draft → approved/rejected flow as
// facts and entities. LLM-driven reflectLLM() writes drafts; this test
// suite verifies the API endpoint promotes them with the fail-closed
// evidence gate semantics.

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

const KEYS = { "dev-ardin": "ardin" };

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-cog-approve-"));
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
    headers: { "x-api-key": "dev-ardin", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: JSON.parse((await r.text()) || "{}") };
}

describe("v2.10.0 cognitive approval lifecycle", () => {
  test("approve promotes a draft cognitive record (with valid source)", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", {
      kind: "document", content: "Ardin prefers Bun runtime.", source: "t",
      skip_extraction: true,
    });
    // Write a draft cognitive record.
    const fs = require("node:fs");
    const matterMod = require("gray-matter");
    const id = "01ABCDEFGHIJKLMNOPQRSTUVWX";
    const dir = `${vault}/cognitive/ardin/belief`;
    fs.mkdirSync(dir, { recursive: true });
    const body = matterMod.stringify("Ardin prefers Bun.", {
      id, slug: "belief-test", kind: "belief",
      confidence: 0.9, derived_from: [ep.data.episode.id],
      reflected_at: new Date().toISOString(),
      superseded_by: null, owner: "ardin",
      status: "draft",
      evidence_excerpt: "Ardin prefers Bun runtime.",
      proposed_by: "reflect-llm:test",
      links: [`[[${ep.data.episode.id}]]`],
    });
    fs.writeFileSync(`${dir}/belief-test--${id}.md`, body, "utf8");

    const ap = await req(app, "POST", `/v2/cognitive/${id}/approve`, { reason: "looks good" });
    expect(ap.status).toBe(200);
    expect(ap.data.record.status).toBe("approved");
    expect(ap.data.record.review_reason).toBe("looks good");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approve fails 422 when derived_from is empty", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fs = require("node:fs");
    const matterMod = require("gray-matter");
    const id = "01BCDEFGHIJKLMNOPQRSTUVWXY";
    const dir = `${vault}/cognitive/ardin/belief`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/belief-test--${id}.md`, matterMod.stringify("orphan belief", {
      id, slug: "belief-orphan", kind: "belief",
      confidence: 0.9, derived_from: [],
      reflected_at: new Date().toISOString(),
      superseded_by: null, owner: "ardin", status: "draft",
    }), "utf8");

    const ap = await req(app, "POST", `/v2/cognitive/${id}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.missing).toContain("derived_from");
    rmSync(vault, { recursive: true, force: true });
  });

  test("approve fails 422 when source episode/fact is missing", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fs = require("node:fs");
    const matterMod = require("gray-matter");
    const id = "01CDEFGHIJKLMNOPQRSTUVWXYZ";
    const dir = `${vault}/cognitive/ardin/belief`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/belief-test--${id}.md`, matterMod.stringify("draft with bad source", {
      id, slug: "belief-bad-source", kind: "belief",
      confidence: 0.9, derived_from: ["01ZZZZZZZZZZZZZZZZZZZZZZZZ"],
      reflected_at: new Date().toISOString(),
      superseded_by: null, owner: "ardin", status: "draft",
    }), "utf8");

    const ap = await req(app, "POST", `/v2/cognitive/${id}/approve`, {});
    expect(ap.status).toBe(422);
    expect(ap.data.missing).toContain("source_episode_or_fact");
    rmSync(vault, { recursive: true, force: true });
  });

  test("force=true with reason bypasses the gate", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fs = require("node:fs");
    const matterMod = require("gray-matter");
    const id = "01DEFGHIJKLMNOPQRSTUVWXYZA";
    const dir = `${vault}/cognitive/ardin/belief`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/belief-test--${id}.md`, matterMod.stringify("external belief", {
      id, slug: "belief-external", kind: "belief",
      confidence: 0.9, derived_from: [],
      reflected_at: new Date().toISOString(),
      superseded_by: null, owner: "ardin", status: "draft",
    }), "utf8");
    const ap = await req(app, "POST", `/v2/cognitive/${id}/approve`, {
      force: true, reason: "external evidence in case file 2026-05",
    });
    expect(ap.status).toBe(200);
    expect(ap.data.record.status).toBe("approved");
    rmSync(vault, { recursive: true, force: true });
  });

  test("reject sets status=rejected (requires reason)", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fs = require("node:fs");
    const matterMod = require("gray-matter");
    const id = "01EFGHIJKLMNOPQRSTUVWXYZAB";
    const dir = `${vault}/cognitive/ardin/belief`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/belief-test--${id}.md`, matterMod.stringify("bad belief", {
      id, slug: "belief-bad", kind: "belief",
      confidence: 0.8, derived_from: [],
      reflected_at: new Date().toISOString(),
      superseded_by: null, owner: "ardin", status: "draft",
    }), "utf8");

    const noReason = await req(app, "POST", `/v2/cognitive/${id}/reject`, {});
    expect(noReason.status).toBe(400);

    const ok = await req(app, "POST", `/v2/cognitive/${id}/reject`, { reason: "hallucinated" });
    expect(ok.status).toBe(200);
    expect(ok.data.record.status).toBe("rejected");
    rmSync(vault, { recursive: true, force: true });
  });

  test("/v2/cognitive/drafts lists all draft records across kinds", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const fs = require("node:fs");
    const matterMod = require("gray-matter");
    for (const [i, kind] of ["belief", "observation", "experience"].entries()) {
      const id = `01DRAFT${i}LISTAAAAAAAAAAAA`;
      const dir = `${vault}/cognitive/ardin/${kind}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/test--${id}.md`, matterMod.stringify(`${kind} draft`, {
        id, slug: kind, kind,
        confidence: 0.8, derived_from: [],
        reflected_at: new Date().toISOString(),
        superseded_by: null, owner: "ardin", status: "draft",
      }), "utf8");
    }
    const r = await req(app, "GET", "/v2/cognitive/drafts");
    expect(r.status).toBe(200);
    expect(r.data.records.length).toBe(3);
    const kinds = r.data.records.map((rec: any) => rec.kind).sort();
    expect(kinds).toEqual(["belief", "experience", "observation"]);
    rmSync(vault, { recursive: true, force: true });
  });
});
