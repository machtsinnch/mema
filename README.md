# machtsinn.ai

Topology-governed AI memory infrastructure for multi-client consulting teams.

Filesystem-as-truth markdown vault + provenance log + HTTP API. Obsidian-compatible — open the `data/` folder as an Obsidian vault to see the graph view.

## Quick start

```bash
bun install
bun dev                    # start server on :3001
bun test                   # run isolation invariant tests
bash scripts/simulate.sh   # full end-to-end simulation
```

## Architecture (v0)

```
data/                       (the vault — point Obsidian here)
├── entities/{entity}/...   (per-client knowledge, isolated by default)
├── generalized/{category}/ (cross-entity patterns, the "lessons" layer)
├── users/{owner}/          (private personal notes per founder)
└── _meta/log.sqlite        (append-only provenance log)
```

Every memory is a markdown file with YAML frontmatter:
- `id` (ULID), `scope`, `owner`, `visibility`, `tags`, `links`, `trust`
- `forgotten` (soft-delete, never destructive)
- Plain body content below the frontmatter

## Six-op API

| Op | Endpoint |
|---|---|
| WRITE | `POST /v1/remember` |
| RETRIEVE | `POST /v1/recall` |
| UPDATE | `PUT /v1/memory/:id` |
| FORGET | `POST /v1/forget` |
| READ | `GET /v1/memory/:id` |
| AUDIT | `GET /v1/log` |
| STATS | `GET /v1/stats` |

Auth: `x-api-key` header. Dev keys: `dev-ardin` / `dev-marcel` / `dev-founder3`.

## Topology rules

| Rule | Threshold |
|---|---|
| Promotion to generalized | 3+ entity contexts |
| Healthy hub spokes | 3–15 |
| Super-hub (split required) | 30+ |
| Demote candidate | 1–2 |

`GET /v1/stats` surfaces `max_spokes` and a `warning` field when a hub starts bulging.

## Isolation invariant

- Default search scope = current entity only
- Cross-entity flow only via `generalized/` layer
- Private user memories never appear in another user's recall — even with `scope: "all"`
- Filesystem permissions + code enforce isolation (defense in depth)
- Failing tests in `tests/isolation.test.ts` must pass before any release

## What v0 deliberately does NOT do yet

- No vector DB (ripgrep first; add embeddings when grep is proven too slow)
- No graph DB (Postgres recursive CTEs later if needed)
- No LLM-on-every-write extraction (Anthropic file-pattern, model writes its own files)
- No MCP server yet (Session 2)
- No CLI yet (Session 2)
- No consolidation pass yet (Session 3)
