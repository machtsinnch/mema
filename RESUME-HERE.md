# Resume Here

**Latest session:** 2026-05-17 → 2026-05-18 overnight (autonomous; Ardin slept; Codex sparring partner).

**🎯 STATUS:** All v2.14.0 + scripts committed and pushed (5 commits in this overnight: `25942b2` v2.14.0 supersession, `b44d61e` test scripts, plus earlier session commits `720f961`, `c8a09aa`, `074e8b2`, `b4a3054`, `83abbb8`). Real user data ingested for morning qualitative eval. PAI fully disabled (three things newly stopped tonight).

## First 5 minutes when you wake

```bash
cd ~/Projects/machtsinn.ai
git log --oneline origin/main..HEAD                # should be empty — everything pushed
bun test 2>&1 | tail -3                            # 366 pass / 0 fail
curl -s http://localhost:3001/health               # primary mema (running with v2.14.0)
find data/episodes/ardin-v214test -name "*.md" | wc -l   # should be 300 (your data, isolated namespace)
cat /tmp/MORNING-TEST-PROTOCOL.md                  # exact steps for today's qualitative test
cat /tmp/OVERNIGHT-REPORT.md                       # chronological log of what happened overnight
```

## What's new from yesterday's session

### Committed + pushed (origin/main is current)

| Commit | What |
|---|---|
| `720f961` | v2.12.1 — IP audit + integer-answer fix + Sonnet default + exp-jitter backoff |
| `c8a09aa` | v2.13.0 — nomic embedder + preference-aware prompts + time-aware retrieval + temporal-expansion module |
| `074e8b2` | docs(RESUME-HERE) — v2.13.0 status |
| `b4a3054` | v2.13.1 — revert time-aware pass-through (caused -7.4pp memory-packet regression) |
| `83abbb8` | v2.13.2 — variance caveat + determinism-by-default architectural commitment |
| `25942b2` | **v2.14.0 — write-time supersession + hard-omit superseded facts from packet** |
| `b44d61e` | scripts — v214-test-ingest.ts + v214-test-query.ts |

### Bench evidence

| Run | Memory-packet | KU | Notes |
|---|---|---|---|
| v2.12 (hash embedder) | 79.3% (n=29) | 80% | baseline |
| v2.13a (nomic + prompts) | 83.3% (n=30) | 80% | the headline-but-lucky run |
| v2.13b (with time-aware) | 75.9% (n=29) | 60% | time-aware hurt |
| v2.13.1 verify-revert | 73.3% (n=30) | 40% | re-confirms variance |
| **v2.14.0 (supersession)** | **80.0% (n=30)** | **60%** | in noise band; supersession works but undetectable at n=5/cat |

