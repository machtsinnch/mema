# Resume Here — Session Continuation Notes

**Last session ended:** 2026-05-17
**Resume context:** post-architecture-ablation, honest results landed
**Current released version:** v2.10.0 (tag) + 6 unreleased commits on `main`

---

## TL;DR of what shipped this session

- **v2.7.0 → v2.10.0** all released, tagged, pushed to `github.com/machtsinnch/mema`
- License pivot: **MIT → BUSL-1.1** (Change Date 2030-05-15 → Apache 2.0)
  - v2.0.0–v2.8.0 stay MIT-licensed at their tags
  - Principle #5 in mema cognitive store superseded (`01KRPTG7NNMCDXG4NA7M8DXPP9`)
- All ~10 priorities from the 2-3 external review rounds shipped (P1–P8, W4, W8, NEW: contradiction, reflectLLM, entity resolution, RRF, cognitive approval, ablation modes, LongMemEval+LoCoMo+Swiss Trust harnesses, claude/codex backends, gold-coverage metrics, etc.)
- **231/231 tests passing.** Swiss Trust Bench: **9/9 scenarios passing**.
- First defensible LongMemEval result: **83.0% on N=100 balanced** (baseline, episode-only retrieval, Claude Opus answer, Codex judge)

---

## Honest standing on the "competes with Zep/Hindsight" claim

| Claim | Status | Evidence |
|---|---|---|
| Retrieval is competitive | ✅ defensible | 100% Hit@5 on N=100 LongMemEval, AllGold@10 = 100% |
| Answer-correct competitive | ✅ defensible | **83.0%** beats Zep (71.2%), matches Hindsight 20B (83.6%) |
| Architecture (facts/cognitive) earns its keep | ❌ NOT yet defensible | Ablation regressed -8pp (75.0%) — see "why" below |
| Swiss-trust differentiator | ✅ rock solid | 9/9 Swiss Trust Bench, hash-chained audit, hard erasure with provenance, strict policy mode |
| "Gets better over time" thesis | ❌ NOT yet tested | No streaming benchmark exists; LongMemEval is snapshot-shaped |

---

## The five concrete things mema does poorly today (Ardin's plain-English summary, 2026-05-17)

1. **Smart memory layers (facts/cognitive) hurt accuracy, not help.** Plain mema = 83%. With architecture ON = 75%. -8pp regression on LongMemEval.
2. **Mixed-up context confuses the answer LLM.** mema dumps raw conversations AND extracted facts AND beliefs into one blob; Claude can't reconcile "transcript says maybe X" with "Fact: definitely X."
3. **"Improves over time" pitch is completely unproven.** Every test gives mema 3 sessions, asks a question 5s later, throws the vault away. mema never accumulates.
4. **Preference questions weak.** mema stores raw observations ("I avoid crowds") instead of synthesizing durable preferences ("user prefers quiet local restaurants").
5. **Extraction noise.** Even Claude as extractor produces some wrong facts; some slip past the gate and pollute future retrievals.

Where mema does NOT fail (balance): retrieval rock-solid, Swiss-trust scenarios all pass, no crashes, no regressions in unit tests.

---

## The harness bug we discovered in this session (CRITICAL context for next work)

When the LongMemEval harness retrieves with `--kinds episode,fact,cognitive`, mema correctly returns top-K hits across all three. But the harness then maps hit IDs → haystack session IDs via `idToSession` — which only has `episode_id → session_id` mappings. **Fact and cognitive hit IDs return `undefined` and silently get DROPPED from the context packet.**

So the v2.10.6 "architecture ablation" wasn't actually testing what we thought:
- The retrieval pool got contaminated by facts/cognitive (displaced some gold episodes from top-K)
- But Claude only saw episode session text — never any fact or cognitive content
- The -8pp regression was from EPISODE DISPLACEMENT, not from facts confusing the model

**Until the harness actually formats fact/cognitive content into the context packet, no "architecture ablation" claim is honest.**

---

## What's queued for the next session (in priority order)

### P1 — Make the architecture ablation actually valid

