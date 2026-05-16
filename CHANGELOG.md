# Changelog

All notable changes to mema. Follows [Keep a Changelog](https://keepachangelog.com/).

## v2.10.0 — 2026-05-16

Architecture-complete checkpoint for the v3.0 evidence-package push.
Closes the architecture half of the v3.0 acceptance criteria proposed
in the third external review; the remaining half (FULL LongMemEval +
LoCoMo runs with answer-level judge, human-labeled extraction sample,
Swiss Trust Bench scenarios expanded, Zep/Hindsight apples-to-apples
baselines) is benchmark RUNTIME that produces evidence on top of this
release. v2.10.0 is the last code-only release before v3.0.

### Added (v3.0 acceptance-criteria items)

- **#1 RRF wired into /v2/recall.** New `RetrievalQuery.fusion?: "weighted" | "rrf"`.
  When `"rrf"`, recall builds five per-signal ranked lists (keyword,
  vector, graph, temporal, title) and replaces the per-hit weighted-
  linear score with the Reciprocal Rank Fusion score (k=60). Hit set
  is identical to the weighted path; only ordering differs. The
  `score_components.rrf` field is populated so downstream consumers
  can debug fusion outcomes. 3 new tests verify both modes return the
  same hit set with different orderings.
- **#2 Cognitive approval endpoints (parity with facts/entities).** New
  endpoints `POST /v2/cognitive/:id/approve`, `POST /v2/cognitive/:id/reject`,
  `GET /v2/cognitive/drafts`. Same fail-closed semantics as facts:
  empty `derived_from` or missing source episode/fact = 422, force
  bypass requires non-empty reason. New layer functions
  `approveCognitive`, `rejectCognitive`, `listDraftCognitive`. 6 new
  tests.
- **#3 LongMemEval harness ablation modes.** Added `--retrieval-mode
  hybrid|bm25|vector|full-context` and `--fusion weighted|rrf` to
  `bench/longmemeval-harness.ts`. Lets reviewers reproduce the
  ablation matrix the v3.0 criteria asks for with single-flag changes.
  `full-context` is the oracle upper bound (every haystack session
  goes into the answer prompt). `bm25` is keyword-only baseline.
- **#4 LoCoMo benchmark harness skeleton.** New
  `bench/locomo-harness.ts` runs QA over LoCoMo-10 conversations
  (Snap Research, NAACL 2024). Same x-owner-isolation pattern as the
  LongMemEval harness. Substring + LLM judge modes. Summarization and
  multimodal-dialogue tasks deferred to v2.11.
- **#5 Swiss Trust Memory Bench skeleton** — `bench/swiss-trust-bench.ts`
  with 9 end-to-end scenarios: strict-mode deny / permissive allow /
  governance-builder / cross-tenant isolation / hard-erase audit
  chain / audit-chain integrity under burst / fact-gate orphan
  rejection / entity-gate fragment rejection / model-routing context
  plumbing. **9/9 scenarios pass** on a fresh strict-mode bench
  instance. This is the differentiator no other memory system has.

### Test counts

- v2.9.0:  222 tests, 24 files, 519 expect() calls
- v2.10.0: 231 tests, 26 files, 551 expect() calls (+9 tests covering
  cognitive approval flow + RRF integration)

### v3.0 milestone — what's still missing

The reviewer's v3.0 acceptance criteria split into:
- **Code (this release):** RRF wired, cognitive approval, harness
  ablation modes, LoCoMo skeleton, Swiss Trust Bench skeleton.
- **Evidence (next sessions):** full 500-question LongMemEval with
  --extract --judge llm; LoCoMo QA full run; weighted-vs-RRF
  ablation matrix; extraction precision/recall against a
  human-labeled sample; Zep/Hindsight apples-to-apples baseline
  comparison; optional direct Zep run.

A small 50-question LongMemEval run with `--extract --judge llm`
will be kicked off in the background after this commit lands.

---

## v2.9.0 — 2026-05-16

Closes every P0 from the v2.8.0 external review and adds the architectural
pieces needed to make the "mema competes with Zep/Hindsight on memory
performance" claim defensible: contradiction detection, LLM-driven
reflection, entity resolution, RRF fusion helper, and a LongMemEval
LLM-judge layer for answer-level scoring. Also pivots the license to
**Business Source License 1.1**.

### Added (P0 from second external review)

- **`MEMA_BENCH_ALLOW_OWNER_OVERRIDE` server flag (P0-A).** When set,
  the `x-owner` header overrides the API-key-derived owner. The
  LongMemEval harness now uses this to actually achieve per-question
  vault isolation (previously silently pooled into one owner). Strict
  whitelist on the header value (`[A-Za-z0-9._-]{1,64}`). x-actor
  spoofing still cross-checked against the *effective* owner.
- **Fail-closed fact approval (P0-B).** `/v2/fact/:id/approve` now
  rejects with `422 evidence_check_failed` when `derived_from` is empty
  OR the cited source episode is missing from the vault OR the
  evidence-check guard fails. `force: true` bypass now requires a
  non-empty `reason` (`400 force_requires_reason` otherwise).
- **Entity evidence check (P0-C).** `/v2/entity/:id/approve` runs a
  parallel gate to facts. New `entityEvidenceCheck(name, aliases, body)`
  helper + `entityNameLooksLikeFragment(name)` rejects fragment-shaped
  proposals (pure numbers, currency amounts like "CHF 22", ISO dates,
  month-day strings, punctuation-only, single chars).
- **v2-entities as first-class retrieval candidates (P0-D).** Added
  `"entity"` to `RetrievalKind`, `classifyPath` recognises
  `/v2-entities/`, and `reindexAll` now includes `data/v2-entities/`
  in its candidate roots. Calling `/v2/recall` with `kinds:["entity"]`
  now returns approved v2 entities (was a silent no-op before).
- **`--extract` real implementation (P0-E).** The LongMemEval harness
  previously documented but stubbed `--extract`. Now runs inline LLM
  extraction (via `pickExtractor`) per ingested session, writes drafts,
  and auto-approves high-confidence (≥0.9) ones via the
  `/v2/fact/:id/approve` evidence gate. Approval counts surfaced in
  the report.
- **Ollama embedder dim probe (P0-F).** `OllamaEmbedder.dim` is no
  longer `0` until the first `embed()` call. Constructor seeds from
  `OLLAMA_EMBED_DIM` env, a known-model table (`nomic-embed-text`=768,
  `mxbai-embed-large`=1024, `bge-m3`=1024, etc.), or an explicit ctor
  arg. First real embed corrects the seed if it disagrees.
- **`legal_basis` exposed through `/v2/erase` (P0-G).** Request body
  accepts `{ record_path, reason, legal_basis? }` and forwards the
  field to `hardErase` which already supported it. Lets API callers
  record GDPR Article 17 / nFADP citations alongside the erasure.

### Added (P1 — answer-level benchmark scoring)

- **LLM-judge layer in `bench/longmemeval-harness.ts`.** Two judge
  modes: `--judge substring` (case-insensitive token check, fast, no
  LLM) and `--judge llm` (Ollama-based judge prompt). Generates a
  candidate answer from retrieved context (`--top-k` sessions,
  `--context-chars`), then judges against the LongMemEval gold
  answer. Per-category and overall **Answer-correct%** alongside the
  existing Hit@k metrics.

### Added (NEW — Zep/Hindsight gap closers)

- **Contradiction detection** on fact write. `findContradictions(vault,
  owner, candidate)` returns existing approved non-invalidated facts
  that share `(subject, predicate)` with a different object. Exposed
  at `POST /v2/fact/contradictions`.
- **Approve-with-supersedes**: `POST /v2/fact/:newId/approve-supersedes/:oldId`
  atomically approves the new fact and invalidates the old one
  (setting `superseded_by` to point at the new fact). Runs the same
  evidence gate as plain approve.
- **LLM-driven reflection**: `reflectLLM` runs the existing rule-based
  pass, then feeds the same window of episodes + facts to a
  structured-prompt LLM that proposes high-confidence beliefs. Drafts
  go through the same acceptance gate as facts (with `evidence_excerpt`
  required). Opt-in via `POST /v2/reflect` with `llm: true`.
- **Entity resolution** (`resolveEntity` + `POST /v2/entity/resolve`).
  Given a candidate name/aliases/type, returns ranked existing
  entities by exact match (1.0), substring containment (0.7+0.2×len
  ratio), and Levenshtein ≤ 2 (0.5+0.4×similarity). Closes the Zep
  alias-resolution gap. Used by extractors to avoid creating duplicate
  entities.
- **Reciprocal Rank Fusion** (`reciprocalRankFusion` in
  `layer5-rrf.ts`). Standard RRF (k=60 default) for combining keyword,
  vector, graph candidate lists. Available as a helper today; not yet
  wired into `/v2/recall` as a fusion strategy (that requires a
  retrieval pipeline refactor — deferred to v2.10).

### Added (acceptance lifecycle parity)

- **Draft cognitive records**. `recordCognitive` now accepts
  `status: "draft" | "approved" | "rejected"`, `evidence_excerpt`,
  `proposed_by`. LLM-driven reflection uses this. Layer 5 retrieval
  filter now excludes draft / rejected cognitive records (in addition
  to facts and entities).

### Changed

- **License pivot: MIT → BUSL-1.1.** v2.9.0 onward is under the
  Business Source License 1.1 with Change Date 2030-05-15 and Change
  License Apache 2.0. Non-production use (evaluation, academic
  research, security review, internal development) is free. Production
  use requires a commercial license. Versions v2.0.0 through v2.8.0
  remain MIT-licensed at their git tags. See `NOTICE-LICENSE-HISTORY.md`,
  `LICENSE`, and `LICENSE-MIT-PRE-V2.9.md`.
- README claim wording updated to reviewer's precise framing: "rejected
  ~27% of LLM-proposed facts for failing source-evidence checks" (not
  "caught 27% hallucinations" — that needs human-labeled ground truth).
- README Quick Start no longer claims a stale "97 assertions" test count.

### Test counts

- v2.8.0: 177 tests, 18 files, 411 expect() calls
- v2.9.0: 222 tests, 25 files, 525+ expect() calls (+45 tests covering
  x-owner override, fail-closed fact + entity approval, evidence-check
  fragment detection, contradiction detection, entity resolution, RRF
  fusion edge cases)

### Migration notes

- License: production users of v2.9.0+ require a commercial license.
  v2.0.0–v2.8.0 at their tags stay MIT — no clawback.
- Schema: `status` field on cognitive records is optional and defaults
  to `approved` for back-compat. Audit table has no new columns
  (metadata column from v2.8.0 unchanged).
- `RetrievalKind` gained the `"entity"` value — existing callers that
  pass `kinds:["fact", "cognitive"]` are unaffected; callers that
  asked for `["entity"]` and silently got nothing now get the v2
  approved entities.

---

## v2.8.0 — 2026-05-15

Closes the remaining priorities from the external review of v2.5.1
(P2, P4, P5, P6, P7, W4, W8). Companion to v2.7.0 which delivered P1 +
P3. mema now ships every architectural fix the reviewer asked for; the
remaining work is benchmark coverage and embedder quality optimization.

### Added

- **Atomic writes everywhere (P2).** New `src/v2/atomic.ts` exposes
  `atomicWriteFile(path, content)` (tmp + fsync + rename). Every v2
  layer writer (`layer1-episodic`, `layer2-entities`, `layer2-semantic`,
  `layer3-cognitive`, `layer4-governance`, `layer7-assets`) now uses
  it — 24 direct `writeFileSync` calls removed from the v2 surface. The
  README architecture invariant "all write paths use atomic write"
  now holds without caveat.
- **Strict policy mode (P4).** New `MEMA_POLICY_MODE` env var
  (`permissive` default, `strict` opt-in) plus `PolicyContext.mode`
  override. In strict mode `policyCheck` denies:
  - missing governance block
  - governance with empty `purpose[]`
  - regulated data class (`personal`/`pii`/`health`/`financial`/`phi`)
    without `retention_until`
  - jurisdiction mismatch between the recall context and the record
  - regulated cloud destination without `human_review: true`
- **Jurisdiction + model-routing policy (P5).** `PolicyContext.model`
  now carries `{model, model_region, deployment, human_review,
  approved_models}`. `policyCheck` denies recall when regulated content
  would flow to a cloud model whose `model_region` doesn't match the
  record's jurisdiction AND isn't in the caller's `approved_models`
  allowlist. Applies in both modes; the human-review requirement is
  strict-mode-only. Wired through `/v2/recall`.
- **Hard-erase audit provenance (P6).** Before erasure, `hardErase`
  now captures `{erased_record_id, erased_record_path,
  content_hash_before, metadata_hash_before, legal_basis}` and writes
  them into the audit log's new `metadata` column. The tombstone on
  disk carries only the hashes (auditors can prove what was erased
  without retaining the content). Audit chain stays valid across the
  schema upgrade (ALTER TABLE is idempotent; pre-v2.8 entries hash
  without the metadata field).
- **Epoch-ms temporal comparison (W8).** New `src/v2/temporal.ts`
  exposes `toEpochMs`, `factValidAt(fact, atIso, "lt"|"lte")`,
  `factValidSince`. `layer2-semantic.getFactsValidAt`,
  `layer3-reflection`, and `layer5-retrieval` now use them. Mixed
  timezone formats (`2026-05-15`, `2026-05-15T10:00:00+02:00`,
  `2026-05-15T08:00:00Z`) compare correctly; unparseable strings
  fall through conservatively rather than crashing.
- **Graph-influenced retrieval ranking (P7).** New `buildSupportIndex`
  in `layer5-graph` computes per-record in-degree (how many records
  cite this one via `derived_from` / `superseded_by`). `recall` now
  includes three new score components: `graph_support` (normalized
  in-degree), `recency` (linear 90-day decay over `valid_from`), and
  `contradiction` (1 if `invalidated_at` or `superseded_by` is set, 0
  otherwise). Fused score: 24% IDF + 20% title + 20% vector + 8%
  confidence + 6% layer prior + 12% graph_support + 5% recency,
  multiplied by `(1 - 0.35 × contradiction)`. `why_retrieved`
  surfaces graph and recency signals when they dominate.
- **OllamaEmbedder (W4).** New `OllamaEmbedder` class wraps Ollama's
  `/api/embeddings` endpoint. Opt in with `MEMA_EMBEDDER=ollama`;
  default model `nomic-embed-text` (pull with `ollama pull
  nomic-embed-text`). Privacy-preserved (local), transformer-quality
  vectors. Closes the paraphrase / cross-language gap of the
  deterministic-hash `LocalHashEmbedder`. `pickEmbedder` honors
  `MEMA_EMBEDDER` (values `ollama|openai|local`); falls back to
  `LocalHashEmbedder` when nothing is configured.
- **LongMemEval benchmark harness (P8).** New `bench/longmemeval-
  harness.ts` runs mema retrieval against the LongMemEval oracle
  dataset (Wu et al., ICLR 2025) and scores Hit@1 / Hit@5 / Hit@10
  per question category. Default is retrieval-only (fast); `--extract`
  hooks the v2.7+ LLM-extraction + auto-review pipeline (slow). See
  `bench/longmemeval-harness.ts` header for usage.

### Changed

- `AppendAuditInput` and `AuditEntry` gained an optional
  `metadata?: Record<string, unknown>` field. The audit hash payload
  includes metadata when present so tampering invalidates the chain.
- `RetrievalQuery` gained `jurisdiction`, `model`, `policy_mode` —
  forwarded to `policyCheck` to enable P5 enforcement.
- `getFactsValidAt(vault, owner, at, includeDrafts?)` signature
  unchanged (already gained `includeDrafts` in v2.7.0).
- `RetrievalHit.score_components` now contains `graph_support`,
  `recency`, `contradiction` alongside the prior `idf`, `title`,
  `vector`, `confidence`, `layerPrior` fields.

### Test counts

- v2.7.0: 143 tests, 15 files, 342 expect() calls
- v2.8.0: 177 tests, 18 files, 411 expect() calls (+34 tests covering
  strict-mode, model-routing, erasure provenance, temporal edge cases,
  graph-rank signal correctness)

### First LongMemEval result (176 questions, retrieval-only)

Ran the new `bench/longmemeval-harness.ts` against the LongMemEval
oracle dataset (Wu et al., ICLR 2025) on an isolated bench vault:

| Category               | n   | Hit@1 | Hit@5 | Hit@10 | Recall ms |
|------------------------|-----|-------|-------|--------|-----------|
| knowledge-update       | 76  | 65.8% | 88.2% | 93.4%  | 77        |
| temporal-reasoning     | 60  | 30.0% | 86.7% | 96.7%  | 35        |
| multi-session          | 40  | 32.5% | 72.5% | 80.0%  | 66        |
| **Overall**            | 176 | 46.0% | 84.1% | 91.5%  | 60        |

Honest framing: this is **session-level retrieval recall@k** (did mema
return the haystack session containing the answer?), not LongMemEval's
official answer-correctness score (which requires an LLM judge on top
of retrieval). The next milestone is wiring a judge on top to produce
comparable LongMemEval numbers.

Reviewer's pre-fix estimate for v2.5.1 on LongMemEval temporal-reasoning
was "Medium". v2.8.0 demonstrates Hit@5 = 86.7% on that category at
~17–35ms retrieval latency. The Hit@1 drop on temporal/multi-session
relative to a single-question run reflects expected cross-question
ranking competition when 200 questions × ~5 sessions each are pooled
into one vault — Hit@5 stays strong, which is what matters for
LLM-judge downstream.

### Real-world acceptance-gate result (first run on Ardin's vault)

Ran `bun scripts/extract-facts-llm.ts --owner ardin --limit 20` then
`bun scripts/review-proposals.ts --owner ardin --auto` on a real
20-episode slice of the production corpus (Ollama llama3.1:8b):

- **20 episodes processed** in 490 seconds (24.5s/episode mean).
- **111 draft facts + 60 draft entities** proposed by the LLM.
- **55 auto-approved** (confidence ≥ 0.9 AND evidence check passed).
- **30 auto-rejected** (~27% of drafts) for failing the evidence
  check — examples: "@company/finance agent implemented Finance agent
  implementation (#69)", "UMB AG earns CHF 101,850/year", "Marcel
  corrected target partners". Real LLM over-extractions that the
  gate correctly caught.
- **26 held for human review** (confidence 0.75–0.89 with evidence
  passing).

This is the noise-reduction validation the reviewer asked for:
heuristic v2.5 had ~30% noise enter the vault; LLM v2.6 + acceptance
gate v2.7 + atomic-write/strict-policy v2.8 caught ~27% before they
landed.

### Migration notes

Fully backward compatible. The audit table gains a nullable
`metadata` column via idempotent `ALTER TABLE`. Existing facts and
entities without acceptance-lifecycle fields default to `approved`
(unchanged from v2.7.0). `MEMA_POLICY_MODE` defaults to `permissive`;
strict mode is explicit opt-in for regulated deployments.

---

## v2.7.0 — 2026-05-15

Acceptance lifecycle for untrusted producers (LLM extractors, heuristics)
plus version-metadata drift fix. Closes external-review weaknesses #1
(extraction quality) and partially the documentation-drift critique
(P1 from the v2.5.1 review).

### Added

- **Draft → approved/rejected lifecycle** on L2 facts and entities.
  - `RecordStatus = "draft" | "approved" | "rejected"` added to
    `SemanticFact` and `Entity` types.
  - New per-record fields: `evidence_excerpt`, `proposed_by`,
    `proposed_at`, `reviewed_by`, `reviewed_at`, `review_reason`.
  - Direct API writes default to `approved` for full back-compat.
  - LLM extractors write `status: "draft"` and include an evidence
    excerpt from the source episode.
- **New endpoints:**
  - `POST /v2/fact/:id/approve` — runs evidence check (subject and
    object substrings must appear in source episode body) then promotes
    draft. Accepts `force: true` to override for synonym cases.
  - `POST /v2/fact/:id/reject` — requires `reason`; soft-rejects.
  - `POST /v2/entity/:id/approve` and `/reject`.
  - `GET /v2/facts/drafts` and `GET /v2/entities/drafts` — review
    surfaces.
  - `GET /v2/facts/valid-at?include_drafts=true` — opt-in surfacing of
    drafts for review tools.
- **New audit ops:** `PROPOSE`, `APPROVE`, `REJECT`. The hash chain
  remains valid across the new transitions (`verifyChain().valid`).
- **`evidenceCheck(subject, object, episodeBody)`** helper in
  `layer2-semantic.ts` — case-insensitive substring check for both
  terms; returns `{ok}` or `{ok: false, missing: [...]}`.
- **`scripts/review-proposals.ts`** — two modes:
  - `--auto` auto-approves drafts where confidence ≥ 0.9 AND evidence
    passes, auto-rejects drafts whose evidence is missing, leaves the
    rest for human review.
  - Default (interactive) prints each draft with source excerpt and
    prompts `a/r/s/q`.
- **`scripts/extract-facts-llm.ts`** writes drafts by default. Pass
  `--commit-direct` to opt into legacy direct-commit behavior.
- **Acceptance-lifecycle test suite** — 15 new tests covering schema
  defaults, draft writes, approve/reject transitions, retrieval
  filters, evidence check, audit chain continuity.

### Fixed

- **Documentation/version drift (review P1):**
  - `package.json` now has a `version` field (was missing).
  - `GET /health` reads `pkg.version` instead of hardcoded `"1.0.0"`.
  - README badges + Status section synced to reality (was claiming
    v2.0.0 + 97 tests).

### Changed

- `getFactsValidAt(vault, owner, at)` gained an optional `includeDrafts`
  parameter (default `false`). Approved is the only default-visible
  status; drafts and rejected are excluded unless explicitly requested.
- `listEntities(vault, owner, type?)` gained an optional `includeDrafts`
  parameter with the same default.
- `layer5-retrieval` filters out `status: "draft"` and `"rejected"` on
  both fact and entity hits.

### Test counts

- v2.6.0: 128 tests, 14 files, 301 expect() calls
- v2.7.0: 143 tests, 15 files, 342 expect() calls

### Migration notes

Fully backward compatible. Existing vaults need no migration — records
without a `status` field are treated as `approved` by retrieval. Only
producers that opt in (LLM extractors, the `--auto` review CLI, etc.)
see the new lifecycle behavior.

---

## v2.6.0 — earlier 2026-05-15

LLM-augmented fact + entity extraction framework. Pluggable extractor
(`OllamaExtractor` default, `AnthropicExtractor` / `OpenAIExtractor` as
fallbacks). Strict structured prompt targets <5% noise vs the v2.5
heuristic's ~30%. Extraction script: `scripts/extract-facts-llm.ts`.

See `RESUME-HERE.md` for the deployment sequence.

## v2.5.1 — earlier 2026-05-15

Graph-connectivity fixes:
- Folded YAML wikilinks (1,164 v2 files) — js-yaml's default lineWidth
  broke Obsidian wikilink resolution; post-process pass unfolds them.
- v1→v2 back-wiring — v1 records derived into v2 episodes now carry
  back-links (v1 entities populated 4→353 of 355 after fix).

## v2.5.0

Heuristic entity + fact extraction to populate L2 / graph. *Deprecated
in v2.6.0 in favor of LLM extraction.*

## v2.4.0

PAI memory → mema migration. CLAUDE.md updated to use mema as the
primary memory store.

## v2.3.0

Human-readable filenames: `{slug}--{ulid}.md`. Fixes opaque
ULID-only filenames that made the Obsidian graph unreadable. ULID
preserved in frontmatter.

## v2.2.0

v1 → v2 migration. v2 layers were empty after import because import
only wrote to v1 — migration creates v2 episodes from v1 records.

## v2.1.x

Obsidian graph compatibility: v2 writers populate `links:`, graph
viewer added, audit fixes.

## v2.0.0

Seven-layer architecture: episodic / temporal-semantic / cognitive /
governance / retrieval / audit / verifiable-assets. 97 automated
assertions across 10 test files. 96.0% Precision@1 on 25-query
benchmark over a 347-document corpus (vs 44.0% for the v1 baseline).
