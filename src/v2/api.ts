// mema v2 API — HTTP endpoints for the six-layer architecture.
// Mounted at /v2/* alongside v1 endpoints (v1 stays intact).

import type { Hono, Context } from "hono";
import { observe } from "./layer1-episodic";
import { recordFact, invalidateFact, getFactsValidAt, readFact } from "./layer2-semantic";
import { createEntity, readEntity, findEntityByName, listEntities, mergeEntities } from "./layer2-entities";
import { recordCognitive, supersedeBelief } from "./layer3-cognitive";
import { reflect } from "./layer3-reflection";
import { buildGovernance, hardErase } from "./layer4-governance";
import { recall } from "./layer5-retrieval";
import { initVectorStore, pickEmbedder, indexRecord, reindexAll } from "./layer5-embeddings";
import { walkDerivedFrom, walkSiblingFacts } from "./layer5-graph";
import { queryAudit, verifyChain, initAudit } from "./layer6-audit";
import {
  wrapRecordAsAsset, verifyAssetIntegrity, parseUAL,
  anchorAsset, listAnchors, setVerificationStatus, initAnchorStore,
} from "./layer7-assets";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface V2Config { vaultRoot: string; }

// CRITICAL: per-request body cap. Without this, a single tenant can write a
// 1 GB string via /v2/observe and fill the disk. Default 2 MB, overridable
// via env MACHTSINN_V2_MAX_BODY_BYTES.
const MAX_BODY_BYTES = Number(process.env.MACHTSINN_V2_MAX_BODY_BYTES ?? 2_000_000);

async function parseBody<T>(c: Context): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  try {
    // Pre-read as text to enforce size limit before parsing.
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, response: c.json({
        error: "payload too large",
        max_bytes: MAX_BODY_BYTES,
        actual_bytes: text.length,
      }, 413) };
    }
    const body = JSON.parse(text) as T;
    return { ok: true, body };
  } catch {
    return { ok: false, response: c.json({ error: "invalid JSON body" }, 400) };
  }
}

