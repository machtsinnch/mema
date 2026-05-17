# Resume Here — Session Continuation Notes

**Last session ended:** 2026-05-18 (overnight)
**Resume context:** v2.11 Memory Compiler complete + **3-mode N=30 bench running** (right-sized down from original 5-mode N=100 plan after first run showed 30+ h wall time)
**Current released version:** v2.10.0 (tag) — `main` has 6 new commits for v2.11.0-rc.1
**Commits NOT pushed** (per your "no push" authorization). Push when satisfied with overnight bench results.

## ⚠️ Bench scope reduced — read this first

The original plan was 5 modes × N=100 (~6h estimate). First run showed actual rate is ~2 min/q for episode-only (no extract) and projected ~4-5 min/q for extract-enabled modes. Full 5×100 would've been **30+ hours** — far past your wake. **Triage call made at 02:00 PT:** kill that run, restart with **3 most informative modes at N=30** (fits in ~5h):

- ✅ **episode-only** — baseline (the 83.0% reference)
- ✅ **memory-packet** — headline v2.11 (does mema's architecture earn its keep?)
- ✅ **zep-format** — control (do mema's extensions beat Zep's bare format?)
- ⏭️ **flat-mixed** — SKIPPED (v2.10.6 already showed regression to 75% with this design; re-confirmation not load-bearing)
- ⏭️ **routed-packet** — SKIPPED (it's memory-packet + routing — defer to a follow-up session that re-runs ALL 5 at N=100 with a quieter Claude CLI)

**N=30 caveat:** 30 questions balanced = ~5 per category. Decent directional signal but high variance per category. Decision-rule verdicts (memory-packet vs episode-only, memory-packet vs zep-format) are **directionally meaningful at N=30, not statistically definitive**. A full N=100 follow-up is your next bench task.

---

## TL;DR — what to do FIRST

```bash
cd ~/Projects/machtsinn.ai

# 1. Check bench completion
tail -1 /tmp/bench_v211_3mode.log
# Expected when done: "ALL_MODES_COMPLETE"

# 2. View 3-mode comparison (only 3 modes ran; flat-mixed + routed-packet are missing)
bun bench/compare-context-modes.ts

# 3. View commits ready for push
git log --oneline origin/main..HEAD

# 4. Verify tests still green
bun test 2>&1 | tail -3
```

The comparison tool reads `/tmp/bench_v211_5mode_*.jsonl` and tolerates the missing modes (prints `(missing)`). The 3 completed modes give the headline answer.

If the comparison shows **memory-packet ≥ episode-only on hard categories AND memory-packet ≥ zep-format overall**, the architecture is directionally earning its keep (validate with a full N=100 follow-up before claiming externally).

If memory-packet regresses vs episode-only at N=30, the result is suggestive but not definitive (small N). Re-run at N=100 before acting. If the regression also holds at N=100, the next iteration should focus on extraction quality (Mem0-style — see `COMPETITOR-PROMPT-INTEL.md` §2 for the verbatim Mem0 extractor prompt) or wiring the routing classifier (v2.12).

---

## What landed this session — 5 commits on `main`

```bash
git log --oneline origin/main..HEAD
```

| # | SHA | What |
|---|---|---|
| 1 | feat(v2.11) | RetrievalHit.payload + bench sectioned packet (iter-1 base) |
| 2 | feat(v2.11) | MemoryPacket compiler (XML format + Datalog-style rules) |
| 3 | feat(v2.11) | POST /v2/recall/packet two-channel retrieval endpoint |
| 4 | feat(v2.11) | bench --context-mode {5 modes} |
| 5 | feat(bench) | compare-context-modes.ts consolidation tool |

**266 tests pass / 0 fail.** Mema healthy on :3001 serving v2.11.0-rc.1.

---

## Files touched (chronological)

```
src/v2/types.ts                          (iter-1 — RetrievalHit.payload + RetrievalHitPayload)
src/v2/layer5-retrieval.ts               (iter-1 — populate payload per kind)
src/v2/api.ts                             (iter-1 — entity in kinds; iter-3 — /v2/recall/packet)
bench/longmemeval-harness.ts             (iter-1 + iter-3 — sectioned packet, then 5-mode dispatch)
tests/v2/recall-payload.test.ts           (iter-1 — 5 tests for payload)
package.json                              (iter-1 — 2.10.0 → 2.11.0-rc.1)
CHANGELOG.md                              (iter-1 — v2.11.0-rc.1 entry)
src/v2/memory-packet.ts                   (iter-2/3 — typed Memory Compiler + XML renderer + Zep-format renderer + Datalog-style rule predicates)
tests/v2/memory-packet.test.ts            (iter-3 — 28 tests: predicates + builder + 2 renderers + classifier)
tests/v2/recall-packet.test.ts            (iter-3 — 2 tests: two-channel contract + no-displacement)
bench/compare-context-modes.ts            (iter-3 — 5-mode JSONL consolidation tool)
COMPETITOR-PROMPT-INTEL.md                (iter-3 — verbatim Zep/Mem0/Letta/Graphiti/LangMem prompt intel + revised v2.11 spec)
RESUME-HERE.md                            (this file)
```

---

## Strategic beliefs saved to mema this session

| ID | Belief |
|---|---|
| `01KRSFEGW0XC6AQRRW7MPKDKPF` | Memory intelligence foundation; Swiss trust cherry on top |
| `01KRSG32JK4W1ZCJY4WGZPXWXM` | PAI rule: verbatim prompt-level competitor intel BEFORE building anything competing with leaders |
| `01KRSG7E0NFG6P3S9DDP7GMHAT` | Session experience record (early iteration-3 snapshot — superseded by overnight work) |
| `01KRSGB7PVCHCWFNPGRKWQKMK0` | Prolog/Datalog as symbolic reasoning layer (Geistesblitz) |
| `01KRSGH9208NZ2XFKXZNSVSBE8` | Implementation-stack ranking: typed TS Memory Compiler (10/10) → Datalog/SQL CTEs (8/7) → SHACL validation (7) → Prolog/SMT (defer) |

---

## The 5 context modes implemented

| Mode | Retrieval | Format | Purpose |
|---|---|---|---|
| `episode-only` | single `/v2/recall` kinds=episode | chronological raw episodes | Baseline (v2.10.5 83.0%) |
| `flat-mixed` | single `/v2/recall` kinds=all | markdown sections | Iter-1 "bad architecture" reference |
| `memory-packet` | `/v2/recall/packet` (two-channel) | XML + inline hints + mema extensions (CURRENT_STATE, CONFLICTS, UNCERTAINTY, INSTRUCTIONS) | Headline v2.11 |
| `routed-packet` | `/v2/recall/packet` + classifier | memory-packet renderer + question_type routing | Per-category specialization |
| `zep-format` | `/v2/recall/packet` | Zep's exact format (FACTS / ENTITIES / EPISODES, no extensions) | Control — validates whether mema's extensions add value beyond Zep's baseline |

---

## Decision rule for v2.11 (per expert review)

After viewing `bun bench/compare-context-modes.ts`:

- ✅ **memory-packet ≥ episode-only on hard categories** (knowledge-update, temporal-reasoning, multi-session, preference) → architecture earns its keep
- ✅ **routed-packet ≥ episode-only overall** → routing adds value
- ✅ **memory-packet ≥ zep-format overall** → mema's CURRENT_STATE / CONFLICTS / UNCERTAINTY / INSTRUCTIONS extensions earn keep

If all three pass: tag `v2.11.0-rc.1`, push, defensible "competes with Zep/Hindsight on memory intelligence" claim. Then v2.11.0 GA after a soak period.

If memory-packet regresses vs episode-only: do NOT pivot to trust-only. Per expert: fix extraction (Mem0-style discipline — see COMPETITOR-PROMPT-INTEL.md §2), relation-level evidence gate (v2.13), preference synthesis. The decision rule is binding.

If memory-packet ≥ episode-only but ≤ zep-format: simplify to Zep's format, drop our extensions. Keep CURRENT_STATE only if it materially helps temporal-reasoning category.

---

## Architecture stack to build next (per overnight expert challenge)

```
Raw memory store      (mema today)
       ↓
Memory validators     (v2.12 — MemoryValidator.ts module)
       ↓
Rule layer            (TS predicates in v2.11; Datalog in v2.13 if needed)
       ↓
Memory packet         (v2.11 — DONE TONIGHT)
       ↓
LLM reader            (Claude/Codex/GPT — DONE)
```

**v2.11** (this session): typed Memory Compiler + rule predicates + two-channel retrieval + 4-mode benchmark
**v2.12** (next): MemoryValidator module (catch bad facts at write time); SQL recursive CTEs for derived_from / superseded_by chains
**v2.13** (later): LLM-based answer-strategy classifier; relation-level evidence gate (Mem0-style extraction discipline)
**v2.14** (later): streaming memory benchmark (mema gets better over time — the thesis test snapshot benchmarks can't run)

---

## Quick state checks

```bash
cd ~/Projects/machtsinn.ai

git log --oneline origin/main..HEAD     # 5 commits ready for push
git status -sb                           # should be clean
bun test 2>&1 | tail -3                  # 266 pass / 0 fail
curl -s http://localhost:3001/health     # {"ok":true,"version":"2.11.0-rc.1"}
bun bench/compare-context-modes.ts       # the bench results
tail -3 /tmp/bench_v211_5mode.log        # last bench log line
```

---

## If bench is still running when you wake

```bash
# Are the harnesses alive?
ps -ef | grep "bun bench/longmemeval-harness" | grep -v grep

# Which mode is currently running?
grep "^=== START\|^=== DONE\|^ALL_MODES_COMPLETE" /tmp/bench_v211_5mode.log

# Lines per mode JSONL (each line = one question completed)
for MODE in episode-only flat-mixed memory-packet routed-packet zep-format; do
  echo -n "$MODE: "; wc -l < /tmp/bench_v211_5mode_${MODE}.jsonl 2>/dev/null || echo "not started"
done
```

If a mode is stuck (no progress in 30+ min), the Claude CLI may have hit a rate limit. Restart that mode individually with the command pattern in `/tmp/bench_v211_5mode.log` (search for the most recent `=== START`).

---

## If bench failed midway

The comparison tool tolerates missing modes (prints `(missing)` for any without a JSONL). You can re-run any single mode:

```bash
cd ~/Projects/machtsinn.ai
MODE=memory-packet  # or whichever failed
EXTRA=""
if [ "$MODE" != "episode-only" ]; then
  EXTRA="--extract --extractor-backend claude --kinds episode,fact,cognitive,entity"
fi
bun bench/longmemeval-harness.ts \
  --data /tmp/longmemeval/data/longmemeval_oracle.json \
  --api http://localhost:3002 --key bench-key \
  --owner lme_v211_5mode_${MODE}_$(date +%s) \
  --limit 100 --balanced \
  --context-mode $MODE \
  $EXTRA \
  --judge llm --answer-backend claude --judge-backend codex \
  --top-k 10 \
  --save-results /tmp/bench_v211_5mode_${MODE}.jsonl
```

Bench mema is running on :3002 (vault at `/tmp/mema_bench`). If it's not up:
```bash
kill $(lsof -ti:3002 2>/dev/null); sleep 2; rm -rf /tmp/mema_bench && mkdir -p /tmp/mema_bench
VAULT_ROOT=/tmp/mema_bench PORT=3002 MACHTSINN_KEYS="bench-key:lmebench" \
  MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true \
  MACHTSINN_RATE_LIMIT_BURST=1000000 MACHTSINN_RATE_LIMIT_RPS=100000 \
  bun src/index.ts > /tmp/mema_bench.log 2>&1 &
```

---

**Bottom line for the morning:** check `bun bench/compare-context-modes.ts` first. The verdict on the architecture is in that table.
