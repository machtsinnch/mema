// Layer 5 (companion) — Graph traversal helpers.
//
// Not a separate graph DB. Walks the existing derived_from links between
// records (episode → fact → cognitive) and the subject/predicate/object links
// between facts. Filesystem-truth preserved — the graph is implicit in the
// frontmatter pointers; we just read them.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { SemanticFact, CognitiveRecord, Episode } from "./types";
import { idFromFilename } from "./types";

export interface GraphNode {
  id: string;
  kind: "episode" | "fact" | "cognitive";
  path: string;
}

// Walk backwards: from a record, find all records that supported it via
// derived_from. Depth-limited to prevent cycles + runaway.
export function walkDerivedFrom(
  vaultRoot: string,
  owner: string,
  rootId: string,
  maxDepth = 3,
): GraphNode[] {
  const visited = new Set<string>();
  const out: GraphNode[] = [];

  function findByIdInDir(dir: string, id: string): { path: string; fm: any } | null {
    if (!existsSync(dir)) return null;
    // Legacy: try `{id}.md` first (cheap stat) before scanning.
    const legacy = join(dir, `${id}.md`);
    if (existsSync(legacy)) {
      try { return { path: legacy, fm: matter(readFileSync(legacy, "utf8")).data }; } catch { /* */ }
    }
    for (const f of readdirSync(dir)) {
      if (idFromFilename(f) !== id) continue;
      const p = join(dir, f);
      try { return { path: p, fm: matter(readFileSync(p, "utf8")).data }; } catch { /* */ }
    }
    return null;
  }

  function find(id: string): { path: string; fm: any } | null {
    // Try cognitive (across all three kinds)
    for (const kind of ["belief", "observation", "experience"]) {
      const hit = findByIdInDir(join(vaultRoot, "cognitive", owner, kind), id);
      if (hit) return hit;
    }
    // Try fact
    const factHit = findByIdInDir(join(vaultRoot, "facts", owner), id);
    if (factHit) return factHit;
    // Try episode (date bucket scan)
    const epOwnerDir = join(vaultRoot, "episodes", owner);
    if (existsSync(epOwnerDir)) {
      for (const bucket of readdirSync(epOwnerDir)) {
        const hit = findByIdInDir(join(epOwnerDir, bucket), id);
        if (hit) return hit;
      }
    }
    return null;
  }

  function recurse(id: string, depth: number) {
    if (depth > maxDepth || visited.has(id)) return;
    visited.add(id);
    const found = find(id);
    if (!found) return;
    const kind: GraphNode["kind"] =
      found.path.includes("/cognitive/") ? "cognitive" :
      found.path.includes("/facts/") ? "fact" : "episode";
    out.push({ id, kind, path: found.path });
    const derivedFrom: string[] = found.fm.derived_from ?? [];
    for (const child of derivedFrom) recurse(child, depth + 1);
  }

  recurse(rootId, 0);
  return out.slice(1);  // exclude root
}

// Find sibling facts: facts that share a subject with the given fact (e.g., all
// facts about entity X). Useful for expanding a single fact into the cluster of
// claims around the same subject.
export function walkSiblingFacts(
  vaultRoot: string,
  owner: string,
  subject: string,
  excludeFactId?: string,
): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      if (fact.subject !== subject) continue;
      if (excludeFactId && fact.id === excludeFactId) continue;
      if ((fact as any).invalidated_at) continue;
      out.push(fact);
    } catch { /* skip */ }
  }
  return out;
}

// Build evidence chain for a retrieval result: starting from each top hit,
// walk derived_from up to maxDepth and collect supporting record IDs.
export function buildEvidenceChain(
  vaultRoot: string,
  owner: string,
  hitIds: string[],
  maxDepth = 2,
): string[] {
  const all = new Set<string>(hitIds);
  for (const id of hitIds) {
    const supporting = walkDerivedFrom(vaultRoot, owner, id, maxDepth);
    for (const node of supporting) all.add(node.id);
  }
  return [...all];
}
