# Resume Here — Session Continuation Notes

**Last session ended:** 2026-05-18 (late morning / early afternoon PT)
**Resume context:** v2.11.0-rc.1 bench done + diagnosed extractor-temporal-grounding bug + v2.11.1 hotfix landed + verified on 5 knowledge-update questions (40% → 80%)
**Current released version:** v2.10.0 (tag) — `main` has 10 new commits for v2.11.0-rc.1 + v2.11.1 fix
**Commits NOT pushed** (per your "no push" authorization). Push when satisfied.

## ⚠️ Two-part v2.11.1 fix — both must apply before N=100 re-bench

### Part 1: Extractor temporal grounding (already landed)
Extractor now passes observation_date + extracts event_date per fact. Re-verified on the 5 failing knowledge-update questions: 40% → 80%.

### Part 2: Judge retry + cross-judge rejudge (NEW)
Diagnosed the temporal-reasoning -20pp regression. Root cause: the SAME judge-no-response bug that caused 1 of the 5 knowledge-update failures was responsible. 9/90 questions (10%) across the N=30 run got `judge-no-response` from Codex CLI silently → all scored 0.

**Cross-judged with Claude + Codex (parallel) + substring fallback. Of 9 failures:**
- 5 actually CORRECT (judge bug masked real wins)
- 2 actually INCORRECT
- 2 DISPUTED → resolved to INCORRECT

**Corrected per-category memory-packet vs episode-only (N=30):**
- temporal-reasoning: +0.0pp ✅ (was -20pp — entirely judge bug)
- multi-session: +20.0pp ✅ (real win)
- knowledge-update: -40.0pp ⚠️ (pre-v2.11.1 extractor bug — fixed)
- 3 single-session categories: 0.0pp (tied)

**Harness now has judgeWithRetry: 3 retries on primary judge → 2 on secondary fallback. ScoredQuestion.judge_score type is now `number | null | undefined` so judge failures are visible in JSONL (not silently coerced to 0).**

To view corrected metrics:
```bash
cd ~/Projects/machtsinn.ai
bun bench/compare-context-modes.ts --rejudge /tmp/rejudge_v211_5mode.jsonl
```

## ⚠️ The v2.11.1 fix DOES NOT yet validate the architecture at scale

The v2.11.1 fix took knowledge-update memory-packet from 40% → 80% on the SAME 5 questions that failed in the v2.11.0-rc.1 N=30 run. This is a clean diagnostic win — it proves the fix removes the specific bug. **It is NOT yet a generalization claim** because:

1. **N=5 ≠ N=78**: knowledge-update has 78 questions in the LongMemEval oracle set; we re-verified on the 5 that the N=30 run sampled. Those 5 were the failure-set, so the +40pp is "the fix removes the regression on the previously-broken cases" — not "the architecture beats episode-only on a fresh holdout".
2. **Other categories not re-bench'd**: temporal-reasoning regressed -20pp in the N=30 run; we haven't re-tested it.
3. **`routed-packet` not re-bench'd**: the expert decision rule required routed-packet to beat episode-only overall, not just memory-packet on one category.

**To make the architecture claim defensibly:** run a full N=100 5-mode bench with v2.11.1. That's ~9h wall time. Documented as the next session's first task below.

## ⚠️ Bench scope reduced — read this first

The original plan was 5 modes × N=100 (~6h estimate). First run showed actual rate is ~2 min/q for episode-only (no extract) and projected ~4-5 min/q for extract-enabled modes. Full 5×100 would've been **30+ hours** — far past your wake. **Triage call made at 02:00 PT:** kill that run, restart with **3 most informative modes at N=30** (fits in ~5h):

