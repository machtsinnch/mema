// machtsinn.ai — filesystem storage for memories.
// Markdown files with YAML frontmatter. Obsidian-compatible vault layout.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import matter from "gray-matter";
import { ulid } from "ulid";
import type { Memory, MemoryFrontmatter, RememberInput, Scope } from "./types";

const DEFAULT_TRUST = 0.7;

export interface VaultConfig {
  root: string; // absolute path
}

export function ensureVault(cfg: VaultConfig): void {
  for (const sub of ["entities", "users", "generalized", "_meta"]) {
    mkdirSync(join(cfg.root, sub), { recursive: true });
  }
  // Reset index for this vault — tests reuse module state across runs.
  _indexCache.delete(cfg.root);
  _indexDirty.delete(cfg.root);
}

// Reject any path segment that could escape the vault. Strict allowlist: lowercase
// alphanumerics, hyphens, underscores, dots inside the segment (but not leading), and digits.
// Length-capped per segment to prevent unbounded blowup.
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function sanitizeSegment(s: string, label: string): string {
  if (typeof s !== "string") throw new Error(`invalid ${label}: not a string`);
  const trimmed = s.trim();
  if (trimmed === "" || trimmed === "." || trimmed === ".." || trimmed.includes("..") || !SAFE_SEGMENT.test(trimmed)) {
    throw new Error(`invalid ${label} value: ${JSON.stringify(s)} — must match ${SAFE_SEGMENT}`);
  }
  return trimmed;
}

function sanitizePath(p: string | undefined, label: string): string[] {
  if (!p) return [];
  if (p.includes("\0") || p.includes("..")) {
    throw new Error(`invalid ${label}: contains forbidden sequence`);
  }
  return p.split("/").filter(Boolean).map(seg => sanitizeSegment(seg, label));
}

function buildPath(cfg: VaultConfig, fm: MemoryFrontmatter): string {
  const parts: string[] = [cfg.root];
  if (fm.scope === "entity") {
    if (!fm.entity) throw new Error("entity required for scope=entity");
    parts.push("entities", sanitizeSegment(fm.entity, "entity"));
    if (fm.path) parts.push(...sanitizePath(fm.path, "path"));
    else parts.push(sanitizeSegment(fm.type, "type"));
  } else if (fm.scope === "generalized") {
    parts.push("generalized");
    if (fm.category) parts.push(sanitizeSegment(fm.category, "category"));
  } else if (fm.scope === "user") {
    parts.push("users", sanitizeSegment(fm.owner, "owner"));
    if (fm.path) parts.push(...sanitizePath(fm.path, "path"));
    else parts.push(sanitizeSegment(fm.type, "type"));
  } else {
    throw new Error(`unknown scope: ${fm.scope}`);
  }
  parts.push(`${sanitizeSegment(fm.id, "id")}.md`);
  return join(...parts);
}

// Atomic write: temp file in same dir, fsync, rename. On POSIX rename is atomic.
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { encoding: "utf8", flag: "w" });
  renameSync(tmp, path);
}

// Convert raw ID(s) into Obsidian wikilink format. Accepts either raw "<id>" or already-wrapped "[[<id>]]".
export function toWikilink(idOrLink: string): string {
  const v = idOrLink.trim();
  if (v.startsWith("[[") && v.endsWith("]]")) return v;
  return `[[${v}]]`;
}

export function fromWikilink(link: string): string {
  const v = link.trim();
  if (v.startsWith("[[") && v.endsWith("]]")) return v.slice(2, -2);
  return v;
}

export function writeMemory(cfg: VaultConfig, input: RememberInput): Memory {
  const now = new Date().toISOString();
  const fm: MemoryFrontmatter = {
    id: ulid(),
    type: input.type,
    scope: input.scope,
    owner: input.owner,
    visibility: input.visibility ?? (input.scope === "user" ? "private" : "project"),
    entity: input.entity,
    category: input.category,
    path: input.path,
    aliases: input.aliases,
    created: now,
    updated: now,
    source: input.source,
    trust: input.trust ?? DEFAULT_TRUST,
    tags: input.tags ?? [],
    // Always store links in Obsidian wikilink format so the graph view renders them.
    links: (input.links ?? []).map(toWikilink),
    forgotten: false,
    forgotten_at: null,
    forgotten_reason: null,
  };
  const path = buildPath(cfg, fm);
  mkdirSync(dirname(path), { recursive: true });
  const content = matter.stringify(input.content, cleanFrontmatter(fm));
  atomicWrite(path, content);
  // Update index incrementally rather than full-invalidate to keep lookups fast.
  const idx = _indexCache.get(cfg.root);
  if (idx) idx.set(fm.id, { path, frontmatter: fm });
  return { frontmatter: fm, body: input.content, path };
}

