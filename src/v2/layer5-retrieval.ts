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
import { join } from "node:path";
import matter from "gray-matter";
import type {
  RetrievalQuery, RetrievalResult, RetrievalHit, RetrievalKind,
  SemanticFact, Governance,
} from "./types";
import { policyCheck } from "./layer4-governance";
import { appendAudit } from "./layer6-audit";
import { pickEmbedder, vectorSearch, type Embedder } from "./layer5-embeddings";
import { buildEvidenceChain, buildSupportIndex } from "./layer5-graph";
import { factValidAt, toEpochMs } from "./temporal";
import { reciprocalRankFusion } from "./layer5-rrf";
import { relationVariants } from "./predicates";

// v2.16.3 — deterministic morphological variants for a query token, so
// "build" finds "built" and "holds" finds "hold". No stemming library, no
// LLM: a small irregulars table + conservative suffix rules. All variants
// are counted under the BASE token in scoring, so expansion never inflates
// IDF.
const IRREGULARS: Record<string, string[]> = {
  build: ["built"], built: ["build"],
  hold: ["held"], held: ["hold", "holds"], holds: ["held", "hold"],
  speak: ["spoke", "spoken", "speaks"], speaks: ["speak"],
  write: ["wrote", "written"], wrote: ["write"],
  lead: ["led"], led: ["lead"],
  make: ["made"], made: ["make"],
  teach: ["taught"], apply: ["applied", "applies"], applied: ["apply"],
};
export function morphVariants(token: string): string[] {
  const t = token.toLowerCase();
  const out = new Set<string>([t]);
  for (const v of IRREGULARS[t] ?? []) out.add(v);
  // v2.22.0 (round-2 finding): guard against degenerate stems. "ring" ->
  // "r" flooded recall AND forged a full titleBoost via includes("r").
  // Only keep a stem of >= 3 chars.
  // v2.22.0 (round-2 finding): only emit variants of >= 3 chars. "ring" ->
  // "r" flooded recall and forged a titleBoost; but "using" -> "use" (a
  // 2-char stem yielding a valid 3-char form) must still work, so each
  // candidate is filtered independently by length.
  const addV = (...cands: string[]) => { for (const c of cands) if (c.length >= 3) out.add(c); };
  if (t.length >= 4) {
    if (t.endsWith("ing")) { const s = t.slice(0, -3); addV(s, s + "e"); }
    else if (t.endsWith("ied")) addV(t.slice(0, -3) + "y");
    else if (t.endsWith("ed")) addV(t.slice(0, -2), t.slice(0, -1));
    else if (t.endsWith("es")) addV(t.slice(0, -2), t.slice(0, -1));
    else if (t.endsWith("s") && !t.endsWith("ss")) addV(t.slice(0, -1));
    else addV(t + "s", t + "ed", t + "ing");
  }
  return [...out];
}

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
  owner: string,
): Promise<{ byPath: Map<string, { matches: number; firstLine: string; tokensMatched: Set<string> }>, tokenDocFreq: Map<string, number> }> {
  if (!query.trim()) return { byPath: new Map(), tokenDocFreq: new Map() };
  const tokens = query
    .split(/\s+/)
    .map(t => t.replace(/^[^\w-]+|[^\w-]+$/g, "").toLowerCase())
    .filter(t => t.length >= 2);
  if (tokens.length === 0) return { byPath: new Map(), tokenDocFreq: new Map() };
  // v2.16.3 — expand each token into morphological variants + relation-
  // class surface forms ("employer" → works_at/works_for/employed_by...).
  // variantToBase maps every matched pattern back to its ORIGINAL query
  // token so IDF and title-boost scoring see base tokens only.
  const variantToBase = new Map<string, string>();
  for (const t of tokens) {
    for (const v of [...morphVariants(t), ...relationVariants(t)]) {
      if (!variantToBase.has(v)) variantToBase.set(v, t);
    }
  }
  const eFlags = [...variantToBase.keys()].flatMap(v => ["-e", v]);
  // v2.22.0 (round-2 finding R2): -F treats every pattern as a literal, so
  // a query token with regex metacharacters ("sin(x") can't produce an
  // invalid regex and crash the whole recall.
  const proc = await $`rg --json -i -F -g "*.md" ${eFlags} ${vaultRoot}`
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
      // v2.16.3 — credit the BASE query token, not the expanded variant.
      if (tok) matchedTokens.push(variantToBase.get(tok) ?? tok);
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
      tokenDocFreq.set(t, (tokenDocFreq.get(t) ?? 0) + 1);   // narrowed to owner below
    }
  }
  // v2.22.0 (round-2 finding R5): IDF/doc-frequency must reflect only THIS
  // owner's corpus — otherwise score_components.idf becomes an existence
  // oracle for other tenants' content. Candidate discovery below already
  // filters by frontmatter owner; narrow the keyword stats here to match.
  const ownerPrefixes = ["episodes", "facts", "v2-entities", "cognitive", "generalized"]
    .map(layer => join(vaultRoot, layer, owner));
  const underOwner = (p: string) => ownerPrefixes.some(pre => p === pre || p.startsWith(pre + "/"));
  const ownedByPath = new Map([...byPath].filter(([p]) => underOwner(p)));
  const ownedFreq = new Map<string, number>();
  for (const [, { tokensMatched }] of ownedByPath) {
    for (const t of tokensMatched) ownedFreq.set(t, (ownedFreq.get(t) ?? 0) + 1);
  }
  return { byPath: ownedByPath, tokenDocFreq: ownedFreq };

}