export function mountV2(app: Hono, cfg: V2Config): void {
  initAudit(cfg.vaultRoot);
  initVectorStore(cfg.vaultRoot);
  initAnchorStore(cfg.vaultRoot);

  // ── Layer 1: Episodic ────────────────────────────────────────────
  app.post("/v2/observe", async c => {
    const parsed = await parseBody<{
      kind: "conversation" | "document" | "tool_call" | "observation";
      content: string;
      source?: string;
      refs?: string[];
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const ep = observe(cfg.vaultRoot, { ...parsed.body, actor, owner });
    return c.json({ episode: ep });
  });

  // ── Layer 2: Temporal Semantic ───────────────────────────────────
  app.post("/v2/fact", async c => {
    const parsed = await parseBody<{
      subject: string;
      predicate: string;
      object: string;
      valid_from?: string;
      valid_to?: string | null;
      derived_from: string[];
      confidence?: number;
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const fact = recordFact(cfg.vaultRoot, { ...parsed.body, actor, owner });
    return c.json({ fact });
  });

  app.post("/v2/fact/:id/invalidate", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ superseded_by?: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const f = invalidateFact(cfg.vaultRoot, id, owner, actor, parsed.body.superseded_by);
    if (!f) return c.json({ error: "not found" }, 404);
    return c.json({ fact: f });
  });

  app.get("/v2/facts/valid-at", async c => {
    const owner = c.get("owner");
    const at = c.req.query("at") ?? new Date().toISOString();
    return c.json({ facts: getFactsValidAt(cfg.vaultRoot, owner, at) });
  });

  app.get("/v2/fact/:id", async c => {
    const owner = c.get("owner");
    const f = readFact(cfg.vaultRoot, owner, c.req.param("id"));
    if (!f) return c.json({ error: "not found" }, 404);
    return c.json({ fact: f });
  });

  // ── Layer 2: Entities ────────────────────────────────────────────
  app.post("/v2/entity", async c => {
    const parsed = await parseBody<{ name: string; type: string; aliases?: string[] }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const e = createEntity(cfg.vaultRoot, { ...parsed.body, actor, owner });
    return c.json({ entity: e });
  });

  app.get("/v2/entity/:id", async c => {
    const owner = c.get("owner");
    const e = readEntity(cfg.vaultRoot, owner, c.req.param("id"));
    if (!e) return c.json({ error: "not found" }, 404);
    return c.json({ entity: e });
  });

  app.get("/v2/entities", async c => {
    const owner = c.get("owner");
    const type = c.req.query("type");
    return c.json({ entities: listEntities(cfg.vaultRoot, owner, type) });
  });

  app.get("/v2/entity/find/:name", async c => {
    const owner = c.get("owner");
    const e = findEntityByName(cfg.vaultRoot, owner, c.req.param("name"));
    if (!e) return c.json({ error: "not found" }, 404);
    return c.json({ entity: e });
  });

  app.post("/v2/entity/:keeperId/merge/:mergedId", async c => {
    const owner = c.get("owner");
    const actor = c.get("actor");
    const e = mergeEntities(cfg.vaultRoot, owner, actor, c.req.param("keeperId"), c.req.param("mergedId"));
    if (!e) return c.json({ error: "not found" }, 404);
    return c.json({ entity: e });
  });

  // ── Layer 3: Cognitive ───────────────────────────────────────────
  app.post("/v2/cognitive", async c => {
    const parsed = await parseBody<{
      kind: "experience" | "observation" | "belief";
      content: string;
      confidence: number;
      derived_from: string[];
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const rec = recordCognitive(cfg.vaultRoot, { ...parsed.body, actor, owner });
    return c.json({ record: rec });
  });

  app.post("/v2/cognitive/:oldId/supersede", async c => {
    const parsed = await parseBody<{ new_id: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const oldId = c.req.param("oldId");
    const result = supersedeBelief(cfg.vaultRoot, oldId, parsed.body.new_id, owner, actor);
    if (!result) return c.json({ error: "not found" }, 404);
    return c.json({ record: result });
  });

  // ── Layer 3: Reflection (automated synthesis) ────────────────────
  app.post("/v2/reflect", async c => {
    const parsed = await parseBody<{
      since?: string; min_support?: number; max_records_emitted?: number;
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const report = reflect({
      vaultRoot: cfg.vaultRoot,
      owner, actor,
      since: parsed.body.since,
      min_support: parsed.body.min_support,
      max_records_emitted: parsed.body.max_records_emitted,
    });
    return c.json({ report });
  });

  // ── Layer 5: Vector index management ─────────────────────────────
  app.post("/v2/vector/reindex", async c => {
    const owner = c.get("owner");
    const result = await reindexAll(cfg.vaultRoot, pickEmbedder(), { owner });
    return c.json({ indexed: result.indexed, skipped: result.skipped, embedder: pickEmbedder().name });
  });

  // ── Layer 5: Graph walks (read-only) ─────────────────────────────
  app.get("/v2/graph/derived-from/:id", async c => {
    const owner = c.get("owner");
    const id = c.req.param("id");
    const maxDepth = c.req.query("depth") ? Number(c.req.query("depth")) : 3;
    return c.json({ nodes: walkDerivedFrom(cfg.vaultRoot, owner, id, maxDepth) });
  });

  app.get("/v2/graph/siblings/:subject", async c => {
    const owner = c.get("owner");
    const subject = c.req.param("subject");
    return c.json({ facts: walkSiblingFacts(cfg.vaultRoot, owner, subject) });
  });

  // ── Layer 4: Governance ──────────────────────────────────────────
  app.post("/v2/governance/build", async c => {
    const parsed = await parseBody<{
      source_content: string;
      purpose: string[];
      retention_until?: string;
      jurisdiction?: string;
      data_classes?: string[];
      allowed_actors?: string[];
    }>(c);
    if (!parsed.ok) return parsed.response;
    const actor = c.get("actor");
    const gov = buildGovernance({ ...parsed.body, actor });
    return c.json({ governance: gov });
  });

  app.post("/v2/erase", async c => {
    const parsed = await parseBody<{ record_path: string; reason: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const r = hardErase({
      vaultRoot: cfg.vaultRoot,
      owner, actor,
      record_path: parsed.body.record_path,
      reason: parsed.body.reason,
    });
    return c.json(r);
  });

  // ── Layer 5: Retrieval ───────────────────────────────────────────
  app.post("/v2/recall", async c => {
    const parsed = await parseBody<{
      query: string;
      purpose: string;
      kinds?: ("episode" | "fact" | "cognitive")[];
      temporal?: { valid_at?: string };
      limit?: number;
      use_vector?: boolean;
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const result = await recall(cfg.vaultRoot, { ...parsed.body, owner, actor });
    return c.json(result);
  });

  // ── Layer 7: Verifiable Memory Assets ────────────────────────────
  // Wrap a record file as an asset (compute hashes, mint UAL, version it).
  app.post("/v2/asset/wrap", async c => {
    const parsed = await parseBody<{ path: string; kind: string; scope: string; id: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const p = parsed.body.path.startsWith("/") ? parsed.body.path : join(cfg.vaultRoot, parsed.body.path);
    if (!existsSync(p)) return c.json({ error: "file not found" }, 404);
    // Owner-isolation: verify the record file belongs to caller
    const matter = (await import("gray-matter")).default;
    const rec = matter(readFileSync(p, "utf8"));
    if (rec.data.owner && rec.data.owner !== owner) return c.json({ error: "not found" }, 404);
    const meta = wrapRecordAsAsset(p, {
      owner, kind: parsed.body.kind, scope: parsed.body.scope, id: parsed.body.id,
    });
    return c.json({ asset: meta });
  });

  // Verify an asset's integrity by recomputing hashes.
  app.post("/v2/asset/verify-integrity", async c => {
    const parsed = await parseBody<{ path: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const p = parsed.body.path.startsWith("/") ? parsed.body.path : join(cfg.vaultRoot, parsed.body.path);
    if (!existsSync(p)) return c.json({ error: "file not found" }, 404);
    const matter = (await import("gray-matter")).default;
    const rec = matter(readFileSync(p, "utf8"));
    if (rec.data.owner && rec.data.owner !== owner) return c.json({ error: "not found" }, 404);
    return c.json(verifyAssetIntegrity(p));
  });

  // Resolve a UAL into its parsed components.
  app.get("/v2/asset/resolve/:ual", async c => {
    const ual = decodeURIComponent(c.req.param("ual"));
    const parsed = parseUAL(ual);
    if (!parsed) return c.json({ error: "invalid UAL" }, 400);
    if (parsed.owner !== c.get("owner")) return c.json({ error: "not found" }, 404);
    return c.json({ ual: parsed });
  });

  // Anchor an asset to a target (local | customer-audit-bundle | origintrail | ...)
  app.post("/v2/asset/anchor", async c => {
    const parsed = await parseBody<{ path: string; target: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const p = parsed.body.path.startsWith("/") ? parsed.body.path : join(cfg.vaultRoot, parsed.body.path);
    if (!existsSync(p)) return c.json({ error: "file not found" }, 404);
    const matter = (await import("gray-matter")).default;
    const rec = matter(readFileSync(p, "utf8"));
    if (rec.data.owner && rec.data.owner !== owner) return c.json({ error: "not found" }, 404);
    try {
      const anchor = anchorAsset({ vaultRoot: cfg.vaultRoot, filePath: p, target: parsed.body.target });
      return c.json({ anchor });
    } catch (e: any) {
      return c.json({ error: e.message ?? String(e) }, 400);
    }
  });

  // List anchors for the caller (owner-scoped). When `ual` is provided, only
  // anchors for that UAL are returned and we verify the UAL belongs to caller.
  app.get("/v2/asset/anchors", async c => {
    const owner = c.get("owner");
    const ual = c.req.query("ual");
    if (ual) {
      const parsed = parseUAL(ual);
      if (!parsed) return c.json({ error: "invalid UAL" }, 400);
      if (parsed.owner !== owner) return c.json({ error: "not found" }, 404);
    }
    return c.json({ anchors: listAnchors(owner, ual) });
  });

  // Set the verification status of an asset (typically after human review).
  app.post("/v2/asset/verification-status", async c => {
    const parsed = await parseBody<{ path: string; status: "unverified" | "verified" | "anchored" }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const p = parsed.body.path.startsWith("/") ? parsed.body.path : join(cfg.vaultRoot, parsed.body.path);
    if (!existsSync(p)) return c.json({ error: "file not found" }, 404);
    const matter = (await import("gray-matter")).default;
    const rec = matter(readFileSync(p, "utf8"));
    if (rec.data.owner && rec.data.owner !== owner) return c.json({ error: "not found" }, 404);
    setVerificationStatus(p, parsed.body.status);
    return c.json({ ok: true, status: parsed.body.status });
  });

  // ── Layer 6: Audit ───────────────────────────────────────────────
  app.get("/v2/audit/log", async c => {
    const owner = c.get("owner");
    const op = c.req.query("op") as any;
    const since = c.req.query("since");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 100;
    const entries = queryAudit({ owner, op, since, limit });
    return c.json({ entries });
  });

  app.get("/v2/audit/verify", async c => {
    const r = verifyChain();
    return c.json(r);
  });
}