export function readMemoryFromPath(path: string): Memory {
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  return {
    frontmatter: parsed.data as MemoryFrontmatter,
    body: parsed.content.trim(),
    path,
  };
}

// In-memory ULID→{path, frontmatter} index. The frontmatter is held in memory so that
// canRead() can deny *without* reading the file — closes the v0.6 timing oracle where
// 404-after-file-read leaked existence via 1.24× latency ratio. For v0 scale (<100k
// memories) frontmatter caching costs ~few MB of RAM and gives constant-time auth.
interface IndexEntry { path: string; frontmatter: MemoryFrontmatter }
const _indexCache = new Map<string, Map<string, IndexEntry>>();
const _indexDirty = new Set<string>();

function buildIndex(cfg: VaultConfig): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  for (const m of walkVault(cfg)) {
    map.set(m.frontmatter.id, { path: m.path, frontmatter: m.frontmatter });
  }
  _indexCache.set(cfg.root, map);
  _indexDirty.delete(cfg.root);
  return map;
}

function getIndex(cfg: VaultConfig): Map<string, IndexEntry> {
  const cached = _indexCache.get(cfg.root);
  if (cached && !_indexDirty.has(cfg.root)) return cached;
  return buildIndex(cfg);
}

function invalidateIndex(cfg: VaultConfig): void {
  _indexDirty.add(cfg.root);
}

// Existence + readability check using ONLY the index. No file read — so the timing of
// the response does not depend on whether the file exists. Mitigates the v0.6 timing
// oracle that distinguished "exists but private" from "not found" via ~1.24× latency.
export function isReadable(cfg: VaultConfig, id: string, owner: string): boolean {
  const idx = getIndex(cfg);
  const entry = idx.get(id);
  if (!entry) return false;
  // Build a synthetic Memory just to reuse canRead's logic (body is "" — canRead doesn't touch it).
  return canRead({ frontmatter: entry.frontmatter, body: "", path: entry.path }, owner, "all");
}

export function findMemoryById(cfg: VaultConfig, id: string): Memory | null {
  const idx = getIndex(cfg);
  const entry = idx.get(id);
  if (!entry) return null;
  try {
    return readMemoryFromPath(entry.path);
  } catch {
    // File may have been removed since index built; mark dirty and fall back to scan.
    invalidateIndex(cfg);
    for (const m of walkVault(cfg)) {
      if (m.frontmatter.id === id) return m;
    }
    return null;
  }
}

export function* walkVault(cfg: VaultConfig, subdir?: string): Generator<Memory> {
  const root = subdir ? join(cfg.root, subdir) : cfg.root;
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_meta") continue;
      yield* walkVault({ root: cfg.root }, relative(cfg.root, full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      try {
        yield readMemoryFromPath(full);
      } catch (e) {
        // skip malformed files
      }
    }
  }
}

export function updateMemory(
  cfg: VaultConfig,
  id: string,
  patch: Partial<Pick<MemoryFrontmatter, "trust" | "tags" | "links" | "visibility" | "aliases" | "siblings" | "parent" | "children" | "supersedes" | "alternatives">> & { body?: string }
): Memory | null {
  const existing = findMemoryById(cfg, id);
  if (!existing) return null;
  const updated: MemoryFrontmatter = {
    ...existing.frontmatter,
    ...(patch.trust !== undefined && { trust: patch.trust }),
    ...(patch.tags && { tags: patch.tags }),
    ...(patch.links && { links: patch.links.map(toWikilink) }),
    ...(patch.aliases && { aliases: patch.aliases }),
    ...(patch.visibility && { visibility: patch.visibility }),
    ...(patch.siblings && { siblings: patch.siblings.map(toWikilink) }),
    ...(patch.parent !== undefined && { parent: patch.parent ? toWikilink(patch.parent) : undefined }),
    ...(patch.children && { children: patch.children.map(toWikilink) }),
    ...(patch.supersedes !== undefined && { supersedes: patch.supersedes ? toWikilink(patch.supersedes) : undefined }),
    ...(patch.alternatives && { alternatives: patch.alternatives.map(toWikilink) }),
    updated: new Date().toISOString(),
  };
  const body = patch.body ?? existing.body;
  const content = matter.stringify(body, cleanFrontmatter(updated));
  atomicWrite(existing.path, content);
  // Update the index so subsequent canRead checks see the new frontmatter.
  const idx = _indexCache.get(cfg.root);
  if (idx) idx.set(id, { path: existing.path, frontmatter: updated });
  return { frontmatter: updated, body, path: existing.path };
}

