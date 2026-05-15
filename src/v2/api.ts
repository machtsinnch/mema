// mema v2 API — HTTP endpoints for the six-layer architecture.
// Mounted at /v2/* alongside v1 endpoints (v1 stays intact).

import type { Hono, Context } from "hono";
import { observe } from "./layer1-episodic";
import {
  recordFact, invalidateFact, getFactsValidAt, readFact,
  approveFact, rejectFact, listDraftFacts, evidenceCheck,
} from "./layer2-semantic";
import {
  createEntity, readEntity, findEntityByName, listEntities, mergeEntities,
  approveEntity, rejectEntity, listDraftEntities,
} from "./layer2-entities";
import { findEpisode } from "./layer1-episodic";
import { recordCognitive, supersedeBelief, addDerivedFrom } from "./layer3-cognitive";
import { reflect } from "./layer3-reflection";
import { buildGovernance, hardErase } from "./layer4-governance";
import { recall } from "./layer5-retrieval";
import { initVectorStore, pickEmbedder, indexRecord, reindexAll, vectorIndexHealth } from "./layer5-embeddings";
import { walkDerivedFrom, walkSiblingFacts } from "./layer5-graph";
import { queryAudit, verifyChain, initAudit } from "./layer6-audit";
import {
  wrapRecordAsAsset, verifyAssetIntegrity, parseUAL,
  anchorAsset, listAnchors, setVerificationStatus, initAnchorStore,
} from "./layer7-assets";
import { buildGraphView } from "./layer5-graph-view";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface V2Config { vaultRoot: string; }

