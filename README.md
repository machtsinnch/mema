# mema

**Verifiable seven-layer memory for AI agents.**

mema gives an agent a memory that a regulator, an auditor, or a customer can
inspect. It is built for Swiss and EU contexts where FINMA, GDPR, and the
revised nFADP apply, and where audit replay, hard erasure, tenant isolation,
and jurisdiction-aware governance matter as much as recall quality. The
substrate is a plain markdown vault: no graph database, no vector database
extension, no blockchain. The filesystem is the source of truth, and every
index is derived state that can be rebuilt from it.

---

## Why

Memory errors compound. A single wrong or unattributed fact written today
becomes the premise an agent reasons from tomorrow, and the cost of that
mistake grows the longer it stays uncaught. mema puts the controls on the
write path, so bad records are stopped before they enter the retrieval
surface rather than caught after they have done damage. Every recall returns
a receipt: `score_components`, `why_retrieved`, the `governance` decision, a
content hash, and a UAL for records that have been wrapped as assets.

---

## The seven layers

```
┌─────────────────────────────────────────────────────────────────┐
│  L7  Asset       (content_hash + metadata_hash + UAL + anchor)  │
├─────────────────────────────────────────────────────────────────┤
│  L6  Audit       (SHA-256 hash-chained log + sealed witness)    │
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

Each layer is one or more TypeScript files under `src/v2/layer{N}-*.ts`. The
filesystem layout mirrors the architecture: `data/episodes/`, `data/facts/`,
`data/cognitive/`, `data/v2-entities/`, `data/_meta/audit.sqlite`,
`data/_meta/vectors.sqlite`, `data/_meta/anchors.sqlite`.

mema draws on Zep (bi-temporal facts), Hindsight (epistemic separation), Mem0
(production memory pipeline), and OriginTrail (verifiable knowledge assets),
but ships without a graph-DB substrate, online LLM extraction, or blockchain
dependencies. See [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md) for the full
related-work positioning.

---

## Highlights

- **v2.22.13.** 538 tests passing across 63 test files (1,362 `expect()`
  assertions), running in under 4 seconds via `bun test`.
- **96.0% Precision@1** on a 25-query retrieval benchmark over a 347-document
  corpus, versus 44.0% for the v1 keyword baseline. This is the measurement
  recorded for the v2.0.0 architecture in `bench/recall-benchmark-v2.py`;
  re-run it against your own corpus to reproduce.
- **External evaluation harnesses** for LongMemEval (`bench/longmemeval-harness.ts`)
  and LoCoMo (`bench/locomo-harness.ts`), with retrieval-mode and fusion-mode
  flags for one-flag ablations.
- **Trust benchmark** (`bench/swiss-trust-bench.ts`): 12 end-to-end scenarios
  covering strict-mode denial, purpose and jurisdiction mismatch, cross-tenant
  isolation, hard-erase audit replay, and audit-chain integrity. These are the
  procurement-checkbox properties that recall benchmarks do not measure.
- **Acceptance lifecycle** for untrusted producers: LLM extractors propose
  drafts, an evidence check gates promotion, and every transition is recorded
  in the audit chain.
- **Strict policy mode** (`MEMA_POLICY_MODE=strict`) denies missing
  governance, jurisdiction mismatches, and regulated-cloud routing without
  human review.
- **Hard erase with audit provenance**: erasure records the pre-erasure
  `record_id`, content and metadata hashes, and `legal_basis` without
  retaining the erased content.
- **MCP server** exposing nine v2 tools to Claude Code, Cursor, or any MCP
  client, alongside three independent adversarial security reviews with
  shipped mitigations.

> **v1 is preserved unchanged** at `/v1/*` for backwards compatibility. New
> deployments should use v2.

---

## Quick start

```bash
git clone https://github.com/machtsinnch/mema && cd mema
bun install

# Start the server (permissive rate limit for development)
MACHTSINN_RATE_LIMIT_BURST=10000 ./scripts/start.sh

# Verify
curl http://localhost:3001/health

# Run the full test suite
bun test

# Import a corpus
bun scripts/import-tree.ts /path/to/your/markdown/folders

# Build the vector index (idempotent, one-time per corpus change)
curl -X POST http://localhost:3001/v2/vector/reindex -H "x-api-key: dev-ardin"

# Run the v2 recall benchmark
python3 bench/recall-benchmark-v2.py
```

---

## HTTP API

### v2 (recommended)

| Method | Endpoint | Layer | Purpose |
|---|---|---|---|
| POST | `/v2/observe` | L1 | Ingest a raw episode (runs extraction by default) |
| POST | `/v2/fact` | L2 | Record a bi-temporal fact. Pass `status: "draft"` + `evidence_excerpt` for untrusted producers |
| POST | `/v2/fact/:id/invalidate` | L2 | Mark a fact invalidated or superseded |
| POST | `/v2/fact/:id/approve` | L2 | Promote a draft fact (runs the server-side evidence check unless `force: true`) |
| POST | `/v2/fact/:id/reject` | L2 | Reject a draft fact (requires `reason`) |
| GET | `/v2/facts/drafts` | L2 | List draft facts for the owner |
| GET | `/v2/facts/valid-at?at=...` | L2 | Facts valid at a given timestamp |
| POST | `/v2/entity` | L2 | Create an entity (supports `status: "draft"`) |
| GET | `/v2/entity/find/:name` | L2 | Resolve a name or alias to an entity |
| POST | `/v2/entity/:keeperId/merge/:mergedId` | L2 | Merge two entities |
| POST | `/v2/cognitive` | L3 | Record an experience, observation, or belief |
| POST | `/v2/reflect` | L3 | Run automated reflection |
| POST | `/v2/governance/build` | L4 | Compute a governance block from source |
| POST | `/v2/erase` | L4 | Hard-erase a record (tombstone + audit) |
| POST | `/v2/recall` | L5 | Hybrid retrieval, returns verifiable packets |
| POST | `/v2/recall/packet` | L5 | Compiled memory packet for a query |
| POST | `/v2/vector/reindex` | L5 | Rebuild the vector index |
| GET | `/v2/graph/derived-from/:id` | L5 | Walk supporting records |
| GET | `/v2/audit/log` | L6 | Query the audit log |
| GET | `/v2/audit/verify` | L6 | Verify hash-chain integrity |
| POST | `/v2/asset/wrap` | L7 | Wrap a record as a verifiable asset |
| POST | `/v2/asset/anchor` | L7 | Anchor an asset to a target |
| GET | `/v2/asset/anchors?ual=...` | L7 | List anchors for the caller |

The full route set, including cognitive approval, judgments, contradictions,
and supersession, lives in `src/index.ts`. v1 operations (`/v1/remember`,
`/v1/recall`, `/v1/memory/:id`, `/v1/forget`, `/v1/promote`, `/v1/link`,
`/v1/log`, `/v1/stats`) are preserved at `/v1/*`.

Auth: `x-api-key` header. Dev keys: `dev-ardin`, `dev-marcel`, `dev-founder3`.

---

## MCP server

Add to `~/.claude.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "machtsinn": {
      "command": "bun",
      "args": ["/absolute/path/to/mema/src/mcp.ts"],
      "env": {
        "MACHTSINN_URL": "http://localhost:3001",
        "MACHTSINN_KEY": "dev-ardin",
        "MACHTSINN_ACTOR": "claude-code"
      }
    }
  }
}
```

v2 tools: `memory_v2_observe`, `memory_v2_fact`, `memory_v2_recall`,
`memory_v2_reflect`, `memory_v2_audit_log`, `memory_v2_audit_verify`,
`memory_v2_erase`, `memory_v2_asset_wrap`, `memory_v2_asset_anchor`. The eight
v1 tools (`memory_remember`, `memory_recall`, `memory_show`, `memory_forget`,
`memory_promote`, `memory_stats`, `memory_health`, `memory_log`) remain
available.

---

## Acceptance lifecycle for untrusted producers

LLM extractors and other untrusted producers do not write directly into the
retrieval surface. They propose drafts, and an evidence-checked review step
promotes them to `approved` or marks them `rejected`.

```
raw episode ─▶ LLM extractor ─▶ DRAFT fact/entity (status: "draft")
                                        │
                                        ▼
                              evidence-check guard
                                        │
                            ┌───────────┴───────────┐
                            ▼                       ▼
                       APPROVED                  REJECTED
                  (visible in recall)       (kept for audit,
                                             never retrievable)
```

The guard runs server-side on `/v2/fact/:id/approve` and returns
`422 evidence_check_failed` when the fact's `subject` or `object` does not
appear in the source episode body (case-insensitive). Pass `force: true` to
override for synonym or alias cases. Every transition appends an `APPROVE` or
`REJECT` entry to the hash-chained audit log, and `verifyChain()` includes
them. Records written without an explicit `status` default to `approved`, so
the lifecycle is opt-in and backward-compatible with existing vaults.

---

## Architecture invariants

1. **Filesystem is the source of truth.** SQLite (audit, vectors, anchors) is
   derived state, rebuildable from the markdown vault.
2. **All write paths are atomic** (temp + fsync + rename via `src/v2/atomic.ts`).
   No direct `writeFileSync` remains in the v2 surface.
3. **All reads filter by owner** (`canRead` in v1, deny-on-owner-mismatch in
   v2). No exceptions.
4. **Uniform 404** for not-found versus not-readable.
5. **Path sanitization on every user-supplied segment**, including inside UALs
   after URL-decode.
6. **Audit log is append-only** with a hash chain plus an external sealed
   witness.
7. **Untrusted producers write drafts only** and are gated by the acceptance
   lifecycle before entering the retrieval surface.

---

## Threat model

mema v2 underwent three independent adversarial reviews. Mitigations shipped:

| Attack | Mitigation |
|---|---|
| Audit row deletion or suffix-drop | seq-contiguity check + `sqlite_sequence` comparison + external sealed witness |
| Audit chain fork via race | `appendAudit` wrapped in a `BEGIN IMMEDIATE` transaction |
| Cross-tenant recall or anchor leak | owner filter is deny-by-default; `listAnchors` is owner-scoped |
| UAL path traversal | `SAFE_SEGMENT` regex applied after URL-decode |
| NaN/Inf confidence poisoning | `clampConfidence()` at every write and read boundary |
| Disk-fill DoS | per-request body cap (`MACHTSINN_V2_MAX_BODY_BYTES`) |
| Silent retrieval failure | ripgrep exit-code check, throws on a missing binary |
| Vector cross-embedder pollution | vector search filters by embedder name |

Full detail in [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md) sections 4.4 to 4.5.

---

## Graph view

Three ways to see the network of memories, all sharing one layer-color
palette:

- **Obsidian:** open `data/` as a vault and run
  `./scripts/install-obsidian-config.sh` to install layer coloring, then
  `Cmd+G`.
- **Built-in viewer:** open `http://localhost:3001/graph`, enter an API key,
  and load a zero-dependency force-directed canvas.
- **External tools:** `curl 'http://localhost:3001/v2/graph?limit=2000'`
  returns `{nodes, edges, stats}` ready for Cytoscape, vis-network, Gephi, or
  D3.

---

## Stack

- Bun and TypeScript
- Hono for HTTP
- `bun:sqlite` for the audit, vector, and anchor stores
- `@modelcontextprotocol/sdk` for the MCP server
- ripgrep for keyword search (system dependency)
- gray-matter for frontmatter, ulid for IDs

No graph DB, no vector DB extension, no blockchain. Semantic embeddings are
optional and fall back to a local hash embedder when no external embedder is
configured.

---

## License

**Business Source License 1.1**, converting to **Apache 2.0 on 2030-05-15**.
Non-production use (evaluation, academic research, security review, internal
development) is free. Production use requires a commercial license: contact the
Licensor.

BUSL applies from v2.9.0 onward. Versions **v2.0.0 through v2.8.0 remain
MIT-licensed** at their published git tags. See [`LICENSE`](LICENSE),
[`NOTICE-LICENSE-HISTORY.md`](NOTICE-LICENSE-HISTORY.md), and
[`LICENSE-MIT-PRE-V2.9.md`](LICENSE-MIT-PRE-V2.9.md) for the full history.