**Honest read of memory-packet at n=30**: ~78% ± 5pp. The "+4.0pp" claim in any of these is variance, not signal. The single solid lift in this whole arc is **single-session-preference jumping 20% → 80% across all runs** (Codex's prompt-fix diagnosis was right). Write-time supersession will be properly measured on MemoryAgentBench/FactConsolidation where it's the scoring criterion.

### What landed code-wise

- **v2.14.0 write-time supersession** — `src/v2/layer4-supersession.ts` (new, ~120 LOC, pure `classifyOnWrite` function), `recordFactWithSupersession` wrapper in `layer2-semantic.ts`, `/v2/fact` endpoint switched to it, `compilePacketToPrompt` hard-omits superseded from `<FACTS>` (per Codex's spec — LLMs ignore `isSuperseded` markers, hard-omit is the fix). 11 new tests in `tests/v2/supersession.test.ts`. 3 existing memory-packet tests updated.
- **v2.14test scripts** — `scripts/v214-test-ingest.ts` (300 source files in 0.3s with `--skip-extract`) and `scripts/v214-test-query.ts` (interactive REPL for your morning eval).
- **MemoryAgentBench adapter** — at `/tmp/MemoryAgentBench/methods/mema/` (zero-dep Python; not in repo). Ready to plug into the bench's `agent.py` for the FactConsolidation flagship run.

### Tests

**366 pass / 0 fail** (up from 325 → 358 → 366 across session). Net +41 new tests this overnight.

## Real user data is ingested + waiting for your eval

Your `~/Documents/pai/{finance-plan,machtsinn}` source files have been ingested as **300 episodes under owner `ardin-v214test`** (isolated namespace; your production `ardin` data is untouched). Nomic embeddings, no fact extraction (the extractor had a zombie-process bug last night — root cause identified, fix deferred).

Run `bun scripts/v214-test-query.ts --owner ardin-v214test` to query interactively. See `/tmp/MORNING-TEST-PROTOCOL.md` for the test plan, suggested questions, and what to evaluate.

## PAI status

**Fully disabled. Three things newly stopped overnight:**
- `com.pai.voice-server` launchd agent — unloaded + plist renamed `.pai-disabled-20260518`
- `~/.claude/hooks/` directory (25 PAI `.hook.ts` files on disk) — renamed `.pai-disabled-20260518`
- Stale `claude`/`bun` processes from earlier extraction attempts — killed

Still cleanly disabled (re-verified):
- `~/.claude/CLAUDE.md` (renamed `.pai-disabled-20260517` earlier)
- `settings.json` hooks → only mema lifecycle (`start.sh`/`stop.sh`)
- `.zshrc` PAI alias commented out

Still on disk but inert (no hooks point at them): `~/.claude/PAI/`, `PAI-Install/`, `MEMORY/`, `VoiceServer/`. Safe to delete later if you want cosmetic cleanup.

## Known issues to clean up when convenient

1. **`bench/bench-utils.ts callClaudeCLI` watchdog leak** — the timer kills the proc but doesn't reliably reap zombie child processes. The 18-min "hang" we saw was a stale `claude` PID 14798 from an earlier extraction call. One-hour fix: ensure `proc.kill()` is followed by an awaited `proc.exited` with hard timeout, then drop a follow-up `kill -9` if still alive. Add a regression test.

2. **scripts/start.sh** doesn't set the test-mode env vars (MEMA_BENCH_ALLOW_OWNER_OVERRIDE etc.) — that's correct for production safety, but means when SessionStart fires and the port is free, mema restarts in production mode. For your overnight ingestion to keep working, the manual `nohup env VARS bun src/index.ts` incantation in `/tmp/MORNING-TEST-PROTOCOL.md` is what to use.

3. **memory-packet knowledge-update at 60% in v2.14.0** — same as v2.13b. Supersession likely fires but n=5/category can't measure it. Will be the actual test on MemoryAgentBench/FactConsolidation when we plug the adapter in.

## Three open items waiting for your call (tomorrow's decisions)

1. **MemoryAgentBench integration kickoff** — adapter is ready at `/tmp/MemoryAgentBench/methods/mema/`. Plug into their `agent.py`, run on FactConsolidation specifically (current SOTA HippoRAG-v2 29.5%; mema target 50%+). Time: 3-5 hours setup + LLM-judge run.

2. **v2.14.1 `/v2/observe` extraction-mandatory implementation** — design doc at `/tmp/v2.14.1-observe-extraction-mandatory-DESIGN.md`. Codex-quality spec. 6-10 hours to implement + test. Required for the "determinism principle" architectural commitment.

3. **First Jungbunzlauer discovery meeting prep** — you have warm intros to Head of IT + Head of Data. The "land narrow on one workflow" play needs a 30-min discovery call. Could draft questions + collateral.

## Files you should look at in priority order

1. `/tmp/MORNING-TEST-PROTOCOL.md` — RUN THIS FIRST (the qualitative test on your real data)
2. `/tmp/OVERNIGHT-REPORT.md` — chronological story of what happened while you slept
3. `/tmp/v2.13-strategy.md` — strategic plan with Codex's audited corrections
4. `/tmp/memory-systems-landscape.md` — full 2026 competitive map with sources
5. `/tmp/memoryagentbench-integration-plan.md` — the flagship-bench plan
6. `/tmp/v2.14.1-observe-extraction-mandatory-DESIGN.md` — next implementation spec
7. `/tmp/mema_bench_spec.md` — NeurIPS-grade hallucination/abstention benchmark spec (Codex gpt-5.5)
8. `/tmp/v2.14.x-summary.md` — concise commit-by-commit log of the v2.14 cycle
