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
// sharing the same rare lexical surface (tokens AND character n-grams) get
// closer than two sharing only stopwords.
//
// Method:
//   1. Tokenize → drop stopwords → keep word tokens (length 2..32)
//   2. Also extract character 3-grams from each token (catches acronyms,
//      partial matches, identifier suffixes like "NCPCS-3041")
//   3. For each feature (token + each 3-gram), hash to D buckets using THREE
//      signed hash functions (catches collisions that 2-hash misses)
//   4. Weight word-token features higher than n-gram features (signal density)
//   5. Normalize to unit length for cosine similarity
//
// Bumped from 256 → 512 dims to halve collision rate at the cost of 2× index
// size (still tiny — 4 KB per record at float32).
//
// Schema-versioned: increment EMBEDDER_VERSION on any change to the projection
// so vectorSearch can reject stale rows and warn the operator to reindex.

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
    .replace(/[^\p{L}\p{N}\s\-_.]/gu, " ")    // keep dots/underscores in identifiers
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 64 && !STOPWORDS.has(t));
}

// Character n-grams from a single token. n=3 default — catches acronym
// substrings like "NCP", "PCS", "CS-", etc. We pad with sentinel "^" and "$"
// so first/last n-grams of short tokens are still meaningful.
function charNgrams(token: string, n = 3): string[] {
  const padded = `^${token}$`;
  if (padded.length < n) return [padded];
  const out: string[] = [];
  for (let i = 0; i <= padded.length - n; i++) {
    out.push(padded.slice(i, i + n));
  }
  return out;
}

