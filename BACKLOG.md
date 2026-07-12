# mema backlog

Candidate ideas and deferred work. Not committed to a release yet.

## Ingestion / extraction

- **Episode idempotency (re-ingest self-corroboration).** (breaker finding,
  2026-07-12) /v2/observe has no content-hash dedup, so re-POSTing the same
  document (the documented retry remedy) mints a new episode id and the
  duplicate-skip provenance merge counts it as a second "independent"
  source — corroboration and the auto fact-checker can be inflated by
  retries. Fix idea: per-owner content hash on observe; same hash → return
  the existing episode instead of minting.

- **Evidence gate: one generic token per side still suffices.** (breaker
  finding) "Acme Board approved Zenith merger" can be rescued by a quote
  containing only "board" and "merger". Word boundaries + stopwords closed
  the vacuous cases; requiring the MOST distinctive token (or 2+ tokens)
  would cut real recall — revisit with corpus data.

- **mergeFactProvenance leaves the body text's "derived from N episode(s)"
  stale** (cosmetic; frontmatter is authoritative).

## Retrieval

- **Ranking boost for web-confirmed facts?** (Ardin, 2026-07-10, undecided)
  v2.18.1 demotes `verification: contradicted` facts by 60% in search but
  gives NO boost to `confirmed` ones. Open question: should confirmed facts
  rank above unchecked ones (rewards verification, but penalizes facts the
  checker simply hasn't reached yet), and should `unverifiable` be neutral
  or slightly demoted? Decide after the fact-checker has stamped a larger
  corpus and we can measure the effect on LongMemEval retrieval quality.

## Extractor models / throughput

- **Evaluate Cursor `composer-2.5` as the extractor model.** Reportedly
  benchmarks close to Opus but is *much cheaper* and fast. If it's reachable
  via an API mema can call, it could resolve the extractor trilemma
  (quality vs. speed vs. cost) that currently forces a choice between
  qwen2.5:7b (fast/cheap, regurgitates) and Claude sonnet (high quality,
  but the CLI path times out on large episodes — see finding below).
  Action: check whether composer-2.5 has a callable API + an OpenAI-compatible
  endpoint we could wire as a new extractor in `src/v2/llm-extractor.ts`.

- **In-server Claude-CLI entity-extractor times out on large episodes.**
  2026-05-20: switched the extractor to `ClaudeCLIExtractor` (sonnet, full
  content, 8 KB truncation removed to fix Bug A). On the 65 KB
  `07e-antifragile-strategy.md` it **timed out at 180s and produced 0 facts**
  — worse than the truncated path's ~30. Root cause: CLI subprocess startup
  + full 16k-token input + dense structured output. Faster deliveries to try:
  (a) `AnthropicExtractor` via API key (no subprocess startup — direct HTTPS,
  much faster; also needs its 8 KB slice removed), (b) batch orchestration
  (one 1M-context agent reads many episodes per call), (c) composer-2.5.

## Architecture (from context-engineering review, 2026-05-20)

- **3-arm LongMemEval benchmark**: full-history (arm 1, exists) vs.
  mema-packet (arm 2, exists) vs. naive-RAG (arm 3, to build). Proves
  whether mema's extraction beats plain chunk-and-retrieve.
- **mema-on-mema dogfood**: ingest the codebase + session decisions, then
  query mema instead of grep+RESUME-HERE.md. Currently NOT dogfooded.
- **Fact↔entity linking** (codex finding): facts store subject/object as raw
  strings, not entity IDs; no write-time resolution. Half-defined in the
  type contract ("entity ID or string") but never implemented.
- **Bug B**: server extractor prompt dropped `event_date` — facts carry no
  real-world event time, only ingestion time.
- **Bug C**: episode timestamp + fact `valid_from` default to ingestion time,
  not event time → supersession orders by ingestion order, not reality.