- ✅ **episode-only** — baseline (the 83.0% reference)
- ✅ **memory-packet** — headline v2.11 (does mema's architecture earn its keep?)
- ✅ **zep-format** — control (do mema's extensions beat Zep's bare format?)
- ⏭️ **flat-mixed** — SKIPPED (v2.10.6 already showed regression to 75% with this design; re-confirmation not load-bearing)
- ⏭️ **routed-packet** — SKIPPED (it's memory-packet + routing — defer to a follow-up session that re-runs ALL 5 at N=100 with a quieter Claude CLI)

**N=30 caveat:** 30 questions balanced = ~5 per category. Decent directional signal but high variance per category. Decision-rule verdicts (memory-packet vs episode-only, memory-packet vs zep-format) are **directionally meaningful at N=30, not statistically definitive**. A full N=100 follow-up is your next bench task.

---

## Next-session priorities (in order)

1. **Full N=100 5-mode re-bench with v2.11.1.** ~9h wall time. This is the test that turns the 5-question diagnostic win into a defensible architecture claim. Use the comparison tool to land a verdict against the expert decision rule.

2. **If the verdict is positive:** push the 10 commits, tag v2.11.0-rc.1, decide on GA timeline.

3. **If the verdict shows the v2.11.0-rc.1 regression is fixed AND memory-packet beats episode-only on hard categories AND routed-packet beats episode-only overall:** that's the full validation. Move to v2.12 work (LLM answer-strategy classifier; MemoryValidator module).

4. **If the verdict shows memory-packet still regresses somewhere:** investigate WITHOUT pivoting (per Ardin's standing rule — memory intelligence is the foundation). Likely follow-ups: Mem0-style extraction discipline (port more of their prompt rules from `COMPETITOR-PROMPT-INTEL.md` §2), the INSTRUCTIONS softening's hallucination risk (see "Known caveats" below), per-question prompt audit on failures.

## Known caveats from the critic review of v2.11.1

- **INSTRUCTIONS softening on retrieval-miss questions.** When `packet.uncertainty` is empty, the new INSTRUCTIONS line is "Do not refuse to answer when the evidence actually contains the answer". On questions where retrieval MISSED the gold session, `uncertainty` will (correctly) be empty AND the answer won't actually be in the packet — the new line could push the LLM toward confabulation. The N=30 run had perfect retrieval on the 5 failed questions, so this risk wasn't visible. **The full N=100 re-run should track wrong-answer% separately from no-answer% to surface this if it's real.**

- **`isCurrent` rule is symmetric**: a fact dated AFTER question_date is treated the same as a fact dated BEFORE question_date if it's invalidated. The current logic is "valid_from ≤ question_date AND no invalidated_at". For knowledge-update this is correct; for temporal-reasoning questions that ask about future plans, this may be too strict. Watch for temporal-reasoning regressions in the full bench.

- **Tertiary fallback in extract-loop now THROWS** on missing observation_date instead of silently using today (per critic). If any LongMemEval record has both `haystack_dates[i]` and `question_date` empty, the run will fail loudly. Inspect `rec.question_id` from the error and skip those records explicitly if it becomes a problem (none observed in the N=30 run).

- **Ollama extractor backend warns loudly** if used; don't compare an Ollama run's numbers against a Claude run's numbers — they're not apples-to-apples.

## TL;DR — what to do FIRST

```bash
cd ~/Projects/machtsinn.ai

# 1. Check bench completion
tail -1 /tmp/bench_v211_3mode.log
# Expected when done: "ALL_MODES_COMPLETE"
# If memory-packet still running, see "partial results" section below.

# 2. View whichever modes completed
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

## EPISODE-ONLY N=30 FIRST RESULT (already in)

Episode-only completed at 05:21 PT. Initial number:
- **Hit@1/5/10 = 100% / 100% / 100%** (retrieval rock solid)
- **Answer-correct overall: 60.0%** (n=30)
- Per category: knowledge-update 80% / multi-session 40% / single-session-{assistant=60%, preference=40%, user=60%}
- Note: no temporal-reasoning category in this N=30 balanced — sampling chose 5 other categories. (Ardin: confirm whether to weight that into interpretation.)

**Why 60% vs the v2.10.5 baseline of 83%?** Likely a combination of:
1. N=30 = ~5/category sample variance
2. Different category mix (no temporal-reasoning in this sample; that was the highest-scoring category in v2.10.5 at 94.1%)
3. Answer-LLM behavior may have shifted slightly between runs

The **within-N=30 apples-to-apples** comparison (memory-packet vs THIS 60%, not vs historical 83%) is what matters for the v2.11 verdict.

## Partial results — viewing memory-packet mid-run

Memory-packet rate is ~15 min/q (with --extract: ~6 sessions × Claude CLI extractor + answer + judge). At N=30, finishes ~12:51 PT — likely PAST your wake time.

To see partial progress before it completes:
```bash
# Per-question Hit@K from the log
grep "^  \[" /tmp/bench_v211_3mode.log | grep -A0 "memory-packet" -B100 2>/dev/null | tail -20

# Count of questions completed in current mode
grep -A1000 "=== START memory-packet" /tmp/bench_v211_3mode.log | grep -c "^  \["

# Answer-correct count from log (per-question judge output is NOT in log;
# only Hit@K. The Answer% only appears after mode completes and the
# Overall: line is printed.)
```

If memory-packet hasn't finished by the time you read this:
1. Decide whether to **wait** (~2-3h more) or **kill+restart at smaller N** (lose progress but get a verdict sooner).
2. Zep-format won't have started yet. You'll need to choose: run it (~2-4h more wall time) or defer.

If memory-packet HAS finished but zep-format hasn't started, manually launch zep-format:
```bash
cd ~/Projects/machtsinn.ai
bun bench/longmemeval-harness.ts \
  --data /tmp/longmemeval/data/longmemeval_oracle.json \
  --api http://localhost:3002 --key bench-key \
  --owner lme_v211_zep_$(date +%s) \
  --limit 30 --balanced \
  --context-mode zep-format \
  --extract --extractor-backend claude --kinds episode,fact,cognitive,entity \
  --judge llm --answer-backend claude --judge-backend codex \
  --top-k 10 \
  --save-results /tmp/bench_v211_5mode_zep-format.jsonl
```

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
