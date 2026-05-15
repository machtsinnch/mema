// Layer 5: Retrieval — hybrid recall across L1/L2/L3 + v1 legacy vault.
//
// Pipeline:
//   1. Keyword search via ripgrep (covers v1 vault + v2 episodes/facts/cognitive)
//   2. Filter by temporal validity (L2 facts only)
//   3. Filter by governance policy (L4 policyCheck per record)
//   4. Score: relevance (keyword match count) × confidence × recency
//   5. Build evidence chain (which records support each hit)
//   6. Log to audit (full result set, not just top-1)
//
// v2.0 stubs: vector search (use_vector flag is accepted but does keyword fallback;
// real sqlite-vec wiring lands in v2.1). Graph traversal (entity → facts → episodes)
// also stubbed for v2.0.

import { $ } from "bun";
import { readFileSync, existsSync } from "node:fs";
import matter from "gray-matter";
import type {
  RetrievalQuery, RetrievalResult, RetrievalHit, RetrievalKind,
  SemanticFact, Governance,
} from "./types";
import { policyCheck } from "./layer4-governance";
import { appendAudit } from "./layer6-audit";
import { pickEmbedder, vectorSearch, type Embedder } from "./layer5-embeddings";
import { buildEvidenceChain } from "./layer5-graph";

// Module-level cached embedder — initialized once per process.
let _embedder: Embedder | null = null;
function embedder(): Embedder {
  if (!_embedder) _embedder = pickEmbedder();
  return _embedder;
}

interface RawHit {
  kind: RetrievalKind | "v1_memory";
  id: string;
  path: string;
  match_count: number;
  excerpt: string;
  governance?: Governance;
  fact_meta?: Partial<SemanticFact>;
}

async function ripgrepAcross(
  vaultRoot: string,
  query: string,
): Promise<{ byPath: Map<string, { matches: number; firstLine: string; tokensMatched: Set<string> }>, tokenDocFreq: Map<string, number> }> {
  if (!query.trim()) return { byPath: new Map(), tokenDocFreq: new Map() };
  const tokens = query
    .split(/\s+/)
    .map(t => t.replace(/^[^\w-]+|[^\w-]+$/g, "").toLowerCase())
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return { byPath: new Map(), tokenDocFreq: new Map() };
  const eFlags = tokens.flatMap(t => ["-e", t]);
  const proc = await $`rg --json -i -g "*.md" ${eFlags} ${vaultRoot}`
    .nothrow().quiet();
  const result = proc.text();
  // Detect missing ripgrep binary. `rg` returns 1 for "no matches" (normal) and
  // 0 for "matches found" (normal); other exit codes (127 missing, 2 usage)
  // indicate a real failure that would silently zero out retrieval.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(`ripgrep failed with exit code ${proc.exitCode} — is rg installed and on PATH?`);
  }
  const byPath = new Map<string, { matches: number; firstLine: string; tokensMatched: Set<string> }>();
  for (const line of result.split("\n")) {
    if (!line) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type !== "match") continue;
    const path = evt.data.path.text;
    const text = evt.data.lines.text.trim();
    const matchedTokens: string[] = [];
    for (const sm of evt.data.submatches ?? []) {
      const tok = (sm.match?.text ?? "").toLowerCase();
      if (tok) matchedTokens.push(tok);
    }
    const prev = byPath.get(path);
    if (prev) {
      prev.matches++;
      for (const t of matchedTokens) prev.tokensMatched.add(t);
    } else {
      byPath.set(path, { matches: 1, firstLine: text, tokensMatched: new Set(matchedTokens) });
    }
  }
  // Token document-frequency for IDF
  const tokenDocFreq = new Map<string, number>();
  for (const [, info] of byPath) {
    for (const t of info.tokensMatched) {
      tokenDocFreq.set(t, (tokenDocFreq.get(t) ?? 0) + 1);
    }
  }
  return { byPath, tokenDocFreq };
}

function classifyPath(path: string): RetrievalKind | "v1_memory" {
  if (path.includes("/episodes/")) return "episode";
  if (path.includes("/facts/")) return "fact";
  if (path.includes("/cognitive/")) return "cognitive";
  return "v1_memory";   // legacy v1 vault: data/entities/, data/generalized/, data/users/
}

