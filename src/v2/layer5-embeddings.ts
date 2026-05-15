// Layer 5 (companion) — Pluggable embedder + sqlite vector store.
//
// Filesystem-truth preserved: the markdown vault is authoritative. The vector
// store under data/_meta/vectors.sqlite is **derived state**, rebuildable from
// the vault at any time via reindexAll().
//
// Embedder interface lets us swap providers without changing storage or recall:
//   - LocalHashEmbedder   : deterministic, no API key, ships today
//   - OpenAIEmbedder      : activates when OPENAI_API_KEY is set
//   - VoyageEmbedder      : activates when VOYAGE_API_KEY is set
//
// Vectors are stored as JSON arrays in sqlite (no sqlite-vec extension needed —
// sqlite-vec is a stretch goal once we've validated retrieval quality).

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export interface Embedder {
  name: string;
  dim: number;
  embed(text: string): Promise<number[]>;
}

// ── LocalHashEmbedder ─────────────────────────────────────────────────
// Deterministic, hash-based projection. Not "semantic" in the
// transformer-embedding sense, but discriminating enough that two documents
// sharing the same rare tokens get closer than two sharing only stopwords.
//
// Method: tokenize → for each token, hash to D buckets, increment bucket by
// IDF-ish weight (log(1 + 1/df) approximated as 1/sqrt(token_count_in_doc)).
// Normalize. This is essentially a sparse character-shingled bag-of-words
// projected to a fixed-dim dense vector via the hashing trick.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at",
  "for", "with", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "by", "from", "we", "you",
  "i", "he", "she", "they", "our", "your", "their", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "der", "die", "das", "den", "dem", "des", "und", "oder", "aber", "ist",
  "sind", "war", "waren", "sein", "haben", "hat", "hatte", "wird", "werden",
  "ein", "eine", "einen", "einer", "eines", "auf", "in", "zu", "mit", "von",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]/gu, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 32 && !STOPWORDS.has(t));
}

function hashTo(buckets: number, token: string): number {
  const h = createHash("md5").update(token).digest();
  const combined = (((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0);
  return combined % buckets;
}

function norm(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n === 0) return v;
  return v.map(x => x / n);
}

export class LocalHashEmbedder implements Embedder {
  readonly name = "local-hash";
  readonly dim: number;
  constructor(dim = 256) { this.dim = dim; }
  async embed(text: string): Promise<number[]> {
    const tokens = tokenize(text);
    if (tokens.length === 0) return new Array(this.dim).fill(0);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Array<number>(this.dim).fill(0);
    for (const [tok, c] of tf) {
      // Two hash buckets per token (reduces collisions on small dim)
      const b1 = hashTo(this.dim, tok);
      const b2 = hashTo(this.dim, tok + ":signed");
      const weight = (1 + Math.log(c)) / Math.sqrt(tokens.length);
      v[b1] += weight;
      v[b2] -= weight * 0.5;
    }
    return norm(v);
  }
}

// ── OpenAIEmbedder ────────────────────────────────────────────────────
// Activates when OPENAI_API_KEY env is set. Falls back to LocalHashEmbedder
// otherwise.

export class OpenAIEmbedder implements Embedder {
  readonly name = "openai-text-embedding-3-small";
  readonly dim = 1536;
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }
  async embed(text: string): Promise<number[]> {
    const r = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
    });
    if (!r.ok) throw new Error(`OpenAI embed failed: ${r.status} ${await r.text()}`);
    const d = await r.json() as { data: { embedding: number[] }[] };
    return d.data[0].embedding;
  }
}

export function pickEmbedder(): Embedder {
  const key = process.env.OPENAI_API_KEY;
  if (key && key.length > 10) {
    try { return new OpenAIEmbedder(key); } catch { /* fallback */ }
  }
  return new LocalHashEmbedder(256);
}

// ── Vector store (sqlite) ─────────────────────────────────────────────

let _vdb: Database | null = null;

