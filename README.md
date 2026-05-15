# mema

**Verifiable seven-layer memory infrastructure for AI agents.**

Markdown-vault substrate + bi-temporal facts + epistemic cognitive layer +
purpose-bound governance + hybrid retrieval (keyword + IDF + vector + graph
+ temporal + policy) + SHA-256-hash-chained audit log + verifiable memory
assets (UAL + content hash + anchor lifecycle).

Designed for **regulated enterprise contexts** — Swiss / EU financial
services, healthcare, public sector — where audit replay, hard erasure,
multi-tenant isolation, jurisdiction-aware governance, and inspectable
storage matter as much as benchmark recall.

[![v2.0.0](https://img.shields.io/badge/release-v2.0.0-blue)](https://github.com/machtsinnch/mema/releases/tag/v2.0.0)
[![tests](https://img.shields.io/badge/tests-97_passing-green)](https://github.com/machtsinnch/mema/blob/main/tests/)
[![benchmark](https://img.shields.io/badge/Precision@1-96.0%25-green)](https://github.com/machtsinnch/mema/blob/main/bench/recall-benchmark-v2.py)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Status

**v2.0.0** — Seven-layer verifiable memory architecture. Three rounds of
adversarial review, all critical findings fixed and regression-tested.

- **97 automated assertions** passing across 10 test files
- **96.0% Precision@1** on a 25-query benchmark over a real 347-document
  corpus (vs 44.0% for the v1 baseline — **+52 percentage points**)
- **MCP v2 surface live** — 9 tools for Claude Code / Cursor / any MCP client
- Full architecture documented in [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md)

> **v1 is preserved unchanged** at `/v1/*` endpoints for backwards
> compatibility. New deployments should use v2.

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

Each layer is one or more TypeScript files under `src/v2/layer{N}-*.ts`.
The filesystem layout mirrors the architecture: `data/episodes/`,
`data/facts/`, `data/cognitive/`, `data/v2-entities/`,
`data/_meta/audit.sqlite`, `data/_meta/vectors.sqlite`,
`data/_meta/anchors.sqlite`.

**Inspired by** Zep (bi-temporal facts), Hindsight (epistemic separation),
Mem0 (production memory pipeline), and OriginTrail/DKG (verifiable
knowledge assets). **Ships without** graph-DB substrate, online LLM
extraction, or blockchain dependencies. See [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md)
for full related-work positioning.

---

## Quick start

```bash
git clone https://github.com/machtsinnch/mema && cd mema
bun install

# Start the server (with permissive rate-limit for development)
MACHTSINN_RATE_LIMIT_BURST=10000 ./scripts/start.sh

# Verify
curl http://localhost:3001/health

# Run the full test suite (97 assertions)
bun test

# Import a corpus
bun scripts/import-tree.ts /path/to/your/markdown/folders

# Build the vector index (idempotent, one-time per corpus change)
curl -X POST http://localhost:3001/v2/vector/reindex -H "x-api-key: dev-ardin"

# Run the v2 recall benchmark
python3 bench/recall-benchmark-v2.py
```

---

## Architecture invariants (DO NOT BREAK)

1. **Filesystem is the source of truth.** SQLite (audit, vectors, anchors)
   and any future index is derived state, rebuildable from the markdown
   vault.
2. **All write paths use atomic write** (temp + rename).
3. **All read endpoints filter through `canRead` (v1) or `owner !==
   query.owner → deny` (v2).** No exceptions.
4. **Uniform 404** for not-found vs not-readable.
5. **Path sanitization on every user-supplied path segment** (including
   inside UALs after URL-decode).
6. **N=3 promotion rule** for v1 generalized layer is server-side enforced.
7. **Audit log is append-only with hash chain + external sealed witness.**

---

## HTTP API surface

### v2 (recommended)

| Method | Endpoint | Layer | Purpose |
|---|---|---|---|
| POST | `/v2/observe` | L1 | Ingest a raw episode |
| POST | `/v2/fact` | L2 | Record a semantic fact (bi-temporal) |
| POST | `/v2/fact/:id/invalidate` | L2 | Mark a fact invalidated/superseded |
| GET | `/v2/facts/valid-at?at=...` | L2 | Facts valid at a given timestamp |
| POST | `/v2/entity` | L2 | Create an entity |
| GET | `/v2/entity/find/:name` | L2 | Resolve name/alias to entity |
| POST | `/v2/entity/:keeperId/merge/:mergedId` | L2 | Merge two entities |
| POST | `/v2/cognitive` | L3 | Record an experience/observation/belief |
| POST | `/v2/reflect` | L3 | Run automated reflection |
| POST | `/v2/governance/build` | L4 | Compute a governance block from source |
| POST | `/v2/erase` | L4 | Hard-erase a record (tombstone + audit) |
| POST | `/v2/recall` | L5 | Hybrid retrieval (returns verifiable packets) |
| POST | `/v2/vector/reindex` | L5 | Rebuild vector index |
| GET | `/v2/graph/derived-from/:id` | L5 | Walk supporting records |
| GET | `/v2/audit/log` | L6 | Query the audit log |
| GET | `/v2/audit/verify` | L6 | Verify the hash chain integrity |
| POST | `/v2/asset/wrap` | L7 | Wrap a record as a verifiable asset |
| POST | `/v2/asset/anchor` | L7 | Anchor an asset to a target |
| GET | `/v2/asset/anchors?ual=...` | L7 | List anchors for caller |
| POST | `/v2/asset/verification-status` | L7 | Transition lifecycle state |

### v1 (legacy, preserved)

| Op | Endpoint |
|---|---|
| WRITE | `POST /v1/remember` |
| RETRIEVE | `POST /v1/recall` |
| READ | `GET /v1/memory/:id` |
| UPDATE | `PUT /v1/memory/:id` |
| FORGET | `POST /v1/forget` (soft) |
| PROMOTE | `POST /v1/promote` |
| LINK | `POST /v1/link` |
| HEALTH | `GET /v1/topology/health` |
| STATS | `GET /v1/stats` |
| AUDIT | `GET /v1/log` |

Auth: `x-api-key` header. Dev keys: `dev-ardin` / `dev-marcel` / `dev-founder3`.

---

## MCP server (Claude Code / Cursor / any MCP client)

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

**v2 tools:** `memory_v2_observe` · `memory_v2_fact` · `memory_v2_recall` ·
`memory_v2_reflect` · `memory_v2_audit_log` · `memory_v2_audit_verify` ·
`memory_v2_erase` · `memory_v2_asset_wrap` · `memory_v2_asset_anchor`

**v1 tools (preserved):** `memory_remember` · `memory_recall` · `memory_show`
· `memory_forget` · `memory_promote` · `memory_stats` · `memory_health` ·
`memory_log`

---

## Verifiable Memory Assets (Layer 7)

Every record can be **wrapped as an asset** — promoting it from a plain
markdown file to a versioned, hash-stamped, UAL-addressable verifiable
artifact:

```yaml
ual: mema://owner/ardin/fact/marcel-r/memory/01KR...
content_hash: sha256:abc...
metadata_hash: sha256:def...
asset_version: 1
verification_status: anchored   # unverified | verified | anchored
anchored_at: 2026-05-15T14:32:11Z
anchor_targets: [local, customer-audit-bundle]
```

`/v2/recall` returns each hit as a **verifiable packet**:

```json
{
  "kind": "fact",
  "score": 0.86,
  "ual": "mema://owner/ardin/fact/marcel-r/memory/01KR...",
  "content_hash": "sha256:abc...",
  "metadata_hash": "sha256:def...",
  "asset_version": 1,
  "verification_status": "anchored",
  "why_retrieved": "rare-term keyword match + title match + semantic similarity (0.41)",
  "governance": { "allowed": true, "reason": "policy_pass" },
  "excerpt": "..."
}
```

A downstream consumer can independently verify the hit by re-hashing the
file at `ual` and comparing to `content_hash`. Inspired by OriginTrail's
DKG Knowledge Asset model, **without** the blockchain dependency.

---

## Threat model & adversarial hardening

mema v2 underwent three independent adversarial reviews. Mitigations
shipped:

| Attack | Mitigation |
|---|---|
| Audit row deletion (mid-stream) | seq-contiguity check |
| Audit suffix-drop | `sqlite_sequence` comparison + external witness file |
| `sqlite_sequence` reset bypass | external sealed witness (`data/_meta/audit-witness.log`) cross-checked at verifyChain time |
| Audit chain fork via race | `appendAudit` wrapped in `db.transaction()` (BEGIN IMMEDIATE) |
| Cross-tenant recall leak | `recall()` owner filter is **deny-by-default** for missing owner |
| Cross-tenant anchor leak | `listAnchors(owner, ual?)` is owner-scoped |
| UAL path traversal | `SAFE_SEGMENT` regex `/^[A-Za-z0-9_.\-]+$/` after URL-decode |
| NaN/Inf confidence poisoning | `clampConfidence()` at every write boundary + defensive clamp at read |
| Disk-fill DoS | 2 MB body cap per v2 request (configurable via `MACHTSINN_V2_MAX_BODY_BYTES`) |
| Silent retrieval failure (rg missing) | `ripgrepAcross` checks exit code, throws on missing binary |
| Vector cross-embedder pollution | `vectorSearch` filters by embedder name |

Full details in [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md) §4.4–4.5.

---

## Test coverage

```
v1 isolation + security:          38 tests (5 files)
v2 six-layer smoke (end-to-end):   3 tests
v2 professional:                  18 tests
v2 verifiable assets:             12 tests
v2 security-hardening round 1:    12 tests
v2 security-hardening round 2:    14 tests
─────────────────────────────────────────────
Total:                            97 tests, all green
```

`bun test` runs them all in ~300 ms.

---

## Stack

- **Bun + TypeScript** (>= 1.1.0)
- **Hono** for HTTP
- **bun:sqlite** (audit, vectors, anchors stores)
- **@modelcontextprotocol/sdk** for MCP server
- **ripgrep** for keyword search (system dependency)
- **gray-matter + js-yaml** for frontmatter
- **ulid** for IDs

No graph DB, no vector DB extension, no blockchain. Optional: `OPENAI_API_KEY`
enables the `OpenAIEmbedder` for semantic retrieval (auto-detected; falls
back to `LocalHashEmbedder` when absent).

---

## License

MIT. See [`LICENSE`](LICENSE).