function loadRecord(path: string): { frontmatter: any; body: string } | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = matter(raw);
    return { frontmatter: parsed.data, body: parsed.content.trim() };
  } catch { return null; }
}

export async function recall(
  vaultRoot: string,
  query: RetrievalQuery,
): Promise<RetrievalResult> {
  const { byPath: matches, tokenDocFreq } = await ripgrepAcross(vaultRoot, query.query);
  const totalDocs = matches.size || 1;
  const queryTokens = query.query
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/^[^\w-]+|[^\w-]+$/g, ""))
    .filter(t => t.length >= 2);

  // ── Vector retrieval (additive signal) ───────────────────────────────
  // Fetched once, then merged into the per-path scoring loop. If the embedder
  // or vector store is unavailable, vector score is 0 (recall falls back to
  // keyword-only gracefully).
  const vectorByPath = new Map<string, number>();
  if (query.use_vector !== false) {
    try {
      const vhits = await vectorSearch(query.query, query.owner, embedder(), 50);
      for (const h of vhits) vectorByPath.set(h.path, h.score);
      // Also add vector-only hits to the matches map so they have a chance to score
      // (they won't get IDF, but vector score alone can carry them in).
      for (const h of vhits) {
        if (!matches.has(h.path)) {
          matches.set(h.path, { matches: 0, firstLine: "", tokensMatched: new Set() });
        }
      }
    } catch { /* vector store not initialized — silently fall back */ }
  }

  const hits: RetrievalHit[] = [];
  const evidenceChain: string[] = [];
  const validAt = query.temporal?.valid_at ?? new Date().toISOString();

  for (const [path, { matches: mCount, firstLine, tokensMatched }] of matches) {
    const kind = classifyPath(path);
    const rec = loadRecord(path);
    if (!rec) continue;

    // Owner filter — never cross-tenant leak.
    // CRITICAL: a record with no `owner` frontmatter is treated as DENY, not pass-through.
    // Closes the v1-legacy-leak bug where records lacking an owner field were returned
    // to every tenant.
    const owner = rec.frontmatter.owner;
    if (!owner || owner !== query.owner) continue;

    // Layer restriction (if specified)
    if (query.kinds && kind !== "v1_memory") {
      if (!query.kinds.includes(kind as RetrievalKind)) continue;
    }

    // Temporal filter for facts
    if (kind === "fact") {
      const f = rec.frontmatter as SemanticFact;
      if (f.valid_from > validAt) continue;
      if (f.valid_to && f.valid_to < validAt) continue;
      if (f.invalidated_at && f.invalidated_at < validAt) continue;
    }

    // Skip tombstones (hard-erased)
    if (rec.frontmatter.tombstone === true) continue;
    // Skip v1 soft-forgotten
    if (rec.frontmatter.forgotten === true) continue;

    // Governance policy check
    const gov = rec.frontmatter.governance as Governance | undefined;
    const policy = policyCheck(gov, { actor: query.actor, purpose: query.purpose, now: validAt });
    if (!policy.allowed) {
      // record the denial in audit but don't surface
      appendAudit({
        op: "POLICY_DENY",
        actor: query.actor,
        owner: query.owner,
        purpose: query.purpose,
        record_ids: [rec.frontmatter.id ?? path],
        reason: policy.reason,
      });
      continue;
    }

    // ── BM25-style scoring with IDF over the result set ──────────────
    // Rare query terms count more (e.g. "3a" matches few docs → high IDF).
    // Common terms ("strategy", "memory") match many docs → low IDF.
    let idfScore = 0;
    for (const t of tokensMatched) {
      const df = tokenDocFreq.get(t) ?? 1;
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      idfScore += idf;
    }
    // Normalize per query length, cap at 1
    const idfNorm = Math.min(idfScore / Math.max(queryTokens.length, 1) / 2, 1);

    // Title/alias boost: if any query token appears in the doc's alias/tags, big bump
    const titleSource = [
      ...(rec.frontmatter.aliases ?? []),
      rec.frontmatter.alias,
      ...(rec.frontmatter.tags ?? []),
      rec.frontmatter.subject,
      rec.frontmatter.predicate,
    ].filter(Boolean).join(" ").toLowerCase();
    const titleHits = queryTokens.filter(t => titleSource.includes(t)).length;
    const titleBoost = Math.min(titleHits / Math.max(queryTokens.length, 1), 1);

    const layerPrior = kind === "cognitive" ? 1.0 : kind === "fact" ? 0.9 : kind === "episode" ? 0.7 : 0.6;
    // CRITICAL: defensive clamp against NaN/Infinity in stored confidence.
    // Even though clampConfidence is applied at write boundaries, legacy v1
    // records may have arbitrary trust values.
    const rawConfidence = rec.frontmatter.confidence ?? rec.frontmatter.trust ?? 0.5;
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0.5;
    const vectorScore = vectorByPath.get(path) ?? 0;
    // Fused score: keyword-IDF (30%) + title hit (25%) + vector cosine (25%) +
    // confidence (10%) + layer prior (10%). Vector lifts paraphrase queries where
    // keyword fails; keyword/title still anchor when the exact words appear.
    const score = idfNorm * 0.30 + titleBoost * 0.25 + vectorScore * 0.25
                + confidence * 0.10 + layerPrior * 0.10;

    // Excerpt prefers the doc's own title/alias over the first matched line (which
    // is often a table-of-contents or boilerplate match).
    const titleAlias = rec.frontmatter.aliases?.[0] ?? rec.frontmatter.alias ?? null;
    const excerpt = titleAlias ? `${titleAlias} — ${firstLine.slice(0, 160)}` : firstLine.slice(0, 240);

    // Build human-readable "why retrieved" — the strongest contributing signal
    const parts: string[] = [];
    if (titleBoost > 0.5) parts.push("title match");
    if (idfNorm > 0.5) parts.push("rare-term keyword match");
    if (vectorScore > 0.3) parts.push(`semantic similarity (${vectorScore.toFixed(2)})`);
    if (confidence > 0.8) parts.push(`high source confidence`);
    if (parts.length === 0) parts.push("weak signal");
    const why = parts.join(" + ");

    const hit: RetrievalHit = {
      kind: kind === "v1_memory" ? "episode" : kind,
      id: rec.frontmatter.id ?? path,
      score,
      score_components: { idf: idfNorm, title: titleBoost, vector: vectorScore, confidence, layerPrior },
      excerpt,
      governance: policy,
      // Verifiable-asset fields — populated when the record has been wrapped as an asset
      ual: rec.frontmatter.ual,
      content_hash: rec.frontmatter.content_hash,
      metadata_hash: rec.frontmatter.metadata_hash,
      asset_version: rec.frontmatter.asset_version,
      verification_status: rec.frontmatter.verification_status,
      why_retrieved: why,
    };
    hits.push(hit);
    evidenceChain.push(hit.id);

    // For facts: include derived_from chain
    if (kind === "fact" && rec.frontmatter.derived_from) {
      evidenceChain.push(...(rec.frontmatter.derived_from as string[]));
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(query.limit ?? 10, 100));
  const finalHits = hits.slice(0, limit);

  // ── Graph expansion of evidence chain ────────────────────────────────
  // For each top hit, walk derived_from up to 2 hops to surface supporting
  // records (episodes that justified a fact, facts that supported a belief).
  const expandedEvidence = buildEvidenceChain(
    vaultRoot,
    query.owner,
    finalHits.map(h => h.id).filter(id => !id.startsWith("/")),  // skip path-only IDs
    2,
  );
  const fullChain = [...new Set([...evidenceChain, ...expandedEvidence].slice(0, limit * 5))];

  // Audit log entry — full evidence chain including graph expansion
  const auditEntry = appendAudit({
    op: "RECALL",
    actor: query.actor,
    owner: query.owner,
    purpose: query.purpose,
    record_ids: finalHits.map(h => h.id),
    evidence_chain: fullChain,
  });

  return {
    query: query.query,
    actor: query.actor,
    purpose: query.purpose,
    hits: finalHits,
    evidence_chain: fullChain,
    audit_id: String(auditEntry.seq),
  };
}
