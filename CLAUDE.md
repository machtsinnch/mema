# CLAUDE.md — mema (machtsinn.ai memory infrastructure)

Guidance for Claude Code / Cursor / any AI assistant working on this codebase.

## What this is

Topology-governed AI memory infrastructure. Filesystem-as-truth markdown vault, multi-tenant isolation, HTTP + CLI + MCP interfaces.

**Status**: v1.0 — multi-tenant production-ready after 5 rounds of adversarial audit. Don't regress the security model without re-running the audit cycle.

## Stack rules

- Use `bun` for everything (not Node, npm, yarn, jest, ts-node)
- `bun test` for tests, `bun src/index.ts` to run the server
- `bun:sqlite` for SQLite (not `better-sqlite3`)
- Hono for HTTP routing (not Express)
- `Bun.$` for shell commands when needed

## Architecture invariants (DO NOT BREAK)

These are enforced by tests and verified by audit. Breaking any of them must be a conscious decision documented in commit message + new test:

1. **Filesystem is the source of truth.** SQLite log and in-memory index are derived state, never authoritative.
2. **All write paths use `atomicWrite`** (temp + rename). Never direct `writeFileSync`.
3. **All read endpoints filter through `canRead`.** No exceptions, including stats / topology / list / consolidate.
4. **`/v1/memory/:id` uses `isReadable` BEFORE reading the file.** Closes timing oracle.
5. **Uniform 404 for not-found vs not-readable.** No existence oracle.
6. **Promote backlinks skip foreign-owned sources.** No cross-owner writes.
7. **`x-actor` is always owner-prefixed.** No actor spoofing.
8. **Path sanitization on every user-supplied path segment.** No `..` allowed.
9. **N=3 promotion rule enforced server-side.** Don't expose a bypass.
10. **The `data/` folder is `.gitignore`d.** Never commit user memories.

## Topology rules (the novel contribution)

| Rule | Threshold | Where enforced |
|---|---|---|
| Promotion to generalized | 3+ memories from 3+ distinct entities | `api.ts:/v1/promote` |
| Healthy hub spokes | 3–15 | `api.ts:/v1/topology/health` |
| Super-hub (must split) | 30+ | warning surfaced in stats + health |
| Orphan hub (demote) | 1–2 | warning surfaced in health |
| Hub-to-hub edge types | sibling/parent/children/supersedes/alternatives | `api.ts:/v1/link` |
| Maturity stages | Birth → Crystallization → Dense → Self-organization | derived from hub count + categories |

## Code conventions

- TypeScript strict mode. No `any` proliferation; use `unknown` + narrowing.
- One file per major concern (`storage.ts`, `api.ts`, `db.ts`, `search.ts`, `scoring.ts`).
- Short functions. If something exceeds ~80 lines, split it.
- Comments explain WHY, not WHAT. Reserve them for non-obvious invariants.
- Frontmatter fields are explicitly typed in `types.ts` — keep that file in sync.

## Testing

- `tests/isolation.test.ts` — primary multi-tenant invariants
- `tests/security.test.ts` — v0.4 security regression
- `tests/cartesian-isolation.test.ts` — full {scope × visibility × owner} matrix
- `tests/v06-fixes.test.ts` and `tests/v07-fixes.test.ts` — audit-finding regression

Before any release, ALL of these must pass + both `scripts/simulate*.sh` must run clean with `MACHTSINN_RATE_LIMIT_BURST=10000`.

## When adding a new endpoint

1. Add the route to `src/api.ts`
2. Use `parseJsonBody<T>(c)` for all body parsing (returns 400 on malformed)
3. Filter responses through `canRead` if returning memory data
4. Use `isReadable` for existence checks (timing-safe)
5. Return uniform 404 for "not found OR not authorized"
6. Add corresponding tests in `tests/`
7. If it's a mutation endpoint, log to `memory_log` via `logOp`

## When changing storage format

The vault is human-readable markdown. Any change to frontmatter MUST be:
1. Backward-compatible with existing files in `data/`
2. Documented in `types.ts`
3. Reflected in `scripts/backfill-aliases.ts`-style migration if needed

## What this codebase is NOT

- Not a vector DB. Use ripgrep until grep is proven the bottleneck.
- Not a graph DB. Use Postgres recursive CTEs if traversal becomes essential.
- Not a chatbot. It's infrastructure that chatbots use.
- Not Obsidian. It's compatible with Obsidian for the graph view but doesn't depend on it.

## Useful commands

```bash
# Start server (with permissive rate-limit for dev)
MACHTSINN_RATE_LIMIT_BURST=1000 MACHTSINN_RATE_LIMIT_RPS=10 bun src/index.ts

# Tests
bun test

# Full simulations (must override rate-limit)
MACHTSINN_RATE_LIMIT_BURST=10000 bash scripts/simulate.sh
MACHTSINN_RATE_LIMIT_BURST=10000 bash scripts/simulate-session2.sh

# CLI
bun src/cli.ts find "query" --scope all

# Health check
curl http://localhost:3001/health
```

## Releases

The audit history (v0.3 → v0.4 → v0.5 → v0.6 → v0.7 → v1.0) is documented through commits and the test files themselves. Each version's specific fixes are described in the corresponding `tests/v0X-fixes.test.ts` file.

Don't regress. If you must, write a test that asserts the new behavior so future contributors don't accidentally re-regress.