// Zero-dependency canvas viewer. Served at /graph. Loads /v2/graph on
// submit. Force-directed layout with Barnes-Hut-ish approximation for
// reasonable performance up to ~2000 nodes. No CDN, no external JS.
const GRAPH_VIEWER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>mema — graph view</title>
<style>
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0a0a0a; color:#e5e5e5; }
  header { padding: 8px 12px; background:#111; border-bottom:1px solid #222; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  input, button { background:#1a1a1a; color:#e5e5e5; border:1px solid #333; padding:6px 10px; border-radius:4px; font: inherit; }
  button { cursor:pointer; }
  button:hover { background:#222; }
  #stats { color:#888; font-size:12px; }
  #legend { display:flex; gap:8px; font-size:11px; color:#aaa; }
  .swatch { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:3px; vertical-align: middle; }
  canvas { display:block; cursor: grab; }
  canvas:active { cursor: grabbing; }
  #tooltip { position:absolute; background:#1a1a1a; border:1px solid #333; padding:6px 8px; border-radius:4px; font-size:12px; pointer-events:none; display:none; max-width:340px; }
</style></head><body>
<header>
  <input id="apiKey" type="password" placeholder="x-api-key" size="20" />
  <button id="load">Load graph</button>
  <span id="stats"></span>
  <span id="legend">
    <span><span class="swatch" style="background:#6cc"></span>episode</span>
    <span><span class="swatch" style="background:#fc6"></span>fact</span>
    <span><span class="swatch" style="background:#c9f"></span>cognitive</span>
    <span><span class="swatch" style="background:#9c9"></span>entity</span>
    <span><span class="swatch" style="background:#888"></span>v1</span>
  </span>
</header>
<canvas id="cv"></canvas>
<div id="tooltip"></div>
<script>
const COLORS = { episode:'#6cc', fact:'#fc6', cognitive:'#c9f', entity:'#9c9', v1_memory:'#888' };
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const tip = document.getElementById('tooltip');
let nodes = [], edges = [], idIndex = new Map();
let camera = { x: 0, y: 0, zoom: 1 };
let dragging = null, panning = null;

function resize() { cv.width = innerWidth; cv.height = innerHeight - 44; }
addEventListener('resize', resize); resize();

async function load() {
  const k = document.getElementById('apiKey').value.trim();
  try {
    const r = await fetch('/v2/graph', { headers: { 'x-api-key': k } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    nodes = data.nodes.map(n => ({
      ...n, x: (Math.random()-0.5)*1200, y: (Math.random()-0.5)*1200, vx: 0, vy: 0,
    }));
    edges = data.edges;
    idIndex = new Map(nodes.map(n => [n.id, n]));
    const s = data.stats;
    document.getElementById('stats').textContent =
      \`\${s.nodes_total} nodes · \${s.edges_total} edges · \` +
      Object.entries(s.by_kind).filter(([,v])=>v>0).map(([k,v])=>\`\${k}:\${v}\`).join(' · ');
  } catch (e) { alert('load failed: ' + e.message); }
}
document.getElementById('load').onclick = load;
load();

// ── Force-directed layout (basic spring-electrical, ticked each frame) ──
function tick() {
  if (nodes.length === 0) return;
  const REPEL = 1600, SPRING = 0.012, REST_LEN = 80, DAMP = 0.86;
  // Pairwise repulsion (O(n²); fine up to ~1500 nodes)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i+1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx*dx + dy*dy + 1;
      const f = REPEL / d2;
      const d = Math.sqrt(d2);
      const fx = (dx/d) * f, fy = (dy/d) * f;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    }
  }
  // Spring on edges
  for (const e of edges) {
    const a = idIndex.get(e.source), b = idIndex.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx*dx + dy*dy) + 0.01;
    const f = SPRING * (d - REST_LEN);
    a.vx += (dx/d) * f; a.vy += (dy/d) * f;
    b.vx -= (dx/d) * f; b.vy -= (dy/d) * f;
  }
  // Integrate
  for (const n of nodes) {
    if (n === dragging) continue;
    n.vx *= DAMP; n.vy *= DAMP;
    n.x += n.vx; n.y += n.vy;
  }
}

function draw() {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.translate(cv.width/2 + camera.x, cv.height/2 + camera.y);
  ctx.scale(camera.zoom, camera.zoom);
  // Edges
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (const e of edges) {
    const a = idIndex.get(e.source), b = idIndex.get(e.target);
    if (!a || !b) continue;
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  // Nodes
  for (const n of nodes) {
    ctx.fillStyle = COLORS[n.kind] || '#aaa';
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.kind === 'cognitive' ? 5 : 3.5, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

function worldFromScreen(sx, sy) {
  return {
    x: (sx - cv.width/2 - camera.x) / camera.zoom,
    y: (sy - cv.height/2 - camera.y) / camera.zoom,
  };
}
function nodeAt(sx, sy) {
  const w = worldFromScreen(sx, sy);
  for (const n of nodes) {
    const dx = n.x - w.x, dy = n.y - w.y;
    if (dx*dx + dy*dy < 36) return n;
  }
  return null;
}

cv.addEventListener('mousedown', ev => {
  const n = nodeAt(ev.offsetX, ev.offsetY);
  if (n) dragging = n;
  else panning = { x: ev.offsetX, y: ev.offsetY };
});
cv.addEventListener('mousemove', ev => {
  if (dragging) {
    const w = worldFromScreen(ev.offsetX, ev.offsetY);
    dragging.x = w.x; dragging.y = w.y; dragging.vx = 0; dragging.vy = 0;
  } else if (panning) {
    camera.x += ev.offsetX - panning.x;
    camera.y += ev.offsetY - panning.y;
    panning = { x: ev.offsetX, y: ev.offsetY };
  } else {
    const n = nodeAt(ev.offsetX, ev.offsetY);
    if (n) {
      tip.style.display = 'block';
      tip.style.left = (ev.clientX + 12) + 'px';
      tip.style.top = (ev.clientY + 12) + 'px';
      const m = n.meta || {};
      const esc = s => (s||'').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
      tip.innerHTML = '<b>' + esc(n.kind) + '</b><br>' +
        esc(n.label) +
        '<br><span style="color:#888">' + esc(n.id) + '</span>' +
        (m.confidence != null ? '<br>confidence: ' + m.confidence.toFixed(2) : '') +
        (m.verification_status ? '<br>status: ' + m.verification_status : '');
    } else tip.style.display = 'none';
  }
});
cv.addEventListener('mouseup', () => { dragging = null; panning = null; });
cv.addEventListener('wheel', ev => {
  ev.preventDefault();
  const factor = ev.deltaY > 0 ? 0.92 : 1.08;
  camera.zoom = Math.max(0.1, Math.min(8, camera.zoom * factor));
}, { passive: false });

(function loop() { tick(); draw(); requestAnimationFrame(loop); })();
</script></body></html>`;

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
      // v2.7+: opt-in draft mode for LLM extractors and other untrusted producers.
      status?: "draft" | "approved";
      evidence_excerpt?: string;
      proposed_by?: string;
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

  // v2.7+ acceptance lifecycle endpoints — approve / reject draft facts.
  // Approve runs the evidence-check guard against the source episode body
  // before promoting the draft, unless force=true is passed (e.g. for
  // facts whose subject/object is a synonym or alias not literally in
  // the source).
  app.post("/v2/fact/:id/approve", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason?: string; force?: boolean }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const existing = readFact(cfg.vaultRoot, owner, id);
    if (!existing) return c.json({ error: "not found" }, 404);
    if (!parsed.body.force) {
      const epId = (existing.derived_from ?? [])[0];
      if (epId) {
        const ep = findEpisode(cfg.vaultRoot, owner, epId);
        if (ep) {
          const ec = evidenceCheck(existing.subject, existing.object, ep.content);
          if (!ec.ok) {
            return c.json({
              error: "evidence_check_failed",
              missing: ec.missing,
              hint: "subject and/or object not found in source episode body; pass force:true to override",
            }, 422);
          }
        }
      }
    }
    const f = approveFact(cfg.vaultRoot, id, owner, actor, parsed.body.reason);
    if (!f) return c.json({ error: "not found" }, 404);
    return c.json({ fact: f });
  });

  app.post("/v2/fact/:id/reject", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason: string }>(c);
    if (!parsed.ok) return parsed.response;
    if (!parsed.body.reason || !parsed.body.reason.trim()) {
      return c.json({ error: "reason is required for reject" }, 400);
    }
    const owner = c.get("owner");
    const actor = c.get("actor");
    const f = rejectFact(cfg.vaultRoot, id, owner, actor, parsed.body.reason);
    if (!f) return c.json({ error: "not found" }, 404);
    return c.json({ fact: f });
  });

  app.get("/v2/facts/drafts", async c => {
    const owner = c.get("owner");
    return c.json({ facts: listDraftFacts(cfg.vaultRoot, owner) });
  });

  app.get("/v2/facts/valid-at", async c => {
    const owner = c.get("owner");
    const at = c.req.query("at") ?? new Date().toISOString();
    const includeDrafts = c.req.query("include_drafts") === "true";
    return c.json({ facts: getFactsValidAt(cfg.vaultRoot, owner, at, includeDrafts) });
  });

  app.get("/v2/fact/:id", async c => {
    const owner = c.get("owner");
    const f = readFact(cfg.vaultRoot, owner, c.req.param("id"));
    if (!f) return c.json({ error: "not found" }, 404);
    return c.json({ fact: f });
  });

  // ── Layer 2: Entities ────────────────────────────────────────────
  app.post("/v2/entity", async c => {
    const parsed = await parseBody<{
      name: string;
      type: string;
      aliases?: string[];
      // v2.7+ acceptance lifecycle opt-in fields.
      status?: "draft" | "approved";
      evidence_excerpt?: string;
      proposed_by?: string;
      derived_from?: string[];
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const e = createEntity(cfg.vaultRoot, { ...parsed.body, actor, owner });
    return c.json({ entity: e });
  });

  // v2.7+ approve / reject draft entities.
  app.post("/v2/entity/:id/approve", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason?: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const e = approveEntity(cfg.vaultRoot, id, owner, actor, parsed.body.reason);
    if (!e) return c.json({ error: "not found" }, 404);
    return c.json({ entity: e });
  });

  app.post("/v2/entity/:id/reject", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason: string }>(c);
    if (!parsed.ok) return parsed.response;
    if (!parsed.body.reason || !parsed.body.reason.trim()) {
      return c.json({ error: "reason is required for reject" }, 400);
    }
    const owner = c.get("owner");
    const actor = c.get("actor");
    const e = rejectEntity(cfg.vaultRoot, id, owner, actor, parsed.body.reason);
    if (!e) return c.json({ error: "not found" }, 404);
    return c.json({ entity: e });
  });

  app.get("/v2/entities/drafts", async c => {
    const owner = c.get("owner");
    return c.json({ entities: listDraftEntities(cfg.vaultRoot, owner) });
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

  // Append IDs to an existing cognitive record's derived_from chain. Used by
  // the PAI migration to wire cross-memory wikilinks AFTER all records exist.
  app.post("/v2/cognitive/:id/derived-from", async c => {
    const parsed = await parseBody<{ add: string[] }>(c);
    if (!parsed.ok) return parsed.response;
    if (!Array.isArray(parsed.body.add)) {
      return c.json({ error: "body.add must be an array of IDs" }, 400);
    }
    const owner = c.get("owner");
    const actor = c.get("actor");
    const r = addDerivedFrom(cfg.vaultRoot, owner, c.req.param("id"), parsed.body.add, actor);
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({ record: r });
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

  // Vector-index health — surfaces stale rows from a previous embedder version
  // so operators see a clear "reindex needed" after an upgrade.
  app.get("/v2/vector/health", async c => {
    const emb = pickEmbedder();
    const h = vectorIndexHealth(emb);
    return c.json({
      embedder: { name: emb.name, dim: emb.dim },
      ...h,
      recommendation: h.needs_reindex
        ? "Run POST /v2/vector/reindex — the active embedder differs from the stored vectors."
        : h.stale_rows > 0
          ? `Mixed state: ${h.current_rows} current, ${h.stale_rows} stale. Reindex to clean up.`
          : "ok",
    });
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
    const p = parsed.body.record_path.startsWith("/")
      ? parsed.body.record_path
      : join(cfg.vaultRoot, parsed.body.record_path);
    // CRITICAL: owner-of-path check. Without this, any authenticated tenant
    // could pass another tenant's path and tombstone their data. (Codex
    // finding C2 — pre-existing bug since v2.0.0.) Symmetric with the
    // checks on /v2/asset/wrap, /v2/asset/verify-integrity, etc.
    if (!existsSync(p)) return c.json({ error: "not found" }, 404);
    const matterMod = (await import("gray-matter")).default;
    let rec;
    try { rec = matterMod(readFileSync(p, "utf8")); }
    catch { return c.json({ error: "not found" }, 404); }
    if (rec.data.owner && rec.data.owner !== owner) {
      // Uniform 404 instead of 403 — no existence oracle for cross-tenant probes.
      return c.json({ error: "not found" }, 404);
    }
    const r = hardErase({
      vaultRoot: cfg.vaultRoot,
      owner, actor,
      record_path: p,
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
      // v2.7.3+ policy-routing context (P4 + P5).
      jurisdiction?: string;
      model?: {
        model?: string;
        model_region?: string;
        deployment?: "local" | "cloud";
        human_review?: boolean;
        approved_models?: string[];
      };
      policy_mode?: "permissive" | "strict";
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

  // ── Layer 5 (companion): Graph view ──────────────────────────────
  // JSON endpoint — drives any external graph viewer (cytoscape, vis-network,
  // Gephi, the bundled /graph HTML page). Supports ?limit=N (default 2000,
  // max 10000) to bound response size on large vaults.
  app.get("/v2/graph", async c => {
    const owner = c.get("owner");
    const limitQ = c.req.query("limit");
    let limit: number | undefined = undefined;
    if (limitQ) {
      const n = Number(limitQ);
      if (!Number.isFinite(n) || n < 1) {
        return c.json({ error: "limit must be a positive integer" }, 400);
      }
      if (n > 10000) {
        return c.json({ error: "limit exceeds max (10000)", max: 10000 }, 413);
      }
      limit = n;
    }
    const view = buildGraphView(cfg.vaultRoot, owner, { limit });
    return c.json(view);
  });

  // Bundled HTML viewer — zero-dependency canvas force-directed layout.
  // Served unauthenticated from /graph so it can be opened directly in a
  // browser; the JS inside calls /v2/graph with whatever key the user
  // supplies in the input box.
  app.get("/graph", async c => {
    return c.html(GRAPH_VIEWER_HTML);
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
