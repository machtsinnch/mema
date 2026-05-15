// Graph view (companion of Layer 5 retrieval) — walks the vault for one owner
// and returns {nodes, edges} ready for any graph viewer (Obsidian, cytoscape,
// vis-network, the bundled /graph HTML page). All edges come from the same
// Obsidian-compatible frontmatter fields that the writers and the backfill
// script populate:
//
//   episode.refs[]            → episode-to-episode edges
//   fact.derived_from[]       → fact-to-episode edges
//   fact.superseded_by        → fact-to-fact edges
//   cognitive.derived_from[]  → cognitive-to-(episode|fact) edges
//   cognitive.superseded_by   → cognitive-to-cognitive edges
//   entity.merged_into        → entity-to-entity redirect edges
//   v1 frontmatter.links[]    → v1-style wikilinks (backwards compatible)
//
// SECURITY: owner isolation is mandatory. All v2 walks scope to a per-owner
// subdirectory at the filesystem level. v1 legacy storage is entity/category-
// keyed (not owner-keyed), so the walk must traverse and filter frontmatter
// `owner` field; documented and tested in tests/v2/security-hardening.test.ts.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

export type GraphNodeKind = "episode" | "fact" | "cognitive" | "entity" | "v1_memory";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  owner: string;
  meta?: {
    subject?: string;
    predicate?: string;
    object?: string;
    confidence?: number;
    valid_from?: string;
    valid_to?: string | null;
    invalidated_at?: string | null;
    superseded_by?: string | null;
    verification_status?: string;
    tags?: string[];
    entity?: string;
  };
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "derived_from" | "superseded_by" | "refs" | "merged_into" | "wikilink";
}

export interface GraphView {
  owner: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodes_total: number;
    edges_total: number;
    by_kind: Record<string, number>;
    truncated: boolean;
  };
}

export interface GraphViewOptions {
  // Hard cap on total node count returned. Default 2000.
  limit?: number;
}
export const GRAPH_VIEW_DEFAULT_LIMIT = 2000;
export const GRAPH_VIEW_MAX_LIMIT = 10000;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(full));
    else if (e.endsWith(".md")) out.push(full);
  }
  return out;
}

function loadFrontmatter(path: string): Record<string, any> | null {
  try {
    return matter(readFileSync(path, "utf8")).data;
  } catch {
    return null;
  }
}

function parseWikilink(s: string): string | null {
  const m = s.match(/^\[\[([^\]|]+)(?:\|.*)?\]\]$/);
  return m ? m[1].trim() : null;
}

function shortLabel(text: string, max = 60): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

