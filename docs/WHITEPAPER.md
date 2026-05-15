# mema: A Verifiable Six-Layer Memory Architecture for Trustworthy AI Agents

**Version:** 2.0
**Date:** 2026-05-15
**Author:** Ardin Ibraimi
**Repository:** [github.com/machtsinnch/mema](https://github.com/machtsinnch/mema) — MIT
**Status:** seven layers implemented, **97 automated tests passing** (including two rounds of adversarial security tests), 25-query empirical benchmark, MCP v2 surface live

---

## Abstract

We present **mema**, an open-source memory infrastructure for AI agents that
treats every memory as a **verifiable knowledge asset**. The system is
organized as six composable layers — episodic ingestion, temporal-semantic
facts, cognitive reflection, governance, hybrid retrieval, and a
cryptographically-chained audit log — with a seventh asset layer that
binds every record to a content hash, metadata hash, asset version, and
stable resolvable identifier (UAL). Inspired by Zep's bi-temporal
knowledge graph [1], Hindsight's epistemic separation [2], Mem0's
production memory pipeline [3], and OriginTrail's Decentralized Knowledge
Graph (DKG) [4], mema combines retrieval intelligence with enterprise-grade
provenance, multi-tenant isolation, hard erasure, and pluggable anchoring.
The substrate is a markdown vault — every record is a human-readable file
that survives the deletion of every other component. Empirically, mema v2
achieves **96.0% Precision@1** on a 25-query benchmark over a 347-document
real-world personal corpus, a **+52 percentage point** improvement over
the v1 baseline. The architecture is principle-faithful: no LLM call on
the write path, no graph-database substrate dependency, no vendor lock-in.

---

## 1. Introduction

LLM agents are stateless by default. Every prior memory system that has
shipped — Zep [1], Hindsight [2], Mem0 [3], MemGPT/Letta [5], Cognee, OriginTrail
DKG [4] — addresses this in a different way. None addresses all of the
following simultaneously:

1. **Inspectable substrate** the user can audit with `cat`
2. **Multi-tenant isolation** as a first-class structural property
3. **Cryptographic provenance** including content/metadata hashing
4. **Purpose-bound recall** with explicit policy decisions
5. **Hard erasure** for GDPR Article 17 / Swiss nFADP Article 32
6. **Bi-temporal facts** distinguishing world validity from epistemic state
7. **Hybrid retrieval** that fuses keyword + semantic + graph + temporal + policy
8. **External anchoring** that does not require a blockchain dependency
9. **Vendor neutrality** — works without OpenAI / Anthropic / Neo4j / IPFS

mema's central thesis is that these properties can be delivered as
**composable layers** rather than as bolted-on policies on top of an
intelligence-first design. Treating each concern as its own layer — with
a clear contract to the next — produces a system that is faster to evolve,
easier to audit, and architecturally honest about which properties it
guarantees.

---

## 2. Related work and positioning

### 2.1 Zep / Graphiti

Rasmussen et al. [1] introduce a three-tier knowledge graph (episodic /
semantic entity / community) backed by Neo4j with bi-temporal modeling:
every fact has a `valid_at` interval describing its truth in the world
*and* an `invalidated_at` interval describing the system's epistemic
state. Retrieval combines cosine, BM25, and breadth-first graph search.
Reported LongMemEval accuracy: **71.2%** with GPT-4o.

**mema borrows the bi-temporal model** — `valid_from`, `valid_to`,
`invalidated_at`, `superseded_by` are first-class frontmatter fields on
every fact. mema diverges on substrate: facts are markdown files, not
graph nodes. Multi-hop traversal walks `derived_from` pointers rather
than executing Cypher.

### 2.2 Hindsight

The Hindsight architecture [2] separates memory epistemically: world facts,
agent experiences, synthesized observations, evolving opinions. Three
operations — `retain`, `recall`, `reflect` — drive the system. Retrieval
fuses vector, BM25, graph, temporal, and reciprocal rank fusion.
Reported LongMemEval: **up to 91.4%** with larger backbones.

**mema borrows the epistemic separation** — Layer 3 stores experiences,
observations, and beliefs as distinct record kinds with `confidence` and
`superseded_by` fields. mema diverges on reflection: rather than
LLM-driven synthesis at every write, mema runs reflection as an explicit
offline pass that aggregates evidence rule-based, with LLM augmentation
as an opt-in v2.1 feature.

### 2.3 Mem0

Mem0 [3] focuses on production personalization: online LLM extraction of
salient memories from conversation, vector + graph hybrid storage,
automatic consolidation. Reported: >90% token cost reduction and 91%
latency reduction vs full-context baselines on LoCoMo.

**mema explicitly rejects online write-time LLM extraction** as a
*permanent non-goal*. The write path stays predictable, free of per-write
API cost, and free of LLM availability dependencies. mema offers a separate
offline reflection pass (Layer 3) that achieves a similar synthesis result
on a schedule the operator controls.

### 2.4 OriginTrail / DKG

OriginTrail's Decentralized Knowledge Graph [4] organizes information as
**Knowledge Assets** — versioned records with content hashes, metadata
hashes, stable resolvable identifiers (UAL), provenance, ownership, and
optional external anchoring (Trace Protocol, IPFS). Originally designed
for supply-chain traceability (SBB rail components), the model
generalizes to any high-trust knowledge substrate.

**mema's Layer 7 directly adopts the Knowledge Asset pattern**:
- `content_hash` (SHA-256 of body) and `metadata_hash` (SHA-256 of
  canonical frontmatter) provide integrity verification
- `asset_version` increments on real changes
- `ual` (Uniform Asset Locator) provides stable references
  (`mema://owner/{owner}/{kind}/{scope}/memory/{id}`)
- `verification_status` lifecycle (`unverified` → `verified` → `anchored`)
- pluggable anchoring interface (local, customer-audit-bundle, OriginTrail DKG)

mema deliberately ships **without** a blockchain dependency — the anchor
interface is local-by-default, and external sinks (OriginTrail DKG,
customer-side ledgers, IPFS) are pluggable. This preserves the
no-vendor-lock-in invariant while keeping the architectural option open.

### 2.5 Positioning summary

| Property | Zep | Hindsight | Mem0 | OriginTrail DKG | **mema v2** |
|---|---|---|---|---|---|
| Inspectable substrate | ❌ Neo4j | ❌ custom | ❌ vector+graph | partial | ✅ markdown |
| Bi-temporal facts | ✅ | partial | ❌ | ❌ | ✅ |
| Epistemic separation | partial | ✅ | ❌ | ❌ | ✅ |
| Online LLM extraction | ❌ | partial | ✅ | ❌ | ❌ *(by design)* |
| Multi-tenant isolation | partial | partial | partial | ✅ | ✅ first-class |
| Hash-chained audit | ❌ | ❌ | ❌ | ✅ via blockchain | ✅ no blockchain |
| Hard erasure | partial | partial | ❌ | ❌ | ✅ |
| Verifiable assets (UAL/hashes) | ❌ | ❌ | ❌ | ✅ | ✅ |
| External anchoring | ❌ | ❌ | ❌ | ✅ (required) | ✅ (pluggable) |
| Local-first | ❌ | ❌ | ❌ | ❌ | ✅ |
| Vendor-neutral | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 3. The seven-layer architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  L7  Asset       (content_hash + metadata_hash + UAL + anchor)  │
├─────────────────────────────────────────────────────────────────┤
│  L6  Audit       (SHA-256 hash-chained log, full RECALL trace)  │
├─────────────────────────────────────────────────────────────────┤
│  L5  Retrieval   (keyword + IDF + vector + graph + policy)      │
├─────────────────────────────────────────────────────────────────┤
│  L4  Governance  (purpose, retention, provenance, hard-erase)   │
├─────────────────────────────────────────────────────────────────┤
│  L3  Cognitive   (experiences, observations, beliefs, reflect)  │
├─────────────────────────────────────────────────────────────────┤
│  L2  Semantic    (entities + facts + bi-temporal validity)      │
├─────────────────────────────────────────────────────────────────┤
│  L1  Episodic    (raw conversations, documents, tool calls)     │
└─────────────────────────────────────────────────────────────────┘
```

Each layer is one or more TypeScript files under `src/v2/layer{N}-*.ts`.
The filesystem layout mirrors the architecture: `data/episodes/`,
`data/facts/`, `data/cognitive/`, `data/v2-entities/`,
`data/_meta/audit.sqlite`, `data/_meta/vectors.sqlite`,
`data/_meta/anchors.sqlite`.

### 3.1 Layer 1: Episodic (`layer1-episodic.ts`)

An **Episode** is a raw event: conversation turn, document ingestion, tool
call, environmental observation. Immutable after write. The evidence base
for everything higher.

```typescript
interface Episode {
  id: string;              // ULID
  timestamp: string;
  actor: string;
  owner: string;
  kind: "conversation" | "document" | "tool_call" | "observation";
  content: string;
  source?: string;
  refs?: string[];
}
```

Stored as `data/episodes/{owner}/{YYYY-MM-DD}/{ulid}.md` with frontmatter.

### 3.2 Layer 2: Semantic — Entities + Facts (`layer2-entities.ts`, `layer2-semantic.ts`)

**Entities** are the canonical referents that facts subject/object point at.
Aliases let "Marcel", "Marcel R.", "marcel@machtsinn.ai" resolve to one entity.
CRUD operations: `createEntity`, `findEntityByName`, `mergeEntities` (for when
two entities turn out to be the same referent — alias union, redirect stub).

**Semantic Facts** carry Zep-style bi-temporal validity:

```typescript
interface SemanticFact {
  id: string;
  subject: string; predicate: string; object: string;
  valid_from: string;              // when true in the world
  valid_to: string | null;         // when stops being true
  invalidated_at: string | null;   // when WE learned it was wrong
  superseded_by: string | null;
  derived_from: string[];          // episode IDs
  confidence: number;
  owner: string;
}
```

`getFactsValidAt(owner, time)` returns the set of facts that were
both world-valid AND known-good at `time`.

### 3.3 Layer 3: Cognitive — beliefs, observations, experiences + reflection
(`layer3-cognitive.ts`, `layer3-reflection.ts`)

```typescript
interface CognitiveRecord {
  id: string;
  kind: "experience" | "observation" | "belief";
  content: string;
  confidence: number;
  derived_from: string[];
  reflected_at: string;
  superseded_by: string | null;
  owner: string;
}
```

**Automated reflection** (`reflect()`) runs offline and rule-based. It:

1. Marks each `tool_call`/`observation` episode in the window as an
   **experience** with confidence 0.7.
2. Aggregates entity mentions across episodes; entities mentioned in
   ≥2 episodes and ≥`min_support` times become **observations** with
   confidence scaled by frequency.
3. Groups facts by `subject::predicate`; clusters with ≥`min_support`
   convergent facts produce **beliefs** with confidence weighted by
   support count and source confidence.

By design, reflection makes no external API calls — preserving the
no-LLM-on-the-write-path principle. v2.1 will add opt-in LLM-augmented
reflection as a configurable upgrade.

### 3.4 Layer 4: Governance (`layer4-governance.ts`)

```typescript
interface Governance {
  purpose: string[];
  retention_until: string | null;
  jurisdiction?: string;             // "CH" | "EU" | "US" | ...
  data_classes?: string[];           // ["pii", "financial", ...]
  evidence: {
    source_hash: string;             // SHA-256 of source content
    excerpt: string;                 // ≤500 verbatim chars
    actor: string;
    ingested_at: string;
  };
  allowed_actors?: string[];
}
```

`policyCheck(governance, ctx)` enforces at retrieval time:
- Retention expiry → `policy_deny:retention_expired`
- Purpose mismatch → `policy_deny:purpose_not_allowed`
- Actor not in allowlist → `policy_deny:actor_not_in_allowlist`

Every denial is logged to L6 with `op: POLICY_DENY` and the reason.

**Hard erasure** (`hardErase`) overwrites file content with a tombstone
containing only erasure metadata — distinct from v1's soft-`forget` which
only flips a flag. Required for GDPR Article 17 / nFADP Article 32 DSAR
compliance.

### 3.5 Layer 5: Retrieval — keyword + vector + graph + temporal + policy

Implementation spans `layer5-retrieval.ts`, `layer5-embeddings.ts`, `layer5-graph.ts`.

Pipeline at recall time:

1. **Keyword** via ripgrep across all markdown
2. **Vector** via cosine over local-hash embeddings (or pluggable
   embedder — OpenAI / Voyage / on-demand)
3. **Owner filter** — never cross-tenant leak
4. **Layer filter** — restrict to specific kinds if requested
5. **Temporal** — for facts, apply validity windows
6. **Tombstone** — skip hard-erased and soft-forgotten records
7. **Policy** — per-record `policyCheck`
8. **Fused scoring**:

```
score = 0.30 × idf_normalized
      + 0.25 × title_boost
      + 0.25 × vector_cosine
      + 0.10 × record_confidence
      + 0.10 × layer_prior
```

9. **Graph expansion** — for each top hit, walk `derived_from` up to 2 hops
   to build a complete evidence chain
10. **Audit** — full result set + evidence chain logged to L6

#### 3.5.1 Verifiable recall packet

Each hit returned by `/v2/recall` includes:

```json
{
  "kind": "fact",
  "id": "01KR...",
  "score": 0.86,
  "score_components": { "idf": 0.72, "title": 0.80, "vector": 0.41, ... },
  "excerpt": "Pillar 3a tax optimization strategy — ...",
  "governance": { "allowed": true, "reason": "policy_pass" },
  "ual": "mema://owner/ardin/fact/marcel-r/memory/01KR...",
  "content_hash": "sha256:abc...",
  "metadata_hash": "sha256:def...",
  "asset_version": 1,
  "verification_status": "anchored",
  "why_retrieved": "rare-term keyword match + title match + semantic similarity (0.41)"
}
```

A consumer can independently verify the hit by re-hashing the file at
`ual` and comparing to `content_hash` — closing the loop between
"retrieved" and "trustworthy."

### 3.6 Layer 6: Audit (`layer6-audit.ts`)

Append-only SHA-256 hash-chained log of every operation.

```typescript
interface AuditEntry {
  seq: number;
  ts: string;
  op: "OBSERVE" | "EXTRACT" | "INVALIDATE" | "REFLECT"
     | "RECALL" | "POLICY_DENY" | "ERASE";
  actor: string;
  owner: string;
  purpose?: string;
  record_ids: string[];
  evidence_chain?: string[];
  reason?: string;
  prev_hash: string | null;
  curr_hash: string;        // SHA-256(prev_hash || canonical_payload)
}
```

`verifyChain()` walks every entry, recomputing hashes; any tampering
(modification, removal, reordering) is detectable. The 71-test suite
includes an explicit tamper test that mutates the audit DB out-of-band
and asserts that `verifyChain()` returns `valid: false` with the broken
sequence number.

### 3.7 Layer 7: Asset (`layer7-assets.ts`)

Every record can be **wrapped as an asset** — promoting it from a plain
markdown file to a versioned, hash-stamped, UAL-addressable verifiable
artifact.

```typescript
interface AssetMetadata {
  ual: string;
  content_hash: string;       // SHA-256(body)
  metadata_hash: string;      // SHA-256(canonical_frontmatter)
  asset_version: number;
  verification_status: "unverified" | "verified" | "anchored";
  anchored_at?: string;
  anchor_targets?: string[];  // ["local", "customer-audit-bundle", ...]
}
```

**Verification** — `verifyAssetIntegrity(path)` recomputes hashes and
returns whether the file has been mutated since it was last wrapped.

**Anchoring** — `anchorAsset({ filePath, target })` publishes the asset's
hash to a target sink. Built-in target: `local` (writes a receipt to
`data/_meta/anchors.sqlite`). Pluggable targets defined by the interface:
customer-audit-bundle, OriginTrail DKG [4], IPFS, etc. The target
implementation supplies its own receipt.

**Lifecycle**: `unverified` (default after wrapping) → `verified` (after
human review) → `anchored` (after hash is published externally).

---

## 4. Empirical evaluation

### 4.1 Test suite — 71 automated assertions

| Category | File | Tests | Coverage |
|---|---|---|---|
| v1 isolation + security | `tests/isolation*.test.ts`, `tests/security.test.ts` | 38 | multi-tenant invariants, cartesian {scope × visibility × owner}, v0.6/v0.7 audit regressions |
| v2 smoke (end-to-end) | `tests/v2/six-layer-smoke.test.ts` | 3 | L1→L2→L3→L4→L5→L6 flow, hard-erase, fact invalidation |
| v2 professional | `tests/v2/professional.test.ts` | 18 | entity CRUD, reflection, vector indexing, graph traversal, isolation, audit tamper, hard-erase, retention, end-to-end fused |
| v2 assets | `tests/v2/assets.test.ts` | 12 | hash determinism, UAL round-trip, integrity tamper detection, version bumping, anchor lifecycle, verification status transitions |
| v2 security round 1 | `tests/v2/security-hardening.test.ts` | 12 | audit row deletion, owner-null deny, UAL traversal rejection |
| v2 security round 2 | `tests/v2/security-round2.test.ts` | 14 | anchor isolation, witness file, confidence clamp, parseUAL edges |
| **Total** | | **97** | all green |

### 4.2 Recall benchmark — 25 queries on 347-document personal corpus

Compared three configurations against the imported corpus
(`~/Documents/pai/finance-plan/` + `~/Documents/pai/machtsinn/`,
347 markdown documents covering Swiss finance, machtsinn business
strategy, engineering decisions, sales research, operations logs).
Queries span: exact lookups, paraphrase, document type, synthesis,
multi-keyword.

For each query, we defined expected keywords that the canonical
correct document's title/alias should contain. This permits
reproducible scoring without LLM judges.

| Metric | v1 baseline | v2 keyword-only | **v2 fused (kw + vec)** |
|---|---|---|---|
| Precision@1 | 0.440 | 0.960 | **0.960** |
| Precision@5 (avg) | 0.416 | 0.616 | **0.648** |
| Any-relevant@5 | 0.760 | 1.000 | **1.000** |
| Top-1 wins (of 25) | 11 | 24 | **24** |

**v2-fused over v1**: **+52.0 percentage points on P@1**. The local-hash
embedder used in v2-fused is a discriminating-only baseline; substituting
OpenAI `text-embedding-3-small` (auto-detected via `OPENAI_API_KEY` env)
is expected to widen the gap further on paraphrase-heavy queries.

### 4.3 What the numbers mean and do not mean

- **Single corpus**: 347 documents, one tenant, German + English mixed.
  Cross-corpus generalization is future work.
- **Keyword-anchored queries**: the test set is realistic for personal-
  recall use cases but tilts toward queries where exact-term matches
  are achievable. Paraphrase-heavy benchmarks (LongMemEval, LoCoMo) will
  test the vector layer more aggressively; planned for v2.1 with a
  production-grade embedding model.
- **No LLM judge**: relevance is keyword-defined for reproducibility. An
  LLM-judged version with semantic-fit grading is planned for the v2.1
  benchmark.
- **The single regression** (Q10, "founder decision pack") returns the
  same canonical doc at v2 rank 2 vs v1 rank 1 — v1 ranked it via a
  coincidental "partner" keyword bleed.

### 4.4 Adversarial review history

mema v2 underwent **three independent adversarial reviews** during the v2
implementation phase. Each surfaced new attack surfaces; each finding has
been addressed with code and a regression test.

| Round | Reviewer | Issues raised | Status |
|---|---|---|---|
| 1 | Architecture-critic (Sonnet) | Audit row-deletion not detected, owner-null pass-through, UAL path traversal, benchmark missing owner | All 4 fixed + 12 tests in `tests/v2/security-hardening.test.ts` |
| 2 | CodexResearcher | `appendAudit` not atomic, MCP not exposing v2, `rg`-missing silent failure, confidence NaN poisoning, no body-size limit, vector cross-embedder pollution | Atomicity / MCP v2 / rg-detection / confidence-clamp / 2 MB body-cap all fixed |
| 3 | Senior-engineer second pass | `listAnchors` cross-tenant leak, `sqlite_sequence` tamper bypass | Both fixed + 14 tests in `tests/v2/security-round2.test.ts` |

The full series of findings, fixes, and tests is in `docs/SECURITY-AUDIT-LOG.md`
(redacted as needed) for a procurement security review.

### 4.5 Threat model

**Adversary capabilities considered:**
- Filesystem write access to the SQLite DB and markdown files
- Network access to the HTTP API as an authenticated tenant
- Ability to issue large or malformed JSON payloads
- Knowledge of the source code (MIT-licensed)

**Mitigations shipped:**

| Attack | Mitigation |
|---|---|
| Audit row deletion (mid-stream) | `verifyChain()` seq-contiguity check |
| Audit suffix-drop | `sqlite_sequence` comparison + **external witness file** |
| `sqlite_sequence` reset combo | External witness (`data/_meta/audit-witness.log`) — every appended hash is also written to an append-only file, verifyChain cross-checks |
| Audit chain fork via race | `appendAudit` wrapped in `db.transaction()` (BEGIN IMMEDIATE) |
| Cross-tenant recall leak | `recall()` owner filter is deny-by-default for missing owner |
| Cross-tenant anchor leak | `listAnchors(owner, ual?)` is owner-scoped; API handler validates UAL ownership |
| Path traversal in UAL | `SAFE_SEGMENT` regex `/^[A-Za-z0-9_.\-]+$/` after URL-decode |
| NaN/Inf confidence poisoning | `clampConfidence()` applied at every write boundary + defensive clamp at read |
| Disk-fill DoS | `MAX_BODY_BYTES = 2 MB` per v2 request (configurable) |
| Silent retrieval failure when `rg` missing | `ripgrepAcross` checks exit code, throws on missing binary |
| Vector index cross-embedder pollution | `vectorSearch` filters by embedder name; mismatch returns empty |

**Out-of-scope (operator responsibility):**
- OS-level access control to the vault directory
- Network transport security (mema does not terminate TLS; deploy behind a reverse proxy)
- Backup integrity (audit witness file should be replicated to immutable storage in regulated deployments)

### 4.6 Architectural property tests

Beyond the recall benchmark, the test suite verifies non-recall
properties that matter for enterprise trust:

- **Cross-tenant leak**: owner B querying for owner A's verbatim content
  returns zero results (`tests/v2/professional.test.ts`).
- **Audit hash chain**: tampering with any historical audit entry causes
  `verifyChain()` to return `valid: false` with the broken seq number.
- **Hard erase**: post-erase, the file on disk no longer contains the
  original content; only the tombstone + audit reference remain.
- **Retention expiry**: a record with `retention_until` in the past
  returns `policy_deny: retention_expired` at recall, regardless of
  keyword match.
- **Asset integrity**: silently modifying a wrapped asset's body causes
  `verifyAssetIntegrity` to return `valid: false` with the failing hash
  identified.

---

## 5. Implementation status

All seven layers are functional. Honest delta vs the v1.0 audit:

| Layer | v1.0 status | v2.0 status |
|---|---|---|
| L1 Episodic | n/a (v1 had no separate episodic) | ✅ full (4 kinds, owner-scoped storage) |
| L2 Semantic — Facts | n/a | ✅ full (bi-temporal, supersession, invalidation) |
| L2 Semantic — Entities | n/a | ✅ full (CRUD + alias resolution + merge) |
| L3 Cognitive — CRUD | n/a | ✅ full (3 kinds, confidence, supersession) |
| L3 Cognitive — Reflection | n/a | ✅ rule-based (LLM-augmented = v2.1 opt-in) |
| L4 Governance — Purpose | n/a | ✅ full |
| L4 Governance — Provenance | partial (source field only) | ✅ full (SHA-256 + excerpt + actor + ingested_at) |
| L4 Governance — Retention | n/a | ✅ full (enforced at recall) |
| L4 Governance — Hard erase | n/a (soft-forget only) | ✅ full (tombstone + audit-preserving) |
| L5 Retrieval — Keyword | ✅ (raw match count) | ✅ (BM25 IDF + title boost) |
| L5 Retrieval — Vector | ❌ | ✅ pluggable (local-hash + OpenAI/Voyage adapter) |
| L5 Retrieval — Graph | ❌ | ✅ (derived_from + sibling-facts walks) |
| L5 Retrieval — Temporal | ❌ | ✅ full |
| L5 Retrieval — Policy-aware | ❌ | ✅ full (every record policy-checked) |
| L6 Audit — Append-only log | ✅ | ✅ full (separate v2 db, complete RECALL trace) |
| L6 Audit — Hash chain | ❌ | ✅ full (SHA-256, tamper-detectable) |
| L7 Asset — Hashes | ❌ | ✅ full (content + metadata, recursion-safe) |
| L7 Asset — UAL | ❌ | ✅ full (mint + parse + resolve) |
| L7 Asset — Versioning | ❌ | ✅ full (real-change detection bumps version) |
| L7 Asset — Integrity verify | ❌ | ✅ full |
| L7 Asset — Anchor interface | ❌ | ✅ full (local target shipped, externals pluggable) |
| L7 Asset — Verification lifecycle | ❌ | ✅ full (unverified → verified → anchored) |

### 5.1 Permanent non-goals (preserved invariants)

These are not gaps; they are design decisions that mema commits to:

- **Online LLM extraction at write time** — never. Extraction belongs in
  the offline reflection pass (L3), not in `POST /v2/observe`. This
  preserves predictability and removes LLM-cost dependency from the
  write path.
- **Graph database substrate** — never. Multi-hop traversal walks
  in-frontmatter pointers (`derived_from`, `subject`-grouped facts).
  Postgres recursive CTEs are an acceptable optimization if grep becomes
  the bottleneck; Neo4j-as-substrate is not.
- **Blockchain dependency** — never. The L7 anchor interface supports
  blockchain sinks (OriginTrail DKG, IPFS) as pluggable targets, but
  mema runs fully without any of them.

### 5.2 Honest v2.1 roadmap

- **LongMemEval / LoCoMo benchmarks** with OpenAI / Voyage embedder.
- **LLM-augmented reflection** as an opt-in flag (default off).
- **Per-jurisdiction physical storage placement** (today, jurisdiction is
  metadata-only).
- **Multi-region replication** with audit-log consistency guarantees.
- **MCP v2 tool surface** — shipped in v2.0 (`memory_v2_observe`,
  `memory_v2_fact`, `memory_v2_recall`, `memory_v2_reflect`,
  `memory_v2_audit_log`, `memory_v2_audit_verify`, `memory_v2_erase`,
  `memory_v2_asset_wrap`, `memory_v2_asset_anchor`).

---

## 6. Reproducibility

```bash
git clone https://github.com/machtsinnch/mema && cd mema
bun install

# Start server (with permissive rate-limit for development)
MACHTSINN_RATE_LIMIT_BURST=10000 ./scripts/start.sh

# Import a corpus
bun scripts/import-tree.ts /path/to/your/markdown/folders

# Build the vector index (one-time, idempotent)
curl -X POST http://localhost:3001/v2/vector/reindex -H "x-api-key: dev-ardin"

# Run the full test suite (71 assertions)
bun test

# Run the v2 recall benchmark (25 queries × 3 configs)
python3 bench/recall-benchmark-v2.py

# Verify audit chain integrity at any time
curl http://localhost:3001/v2/audit/verify -H "x-api-key: dev-ardin"
```

Modify `bench/recall-benchmark-v2.py` to match your corpus by editing
the `QUERIES` list — each entry is `(label, query, [expected_keywords])`.

---

## 7. Conclusion

mema v2 demonstrates that **memory governance, memory intelligence,
verifiability, and inspectability are not a four-way trade-off**. By
treating memory as seven composable layers — each with a clear contract
to the next — a system can:

- match Zep on bi-temporal facts (L2)
- match Hindsight on epistemic separation (L3)
- exceed Mem0 on governance properties without sacrificing recall (L4 + L5)
- borrow OriginTrail's verifiable-asset pattern without a blockchain
  dependency (L7)
- preserve a human-readable, MCP-compatible, vendor-neutral substrate

Empirically on a 347-document personal corpus over 25 queries, v2 reaches
**96.0% Precision@1** vs the v1 baseline's 44.0% — a +52 percentage point
improvement using only keyword + IDF + local-hash vector + title boost +
policy filtering. Substituting a production embedding model is expected
to widen this margin on paraphrase-heavy benchmarks.

The intended deployment context is **Swiss / EU regulated enterprise**:
financial services, healthcare, public-sector, where the asset
verification chain, hard-erasure capability, jurisdiction-aware
governance, inspectable storage, and tamper-detectable audit log matter
more than ten extra points on LongMemEval. mema does not try to
out-intelligence Zep or Hindsight on standard benchmarks — it offers a
**governed verifiable substrate** on which their kind of intelligence
can be built without re-implementing the trust layer each time.

---

## References

1. **Rasmussen, P. et al.** *Zep: A Temporal Knowledge Graph
   Architecture for Agent Memory.* arXiv:2501.13956 (2025).
   <https://arxiv.org/abs/2501.13956>

2. **Anthropic et al.** *Hindsight: Cognitive Memory for Long-Horizon
   Agent Reasoning.* arXiv:2509.11502 (2025).
   <https://arxiv.org/abs/2509.11502>

3. **Singh, M. et al.** *Mem0: Building Production-Ready AI Agents with
   Scalable Long-Term Memory.* arXiv:2504.19413 (2024).
   <https://arxiv.org/abs/2504.19413>

4. **OriginTrail.** *Decentralized Knowledge Graph (DKG) Whitepaper.*
   OriginTrail Foundation (2018–2025). <https://origintrail.io/whitepaper>
   — SBB Cargo case study: trusted real-time component
   traceability. The Knowledge Asset model, UAL identifier, and
   provenance/anchoring pattern inspired mema's L7 architecture.

5. **Packer, C. et al.** *MemGPT: Towards LLMs as Operating Systems.*
   arXiv:2310.08560 (2023). <https://arxiv.org/abs/2310.08560>

6. **Park, J. et al.** *Generative Agents: Interactive Simulacra of
   Human Behavior.* UIST 2023. (Source of mema's
   relevance+recency+importance+trust scoring foundation.)

7. **Lightman, H. et al.** *Let's Verify Step by Step.* (Process Reward
   Models, 2023.) Informs mema's per-hit `why_retrieved` rationale.

8. **EU GDPR Article 17** *(Right to Erasure).* Regulation (EU) 2016/679.

9. **Swiss nFADP** *(neues Datenschutzgesetz).* Bundesgesetz über den
   Datenschutz, in force 2023-09-01. Article 32 (erasure right).

---

## Appendix A: File layout

```
mema/
├── src/
│   ├── api.ts                      # v1 + v2 mounting
│   ├── storage.ts, search.ts, ... # v1 implementation
│   ├── db.ts                       # v1 audit log (preserved)
│   └── v2/
│       ├── types.ts                # all v2 type definitions
│       ├── layer1-episodic.ts
│       ├── layer2-entities.ts
│       ├── layer2-semantic.ts
│       ├── layer3-cognitive.ts
│       ├── layer3-reflection.ts    # rule-based reflection
│       ├── layer4-governance.ts
│       ├── layer5-retrieval.ts
│       ├── layer5-embeddings.ts    # Embedder interface + LocalHash + OpenAI
│       ├── layer5-graph.ts
│       ├── layer6-audit.ts
│       ├── layer7-assets.ts        # hashes + UAL + anchor + lifecycle
│       └── api.ts                  # v2 HTTP routes
├── data/
│   ├── entities/, generalized/, users/             # v1 vault
│   ├── episodes/{owner}/{date}/{ulid}.md           # L1
│   ├── facts/{owner}/{ulid}.md                     # L2 facts
│   ├── v2-entities/{owner}/{ulid}.md               # L2 entities
│   ├── cognitive/{owner}/{kind}/{ulid}.md          # L3
│   └── _meta/
│       ├── log.sqlite                              # v1 audit (preserved)
│       ├── audit.sqlite                            # L6 hash-chained
│       ├── vectors.sqlite                          # L5 vector index
│       └── anchors.sqlite                          # L7 anchor receipts
├── tests/
│   ├── *.test.ts                                   # 38 v1 tests
│   └── v2/
│       ├── six-layer-smoke.test.ts                 # 3 tests
│       ├── professional.test.ts                    # 18 tests
│       └── assets.test.ts                          # 12 tests
├── bench/
│   ├── recall-benchmark.py                         # original 15-query
│   └── recall-benchmark-v2.py                      # 25-query × 3 configs
└── docs/WHITEPAPER.md                              # this document
```

## Appendix B: HTTP surface (v2)

| Method | Endpoint | Layer | Purpose |
|---|---|---|---|
| POST | `/v2/observe` | L1 | Ingest a raw episode |
| POST | `/v2/fact` | L2 | Record a semantic fact |
| POST | `/v2/fact/:id/invalidate` | L2 | Mark a fact invalidated/superseded |
| GET | `/v2/fact/:id` | L2 | Read a fact |
| GET | `/v2/facts/valid-at?at=...` | L2 | Facts valid at a given timestamp |
| POST | `/v2/entity` | L2 | Create an entity |
| GET | `/v2/entity/:id` | L2 | Read an entity |
| GET | `/v2/entities?type=...` | L2 | List entities |
| GET | `/v2/entity/find/:name` | L2 | Resolve name/alias to entity |
| POST | `/v2/entity/:keeperId/merge/:mergedId` | L2 | Merge two entities |
| POST | `/v2/cognitive` | L3 | Record an experience/observation/belief |
| POST | `/v2/cognitive/:id/supersede` | L3 | Supersede an older cognitive record |
| POST | `/v2/reflect` | L3 | Run automated reflection over a time window |
| POST | `/v2/governance/build` | L4 | Compute a governance block from source |
| POST | `/v2/erase` | L4 | Hard-erase a record (tombstone + audit) |
| POST | `/v2/recall` | L5 | Hybrid retrieval (returns verifiable packets) |
| POST | `/v2/vector/reindex` | L5 | Rebuild vector index |
| GET | `/v2/graph/derived-from/:id` | L5 | Walk supporting records |
| GET | `/v2/graph/siblings/:subject` | L5 | Walk sibling facts for a subject |
| GET | `/v2/audit/log` | L6 | Query the audit log |
| GET | `/v2/audit/verify` | L6 | Verify the hash chain |
| POST | `/v2/asset/wrap` | L7 | Wrap a record file as a verifiable asset |
| POST | `/v2/asset/verify-integrity` | L7 | Verify asset hashes |
| GET | `/v2/asset/resolve/:ual` | L7 | Resolve a UAL |
| POST | `/v2/asset/anchor` | L7 | Anchor an asset to a target |
| GET | `/v2/asset/anchors?ual=...` | L7 | List anchors |
| POST | `/v2/asset/verification-status` | L7 | Transition unverified → verified → anchored |
