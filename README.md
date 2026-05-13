# machtsinn.ai (mema)

Topology-governed AI memory infrastructure for multi-tenant / multi-client work.

Filesystem-as-truth markdown vault + SQLite provenance log + HTTP API + CLI + MCP server. Obsidian-compatible — open the `data/` folder as an Obsidian vault to see the graph view for free.

## Status

**v1.0** — multi-tenant production-ready after 5 rounds of adversarial audit (Claude / Gemini / OpenAI Codex). 104 assertions pass (38 unit tests + 35 + 31 end-to-end simulations). Zero CRITICAL or HIGH issues.

## Quick start

```bash
bun install

# Start the server (with permissive rate-limit for daily use)
MACHTSINN_RATE_LIMIT_BURST=1000 MACHTSINN_RATE_LIMIT_RPS=10 bun src/index.ts

# Or use the lifecycle scripts (idempotent)
./scripts/start.sh
./scripts/stop.sh

# Verify
curl http://localhost:3001/health

# Run tests + simulations
bun test
MACHTSINN_RATE_LIMIT_BURST=10000 bash scripts/simulate.sh
MACHTSINN_RATE_LIMIT_BURST=10000 bash scripts/simulate-session2.sh
```

## Architecture

```
data/                          (the vault — point Obsidian here)
├── entities/{entity}/...      (per-client/per-topic knowledge, isolated by default)
├── generalized/{category}/    (cross-entity patterns, the "lessons" layer)
├── users/{owner}/             (private personal notes per user)
└── _meta/log.sqlite           (append-only provenance log)
```

Every memory is a markdown file with YAML frontmatter:

```yaml
---
id: 01KRH93MCA78D8J3R14P7EQF9W   # ULID, sortable by time
type: semantic                    # semantic | episodic | procedural | working
scope: entity                     # entity | generalized | user
owner: ardin
visibility: project               # private | project | team | public
entity: finance-plan
aliases: ['Swiss Tax Optimization & Pillar 3a Strategy']
created: '2026-05-13T18:20:42.250Z'
updated: '2026-05-13T18:20:49.850Z'
source: 'imported:/path/to/original.md'
trust: 0.75
tags: [swiss-tax, pillar-3a]
links: ['[[01KRH93MC4ZTRDXW0QTPB387M6]]', ...]   # Obsidian wikilinks
forgotten: false
---
Plain markdown body content here.
```

## Three interfaces, one backend

| Interface | When to use |
|---|---|
| **HTTP API** (`:3001`) | Programmatic access, integrations, custom scripts |
| **CLI** (`bun src/cli.ts`) | Terminal workflow, scripting |
| **MCP server** (`bun src/mcp.ts`) | Claude Code, Cursor, any MCP client |

## HTTP API