function hashTo(buckets: number, token: string, salt: string): number {
  const h = createHash("md5").update(salt + ":" + token).digest();
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

// Bump this when changing the projection (dims, n-gram size, hash count,
// weight ratio). vectorSearch will skip rows whose embedder field doesn't
// match the current name + version, prompting a reindex.
export const EMBEDDER_VERSION = 2;

export class LocalHashEmbedder implements Embedder {
  readonly name = `local-hash-v${EMBEDDER_VERSION}`;
  readonly dim: number;
  // Word-token weight vs character-3-gram weight. Words carry more signal
  // (whole-meaning) so they dominate; n-grams add lexical fuzziness.
  private readonly TOKEN_WEIGHT = 1.0;
  private readonly NGRAM_WEIGHT = 0.35;
  constructor(dim = 512) { this.dim = dim; }
  async embed(text: string): Promise<number[]> {
    const tokens = tokenize(text);
    if (tokens.length === 0) return new Array(this.dim).fill(0);

    const v = new Array<number>(this.dim).fill(0);

    // Track term frequency over WORDS for log-tf scaling
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const docLen = Math.max(1, tokens.length);

    // ── Word-token features ─────────────────────────────────────────
    for (const [tok, c] of tf) {
      const weight = this.TOKEN_WEIGHT * (1 + Math.log(c)) / Math.sqrt(docLen);
      // Three signed hash functions reduce collision lifetime in cosine.
      v[hashTo(this.dim, tok, "h1")] += weight;
      v[hashTo(this.dim, tok, "h2")] -= weight * 0.6;
      v[hashTo(this.dim, tok, "h3")] += weight * 0.4;
    }

    // ── Character-3gram features (catches partial / acronym matches) ──
    const ngramTf = new Map<string, number>();
    for (const tok of tokens) {
      for (const ng of charNgrams(tok, 3)) {
        ngramTf.set(ng, (ngramTf.get(ng) ?? 0) + 1);
      }
    }
    const ngramDocLen = Math.max(1, [...ngramTf.values()].reduce((a, b) => a + b, 0));
    for (const [ng, c] of ngramTf) {
      const weight = this.NGRAM_WEIGHT * (1 + Math.log(c)) / Math.sqrt(ngramDocLen);
      v[hashTo(this.dim, ng, "n1")] += weight;
      v[hashTo(this.dim, ng, "n2")] -= weight * 0.5;
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

// ── OllamaEmbedder (v2.7.6+, W4 from external review) ─────────────────
// Local transformer-quality embeddings via Ollama's /api/embeddings
// endpoint. Default model nomic-embed-text (768 dims) — install with
// `ollama pull nomic-embed-text`. Privacy-preserved (everything stays
// on-device), but produces real semantic vectors rather than the
// deterministic-hash projection of LocalHashEmbedder. Closes the
// paraphrase/cross-language gap the reviewer called out.
//
// Activation:
//   MEMA_EMBEDDER=ollama
//   OLLAMA_HOST=http://localhost:11434       (default if unset)
//   OLLAMA_EMBED_MODEL=nomic-embed-text       (default if unset)
//   OLLAMA_EMBED_DIM=768                       (default if unset; constructor
//                                               uses this until the first
//                                               real embed call refines it)
//
// v2.9.0+ (P0-F from second external review): the constructor seeds the dim
// from OLLAMA_EMBED_DIM (or a per-model fallback table) so vectorIndexHealth
// and other consumers that read .dim BEFORE the first embed() call no longer
// see 0 and incorrectly flag every row as stale. The first real embed call
// still corrects the dim if it disagrees with the seed.
const OLLAMA_KNOWN_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "snowflake-arctic-embed": 1024,
  "bge-m3": 1024,
};

export class OllamaEmbedder implements Embedder {
  readonly name: string;
  private _dim: number;
  private host: string;
  private model: string;
  constructor(model = "nomic-embed-text", host = "http://localhost:11434", dim?: number) {
    this.model = model;
    this.host = host.replace(/\/+$/, "");
    this.name = `ollama:${model}`;
    const envDim = process.env.OLLAMA_EMBED_DIM ? Number(process.env.OLLAMA_EMBED_DIM) : NaN;
    const knownDim = OLLAMA_KNOWN_DIMS[model] ?? 0;
    this._dim = dim ?? (Number.isFinite(envDim) && envDim > 0 ? envDim : knownDim);
  }
  get dim(): number {
    // v2.9.0+: never 0 — seeded from OLLAMA_EMBED_DIM env, known-model table,
    // or explicit constructor arg. The first embed() call corrects this if
    // the model returns a different dim than we expected.
    return this._dim;
  }
  async embed(text: string): Promise<number[]> {
    const r = await fetch(`${this.host}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text.slice(0, 8000) }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Ollama embed failed: ${r.status} ${body.slice(0, 200)}`);
    }
    const d = await r.json() as { embedding: number[] };
    if (!Array.isArray(d.embedding)) {
      throw new Error(`Ollama embed returned malformed payload (no embedding array)`);
    }
    // First real embed call corrects the seed if it disagrees — the model
    // is the source of truth for dimension. We log nothing here to keep
    // the hot path silent; mismatches surface via vectorIndexHealth.
    if (this._dim === 0 || this._dim !== d.embedding.length) this._dim = d.embedding.length;
    return d.embedding;
  }
}

export function pickEmbedder(): Embedder {
  // v2.7.6+ explicit selector via MEMA_EMBEDDER. Honored regardless of
  // which API keys happen to be in the environment, so dev/test/staging
  // can force a specific backend deterministically.
  const selector = (process.env.MEMA_EMBEDDER ?? "").toLowerCase();
  if (selector === "ollama") {
    const model = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
    const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    return new OllamaEmbedder(model, host);
  }
  if (selector === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (key && key.length > 10) return new OpenAIEmbedder(key);
  }
  if (selector === "local") {
    return new LocalHashEmbedder(512);
  }
  // Auto-detect: OpenAI key present → use OpenAI; otherwise default to
  // the deterministic local embedder. Ollama is opt-in via MEMA_EMBEDDER
  // because it requires the model to be pulled first.
  const key = process.env.OPENAI_API_KEY;
  if (key && key.length > 10) {
    try { return new OpenAIEmbedder(key); } catch { /* fallback */ }
  }
  return new LocalHashEmbedder(512);
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
  // Filter by current embedder name + dim. If rows exist under a different
  // embedder name (i.e. the user upgraded mema without reindexing), the query
  // will return 0 — but countStaleVectors() surfaces the mismatch via the
  // /v2/vector/health endpoint so operators see a clear "reindex needed" signal.
  const rows = vdb().prepare(`SELECT * FROM vectors WHERE owner = ? AND embedder = ? AND dim = ?`)
    .all(owner, embedder.name, embedder.dim) as any[];
  const scored: VectorSearchHit[] = [];
  for (const r of rows) {
    const v: number[] = JSON.parse(r.vec);
    const s = cosine(qv, v);
    if (s > 0) scored.push({ path: r.path, owner: r.owner, kind: r.kind, record_id: r.record_id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Detect stale vectors from a previous embedder. Used to warn operators after
// an upgrade that they should run /v2/vector/reindex before relying on
// semantic recall.
export function vectorIndexHealth(currentEmbedder: Embedder): {
  current_rows: number;
  stale_rows: number;
  stale_embedders: string[];
  needs_reindex: boolean;
} {
  const current = vdb().prepare(
    `SELECT COUNT(*) as n FROM vectors WHERE embedder = ? AND dim = ?`
  ).get(currentEmbedder.name, currentEmbedder.dim) as { n: number };
  const stale = vdb().prepare(
    `SELECT embedder, COUNT(*) as n FROM vectors WHERE NOT (embedder = ? AND dim = ?) GROUP BY embedder`
  ).all(currentEmbedder.name, currentEmbedder.dim) as { embedder: string; n: number }[];
  const stale_rows = stale.reduce((s, r) => s + r.n, 0);
  return {
    current_rows: current.n,
    stale_rows,
    stale_embedders: stale.map(s => s.embedder),
    needs_reindex: stale_rows > 0 && current.n === 0,
  };
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
    `${vaultRoot}/v2-entities`,      // v2 entity storage (P0-D from review)
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
        // v2.9.0+ acceptance lifecycle filter — never index drafts or
        // rejected records, even if reindex is run mid-review.
        if (fm.status === "draft" || fm.status === "rejected") { skipped++; continue; }
        const kind = path.includes("/episodes/") ? "episode"
                   : path.includes("/facts/") ? "fact"
                   : path.includes("/cognitive/") ? "cognitive"
                   : path.includes("/v2-entities/") ? "entity"
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
