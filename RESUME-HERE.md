# Resume Here — Session Continuation Notes

**Last session ended:** 2026-05-15
**Resume context:** mid-v2.6 LLM-extraction rollout
**Current released version:** v2.6.0

## Where things stand right now

mema is at **v2.6.0** with a pluggable LLM extraction framework
(`src/v2/llm-extractor.ts`) supporting Ollama, Anthropic, OpenAI.
**Ollama was just installed** (`brew install ollama`) and **the
`llama3.1:8b` model is downloading in the background** when the previous
session ended.

The previous session shipped:
- v2.3.0: human-readable filenames (`{slug}--{ulid}.md`)
- v2.4.0: PAI memory → mema migration; CLAUDE.md updated to use mema
- v2.5.0: heuristic fact + entity extraction (produced ~30% noise)
- v2.5.1: unfolded YAML wikilinks + wired v1 entity back-links
- v2.6.0: **LLM-extraction framework** to replace the v2.5 noisy heuristics

All 128 tests pass. Audit chain holds at ~2036 entries, valid.
Git is clean, all tags pushed to https://github.com/machtsinnch/mema.

## Resumption — pick up from here

### 1. Confirm Ollama is ready

```bash
# Check service is running
curl -s http://localhost:11434/api/tags

# If models is empty, the pull is still in progress or didn't finish.
# Pull it manually if needed:
ollama pull llama3.1:8b
```

### 2. Optionally purge the v2.5 heuristic noise

The v2.5 heuristic extractor wrote 108 facts + 1125 entities with ~30%
noise. For a clean re-extraction with LLM:

```bash
cd ~/Projects/machtsinn.ai
rm data/facts/ardin/*.md
rm data/v2-entities/ardin/*.md
```

(Or keep them — the LLM extractor dedupes, so it'll only add new clean
facts on top.)

### 3. Run LLM extraction on the corpus

```bash
# Start with --limit 10 to gauge quality on a small sample:
bun scripts/extract-facts-llm.ts --owner ardin --limit 10

# If quality looks good, run on the full corpus:
bun scripts/extract-facts-llm.ts --owner ardin
```

**Verified timing** (smoke-tested at session close on 5 episodes):
**~28 seconds per episode** with `llama3.1:8b` on this machine.
Full corpus of 357 episodes = **~2.5–3 hours**. Plan to run overnight,
or use `--limit 50` for an incremental rollout.

Faster alternatives if you don't want to wait:
- `OLLAMA_MODEL=llama3.2:3b` — ~3× faster, slightly less precise
- `OLLAMA_MODEL=qwen2.5:7b` — similar speed to llama3.1, often better at strict JSON
- `MEMA_EXTRACTOR=anthropic` with `ANTHROPIC_API_KEY` set — fastest, but data leaves the machine

**Smoke-test result at session close** (5 episodes, dry-run): 23 facts + 11 entities extracted, **0 LLM failures**. The framework is working.

### 4. Wire + reindex + verify

```bash
bun scripts/wire-entity-graph.ts
bun scripts/fix-graph-connectivity.ts
curl -X POST http://localhost:3001/v2/vector/reindex -H 'x-api-key: dev-ardin'
bun test tests/
curl -s http://localhost:3001/v2/audit/verify -H 'x-api-key: dev-ardin'
```

Then **Cmd+Q + reopen Obsidian** to verify the new clean facts/entities.

### 5. Validate quality

Open `data/facts/ardin/` in Obsidian; sample 10 facts. Quality target:
**at most 1 in 20 facts is noise** (vs v2.5's ~3 in 10).

If quality is acceptable, ship v2.6.1 with release notes:
"v2.6.0 framework verified on corpus, X facts produced, Y% noise rate."

If quality is still poor:
- Try `qwen2.5:7b` instead (`OLLAMA_MODEL=qwen2.5:7b bun scripts/extract-facts-llm.ts`)
- Or `llama3.1:70b` if your machine has the RAM (~40GB)
- Tighten the prompt in `src/v2/llm-extractor.ts`

## Open items from the previous session

These were noted but deferred:

| Item | Priority | Source |
|---|---|---|
| LLM extraction quality validation on real corpus | P0 | This doc, step 5 |
| Investigate v1 recall 0% benchmark result | P2 | v2.5.1 deviation audit |
| Promote `mentioned_in:` to Entity type definition | P2 | v2.5.1 deviation audit |
| Route `wire/fix` scripts through audit log | P2 | v2.5.1 deviation audit |
| 2-week soak then archive PAI `.md` originals to `memory.legacy/` | scheduled | docs/PAI-MIGRATION.md |
| `scripts/import-tree.ts --v2` so new imports skip v1 detour | P3 | v2.4.0 release notes |
| Writers emit `[[slug--ulid]]` directly (not bare `[[ulid]]`) | P3 | v2.5.0 deviation |

## Architecture invariants — still intact (verified end of last session)

1. Filesystem-as-truth ✓ (every record is a `.md` file)
2. Multi-tenant isolation ✓ (125+ security tests pass)
3. Topology governance ⚠ (v1 N=3 promotion not applied to v2 yet — future work)
4. Three interfaces, one backend ✓ (HTTP / CLI / MCP)
5. MIT licensing ✓
6. No ceremony ✓
7. 3-model adversarial audits ⚠ (last one was v2.1.x; due for another)
8. No vendor lock-in ✓ (Ollama keeps it that way)
9. No LLM on every write ✓ (LLM runs only in offline extraction scripts)

## Where to find context

- **Whitepaper:** `docs/WHITEPAPER.md` (architecture + benchmarks)
- **PAI migration design:** `docs/PAI-MIGRATION.md`
- **Architecture critic findings (3 rounds):** `tests/v2/security-hardening.test.ts`, `security-round2.test.ts`, `security-round3.test.ts`
- **Recall benchmark:** `bench/recall-benchmark-v2.py`
- **Audit chain verify:** `GET /v2/audit/verify` (returns `{valid, entries_checked}`)

## How to use mema in the next session

Per `~/.claude/CLAUDE.md` (v2.4+ section), the next Claude Code session
in this account will:

1. Read this `RESUME-HERE.md` for current-session context
2. Use `POST /v2/recall` for memory recall (instead of reading
   `~/.claude/projects/.../memory/*.md`)
3. Use `POST /v2/cognitive` to record new beliefs/observations

The PAI memory files at `~/.claude/projects/-Users-ardin-Documents-pai/memory/`
are preserved on disk for the 2-week rollback soak.

---

**Next session's first action**: read this file, then check
`curl http://localhost:11434/api/tags` to confirm Ollama is ready, then
follow steps 2–5 above.