export function buildGraphView(
  vaultRoot: string,
  owner: string,
  opts: GraphViewOptions = {},
): GraphView {
  const limit = Math.max(1, Math.min(opts.limit ?? GRAPH_VIEW_DEFAULT_LIMIT, GRAPH_VIEW_MAX_LIMIT));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const byKind: Record<string, number> = { episode: 0, fact: 0, cognitive: 0, entity: 0, v1_memory: 0 };
  let truncated = false;

  function addNode(n: GraphNode): boolean {
    if (nodeIds.has(n.id)) return true;
    if (nodes.length >= limit) { truncated = true; return false; }
    nodeIds.add(n.id);
    nodes.push(n);
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    return true;
  }
  function addEdge(source: string, target: string, kind: GraphEdge["kind"]) {
    if (!source || !target || source === target) return;
    const key = `${source}|${target}|${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, kind });
  }

  // ── L1 episodes (owner-scoped walk) ─────────────────────────────
  for (const path of walk(join(vaultRoot, "episodes", owner))) {
    const fm = loadFrontmatter(path);
    if (!fm || fm.tombstone === true || fm.owner !== owner || !fm.id) continue;
    if (!addNode({
      id: fm.id, kind: "episode", owner,
      label: shortLabel((fm.source as string) ?? fm.kind ?? "episode"),
      meta: { tags: fm.tags ?? [] },
    })) break;
    for (const r of (fm.refs ?? []) as string[]) addEdge(fm.id, r, "refs");
  }

  // ── L2 facts (owner-scoped walk) ────────────────────────────────
  if (!truncated) for (const path of walk(join(vaultRoot, "facts", owner))) {
    const fm = loadFrontmatter(path);
    if (!fm || fm.tombstone === true || fm.owner !== owner || !fm.id) continue;
    if (!addNode({
      id: fm.id, kind: "fact", owner,
      label: shortLabel(`${fm.subject} ${fm.predicate} ${fm.object}`),
      meta: {
        subject: fm.subject, predicate: fm.predicate, object: fm.object,
        confidence: fm.confidence, valid_from: fm.valid_from,
        valid_to: fm.valid_to, invalidated_at: fm.invalidated_at,
        superseded_by: fm.superseded_by,
        verification_status: fm.verification_status,
      },
    })) break;
    for (const d of (fm.derived_from ?? []) as string[]) addEdge(fm.id, d, "derived_from");
    if (fm.superseded_by) addEdge(fm.id, fm.superseded_by, "superseded_by");
  }

  // ── L3 cognitive (owner-scoped walk) ────────────────────────────
  if (!truncated) for (const path of walk(join(vaultRoot, "cognitive", owner))) {
    const fm = loadFrontmatter(path);
    if (!fm || fm.tombstone === true || fm.owner !== owner || !fm.id) continue;
    if (!addNode({
      id: fm.id, kind: "cognitive", owner,
      label: shortLabel(`${fm.kind}: ${(fm.derived_from ?? []).length} sources`),
      meta: {
        confidence: fm.confidence, superseded_by: fm.superseded_by,
        verification_status: fm.verification_status,
      },
    })) break;
    for (const d of (fm.derived_from ?? []) as string[]) addEdge(fm.id, d, "derived_from");
    if (fm.superseded_by) addEdge(fm.id, fm.superseded_by, "superseded_by");
  }

  // ── L2 entities (owner-scoped walk) ─────────────────────────────
  if (!truncated) for (const path of walk(join(vaultRoot, "v2-entities", owner))) {
    const fm = loadFrontmatter(path);
    if (!fm || fm.tombstone === true || fm.owner !== owner || !fm.id) continue;
    if (!addNode({
      id: fm.id, kind: "entity", owner,
      label: shortLabel(fm.name ?? "entity"),
      meta: { tags: fm.aliases ?? [] },
    })) break;
    if (fm.merged_into) addEdge(fm.id, fm.merged_into, "merged_into");
  }

  // ── v1 legacy memories ──────────────────────────────────────────
  // NOTE: v1 storage is entity/category-keyed (not owner-keyed). The walk
  // must traverse all subdirectories under entities/ and generalized/, then
  // filter by `fm.owner`. `data/users/{owner}/` IS owner-keyed and is read
  // via per-owner walk. Single-tenant deployments hit the same disk pages
  // either way; multi-tenant deployments should note this and either keep
  // v1 records segregated by mount point or migrate to v2 storage.
  if (!truncated) {
    // Fast path: users/ is owner-keyed.
    for (const path of walk(join(vaultRoot, "users", owner))) {
      const fm = loadFrontmatter(path);
      if (!fm || fm.forgotten === true || fm.owner !== owner || !fm.id) continue;
      if (!addNode({
        id: fm.id, kind: "v1_memory", owner,
        label: shortLabel((fm.aliases?.[0] as string) ?? "v1 user note"),
        meta: { tags: fm.tags ?? [] },
      })) break;
      for (const l of (fm.links ?? []) as string[]) {
        const target = parseWikilink(l);
        if (target) addEdge(fm.id, target, "wikilink");
      }
    }
    // entities/ and generalized/ — not owner-keyed; walk + filter.
    for (const root of ["entities", "generalized"]) {
      if (truncated) break;
      for (const path of walk(join(vaultRoot, root))) {
        const fm = loadFrontmatter(path);
        if (!fm || fm.forgotten === true || fm.owner !== owner || !fm.id) continue;
        if (!addNode({
          id: fm.id, kind: "v1_memory", owner,
          label: shortLabel((fm.aliases?.[0] as string) ?? fm.entity ?? "v1"),
          meta: { tags: fm.tags ?? [], entity: fm.entity },
        })) break;
        for (const l of (fm.links ?? []) as string[]) {
          const target = parseWikilink(l);
          if (target) addEdge(fm.id, target, "wikilink");
        }
      }
    }
  }

  // Drop edges whose target node doesn't exist (orphan link, or pointed to
  // a node we never added e.g. because of truncation).
  const validEdges = edges.filter(e => nodeIds.has(e.target));

  return {
    owner,
    nodes,
    edges: validEdges,
    stats: {
      nodes_total: nodes.length,
      edges_total: validEdges.length,
      by_kind: byKind,
      truncated,
    },
  };
}