The next session must build proper memory-packet construction in the harness:

```typescript
// in bench/longmemeval-harness.ts, after retrieving with --kinds
// episode,fact,cognitive (and entity, see P2 below):

const ctxParts: string[] = [];

// Section 1: Approved facts (sorted by valid_from)
if (factHits.length > 0) {
  ctxParts.push("# APPROVED FACTS (sorted by validity)");
  for (const f of factHits) {
    ctxParts.push(`- [${f.valid_from.slice(0, 10)}] ${f.subject} ${f.predicate} ${f.object}` +
                  (f.invalidated_at ? `  (invalidated ${f.invalidated_at.slice(0, 10)})` : ""));
  }
}

// Section 2: Cognitive beliefs
if (cognitiveHits.length > 0) {
  ctxParts.push("\n# COGNITIVE BELIEFS");
  for (const c of cognitiveHits) ctxParts.push(`- ${c.content}`);
}

// Section 3: Entities (NEW — Ardin caught that we were missing this)
if (entityHits.length > 0) {
  ctxParts.push("\n# ENTITIES");
  for (const e of entityHits) ctxParts.push(`- ${e.name} (${e.type})` +
                                            (e.aliases?.length ? `, aliases: ${e.aliases.join(", ")}` : ""));
}

// Section 4: Evidence timeline (chronological raw sessions)
ctxParts.push("\n# EVIDENCE TIMELINE");
// ... existing session-content loop
```

The above CHANGES the API surface of the harness's recall call — it needs to return fact/entity/cognitive payloads, not just IDs. The harness currently throws those payloads away. Fix in `bench/longmemeval-harness.ts` around the "for each [sid, eid] of sessionToEpisode" block.

### P2 — Add `entity` to `--kinds` in the ablation runs

Ardin caught this: we've been ablating `episode,fact,cognitive` but NOT `entity`. v2-entities are first-class retrieval candidates as of v2.9.0 but the LongMemEval harness never asked recall to return them. Trivial 30-second change.

### P3 — Then re-run ablation properly

```bash
# After P1 + P2 are in:
kill $(lsof -ti:3002 2>/dev/null) 2>/dev/null; sleep 2; rm -rf /tmp/mema_bench && mkdir /tmp/mema_bench
cd ~/Projects/machtsinn.ai
VAULT_ROOT=/tmp/mema_bench PORT=3002 MACHTSINN_KEYS="bench-key:lmebench" \
  MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true \
  MACHTSINN_RATE_LIMIT_BURST=1000000 MACHTSINN_RATE_LIMIT_RPS=100000 \
  bun src/index.ts > /tmp/mema_bench.log 2>&1 &
sleep 4
bun bench/longmemeval-harness.ts \
  --data /tmp/longmemeval/data/longmemeval_oracle.json \
  --api http://localhost:3002 --key bench-key \
  --owner lme_v211_ablation_proper --limit 100 --balanced \
  --extract --extractor-backend claude \
  --kinds episode,fact,cognitive,entity \
  --judge llm --answer-backend claude --judge-backend codex \
  --top-k 10 --save-results /tmp/lme_v211_ablation.jsonl
```

Compare against the v2.10.5 baseline (83.0%). If the architecture lifts past 83% with PROPER memory-packet integration, the "competes with Zep/Hindsight" claim becomes defensible. If still flat/regressed, mema's value is governance/audit, not memory intelligence.

### P4 — Decide between Path A vs Path B (Ardin to choose)