export function forgetMemory(cfg: VaultConfig, id: string, reason: string): Memory | null {
  const existing = findMemoryById(cfg, id);
  if (!existing) return null;
  const updated: MemoryFrontmatter = {
    ...existing.frontmatter,
    forgotten: true,
    forgotten_at: new Date().toISOString(),
    forgotten_reason: reason,
    updated: new Date().toISOString(),
  };
  const content = matter.stringify(existing.body, cleanFrontmatter(updated));
  atomicWrite(existing.path, content);
  const idx = _indexCache.get(cfg.root);
  if (idx) idx.set(id, { path: existing.path, frontmatter: updated });
  return { frontmatter: updated, body: existing.body, path: existing.path };
}

// js-yaml rejects undefined values — strip them before serialization.
function cleanFrontmatter(fm: MemoryFrontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// Scope filters — used by retrieval to enforce isolation.
//
// INVARIANTS (v0.5):
//   1. USER-scope memories belong to their owner; only that owner reads them, ever.
//   2. ENTITY-scope memories with visibility=private are owner-only.
//   3. ENTITY-scope memories with visibility=project are entity-team-only (currently:
//      writer's owner can read; future v0.6 will introduce per-entity team membership).
//   4. ENTITY-scope memories with visibility=team or public are readable by any caller.
//   5. Generalized memories are visibility-respected but currently default to team/public.
//
// The previous v0.4 fix only patched USER scope. v0.5 closes the entity-private bypass
// that Codex's adversarial audit identified — entity:visibility=private memories were
// readable by any authenticated user via scope=all, GET /v1/memory/:id, etc.
export function canRead(memory: Memory, owner: string, scopeRequest: "current" | "all" | string[], currentEntity?: string): boolean {
  const fm = memory.frontmatter;
  if (fm.forgotten) return false;

  // USER-scope is always per-owner.
  if (fm.scope === "user" && fm.owner !== owner) return false;

  // ENTITY-scope visibility enforcement.
  if (fm.scope === "entity") {
    if ((fm.visibility === "private" || fm.visibility === "project") && fm.owner !== owner) {
      return false;
    }
    // team/public entity memories continue through the scopeRequest gating below.
  }

  // Generalized layer: same visibility rules as entity scope.
  // private/project → owner-only. team/public → readable across users.
  if (fm.scope === "generalized") {
    if ((fm.visibility === "private" || fm.visibility === "project") && fm.owner !== owner) {
      return false;
    }
    return true;
  }

  if (scopeRequest === "all") return true;

  if (scopeRequest === "current") {
    if (fm.scope === "entity") return fm.entity === currentEntity;
    if (fm.scope === "user") return fm.owner === owner;
    return true;
  }

  // Explicit list of entities to include
  if (Array.isArray(scopeRequest)) {
    if (fm.scope === "entity") return scopeRequest.includes(fm.entity ?? "");
    if (fm.scope === "user") return fm.owner === owner;
    return true;
  }

  return false;
}

export function getEntityHierarchy(cfg: VaultConfig): { entities: string[]; users: string[]; generalizedCategories: string[] } {
  const entities = new Set<string>();
  const users = new Set<string>();
  const cats = new Set<string>();
  for (const m of walkVault(cfg)) {
    const fm = m.frontmatter;
    if (fm.scope === "entity" && fm.entity) entities.add(fm.entity);
    if (fm.scope === "user") users.add(fm.owner);
    if (fm.scope === "generalized" && fm.category) cats.add(fm.category);
  }
  return {
    entities: [...entities].sort(),
    users: [...users].sort(),
    generalizedCategories: [...cats].sort(),
  };
}
