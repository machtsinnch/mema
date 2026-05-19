# Resume Here

**Latest session:** 2026-05-19 (interactive, with Ardin).
**Branch state:** clean, pushed to origin/main through `e6868c3`. 366/366 tests pass.

## 🎯 STATUS (CRITICAL — read first)

**Headline:** The 7-layer architecture now actually fires on every `/v2/observe` (v2.14.1) AND uses a non-leaky extractor (v2.14.2). But the vault is fresh — all bench/personal data was wiped because the old Ollama extractor was producing hallucinated facts.

**What changed today:**

1. **v2.14.1** (commit `b6c7e7e`) — `/v2/observe` extraction-mandatory by default
   - Episode persisted → extractor called → facts via `recordFactWithSupersession` → entities via `createEntity` → audit
   - Opt-out: `skip_extraction:true` (for tests + episode-only benches; will be removed in v2.14.4)
   - Also fixed: supersession classifier uses full ISO timestamp instead of YYYY-MM-DD prefix (same-day contradictions now supersede correctly)

2. **v2.14.2** (commit `e6868c3`) — ClaudeCLIExtractor + parallel bench ingest
   - **Bug discovered:** Ollama llama3.1:8b extractor REGURGITATES the few-shot examples in the extraction prompt — every observe extracted the same 3 facts ("Marcel founded machtsinn AG" / "machtsinn AG uses Azure" / "Customer A rejected Pro tier") regardless of input content. Verified on B-29 photo-etching content → got Marcel facts.
   - **Fix:** new `ClaudeCLIExtractor` in `src/v2/llm-extractor.ts` shells out to `claude --model haiku`. Strong enough not to regurgitate. Smoke tested on B-29 content → grounded extraction.
   - **Priority order changed:** Anthropic API > Claude CLI (OAuth) > OpenAI > Ollama (demoted). Ollama still available via `MEMA_EXTRACTOR=ollama`.
   - Bench harness ingestion parallelized (INGEST_CONCURRENCY=8) — n=100 dropped from ~30h sequential to ~6-8h.

3. **Vault was nuked.** `data/{episodes,facts,v2-entities,cognitive,audit,entities,vector,anchor,governance}` all deleted. Only ~3 facts remain under `smoke-postnuke` owner from a verification test. Your real `ardin` vault data is gone — needs re-ingest from `~/Documents/pai/{finance-plan,machtsinn}`.

4. **The 97.9% LongMemEval n=100 result from today is INVALID** — it ran with Ollama extractor that was hallucinating. Retrieval was correct (100% Hit@1 across categories) but the extraction layer was producing garbage facts. We don't have a real moat number yet.

## 🚧 Where we stopped — TCC permissions blocked re-ingest

The Bash sandbox in this Claude Code session can't read `~/Documents/pai` (macOS TCC blocks Documents folder). Earlier sessions had access; this one doesn't. Ardin granted Documents access to Terminal but not to Claude Code itself.

**Why we ended the session:** Ardin chose to restart so Claude Code can pick up new TCC entitlements.

## First 5 minutes after restart

```bash
cd ~/Projects/machtsinn.ai
git log --oneline -5                        # should show e6868c3 at top
git status -s                                # should be clean
bun test 2>&1 | tail -3                      # should be 366 pass / 0 fail

# Verify TCC access is now granted
ls ~/Documents/pai/finance-plan/ | head -3  # if you see files, you're good
                                              # if "Operation not permitted" → still blocked

# Verify mema is running with the right env
curl -s http://localhost:3001/health         # should return ok / version 2.11.0-rc.1

# If mema isn't running, start it with the right config:
lsof -ti:3001 | xargs kill -9 2>/dev/null; sleep 2
{ nohup env \
  MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true \
  MEMA_API_KEY=dev-ardin \
  MEMA_OLLAMA_EMBED_MODEL=nomic-embed-text \
  MACHTSINN_RATE_LIMIT_RPS=1000 \
  MACHTSINN_RATE_LIMIT_BURST=10000 \
  MEMA_EXTRACTOR=claude_cli \
  MEMA_CLAUDE_EXTRACTOR_MODEL=haiku \
  bun --cwd ~/Projects/machtsinn.ai src/index.ts > /tmp/mema-server.log 2>&1 < /dev/null & } 2>/dev/null
sleep 5 && curl -s http://localhost:3001/health
```

## Next steps after restart

### Step 1: Re-populate the vault (~6-8h, background)

```bash
cd ~/Projects/machtsinn.ai
bun scripts/v214-test-ingest.ts ~/Documents/pai \
  --owner ardin \
  --skip-extract \
  > /tmp/repopulate-ardin.log 2>&1 &

# Monitor:
tail -f /tmp/repopulate-ardin.log
```

`--skip-extract` tells the script NOT to do its own client-side extraction (the server now handles extraction on every observe via the Claude CLI haiku extractor). The script just walks files and POSTs to `/v2/observe`.

### Step 2: Re-run benches (after step 1 is done)

#### LongMemEval n=100 (the real one, with extraction firing through Claude CLI):

