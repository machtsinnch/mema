// mema v2 API — HTTP endpoints for the six-layer architecture.
// Mounted at /v2/* alongside v1 endpoints (v1 stays intact).

import type { Hono, Context } from "hono";
import { observe } from "./layer1-episodic";
import {
  recordFact, recordFactWithSupersession, invalidateFact, getFactsValidAt, readFact,
  approveFact, rejectFact, listDraftFacts, evidenceCheck,
  findContradictions,
} from "./layer2-semantic";
import {
  createEntity, readEntity, findEntityByName, listEntities, mergeEntities,
  approveEntity, rejectEntity, listDraftEntities, entityEvidenceCheck,
  resolveEntity,
} from "./layer2-entities";
import { findEpisode } from "./layer1-episodic";
import {
  recordCognitive, supersedeBelief, addDerivedFrom,
  approveCognitive, rejectCognitive, listDraftCognitive, pathForCognitive,
} from "./layer3-cognitive";
import { reflect, reflectLLM } from "./layer3-reflection";
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
    // v2.14.0+ — supersession-aware write. Every fact write goes through
    // the supersession classifier so the graph stays consistent without
    // requiring callers to manually findContradictions + invalidate.
    // Per Ardin's determinism principle: mandatory, not opt-in.
    const result = recordFactWithSupersession(cfg.vaultRoot, {
      ...parsed.body,
      actor,
      owner,
    });
    if (!result.written) {
      // NONE/duplicate or NONE/stale — explicit visibility via response,
      // never silent.
      return c.json({
        fact: null,
        decision: result.decision,
        message: `fact_skipped:${(result.decision as any).reason ?? "duplicate_or_stale"}`,
      });
    }
    return c.json({
      fact: result.written,
      decision: result.decision,
      ...(result.supersededIds.length > 0
        ? { superseded: result.supersededIds }
        : {}),
    });
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
  // v2.9.0+ (P0-B from second external review): the evidence gate is
  // FAIL-CLOSED. A draft cannot be promoted unless:
  //   1. derived_from is non-empty (the fact must cite at least one episode)
  //   2. the cited source episode actually exists in the vault
  //   3. evidenceCheck passes (subject + object appear in the source body)
  // Each guard can be overridden by `{force: true, reason: "..."}` — but
  // `reason` is REQUIRED on force, so every bypass is auditable.
  app.post("/v2/fact/:id/approve", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason?: string; force?: boolean }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const existing = readFact(cfg.vaultRoot, owner, id);
    if (!existing) return c.json({ error: "not found" }, 404);
    const force = parsed.body.force === true;
    if (force && !(parsed.body.reason && parsed.body.reason.trim())) {
      return c.json({
        error: "force_requires_reason",
        hint: "force:true bypasses the evidence gate — provide a non-empty reason for the audit trail",
      }, 400);
    }
    if (!force) {
      const derivedFrom = (existing.derived_from ?? []).filter(s => typeof s === "string" && s.length > 0);
      if (derivedFrom.length === 0) {
        return c.json({
          error: "evidence_check_failed",
          missing: ["derived_from"],
          hint: "draft has no source episode citation; pass {force:true, reason:'...'} to override",
        }, 422);
      }
      const epId = derivedFrom[0];
      const ep = findEpisode(cfg.vaultRoot, owner, epId);
      if (!ep) {
        return c.json({
          error: "evidence_check_failed",
          missing: ["source_episode"],
          hint: `derived_from cites episode '${epId}' which is not in this vault; pass {force:true, reason:'...'} to override`,
        }, 422);
      }
      const ec = evidenceCheck(existing.subject, existing.object, ep.content);
      if (!ec.ok) {
        return c.json({
          error: "evidence_check_failed",
          missing: ec.missing,
          hint: "subject and/or object not found in source episode body; pass {force:true, reason:'...'} to override",
        }, 422);
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

  // v2.9.0+ contradiction detection (NEW — Zep-gap closer). Given a
  // (subject, predicate, object) candidate, returns existing approved
  // non-invalidated facts that share (subject, predicate) with a
  // different object. Review tools surface this to reviewers; approving
  // the new candidate then offers an auto-invalidate-with-supersedes
  // for the older fact.
  app.post("/v2/fact/contradictions", async c => {
    const parsed = await parseBody<{ subject: string; predicate: string; object: string }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const cs = findContradictions(cfg.vaultRoot, owner, parsed.body);
    return c.json({ contradictions: cs });
  });

  // v2.9.0+ approve-with-supersedes (NEW): approve a draft fact AND
  // invalidate a contradicting older fact in a single atomic-ish
  // operation. The new fact's `superseded_by` is left null (it is the
  // CURRENT truth); the old fact gains `invalidated_at` + `superseded_by`
  // pointing at the new approved fact. The audit chain records both ops.
  app.post("/v2/fact/:newId/approve-supersedes/:oldId", async c => {
    const newId = c.req.param("newId");
    const oldId = c.req.param("oldId");
    const parsed = await parseBody<{ reason?: string; force?: boolean }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const newFact = readFact(cfg.vaultRoot, owner, newId);
    if (!newFact) return c.json({ error: "new fact not found" }, 404);
    const oldFact = readFact(cfg.vaultRoot, owner, oldId);
    if (!oldFact) return c.json({ error: "old fact not found" }, 404);
    if (oldFact.subject !== newFact.subject || oldFact.predicate !== newFact.predicate) {
      return c.json({ error: "old and new facts must share (subject, predicate)" }, 400);
    }
    // Run the same evidence gate as /approve.
    const force = parsed.body.force === true;
    if (force && !(parsed.body.reason && parsed.body.reason.trim())) {
      return c.json({ error: "force_requires_reason" }, 400);
    }
    if (!force) {
      const derivedFrom = (newFact.derived_from ?? []).filter(s => typeof s === "string" && s.length > 0);
      if (derivedFrom.length === 0) {
        return c.json({ error: "evidence_check_failed", missing: ["derived_from"] }, 422);
      }
      const ep = findEpisode(cfg.vaultRoot, owner, derivedFrom[0]);
      if (!ep) {
        return c.json({ error: "evidence_check_failed", missing: ["source_episode"] }, 422);
      }
      const ec = evidenceCheck(newFact.subject, newFact.object, ep.content);
      if (!ec.ok) {
        return c.json({ error: "evidence_check_failed", missing: ec.missing }, 422);
      }
    }
    const approved = approveFact(cfg.vaultRoot, newId, owner, actor, parsed.body.reason);
    if (!approved) return c.json({ error: "approve failed" }, 500);
    const invalidated = invalidateFact(cfg.vaultRoot, oldId, owner, actor, newId);
    return c.json({ approved, invalidated });
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
  // v2.9.0+ (P0-C): entity approval runs the same fail-closed evidence gate
  // as facts — entity name or one of its aliases must appear in the cited
  // source episode body, and the name must not be a fragment-shaped string
  // (pure number, currency amount, date, punctuation). `force:true` with a
  // mandatory `reason` bypasses for human-verified cases.
  app.post("/v2/entity/:id/approve", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason?: string; force?: boolean }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const existing = readEntity(cfg.vaultRoot, owner, id);
    if (!existing) return c.json({ error: "not found" }, 404);
    const force = parsed.body.force === true;
    if (force && !(parsed.body.reason && parsed.body.reason.trim())) {
      return c.json({
        error: "force_requires_reason",
        hint: "force:true bypasses the evidence gate — provide a non-empty reason for the audit trail",
      }, 400);
    }
    if (!force) {
      const derivedFrom = ((existing as any).derived_from ?? []).filter(
        (s: any) => typeof s === "string" && s.length > 0,
      ) as string[];
      if (derivedFrom.length === 0) {
        return c.json({
          error: "evidence_check_failed",
          missing: ["derived_from"],
          hint: "entity has no source episode citation; pass {force:true, reason:'...'} to override",
        }, 422);
      }
      const epId = derivedFrom[0];
      const ep = findEpisode(cfg.vaultRoot, owner, epId);
      if (!ep) {
        return c.json({
          error: "evidence_check_failed",
          missing: ["source_episode"],
          hint: `derived_from cites episode '${epId}' which is not in this vault; pass {force:true, reason:'...'} to override`,
        }, 422);
      }
      const ec = entityEvidenceCheck(existing.name, existing.aliases ?? [], ep.content);
      if (!ec.ok) {
        return c.json({
          error: "evidence_check_failed",
          missing: ec.missing,
          hint: "entity name (or any alias) not found in source body, or name is a fragment (number/currency/date/punctuation); pass {force:true, reason:'...'} to override",
        }, 422);
      }
    }
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

  // v2.9.0+ entity resolution (NEW — Zep-gap closer). Given a candidate
  // {name, aliases, type}, returns existing entities that likely refer
  // to the same real-world thing. Ranked. Used by extractors before
  // creating a new entity to avoid duplicates.
  app.post("/v2/entity/resolve", async c => {
    const parsed = await parseBody<{
      name: string; aliases?: string[]; type?: string;
      include_drafts?: boolean; max_levenshtein?: number;
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const candidates = resolveEntity(cfg.vaultRoot, owner, parsed.body, {
      includeDrafts: parsed.body.include_drafts,
      maxLevenshtein: parsed.body.max_levenshtein,
    });
    return c.json({ candidates });
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
  // v2.10.0+ cognitive approval lifecycle — parity with fact/entity
  // approve/reject endpoints (NEW; closes the v3.0 acceptance-lifecycle
  // criterion). Same fail-closed semantics: drafts with empty
  // derived_from or missing source episode are rejected with 422 unless
  // force:true + non-empty reason is passed.
  app.post("/v2/cognitive/:id/approve", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason?: string; force?: boolean }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const path = pathForCognitive(cfg.vaultRoot, owner, id);
    if (!path) return c.json({ error: "not found" }, 404);
    // Load the record so we can check derived_from + source.
    const matter = (await import("gray-matter")).default;
    const parsedRec = matter(readFileSync(path, "utf8"));
    const fm = parsedRec.data as any;
    if (fm.owner !== owner) return c.json({ error: "not found" }, 404);
    const force = parsed.body.force === true;
    if (force && !(parsed.body.reason && parsed.body.reason.trim())) {
      return c.json({ error: "force_requires_reason" }, 400);
    }
    if (!force) {
      const derivedFrom = ((fm.derived_from ?? []) as any[]).filter(s => typeof s === "string" && s.length > 0) as string[];
      if (derivedFrom.length === 0) {
        return c.json({
          error: "evidence_check_failed",
          missing: ["derived_from"],
          hint: "cognitive draft has no source citation; pass {force:true, reason:'...'} to override",
        }, 422);
      }
      // For cognitive records derived_from can cite episode OR fact IDs.
      // Require at least one to resolve in the vault.
      const epId = derivedFrom[0];
      const ep = findEpisode(cfg.vaultRoot, owner, epId);
      const fact = ep ? null : readFact(cfg.vaultRoot, owner, epId);
      if (!ep && !fact) {
        return c.json({
          error: "evidence_check_failed",
          missing: ["source_episode_or_fact"],
          hint: `derived_from cites '${epId}' which is neither an episode nor a fact in this vault; pass {force:true, reason:'...'} to override`,
        }, 422);
      }
    }
    const r = approveCognitive(cfg.vaultRoot, id, owner, actor, parsed.body.reason);
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({ record: r });
  });

  app.post("/v2/cognitive/:id/reject", async c => {
    const id = c.req.param("id");
    const parsed = await parseBody<{ reason: string }>(c);
    if (!parsed.ok) return parsed.response;
    if (!parsed.body.reason || !parsed.body.reason.trim()) {
      return c.json({ error: "reason is required for reject" }, 400);
    }
    const owner = c.get("owner");
    const actor = c.get("actor");
    const r = rejectCognitive(cfg.vaultRoot, id, owner, actor, parsed.body.reason);
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({ record: r });
  });

  app.get("/v2/cognitive/drafts", async c => {
    const owner = c.get("owner");
    return c.json({ records: listDraftCognitive(cfg.vaultRoot, owner) });
  });

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
      // v2.9.0+ (NEW) — opt-in LLM-driven reflection on top of the
      // rule-based pass. LLM-proposed beliefs land as drafts.
      llm?: boolean;
      llm_max_per_window?: number;
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const args = {
      vaultRoot: cfg.vaultRoot,
      owner, actor,
      since: parsed.body.since,
      min_support: parsed.body.min_support,
      max_records_emitted: parsed.body.max_records_emitted,
      llm_max_per_window: parsed.body.llm_max_per_window,
    };
    const report = parsed.body.llm ? await reflectLLM(args) : reflect(args);
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
    // v2.9.0+ (P0-G from second external review): expose legal_basis so
    // API callers can record the GDPR Article / nFADP / etc. citation
    // that authorized the erasure. hardErase already supported it; the
    // API just wasn't plumbing it through.
    const parsed = await parseBody<{ record_path: string; reason: string; legal_basis?: string }>(c);
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
      legal_basis: parsed.body.legal_basis,
    });
    return c.json(r);
  });

  // ── Layer 5: Retrieval ───────────────────────────────────────────
  app.post("/v2/recall", async c => {
    const parsed = await parseBody<{
      query: string;
      purpose: string;
      // v2.11.0+ — "entity" added to align with RetrievalKind. v2.9.0 made
      // entities first-class retrieval candidates but the API type only
      // listed three kinds. Pre-2.11 callers that supplied "entity" still
      // worked at runtime (recall() honored it), but TS clients couldn't
      // type-check the value.
      kinds?: ("episode" | "fact" | "cognitive" | "entity")[];
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
      // v2.10.0+ ablation switch (NEW). "weighted" default = back-compat;
      // "rrf" = Reciprocal Rank Fusion over keyword/vector/graph/temporal/title.
      fusion?: "weighted" | "rrf";
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const result = await recall(cfg.vaultRoot, { ...parsed.body, owner, actor });
    return c.json(result);
  });

  // v2.11.0+ — Two-channel recall for Memory Packet Compiler consumers.
  //
  // Returns evidence_channel (episodes only) and memory_channel
  // (facts + cognitive + entities) as SEPARATE retrieval pools. The
  // fundamental v2.10.6 ablation bug was that a single shared top-K pool
  // let fact/cognitive hits displace gold episodes from the answer
  // context. Two-channel retrieval forbids that displacement by design.
  //
  // The downstream MemoryPacket compiler (src/v2/memory-packet.ts)
  // consumes this shape directly. Callers that want the legacy single-
  // pool behavior keep using /v2/recall.
  app.post("/v2/recall/packet", async c => {
    const parsed = await parseBody<{
      query: string;
      purpose: string;
      temporal?: { valid_at?: string };
      limit_evidence?: number;  // top-K episodes (default 10)
      limit_memory?: number;    // top-K facts+cognitive+entities (default 20)
      use_vector?: boolean;
      jurisdiction?: string;
      model?: {
        model?: string;
        model_region?: string;
        deployment?: "local" | "cloud";
        human_review?: boolean;
        approved_models?: string[];
      };
      policy_mode?: "permissive" | "strict";
      fusion?: "weighted" | "rrf";
    }>(c);
    if (!parsed.ok) return parsed.response;
    const owner = c.get("owner");
    const actor = c.get("actor");
    const base = { ...parsed.body, owner, actor };
    const evidenceLimit = parsed.body.limit_evidence ?? 10;
    const memoryLimit = parsed.body.limit_memory ?? 20;

    // Two independent recall calls — no shared top-K, no displacement.
    const [evidenceResult, memoryResult] = await Promise.all([
      recall(cfg.vaultRoot, {
        ...base,
        kinds: ["episode"],
        limit: evidenceLimit,
      }),
      recall(cfg.vaultRoot, {
        ...base,
        kinds: ["fact", "cognitive", "entity"],
        limit: memoryLimit,
      }),
    ]);

    return c.json({
      query: parsed.body.query,
      actor,
      purpose: parsed.body.purpose,
      evidence_channel: evidenceResult.hits,
      memory_channel: memoryResult.hits,
      evidence_audit_id: evidenceResult.audit_id,
      memory_audit_id: memoryResult.audit_id,
    });
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
