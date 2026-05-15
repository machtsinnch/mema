# Changelog

All notable changes to mema. Follows [Keep a Changelog](https://keepachangelog.com/).

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