export function initVectorStore(vaultRoot: string): void {
  const dbPath = `${vaultRoot}/_meta/vectors.sqlite`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      path TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_id TEXT,
      embedder TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec TEXT NOT NULL,           -- JSON array of floats
      updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vec_owner ON vectors(owner);
    CREATE INDEX IF NOT EXISTS idx_vec_kind ON vectors(kind);
  `);
  _vdb = db;
}

function vdb(): Database {
  if (!_vdb) throw new Error("Vector store not initialized");
  return _vdb;
}

export interface IndexRecordInput {
  path: string;
  owner: string;
  kind: "episode" | "fact" | "cognitive" | "v1_memory";
  record_id?: string;
  text: string;
  embedder: Embedder;
}

export async function indexRecord(input: IndexRecordInput): Promise<void> {
  const v = await input.embedder.embed(input.text);
  vdb().prepare(`
    INSERT INTO vectors (path, owner, kind, record_id, embedder, dim, vec, updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      owner=excluded.owner, kind=excluded.kind, record_id=excluded.record_id,
      embedder=excluded.embedder, dim=excluded.dim, vec=excluded.vec, updated=excluded.updated
  `).run(
    input.path,
    input.owner,
    input.kind,
    input.record_id ?? null,
    input.embedder.name,
    input.embedder.dim,
    JSON.stringify(v),
    new Date().toISOString(),
  );
}

export function deleteVector(path: string): void {
  vdb().prepare(`DELETE FROM vectors WHERE path = ?`).run(path);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface VectorSearchHit {
  path: string;
  owner: string;
  kind: string;
  record_id: string | null;
  score: number;
}

export async function vectorSearch(
  query: string,
  owner: string,
  embedder: Embedder,
  limit = 20,
): Promise<VectorSearchHit[]> {
  const qv = await embedder.embed(query);
  // Pull all rows for this owner (small N for v2.0; sqlite-vec arrives v2.1 if needed)
  const rows = vdb().prepare(`SELECT * FROM vectors WHERE owner = ? AND embedder = ?`)
    .all(owner, embedder.name) as any[];
  const scored: VectorSearchHit[] = [];
  for (const r of rows) {
    const v: number[] = JSON.parse(r.vec);
    const s = cosine(qv, v);
    if (s > 0) scored.push({ path: r.path, owner: r.owner, kind: r.kind, record_id: r.record_id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Reindex the entire vault. Walks v2 storage directories + v1 vault. Idempotent.
export async function reindexAll(
  vaultRoot: string,
  embedder: Embedder,
  opts: { owner?: string; verbose?: boolean } = {},
): Promise<{ indexed: number; skipped: number }> {
  const { readdirSync, statSync } = require("node:fs");
  const matter = (await import("gray-matter")).default;
  let indexed = 0, skipped = 0;

  function walk(dir: string): string[] {
    const out: string[] = [];
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return []; }
    for (const e of entries) {
      const full = `${dir}/${e}`;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) out.push(...walk(full));
      else if (e.endsWith(".md")) out.push(full);
    }
    return out;
  }

  const candidates = [
    `${vaultRoot}/episodes`,
    `${vaultRoot}/facts`,
    `${vaultRoot}/cognitive`,
    `${vaultRoot}/entities`,         // v1 entity storage
    `${vaultRoot}/generalized`,      // v1 generalized hubs
    `${vaultRoot}/users`,            // v1 user notes
  ];
  for (const root of candidates) {
    for (const path of walk(root)) {
      try {
        const parsed = matter(readFileSync(path, "utf8"));
        const fm = parsed.data;
        const owner = fm.owner;
        if (!owner) { skipped++; continue; }
        if (opts.owner && opts.owner !== owner) { skipped++; continue; }
        // Skip soft-forgotten and tombstones
        if (fm.forgotten === true || fm.tombstone === true) { skipped++; continue; }
        const kind = path.includes("/episodes/") ? "episode"
                   : path.includes("/facts/") ? "fact"
                   : path.includes("/cognitive/") ? "cognitive"
                   : "v1_memory";
        const text = [
          (fm.aliases ?? []).join(" "),
          fm.name ?? "",
          fm.subject ?? "", fm.predicate ?? "", fm.object ?? "",
          (fm.tags ?? []).join(" "),
          parsed.content.trim().slice(0, 4000),
        ].filter(Boolean).join("\n");
        await indexRecord({
          path,
          owner,
          kind: kind as any,
          record_id: fm.id ?? null,
          text,
          embedder,
        });
        indexed++;
      } catch {
        skipped++;
      }
    }
  }
  return { indexed, skipped };
}