| Op | Endpoint | Notes |
|---|---|---|
| WRITE | `POST /v1/remember` | Persist a memory |
| RETRIEVE | `POST /v1/recall` | Hybrid scoring (relevance + recency + importance + trust) |
| READ | `GET /v1/memory/:id` | Single memory by ULID (404 for both not-found and unauthorized) |
| UPDATE | `PUT /v1/memory/:id` | Patch body / tags / trust / visibility / links |
| FORGET | `POST /v1/forget` | Soft-delete (forgotten=true; auditable, reversible) |
| PROMOTE | `POST /v1/promote` | Create a generalized hub from 3+ memories across 3+ entities |
| LINK | `POST /v1/link` | Add typed hub-to-hub edge (sibling/parent/children/supersedes/alternatives) |
| CONSOLIDATE | `POST /v1/consolidate` | Surface candidate cross-entity patterns for promotion |
| HEALTH | `GET /v1/topology/health` | Topology rule violations + maturity stage |
| STATS | `GET /v1/stats` | Total memories, entity list, hub count, max spokes |
| AUDIT | `GET /v1/log` | Provenance log (always scoped to caller's owner) |
| LIST | `GET /v1/list` | Paginated list of memories (caller-visible only) |

Auth: `x-api-key` header. Dev keys: `dev-ardin` / `dev-marcel` / `dev-founder3`.
Optional `x-actor` header labels different agents within an owner (e.g. `cursor`, `claude-code`).

## CLI

```bash
bun src/cli.ts login dev-ardin
bun src/cli.ts scope finance-plan
bun src/cli.ts add "Note content here" --tags swiss-tax,personal
bun src/cli.ts find "swiss tax" --scope all
bun src/cli.ts show 01KRH93MCA78D8J3R14P7EQF9W
bun src/cli.ts log --limit 20
bun src/cli.ts stats
bun src/cli.ts health
bun src/cli.ts promote --sources id1,id2,id3 --content "pattern..." --category architecture
```

## MCP server (Claude Code / Cursor)

Add to `~/.claude.json`:

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

Restart Claude Code; the tools `memory_remember`, `memory_recall`, `memory_show`, `memory_forget`, `memory_promote`, `memory_stats`, `memory_health`, `memory_log` become available.

## Topology governance rules

| Rule | Threshold |
|---|---|
| Promotion to generalized | 3+ memories from 3+ distinct entities |
| Healthy hub spokes | 3–15 |
| Super-hub (must split) | 30+ |
| Orphan hub (demote candidate) | 1–2 |
| Hub-to-hub edge types | sibling / parent / children / supersedes / alternatives |
| Maturity stages | Birth → Crystallization → Dense maturity → Self-organization |

`GET /v1/topology/health` surfaces violations + actionable recommendations.

## Isolation invariant

Verified across 5 rounds of adversarial audit:

- USER-scope memories are always per-owner regardless of scope/visibility
- ENTITY-scope `private`/`project` memories are owner-only until per-entity team membership ships
- ENTITY-scope `team`/`public` memories are readable by any authenticated user
- Generalized memories follow the same visibility rules
- All endpoints (`recall`, `list`, `stats`, `health`, `consolidate`, `log`, `memory/:id`) filter through `canRead`
- Uniform 404 for not-found vs unauthorized (no existence oracle)
- Index-based ownership check avoids timing oracle
- Cross-owner writes (promote, link) require ownership
- `x-actor` header can label agents but cannot impersonate other owners

## Lifecycle hooks

`scripts/start.sh` and `scripts/stop.sh` are wired into Claude Code's `SessionStart` and `SessionEnd` hooks (`~/.claude/settings.json`). Idempotent — multiple session starts won't double-launch the server.

## What v1.0 deliberately does NOT do yet

These are deferred to v1.1+ based on the audit roadmap:

- **No semantic embeddings** — pure ripgrep keyword search + hybrid scoring. Add pgvector or sqlite-vec when keyword precision becomes the bottleneck.
- **No bi-temporal model** — single `updated` timestamp per memory, no `valid_from` / `valid_to` periods. Add when temporal reasoning becomes a real need (Zep-style fact invalidation).
- **No auto entity extraction from raw text** — caller specifies the `entity` field. Add LLM-driven extraction when ingestion volume justifies the per-write cost.
- **No graph DB** — filesystem + frontmatter wikilinks is the substrate. Postgres recursive CTEs or a real graph DB only when multi-hop traversal becomes a hot path.
- **No rate-limit bucket TTL/eviction** — keys accumulate forever. Add LRU/TTL when key rotation becomes operational.
- **No per-entity team membership** — `visibility: "project"` is currently owner-only. Add when multiple founders need shared in-entity collaboration.
- **No audit-log hash chain** — append-only by convention, not cryptographically enforced. Add when forge-resistance becomes required.

## Test coverage

```
Unit tests:        38 (5 files — isolation, security, cartesian, v0.6, v0.7)
Session 1 sim:     35 end-to-end assertions
Session 2 sim:     31 end-to-end assertions
─────────────────────────────────────────────
Total:             104 assertions, all passing
```

## Stack

- Bun + TypeScript
- Hono (HTTP)
- bun:sqlite (embedded SQLite)
- @modelcontextprotocol/sdk (MCP server)
- ripgrep (system command, hybrid search)
- gray-matter + js-yaml (frontmatter)
- ulid

## License

TBD. All rights reserved by default until a license file is added.