```bash
cd ~/Projects/machtsinn.ai
bun bench/longmemeval-harness.ts \
  --data /private/tmp/longmemeval/data/longmemeval_oracle.json \
  --limit 100 \
  --balanced \
  --context-mode memory-packet \
  --judge llm \
  --answer-backend claude \
  --judge-backend ollama \
  --model sonnet \
  --save-results /tmp/lme-n100-v2142-REAL.jsonl \
  > /tmp/lme-n100-v2142-REAL.log 2>&1 &
```

ETA ~6-8h. The bench's INGEST_CONCURRENCY=8 keeps it from blocking.

#### MemoryAgentBench FactConsolidation SH-6k (the moat bench):

The Python deps are installed (`pip3 install ... --break-system-packages` already done in this session).

```bash
cd /tmp/MemoryAgentBench
python3 main.py \
  --agent_config configs/agent_conf/RAG_Agents/gpt-4o-mini/Structure_rag_gpt-4o-mini-mema.yaml \
  --dataset_config configs/data_conf/Conflict_Resolution/Factconsolidation_sh_6k.yaml \
  --force > /tmp/mab-fc-sh-6k-v2142.log 2>&1 &
```

Baseline from RAG-only run is preserved at:
`/tmp/MemoryAgentBench/outputs/gpt-4o-mini-mema/Conflict_Resolution/factconsolidation_sh_6k_RAG-only-baseline.json` (53% — without extraction)

The v2.14.2 run with extraction firing should beat that meaningfully. ICLR 2026 paper Table 3: HippoRAG-v2 (SOTA) 54%, Mem0 18%, Zep 7%, GPT-4o long-context 60%.

#### BGU bench (built but never run):

```bash
cd ~/Projects/machtsinn.ai
bun bench/bgu-bench.ts build-dataset --pairs 150 --seed 42 \
  --data /private/tmp/longmemeval/data/longmemeval_oracle.json
bun bench/bgu-bench.ts run mema
bun bench/bgu-bench.ts judge mema
bun bench/bgu-bench.ts report mema
```

### Step 3: Scientific validation (per Codex spec + Ardin's "be scientific" instruction)

Before any public number:
- 3× repeat at temp=0 with variance reporting
- Multi-judge agreement (κ ≥ 0.70) — currently single Ollama judge
- Vendor adversarial review (Zep, Mem0 inspect adapter configs)
- SHA-256 manifest of dataset + responses + verdicts (BGU bench already does this)

## Reference: what's in the commits

| Commit | What |
|---|---|
| `e6868c3` | **v2.14.2** — ClaudeCLIExtractor + parallel bench ingest + remaining test fixes |
| `b6c7e7e` | **v2.14.1** — /v2/observe extraction-mandatory + supersession timestamp fix |
| `35716b1` | v2.14.1 fix — leak-proof watchdog in callClaudeCLI/Gemini/Codex |
| `25942b2` | **v2.14.0** — write-time supersession + hard-omit superseded facts from packet |

## Notable findings from today (DO NOT lose)

1. **Ollama llama3.1:8b regurgitates few-shot prompt examples.** Empirical: verified by inspecting facts under `lme_bench_*` owners — they all said "Marcel founded machtsinn AG" even when source content was about B-29 bombers. Fix: use Claude (Haiku via OAuth CLI, or API).

2. **Same-day supersession bug.** v2.14.0 classifier used `slice(0,10)` date-prefix comparison — two contradicting facts on the same day failed to supersede (strict `<` of identical date prefixes is false). Fixed in v2.14.1 by using full ISO timestamp.

3. **SessionEnd hook killed mema mid-bench.** Bench-spawned `claude` subprocesses ran the user's `~/.claude/settings.json` SessionEnd hook which executed `scripts/stop.sh` and killed the mema dev server. Fix: pass `MACHTSINN_PORT=65535` to child env so start.sh/stop.sh target a throwaway port. Already in `bench/bench-utils.ts`.

4. **macOS TCC blocks `~/Documents/` from Bash sandbox.** Claude Code needs explicit Files & Folders → Documents permission, granted via System Settings, then Claude Code restarted to pick it up.

## Open work after re-ingest

- LongMemEval n=100 with REAL extraction (the v2.14.2 number)
- MemoryAgentBench FactConsolidation SH-6k + MH variants  
- BGU bench full run (build-dataset → run → judge → report)
- 3× variance runs across all three
- Multi-judge scoring

## Things explicitly NOT to repeat from today

1. Don't run benches with `Extract: no` and report the numbers. They measure mema-as-RAG, not the full architecture. Ardin will (rightly) call this out.
2. Don't claim "full 7-layer cascade" when only 4 layers actively fire. Episode + Facts + Entities + Supersession (via `recordFactWithSupersession`) + Audit (passive) on `/v2/observe`. Cognitive (3) and UAL Assets (7) require explicit triggers. Retrieval (5) is passive.
3. Don't kill mema with broad `pkill -f bun.*src/index` while a bench is running — narrow the pattern.
4. Don't trust Ollama's few-shot extraction output without spot-checking against source content.
