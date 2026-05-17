# Resume Here

**Last session:** 2026-05-18 afternoon PT (ended frustrated — PAI ceremony + quota blockers).
**Status:** 21 commits ahead `origin/main`. 325 tests pass. **No defensible bench number yet.** The code is ready; the bench infrastructure hit external blockers.

## TL;DR — first 5 minutes when you wake

```bash
cd ~/Projects/machtsinn.ai
git log --oneline origin/main..HEAD          # 21 commits to review
bun test 2>&1 | tail -3                       # should be 325 pass / 0 fail
curl -s http://localhost:3001/health          # primary mema (start if down)
curl -s http://localhost:3002/health          # bench mema (start if down)
```

Decide ONE thing: how to get a clean bench number. See the "Three real paths" section below. Pick one, execute, stop.

## What landed since v2.10.0 (21 commits)

All four GPT-5.5 "min path to a defensible N=100" steps + extras:

| Commit | What |
|---|---|
| (v2.11.x — 14 commits) | Memory Packet Compiler, sectioned packet, two-channel retrieval, judge-retry, rejudge tool, DRY refactor, trichotomy reporting |
| `bf0cd5d` | **v2.12 STEP 1**: sterilize bench CLI calls (PAI contamination fix — but `--bare` needs API key, the lighter flags don't fully strip the SessionStart hook) |
| `c7d5c9f` | **v2.12 STEP 2**: port Mem0 extraction discipline to `bench/extractor-prompt.ts` (Pydantic-equivalent rigor) |
| `8639a10` | **v2.12 STEP 3**: fix completeness parser bug (3-class `retryCompleteness` kernel) |
| `d0985b4` | **v2.12 STEP 4**: zep-format matches Zep's exact layout (Labels, Attributes, Summary, "No relevant X found" stubs) |
| `fc3d2c1` | Sterile system prompt → format-neutral (the previous version forced one-sentence output and broke extraction JSON) |
| `bc8e385` | Gemini answer/judge/extractor backend + v2.12 trichotomy aggregations in compare tool |

## What broke today

Bench runs failed three different ways across three different LLM backends:

### Claude CLI (the original)
- `claude -p` inherits the user's PAI framework via the SessionStart hook in `~/.claude/settings.json`
- PAI persona leaked into 6-47% of bench outputs (depending on mode) in yesterday's data
- The `--bare` flag SKIPS hooks + CLAUDE.md auto-discovery, but `--bare` strictly requires `ANTHROPIC_API_KEY` env var — refuses keychain/OAuth
- Lighter sterilization flags (`--disable-slash-commands`, `--allowedTools ""`, `--system-prompt <neutral>`, `cwd: /tmp/bench-cwd-sterile`) failed in smoke: SessionStart hook still injected PAI

### Codex CLI
- ChatGPT-account auth has usage limit
- Limit hit after the first question on `model_reasoning_effort="medium"`
- Limit hit again on `low`
- Other models (gpt-5-mini, gpt-4o-mini, o3-mini) rejected: "not supported with a ChatGPT account"
- Quota resets at 2:53 PM PT (might already be reset by the time you read this)

### Gemini CLI
- Built-in retry hides the issue, but you saw "You have exhausted your capacity on this model. Your quota will reset after 2s/6s..."
- Each call now takes ~23s instead of 5s due to retry backoffs
- Q1 of the bench took 17 min

## Three real paths to a clean bench number

**Path A — provide `ANTHROPIC_API_KEY`** (recommended; ~$17-56 one-time cost)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# then update bench-utils.ts callClaudeCLI to add: --bare and remove the cwd workaround
# OR set the env var only for the bench-mema process if you don't want it global
```

Edit `bench/bench-utils.ts:53-90` (`callClaudeCLI`): add `"--bare",` to the Bun.spawn args. With `--bare`, hooks/CLAUDE.md don't load → no PAI contamination → clean output. Cost estimate from session log: N=30 × 3 modes ≈ $17 (Sonnet default), N=100 × 3 modes ≈ $56.

**Path B — kill PAI from the global ~/.claude setup** (free, but affects your normal Claude Code use)

What "kills" PAI for `claude -p` calls:
1. `~/.claude/CLAUDE.md` (the user-global instructions — where Jarvis/ALGORITHM mode/etc. live)
2. The SessionStart hook in `~/.claude/settings.json` that injects AI steering rules

Move both aside (or comment out), run the bench, restore them. This breaks your interactive Claude Code workflow during the bench window. Concrete:

```bash
# Move aside
mv ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.paused
# Edit ~/.claude/settings.json: comment out the SessionStart hook
# Run the bench (claude -p is now PAI-free)
# Restore:
mv ~/.claude/CLAUDE.md.paused ~/.claude/CLAUDE.md
# Un-comment the hook
```

**Path C — wait for Codex quota to reset and re-run**

If it's after 2:53 PM PT by the time you read this, codex quota should be fresh. Launch:

```bash
cd ~/Projects/machtsinn.ai
( for MODE in episode-only memory-packet zep-format; do
    EXTRA=""
    [ "$MODE" != "episode-only" ] && EXTRA="--extract --extractor-backend codex --kinds episode,fact,cognitive,entity"
    bun bench/longmemeval-harness.ts \
      --data /tmp/longmemeval/data/longmemeval_oracle.json \
      --api http://localhost:3002 --key bench-key \
      --owner lme_v212codex_${MODE}_$(date +%s) \
      --limit 30 --balanced --context-mode $MODE $EXTRA \
      --judge llm --answer-backend codex --judge-backend codex \
      --top-k 10 --save-results /tmp/bench_v212_codex_${MODE}.jsonl
  done
) > /tmp/bench_v212_codex.log 2>&1 &
```

Then `bun bench/compare-context-modes.ts --dir /tmp --rejudge /tmp/rejudge_v211_5mode.jsonl` (latter optional) to see results.

ETA at codex-low: ~3-5h. ETA at gemini (if codex still rate-limited): ~25h.

## What's actually in the code now (the v2.12 deliverables)

- **`bench/extractor-prompt.ts`** — Mem0's full ADDITIVE_EXTRACTION_PROMPT adapted with mema's `{subject, predicate, object, event_date, confidence}` schema. Verbatim from `/tmp/competitor-intel/mem0/mem0-ts/src/oss/src/prompts/index.ts:282-757` for the discipline parts.

- **`bench/bench-utils.ts`** — single home for all bench helpers:
  - `callClaudeCLI` (sterilization attempt — needs `--bare` for full clean)
  - `callCodexCLI` (pinned `model_reasoning_effort="low"`)
  - `callGeminiCLI` (NEW — for when codex is throttled)
  - `judgePrompt`, `substringMatch`, `retryVerdict` (binary CORRECT/INCORRECT), `retryCompleteness` (three-class)
  - `sanitizeEventDate`, `classifyAnswerShape`, `goldInContext`
  - `ExtractedFactSchema`, `ExtractedEntitySchema`, `validateExtractorOutput` (zod)
  - `completenessPrompt`, `parseCompletenessVerdict`
  - `PAI_CONTAMINATION_MARKERS` + defense-in-depth check in `callClaudeCLI`

- **`bench/longmemeval-harness.ts`** — 5 context modes wired (`episode-only`/`flat-mixed`/`memory-packet`/`routed-packet`/`zep-format`); ScoredQuestion has all v2.12 fields (gold_in_context, packet_usage, context_completeness, rejected_invalid_*, answer_shape); 4 backends (claude, codex, gemini, ollama).

- **`bench/compare-context-modes.ts`** — trichotomy breakdown (correct/wrong-confident/no-answer/empty/judge-failed) + v2.12 metrics (gold_in_context %, avg packet usage, completeness breakdown). Accepts `--rejudge PATH` to merge cross-judge corrections.

- **`src/v2/memory-packet.ts`** — `compilePacketAsZepFormat` matches Zep's exact `_format_edges` / `_format_nodes` / `_format_episodes` shape.

- **`tests/v2/bench-utils.test.ts`** + **`tests/v2/memory-packet.test.ts`** + others — 325 tests total.

## The PAI side-effect findings (from GPT-5.5 review)

GPT-5.5 reviewed the framework Claude was running inside and flagged real concerns. Recap so you can act on them when you want:

- **E.1 ISC count floor (Advanced ≥ 24)** encourages padding criteria. Two recent PRDs had 30 and 28 ISCs, several non-load-bearing.
- **E.2 Mandatory critic agent** finds real bugs AND creates a queue that becomes next scope.
- **E.3 /simplify in VERIFY** keeps finding DRY/efficiency items that turn into refactor commits.
- **E.4 Cognitive-memory belief saves** become global "PAI default rules" applied unconditionally.
- **E.5 Algorithm-reflections JSONL** mixes useful signals with self-reinforcing meta-rules.
- **E.6 PRD-per-task pattern** treats every micro-change as a full 7-phase Algorithm run.

GPT-5.5's "DO THIS NEXT" was the sterilization fix (`bf0cd5d`). That landed but didn't fully work because `--bare` needs the API key.

Full GPT-5.5 review preserved at `/tmp/gpt5_review.md` (14KB markdown). Worth re-reading if you want to revisit the PAI side-effect findings.

## State checks

```bash
cd ~/Projects/machtsinn.ai
git status -sb                                    # should be clean
git log --oneline origin/main..HEAD | wc -l       # 21
bun test 2>&1 | tail -3                           # 325 pass
ls /tmp/bench_v212_gemini_*.jsonl 2>/dev/null     # partial gemini run — discard
ls /tmp/bench_v212_3mode_*.jsonl 2>/dev/null      # partial codex run — discard
cat /tmp/gpt5_review.md | head -50                # GPT-5.5 review still on disk
cat /tmp/gpt5_next.txt                            # GPT-5.5's "DO THIS NEXT" line
```

Bench mema state at `/tmp/mema_bench` — wipe + restart fresh before next run:

```bash
kill $(lsof -ti:3002 2>/dev/null); sleep 2; rm -rf /tmp/mema_bench && mkdir -p /tmp/mema_bench
VAULT_ROOT=/tmp/mema_bench PORT=3002 MACHTSINN_KEYS="bench-key:lmebench" \
  MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true \
  MACHTSINN_RATE_LIMIT_BURST=1000000 MACHTSINN_RATE_LIMIT_RPS=100000 \
  bun src/index.ts > /tmp/mema_bench.log 2>&1 &
```

## Bottom line

The code is ready. The PAI framework is fighting you (per GPT-5.5's E.1-E.6 findings) and the CLI quotas are throttling you. Pick Path A, B, or C above. Don't add more pre-bench requirements before running the bench.