- **Path A (snapshot benchmark):** Keep chasing LongMemEval/Zep/Hindsight numbers. Build memory-packet, evidence-span retrieval (root cause #2), temporal-state resolution packet (root cause #6). Aim for 87-92% (oracle ceiling).
- **Path B (streaming benchmark):** Build a NEW benchmark that tests mema's actual thesis ("structures unstructured data over time"). Long-horizon ingestion + queries at multiple T's. This is the test that would prove the architecture's value the way the marketing describes it.

### Deferred but queued tasks

- `v2.10.3` — Re-run on original (pre-cleaning) LongMemEval dataset for apples-to-apples vs Zep paper
- `v2.10.4` — GPT-4 judge run (matches Zep's judge methodology exactly)
- LoCoMo harness `bench/locomo-harness.ts` is a skeleton; need to download the LoCoMo dataset and run it
- Swiss Trust Bench has 9 scenarios passing; could expand to 15-20 for fuller coverage

---

## How to resume

1. **Read this file first.**
2. **Read mema's `current state` cognitive records:**
```bash
curl -s -X POST http://localhost:3001/v2/recall \
  -H 'Content-Type: application/json' -H 'x-api-key: dev-ardin' \
  -d '{"query":"v2.10.6 architecture ablation regression honest","purpose":"session-resume","kinds":["cognitive"],"limit":5}'
```
The key experience records:
- `01KRRGQQ67SSZ4Q8ZTK15DHXT4` — v2.10.5 baseline (83.0%)
- `01KRSD8P2TWW4Q2BTFE0NTKBPV` — v2.10.6 ablation regression (-8pp, with diagnosis)
- `01KRPC6BGCQ4RH9TCDA90HC1KC` — colleague review parent (all P1-P8 + W weakness derivations)
- `01KRPTG7NNMCDXG4NA7M8DXPP9` — BSL license pivot supersedes principle #5

3. **Verify state:**
```bash
cd ~/Projects/machtsinn.ai
git log --oneline -10        # see recent commits
git status -sb                # should be: ## main...origin/main (clean)
bun test 2>&1 | tail -3       # should be 231 pass / 0 fail
curl -s http://localhost:3001/health  # primary mema should return {"version":"2.10.0"}
```

4. **The benchmark dataset is at `/tmp/longmemeval/data/longmemeval_oracle.json` (15MB).** If `/tmp` was wiped, re-download:
```bash
mkdir -p /tmp/longmemeval/data
curl -L -o /tmp/longmemeval/data/longmemeval_oracle.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json"
```

5. **Last logs (for forensics if needed):**
- `/tmp/lme_v210_5_baseline.log` — v2.10.5 baseline (83.0%)
- `/tmp/lme_v210_6_ablation.log` — v2.10.6 ablation (75.0%)
- `/tmp/lme_v210_6_ablation.jsonl` — per-question dump for error audit
- `/tmp/replay/` — empirical multi-session replay outputs

6. **Then start with P1 above** (memory-packet integration).

---

## Commits pushed this session (chronological)

```
0df6ea7 fix(bench): 4 high-leverage prompt+metric fixes per third-party diagnostic
a6f1d23 feat(bench): --save-results JSONL + 7-class error auditor
28cb7b0 feat(bench): --extractor-backend ollama|claude|codex for the ablation
```

Plus earlier in the session: v2.7.0, v2.8.0, v2.9.0, v2.10.0 releases (tagged), BSL license pivot, ~50 commits in total.

---

## Critical files touched

- `bench/longmemeval-harness.ts` — heavy iteration, current state has the 4 diagnostic fixes + claude/codex extractor backends + JSONL dump
- `bench/lme-error-audit.ts` — NEW (7-class failure auditor)
- `bench/locomo-harness.ts` — NEW skeleton (LoCoMo QA)
- `bench/swiss-trust-bench.ts` — NEW (9 scenarios, all passing)
- `src/v2/atomic.ts` — atomic-write helper (v2.8.0)
- `src/v2/temporal.ts` — epoch-ms temporal compare (v2.8.0)
- `src/v2/layer5-rrf.ts` — RRF fusion (v2.10.0)
- `src/v2/llm-extractor.ts` — Ollama default; bench overrides via inline `extractViaClaude`/`extractViaCodex` in the harness
- `CLAUDE.md` (in mema, not PAI) — strategic context
- `LICENSE` — BSL 1.1; `LICENSE-MIT-PRE-V2.9.md` — historical MIT
- `NOTICE-LICENSE-HISTORY.md` — license split narrative

---

**Don't start fresh. Read mema's cognitive records + this file, then pick up from P1.**