function classifyPath(path: string): RetrievalKind | "v1_memory" {
  if (path.includes("/episodes/")) return "episode";
  if (path.includes("/facts/")) return "fact";
  if (path.includes("/cognitive/")) return "cognitive";
  // v2.9.0+ — v2-entities under their own kind, separate from v1 entity
  // storage at data/entities/. This is what makes recall return entities
  // as first-class hits when callers ask for kinds:["entity"].
  if (path.includes("/v2-entities/")) return "entity";
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
  const { byPath: matches, tokenDocFreq } = await ripgrepAcross(vaultRoot, query.query, query.owner);
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

  // v2.7.5+ P7 graph signals. One pass over the owner's vault to build the
  // in-degree map; we'll consult it per hit below. Max observed support is
  // used to normalize the per-record signal into [0,1].
  const supportIndex = buildSupportIndex(vaultRoot, query.owner);
  let maxSupport = 1;
  for (const v of supportIndex.values()) if (v > maxSupport) maxSupport = v;
  // Recency normalization: linear decay over ~90 days. Records older than
  // that get recency_score=0; records from today get 1. Cheap, deterministic,
  // doesn't require knowing the corpus age distribution.
  const nowMs = toEpochMs(validAt) ?? Date.now();
  const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

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

    // v2.7.4+ epoch-ms temporal filter (W8). Retrieval uses "lt" semantics
    // on invalidated_at — a fact invalidated AT the query timestamp is
    // still considered queryable for that instant (subtle difference from
    // getFactsValidAt's "lte"; preserves the pre-v2.7.4 contract).
    if (kind === "fact") {
      const f = rec.frontmatter as SemanticFact;
      if (!factValidAt(f, validAt, "lt")) continue;
    }

    // v2.7+ acceptance lifecycle filter. v2.9.0+ extends it to cognitive
    // records since LLM-driven reflectLLM() now writes drafts too.
    // Missing status = "approved" (back-compat for pre-v2.9 records).
    if (kind === "fact" || kind === "entity" || kind === "cognitive") {
      const status = (rec.frontmatter as any).status as ("draft" | "approved" | "rejected" | undefined);
      if (status === "draft" || status === "rejected") continue;
    }

    // Skip tombstones (hard-erased)
    if (rec.frontmatter.tombstone === true) continue;
    // Skip v1 soft-forgotten
    if (rec.frontmatter.forgotten === true) continue;

    // Governance policy check. v2.7.3+: forward jurisdiction + model
    // routing context + per-call policy mode if the caller supplied them.
    const gov = rec.frontmatter.governance as Governance | undefined;
    const policy = policyCheck(gov, {
      // v2.22.0 (round-2 finding): retention expiry is a wall-clock erasure
      // concept — evaluate it at real now, NOT the caller-supplied
      // temporal.valid_at (which otherwise resurfaces expired records).
      now: new Date().toISOString(),
      actor: query.actor,
      purpose: query.purpose,
      mode: query.policy_mode,
      jurisdiction: query.jurisdiction,
      model: query.model,
    });
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
    // v2.16.4 — plus document-length normalization (the BM25 idea): a 60 KB
    // document contains nearly every common word and would otherwise
    // keyword-match every query. Small records (facts, entities, short
    // notes) are untouched (factor ≈ 1); a 60 KB document is divided ~3.7×.
    const lengthNorm = 1 / (1 + Math.log1p(rec.body.length / 4000));
    const idfNorm = Math.min(idfScore / Math.max(queryTokens.length, 1) / 2, 1) * lengthNorm;

    // Title/alias boost: if any query token appears in the doc's alias/tags, big bump
    const titleSource = [
      ...(rec.frontmatter.aliases ?? []),
      rec.frontmatter.alias,
      ...(rec.frontmatter.tags ?? []),
      rec.frontmatter.subject,
      rec.frontmatter.predicate,
    ].filter(Boolean).join(" ").toLowerCase();
    // v2.16.3 — a query token counts as a title hit when ANY of its
    // morphological/relation variants appears in the title source, so
    // "employer" boosts a fact whose predicate is works_at.
    const titleHits = queryTokens.filter(t =>
      titleSource.includes(t)
      || morphVariants(t).some(v => titleSource.includes(v))
      || relationVariants(t).some(v => titleSource.includes(v))
    ).length;
    const titleBoost = Math.min(titleHits / Math.max(queryTokens.length, 1), 1);

    // v2.17.0 — cognitive trust is per-kind, no longer a blanket 1.0:
    // beliefs are multi-source conclusions and rank above facts;
    // observations/experiences rank below facts (the old flat 1.0 let
    // pronoun-counter filler outrank real facts).
    const layerPrior =
      kind === "cognitive"
        // v2.19.0 — judgments rank with beliefs: both are multi-source
        // conclusions (judgments are the arc42-style decisions).
        ? (rec.frontmatter.kind === "belief" || rec.frontmatter.kind === "judgment" ? 0.95 : 0.75)
        : kind === "fact" ? 0.9 : kind === "episode" ? 0.7 : 0.6;
    // CRITICAL: defensive clamp against NaN/Infinity in stored confidence.
    // Even though clampConfidence is applied at write boundaries, legacy v1
    // records may have arbitrary trust values.
    const rawConfidence = rec.frontmatter.confidence ?? rec.frontmatter.trust ?? 0.5;
    const confidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0.5;
    const vectorScore = vectorByPath.get(path) ?? 0;

    // v2.7.5+ P7 graph signals.
    //   graph_support: in-degree (other records citing this one). Normalized
    //     to [0,1] by the corpus max. A record cited by many is more grounded.
    //   recency: linear decay over 90 days from valid_from / first_seen / created.
    //     Newer records get a small ranking bump.
    //   contradiction_penalty: facts with invalidated_at set OR superseded_by set
    //     lose a chunk of score even when temporally "still valid" — surfaces a
    //     contradicted claim less aggressively than a clean one.
    const recordId = rec.frontmatter.id as string | undefined;
    const supportCount = recordId ? (supportIndex.get(recordId) ?? 0) : 0;
    // v2.16.4 — LOG-dampened, not linear. An episode's in-degree counts how
    // many records were extracted FROM it, which measures document LENGTH,
    // not groundedness: on the finance corpus a 480-fact document took the
    // full graph bonus on every query and buried topical results. log1p
    // keeps "cited more = somewhat better" while flattening the size bias.
    const graphSupport = Math.min(
      Math.log1p(supportCount) / Math.log1p(Math.max(maxSupport, 1)), 1,
    );

    const recordTime = rec.frontmatter.valid_from
      ?? rec.frontmatter.first_seen
      ?? rec.frontmatter.created
      ?? rec.frontmatter.reflected_at
      ?? null;
    const recordMs = recordTime ? toEpochMs(String(recordTime)) : null;
    const recency = recordMs !== null
      ? Math.max(0, Math.min(1, 1 - (nowMs - recordMs) / RECENCY_WINDOW_MS))
      : 0;

    const contradiction = rec.frontmatter.invalidated_at || rec.frontmatter.superseded_by
      ? 1 : 0;
    // 35% reduction for contradicted records — still recallable but de-ranked.
    // v2.18.1 — internet fact-check verdict (Ardin's rule 2026-07-10: a
    // fact the web contradicts is never deleted, but must sink in search).
    // Uses the same multiplier channel, harder: 60% reduction, stacking
    // with the supersession penalty up to a cap of 80%.
    const factCheckPenalty = rec.frontmatter.verification === "contradicted" ? 0.6 : 0;
    const contradictionPenalty = Math.min(0.8, contradiction * 0.35 + factCheckPenalty);

    // v2.7.5+ fused score with graph signals.
    //   keyword IDF        24%
    //   title/alias match  20%
    //   vector cosine      20%
    //   confidence          8%
    //   layer prior         6%
    //   graph support      12%   (new — derived_from in-degree)
    //   temporal recency    5%   (new — newer records bump slightly)
    //   contradiction      -5%×0..1 (new — invalidated/superseded penalized)
    //   contradiction_pen  applied as a multiplier (1 - 0.35*contradiction)
    //
    // Weights chosen so existing keyword/title/vector still dominate (64%);
    // graph + recency add 17% without flipping result orderings on simple
    // queries. The contradiction penalty is a multiplier, not a component,
    // so a contradicted record can never out-rank an equivalent clean one.
    const baseScore = idfNorm * 0.24 + titleBoost * 0.20 + vectorScore * 0.20
                    + confidence * 0.08 + layerPrior * 0.06
                    + graphSupport * 0.12 + recency * 0.05;
    const score = baseScore * (1 - contradictionPenalty);

    // Excerpt prefers the doc's own title/alias over the first matched line (which
    // is often a table-of-contents or boilerplate match).
    // v2.16.3 — when the first matched line is frontmatter ("actor: x",
    // "owner: y"), show the record BODY's first content line instead: a
    // recall excerpt reading `actor: ardin-pai` tells the caller nothing.
    const fmLike = /^[a-z_]+:\s/.test(firstLine.trim());
    const displayLine = fmLike
      ? (rec.body.split("\n").find(l => l.trim().length > 0) ?? firstLine)
      : firstLine;
    const titleAlias = rec.frontmatter.aliases?.[0] ?? rec.frontmatter.alias ?? null;
    const excerpt = titleAlias ? `${titleAlias} — ${displayLine.slice(0, 160)}` : displayLine.slice(0, 240);

    // Build human-readable "why retrieved" — the strongest contributing signal
    const parts: string[] = [];
    if (titleBoost > 0.5) parts.push("title match");
    if (idfNorm > 0.5) parts.push("rare-term keyword match");
    if (vectorScore > 0.3) parts.push(`semantic similarity (${vectorScore.toFixed(2)})`);
    if (confidence > 0.8) parts.push(`high source confidence`);
    if (graphSupport > 0.5) parts.push(`graph-supported by ${supportCount} record(s)`);
    if (recency > 0.7) parts.push("recent");
    if (contradiction === 1) parts.push("contradicted (de-ranked)");
    if (parts.length === 0) parts.push("weak signal");
    const why = parts.join(" + ");

    const hit: RetrievalHit = {
      kind: kind === "v1_memory" ? "episode" : kind,
      id: rec.frontmatter.id ?? path,
      score,
      score_components: {
        idf: idfNorm, title: titleBoost, vector: vectorScore,
        confidence, layerPrior,
        graph_support: graphSupport, recency, contradiction,
        // v2.22.0 (round-2 finding): expose the demotion multiplier so RRF
        // fusion can apply it too (below) — a contradicted / web-refuted
        // record must never out-rank a clean one, in EITHER fusion mode.
        contradiction_penalty: contradictionPenalty,
      },
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
    // v2.11.0+ — per-kind structured payload. Downstream consumers (bench
    // harnesses, agent prompts) get structured fields without re-parsing the
    // record. The 240-char `excerpt` above is unchanged and remains the
    // diagnostic field; `payload` is the load-bearing content channel.
    const fm = rec.frontmatter as any;
    if (kind === "fact") {
      hit.payload = {
        subject: fm.subject,
        predicate: fm.predicate,
        object: fm.object,
        valid_from: fm.valid_from,
        // v2.16.5 — provenance inline: consumers (and benchmarks) can credit
        // a fact hit back to the episode(s) it came from without a second
        // lookup.
        ...(Array.isArray(fm.derived_from) && fm.derived_from.length
          ? { derived_from: fm.derived_from } : {}),
        ...(fm.invalidated_at ? { invalidated_at: fm.invalidated_at } : {}),
      };
    } else if (kind === "cognitive") {
      hit.payload = {
        content: rec.body,
        cognitive_kind: fm.kind,
        ...(typeof fm.confidence === "number" ? { confidence: fm.confidence } : {}),
      };
    } else if (kind === "entity") {
      hit.payload = {
        name: fm.name,
        entity_type: fm.type,
        ...(Array.isArray(fm.aliases) && fm.aliases.length > 0 ? { aliases: fm.aliases } : {}),
        ...(Array.isArray(fm.derived_from) && fm.derived_from.length
          ? { derived_from: fm.derived_from } : {}),
      };
    }
    hits.push(hit);
    evidenceChain.push(hit.id);

    // For facts: include derived_from chain
    if (kind === "fact" && rec.frontmatter.derived_from) {
      evidenceChain.push(...(rec.frontmatter.derived_from as string[]));
    }
  }

  // v2.10.0+ optional Reciprocal Rank Fusion (NEW — closes v3.0 criterion).
  // The default path uses the weighted-linear score we just computed above.
  // When query.fusion === "rrf", we replace that score with RRF over five
  // per-signal ranked lists (keyword/vector/graph/temporal/entity). RRF is
  // scale-free — it cares about ranks, not raw scores, which means it
  // tolerates mixed score ranges without weight tuning. Both modes use the
  // SAME hit set; only the ordering differs.
  if (query.fusion === "rrf") {
    // Build the five candidate lists by sorting `hits` on each signal.
    // A document absent from a list contributes 0 from that list.
    const byKeyword = [...hits].sort((a, b) =>
      (b.score_components.idf ?? 0) - (a.score_components.idf ?? 0)
    );
    const byVector = [...hits].sort((a, b) =>
      (b.score_components.vector ?? 0) - (a.score_components.vector ?? 0)
    );
    const byGraph = [...hits].sort((a, b) =>
      (b.score_components.graph_support ?? 0) - (a.score_components.graph_support ?? 0)
    );
    const byTemporal = [...hits].sort((a, b) =>
      (b.score_components.recency ?? 0) - (a.score_components.recency ?? 0)
    );
    // Title boost acts as an entity-overlap proxy when entity-overlap isn't
    // computed separately yet — proper entity-graph candidates are v2.11.
    const byTitle = [...hits].sort((a, b) =>
      (b.score_components.title ?? 0) - (a.score_components.title ?? 0)
    );
    const fused = reciprocalRankFusion([
      { name: "keyword", items: byKeyword },
      { name: "vector", items: byVector },
      { name: "graph", items: byGraph },
      { name: "temporal", items: byTemporal },
      { name: "title", items: byTitle },
    ]);
    // Replace each hit's score with the RRF score, preserving components
    // for debuggability, then re-sort by the new score.
    const idToHit = new Map(hits.map(h => [h.id, h]));
    hits.length = 0;
    for (const f of fused) {
      const h = idToHit.get(f.id);
      if (!h) continue;
      // v2.22.0 (round-2 finding): RRF replaced the fused score wholesale
      // and lost the contradiction / fact-check demotion. Re-apply it here.
      const pen = (h.score_components as { contradiction_penalty?: number }).contradiction_penalty ?? 0;
      h.score = f.rrf_score * (1 - pen);
      h.score_components = { ...h.score_components, rrf: f.rrf_score };
      hits.push(h);
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const limit = Math.max(1, Math.min(query.limit ?? 10, 100));

  // v2.16.5 — result diversification. A chatty source document can spawn
  // dozens of sibling facts that all keyword-match the same query with
  // near-identical scores; unchecked, they fill every result slot and bury
  // the source episodes themselves (LongMemEval round 1: 17 bike-shop facts
  // from one session pushed both gold episodes below rank 18). Standard
  // search-engine practice: cap results per source. At most 3 facts per
  // source episode in the primary ranking; over-cap facts drop behind, and
  // only fill slots if the limit isn't reached by diverse records.
  // v2.16.6 — the cap covers entities too (facts + entities counted
  // together per source): entity swarms from chatty sessions caused the
  // same crowd-out the fact cap fixed (LongMemEval round 2, question
  // c4a1ceb8: the 4th gold session ranked 12 behind entity clutter).
  const MAX_RECORDS_PER_SOURCE = 3;
  const perSource = new Map<string, number>();
  const primary: RetrievalHit[] = [];
  const overflow: RetrievalHit[] = [];
  for (const h of hits) {
    const src = (h.kind === "fact" || h.kind === "entity")
      ? h.payload?.derived_from?.[0] : undefined;
    if (src) {
      const n = perSource.get(src) ?? 0;
      if (n >= MAX_RECORDS_PER_SOURCE) { overflow.push(h); continue; }
      perSource.set(src, n + 1);
    }
    primary.push(h);
  }
  const finalHits = [...primary, ...overflow].slice(0, limit);

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
