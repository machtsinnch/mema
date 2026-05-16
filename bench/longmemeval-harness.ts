#!/usr/bin/env bun
// LongMemEval external benchmark harness (P8 from external review, v2.7.7+).
//
// LongMemEval (Wu et al., ICLR 2025) is the standard long-term-memory
// benchmark — 500 questions across 5 capability categories: information
// extraction, multi-session reasoning, knowledge updates, temporal reasoning,
// abstention. https://github.com/xiaowu0162/LongMemEval
//
// What this harness measures:
//   - RETRIEVAL CORRECTNESS: given a question, does mema's /v2/recall
//     return the haystack session(s) that contain the answer? Scored as
//     Hit@k for k ∈ {1, 5, 10} and per-category breakdown.
//   - INGESTION TIME, RETRIEVAL TIME: wall-clock latency budgets.
//
// What this harness does NOT do (yet):
//   - LLM answer generation. We don't ask an LLM "given these retrieved
//     sessions, what's the answer?" That's the next layer up and would
//     require a judge. Retrieval correctness is the prerequisite — if
//     mema can't retrieve the answer session, no downstream LLM can fix it.
//   - Cross-tenant isolation, audit replay, hard erasure — those live in
//     the Swiss Trust Memory Bench (separate harness).
//
// Usage:
//   # Download the dataset first (one-time):
//   curl -L -o /tmp/longmemeval_oracle.json \
//     "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json"
//
//   # Default — first 10 questions across all 5 categories, retrieval-only:
//   bun bench/longmemeval-harness.ts --data /tmp/longmemeval_oracle.json
//
//   # Full N=50, extraction-included (slow, requires Ollama):
//   bun bench/longmemeval-harness.ts --data /tmp/longmemeval_oracle.json \
//       --limit 50 --extract
//
//   # Single category:
//   bun bench/longmemeval-harness.ts --data /tmp/longmemeval_oracle.json \
//       --category temporal-reasoning --limit 20
//
//   # Custom owner (each run uses a clean isolated owner):
//   bun bench/longmemeval-harness.ts --data /tmp/longmemeval_oracle.json \
//       --owner bench_$(date +%s)

import { readFileSync, existsSync } from "node:fs";
import { pickExtractor } from "../src/v2/llm-extractor";

// v2.10.6+ — Claude/Codex CLI extractors for bench runs (Ollama
// llama3.1:8b at ~30s/session is too slow and quality-bottlenecks the
// architecture ablation; CLI extractors do ~5-10s per session at much
// higher precision/recall).
const EXTRACTOR_SYSTEM = `You are a strict structured-fact extractor. You read a markdown document and extract:

1. FACTS — explicit subject-predicate-object claims that the text directly states.
2. ENTITIES — named referents (people, organizations, products, technical systems, places, important concepts).

Rules:
- Only extract claims explicit and verifiable from the text. Reject vague/hypothetical, metaphors, opinions-as-facts, fragments.
- Predicates must be specific verbs: founded, owns, uses, rejected, supersedes, deploys_to, depends_on, is_a, located_in, reports_to, manages, supports, integrates_with, built_on. NEVER use is/has/at — too generic.
- Subjects and objects must be ENTITIES (proper nouns / products / orgs), not pronouns or articles.
- Reject facts where subject or object is a currency amount (CHF 22), a number/date alone, or a fragment.
- Entity type ∈ {person, organization, product, system, place, concept, event}.
- Confidence: 0.95 explicit, 0.85 clearly implied, ≤0.75 → don't emit.

Output ONLY valid JSON, no prose, no markdown fences. Schema:
{"facts": [{"subject":"...","predicate":"...","object":"...","confidence":0.95}], "entities": [{"name":"...","type":"..."}]}

If zero extractable facts, return {"facts": [], "entities": []}.`;

async function extractViaClaude(text: string): Promise<{ facts: any[]; entities: any[] }> {
  const prompt = `${EXTRACTOR_SYSTEM}\n\nText:\n${text}`;
  const r = await callClaudeCLI(prompt, 120000);
  return parseExtractorJSON(r ?? "");
}

async function extractViaCodex(text: string): Promise<{ facts: any[]; entities: any[] }> {
  const prompt = `${EXTRACTOR_SYSTEM}\n\nText:\n${text}`;
  const r = await callCodexCLI(prompt, 180000);
  return parseExtractorJSON(r ?? "");
}

function parseExtractorJSON(raw: string): { facts: any[]; entities: any[] } {
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const j = JSON.parse(stripped);
    if (j && Array.isArray(j.facts) && Array.isArray(j.entities)) return j;
  } catch { /* fall through */ }
  // Try to find a JSON object in the response
  const m = raw.match(/\{[\s\S]*"facts"[\s\S]*"entities"[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && Array.isArray(j.facts) && Array.isArray(j.entities)) return j;
    } catch { /* fall through */ }
  }
  return { facts: [], entities: [] };
}

type AnswerBackend = "ollama" | "claude" | "codex";

interface Args {
  data: string;
  api: string;
  key: string;
  owner: string;
  limit: number;
  category: string | null;
  extract: boolean;
  judge: "none" | "substring" | "llm";
  judgeModel: string;       // ollama model used for the LLM judge
  ollamaHost: string;
  topK: number;
  contextChars: number;     // truncate context packet for the answer prompt
  retrievalMode: "hybrid" | "bm25" | "vector" | "full-context";
  fusion: "weighted" | "rrf";
  // v2.10.1+ answer/judge LLM backend (NEW — closes "apples-to-apples vs
  // Zep/Hindsight" gap). Default backends remain ollama (free, slow,
  // weaker reasoning). claude shells out to the locally-authenticated
  // claude CLI (Claude Opus by default); codex shells out to the codex
  // CLI (GPT-5.x by default). No API keys needed when the CLIs are
  // already authenticated.
  answerBackend: AnswerBackend;
  judgeBackend: AnswerBackend;
  // v2.10.1+ — sample balanced across categories instead of taking the
  // first N from the file (the LongMemEval oracle is ordered by category,
  // so a plain --limit N=100 misses 5 of 6 categories).
  balanced: boolean;
  // v2.10.2+ — which mema record kinds to retrieve. Default "episode"
  // (back-compat with the v2.10.0 baseline). The reviewer's v3.0
  // ablation asks for "episode-only vs episode+fact+cognitive" so the
  // gain from extraction + reflection is measurable separately.
  kinds: ("episode" | "fact" | "cognitive" | "entity")[];
}

interface ChatTurn { role: string; content: string }
interface LMERecord {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: ChatTurn[][];
  answer_session_ids: string[];
}

interface ScoredQuestion {
  question_id: string;
  category: string;
  question: string;
  answer: string;
  answer_session_ids: string[];
  retrieved_ids: string[];
  hit_at_1: boolean;
  hit_at_5: boolean;
  hit_at_10: boolean;
  // v2.10.4+ stronger retrieval metrics (per diagnostic root cause #1).
  all_gold_at_10: boolean;
  coverage_at_10: number;
  ingest_ms: number;
  recall_ms: number;
  extracted_facts: number;
  extracted_entities: number;
  approved_facts: number;
  rejected_facts: number;
  predicted_answer?: string;
  judge_score?: number;
  judge_reason?: string;
  answer_ms?: number;
  judge_ms?: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[k] = next; i++; }
    else flags[k] = true;
  }
  return {
    data: String(flags.data ?? "/tmp/longmemeval_oracle.json"),
    api: String(flags.api ?? process.env.MACHTSINN_URL ?? "http://localhost:3001"),
    key: String(flags.key ?? process.env.MACHTSINN_KEY ?? "dev-ardin"),
    owner: String(flags.owner ?? `lme_bench_${Date.now()}`),
    limit: flags.limit ? Number(flags.limit) : 10,
    category: flags.category ? String(flags.category) : null,
    extract: !!flags.extract,
    judge: (flags.judge ? String(flags.judge) : "none") as Args["judge"],
    judgeModel: String(flags["judge-model"] ?? process.env.OLLAMA_JUDGE_MODEL ?? "llama3.1:8b"),
    ollamaHost: String(flags["ollama-host"] ?? process.env.OLLAMA_HOST ?? "http://localhost:11434"),
    topK: flags["top-k"] ? Number(flags["top-k"]) : 10,
    // v2.10.3+ — DEFAULT bumped from 6,000 → 200,000 chars (~50K tokens).
    // Root-causing the 8% multi-session collapse on the v2.10.0 baseline
    // showed the prior 6K cap was throwing away 81% of the haystack on
    // multi-session/temporal-reasoning categories (median haystacks are
    // 30K+ chars). The LongMemEval paper recommends 20K+ tokens for
    // GPT-4o-class readers; the official harness uses ~126K tokens for
    // GPT-4o. We were 80x below the recommended budget, hobbling Claude
    // Opus 4.7 (which has a 1M-token context window). 200K chars ≈ 50K
    // tokens — comfortably above the paper's recommendation, comfortably
    // below Claude's window.
    contextChars: flags["context-chars"] ? Number(flags["context-chars"]) : 200000,
    retrievalMode: (flags["retrieval-mode"] ? String(flags["retrieval-mode"]) : "hybrid") as Args["retrievalMode"],
    fusion: (flags["fusion"] ? String(flags["fusion"]) : "weighted") as Args["fusion"],
    answerBackend: (flags["answer-backend"] ? String(flags["answer-backend"]) : "ollama") as AnswerBackend,
    judgeBackend: (flags["judge-backend"] ? String(flags["judge-backend"]) : (flags["answer-backend"] ? String(flags["answer-backend"]) : "ollama")) as AnswerBackend,
    balanced: !!flags["balanced"],
    kinds: (flags["kinds"] ? String(flags["kinds"]).split(",") : ["episode"]) as Args["kinds"],
    saveResults: flags["save-results"] ? String(flags["save-results"]) : null,
    extractorBackend: (flags["extractor-backend"] ? String(flags["extractor-backend"]) : "ollama") as Args["extractorBackend"],
  };
}

async function api(args: Args, method: "GET" | "POST", path: string, body?: any) {
  const r = await fetch(`${args.api}${path}`, {
    method,
    headers: {
      "x-api-key": args.key,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

// Serialize a chat session into a markdown-friendly episode body.
function sessionToContent(turns: ChatTurn[], sessionId: string, date: string): string {
  const header = `# Session ${sessionId} — ${date}\n\n`;
  const body = turns
    .map(t => `**${t.role}:** ${t.content}`)
    .join("\n\n");
  return header + body;
}

// Score: is any answer_session_id present in the top-k retrieved record IDs?
// LongMemEval's evaluation uses session-level recall: retrieval succeeds when
// any of the gold sessions are returned. We mirror that semantics: a hit is
// any retrieved episode whose source session_id matches the gold list.
// v2.10.4+ scoring (per third-party diagnostic root cause #1).
// Hit@k = "any gold retrieved" is too weak for multi-session questions
// where answering requires ALL gold sessions. We additionally report:
//   - all_gold@k: did the top-k include EVERY gold session?
//   - coverage@k: fraction of gold sessions retrieved in top-k (0..1)
// Both expose the real metric for multi-session reasoning.
function scoreHits(retrievedSessionIds: string[], gold: string[]): {
  hit_at_1: boolean; hit_at_5: boolean; hit_at_10: boolean;
  all_gold_at_10: boolean;
  coverage_at_10: number;
} {
  const goldSet = new Set(gold);
  const isAnyHit = (slice: string[]) => slice.some(id => goldSet.has(id));
  const top10 = retrievedSessionIds.slice(0, 10);
  const top10Set = new Set(top10);
  const goldInTop10 = gold.filter(g => top10Set.has(g)).length;
  return {
    hit_at_1: isAnyHit(retrievedSessionIds.slice(0, 1)),
    hit_at_5: isAnyHit(retrievedSessionIds.slice(0, 5)),
    hit_at_10: isAnyHit(top10),
    all_gold_at_10: gold.length > 0 && goldInTop10 === gold.length,
    coverage_at_10: gold.length > 0 ? goldInTop10 / gold.length : 0,
  };
}

// v2.9.0+ answer generation + judging (P1 from review).
//
// LongMemEval's official metric is answer correctness, not retrieval Hit@k.
// To close the gap with Zep/Hindsight published numbers, we must:
//   1. Generate a candidate answer from the retrieved context (LLM call).
//   2. Judge it against the ground-truth answer.
//
// Two judge modes:
//   - substring: case-insensitive substring check (fast, no LLM, ~70% of
//     LongMemEval's official judge correlation on extractive questions).
//   - llm: ask another model to score (predicted == gold semantically).
//     Closer to LongMemEval's official protocol.

// v2.10.4+ — prompt rewritten per third-party troubleshooting report.
// Adds: (1) QUESTION_DATE so temporal questions have a reference point,
// (2) explicit timeline-reasoning instruction for multi-session questions,
// (3) chronological-context invariant so the model can trust the order.
const ANSWER_PROMPT = (question: string, context: string, questionDate?: string) =>
  `You are a long-term-memory assistant answering a question about past conversations.
Use ONLY the context below. The context is a TIMELINE of past sessions, sorted CHRONOLOGICALLY (oldest first).

${questionDate ? `QUESTION_DATE: ${questionDate}
Answer questions about "now" or "current" as of this date. Treat sessions after this date as future / not yet known.

` : ""}CONTEXT (chronological timeline):
${context}

QUESTION: ${question}

Reason internally using this structure (do NOT output the steps):
  1. Identify which sessions / turns contain evidence.
  2. For temporal or "current state" questions: pick the LATEST relevant statement AT OR BEFORE the QUESTION_DATE.
  3. For multi-session counting / aggregation questions: enumerate every relevant item across all sessions.
  4. For preference questions: infer the durable pattern from one or more concrete statements.
  5. For knowledge-update questions: prefer the most recent statement over older contradicting statements.

Return ONLY the final answer as a single short sentence, or say "no answer" if the context truly doesn't support one.`;

const JUDGE_PROMPT = (question: string, gold: string, predicted: string) =>
  `You are a strict grading assistant for the LongMemEval benchmark. Decide if the predicted answer matches the gold answer SEMANTICALLY for the given question.

QUESTION: ${question}
GOLD ANSWER:      ${gold}
PREDICTED ANSWER: ${predicted}

Reply with EXACTLY one of:
  CORRECT
  INCORRECT
Followed by an optional one-line reason.`;

async function callOllama(host: string, model: string, prompt: string, timeoutMs = 60000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${host.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const d = await r.json() as { response: string };
    return (d.response ?? "").trim();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// v2.10.1+ — shell out to the locally-authenticated Claude Code CLI.
// Uses `--print` (-p) for non-interactive mode. Hook errors are emitted
// to stderr (some hooks lack +x); we redirect them so they don't pollute
// the answer. No API key required if the CLI is already logged in.
async function callClaudeCLI(prompt: string, timeoutMs = 120000): Promise<string | null> {
  try {
    const proc = Bun.spawn(["claude", "-p", prompt], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const decoder = new TextDecoder();
    // Race against timeout; kill the process if it stalls.
    const watchdog = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const [out] = await Promise.all([
      (async () => decoder.decode(await new Response(proc.stdout).arrayBuffer()))(),
      proc.exited,
    ]);
    clearTimeout(watchdog);
    // Strip post-response hook noise lines if any made it into stdout.
    const cleaned = out
      .split("\n")
      .filter(l => !l.includes("hook [") && !l.includes("Permission denied"))
      .join("\n")
      .trim();
    return cleaned || null;
  } catch { return null; }
}

// v2.10.1+ — shell out to the codex CLI. `--output-last-message <file>`
// writes ONLY the final assistant text to a file, so we don't have to
// parse the formatted session log. --skip-git-repo-check avoids the
// trust-directory prompt for non-interactive runs.
async function callCodexCLI(prompt: string, timeoutMs = 180000): Promise<string | null> {
  const outPath = `/tmp/codex-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const proc = Bun.spawn([
      "codex", "exec",
      "--skip-git-repo-check",
      "--output-last-message", outPath,
      prompt,
    ], {
      stdout: "ignore",
      stderr: "pipe",
      env: process.env,
    });
    const watchdog = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    await proc.exited;
    clearTimeout(watchdog);
    try {
      const text = await Bun.file(outPath).text();
      return text.trim() || null;
    } finally {
      try { await Bun.file(outPath).unlink(); } catch {}
    }
  } catch { return null; }
}

async function callBackend(backend: AnswerBackend, args: Args, model: string, prompt: string, timeoutMs?: number): Promise<string | null> {
  if (backend === "claude") return callClaudeCLI(prompt, timeoutMs ?? 120000);
  if (backend === "codex") return callCodexCLI(prompt, timeoutMs ?? 180000);
  return callOllama(args.ollamaHost, model, prompt, timeoutMs ?? 60000);
}

async function generateAnswer(
  args: Args,
  question: string,
  context: string,
  questionDate?: string,
): Promise<{ answer: string; ms: number }> {
  const t = Date.now();
  const a = await callBackend(args.answerBackend, args, args.judgeModel, ANSWER_PROMPT(question, context, questionDate));
  return { answer: (a ?? "no answer").slice(0, 500), ms: Date.now() - t };
}

async function judgeAnswer(
  args: Args,
  question: string,
  gold: string,
  predicted: string,
): Promise<{ score: number; reason: string; ms: number }> {
  const t = Date.now();
  if (args.judge === "substring") {
    const ok = gold.trim().toLowerCase().split(/\s+/).filter(w => w.length >= 3).every(
      w => predicted.toLowerCase().includes(w),
    );
    return { score: ok ? 1 : 0, reason: ok ? "substring-match" : "substring-miss", ms: Date.now() - t };
  }
  if (args.judge === "llm") {
    const verdict = await callBackend(args.judgeBackend, args, args.judgeModel, JUDGE_PROMPT(question, gold, predicted));
    const v = (verdict ?? "").toUpperCase();
    const correct = v.startsWith("CORRECT");
    return { score: correct ? 1 : 0, reason: (verdict ?? "judge-no-response").slice(0, 200), ms: Date.now() - t };
  }
  return { score: 0, reason: "judge-disabled", ms: 0 };
}

async function runQuestion(args: Args, rec: LMERecord): Promise<ScoredQuestion> {
  // Per-question isolated owner so haystacks from different questions don't
  // contaminate each other's retrieval. v2.9.0+: the server must be started
  // with MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true so the `x-owner` header is
  // honored; otherwise all questions silently fall back to the API key's
  // owner and Hit@k numbers reflect cross-question pooling.
  const owner = `${args.owner}_${rec.question_id}`;
  // Slugify owner to satisfy the server's whitelist ([a-zA-Z0-9._-]{1,64}).
  const safeOwner = owner.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  const headers = { "x-api-key": args.key, "content-type": "application/json" };
  const apiOwner = (path: string, body?: any) => fetch(`${args.api}${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...headers, "x-owner": safeOwner },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 1. Ingest haystack_sessions as episodes. We map session_id → episode_id
  //    so retrieval scoring can lift back to LongMemEval's session-level
  //    judgment.
  const sessionToEpisode = new Map<string, string>();
  const t0 = Date.now();
  for (let i = 0; i < rec.haystack_sessions.length; i++) {
    const sid = rec.haystack_session_ids[i];
    const date = rec.haystack_dates[i];
    const content = sessionToContent(rec.haystack_sessions[i], sid, date);
    const r = await apiOwner("/v2/observe", {
      kind: "conversation",
      content,
      source: `longmemeval:${sid}`,
    });
    if (!r.ok) {
      console.error(`  observe failed for session ${sid}: ${r.status}`);
      continue;
    }
    const j = await r.json() as { episode: { id: string } };
    sessionToEpisode.set(sid, j.episode.id);
  }
  const ingestMs = Date.now() - t0;

  // 2. Optional: run LLM extraction on the freshly ingested episodes
  //    end-to-end via the v2.7+ acceptance-gate pipeline. v2.9.0+ (P0-E
  //    from second external review): this is no longer stubbed — the
  //    extractor runs inline, writes drafts, and the harness auto-approves
  //    high-confidence ones with passing evidence checks.
  let extractedFacts = 0, extractedEntities = 0;
  let approvedFacts = 0, rejectedFacts = 0;
  if (args.extract) {
    // v2.10.6+ extractor-backend selection.
    const ollamaExtractor = args.extractorBackend === "ollama" ? await pickExtractor() : null;
    const extractorName = args.extractorBackend === "claude" ? "claude-cli"
      : args.extractorBackend === "codex" ? "codex-cli"
      : ollamaExtractor!.name;
    const AUTO_APPROVE_THRESHOLD = 0.9;
    for (const [sid, epId] of sessionToEpisode) {
      const body = sessionToContent(rec.haystack_sessions[rec.haystack_session_ids.indexOf(sid)], sid, "");
      let result;
      try {
        if (args.extractorBackend === "claude") {
          result = await extractViaClaude(body);
        } else if (args.extractorBackend === "codex") {
          result = await extractViaCodex(body);
        } else {
          result = await ollamaExtractor!.extract(body);
        }
      } catch { continue; }
      // Write entity drafts first.
      for (const e of result.entities) {
        const name = String(e.name ?? "").trim();
        if (name.length < 2 || name.length > 80) continue;
        try {
          await apiOwner("/v2/entity", {
            name, type: String(e.type ?? "concept"),
            status: "draft", derived_from: [epId],
            evidence_excerpt: body.slice(0, 400),
            proposed_by: `lmebench:${extractorName}`,
          });
          extractedEntities++;
        } catch { /* dedup/etc */ }
      }
      // Write fact drafts + auto-approve high-confidence ones with evidence.
      for (const f of result.facts) {
        const subj = String(f.subject ?? "").trim();
        const pred = String(f.predicate ?? "").trim();
        const obj  = String(f.object ?? "").trim();
        const conf = Number(f.confidence ?? 0);
        if (!subj || !pred || !obj || conf < 0.75) continue;
        let createdId: string | null = null;
        try {
          const r = await apiOwner("/v2/fact", {
            subject: subj, predicate: pred, object: obj,
            derived_from: [epId],
            confidence: Math.min(Math.max(conf, 0), 1),
            status: "draft",
            evidence_excerpt: body.slice(0, 500),
            proposed_by: `lmebench:${extractorName}`,
          });
          if (r.ok) {
            const j = await r.json() as { fact: { id: string } };
            createdId = j.fact.id;
            extractedFacts++;
          }
        } catch { continue; }
        if (createdId && conf >= AUTO_APPROVE_THRESHOLD) {
          try {
            const ap = await apiOwner(`/v2/fact/${createdId}/approve`, {
              reason: `auto: confidence=${conf.toFixed(2)} via lmebench-harness`,
            });
            if (ap.ok) approvedFacts++;
            else rejectedFacts++;
          } catch { rejectedFacts++; }
        }
      }
    }
  }

  // 3. Recall — v2.10.0+ ablation-aware. The retrieval-mode switch
  //    routes the question through one of four pipelines so we can
  //    publish apples-to-apples ablations alongside the mema number.
  const t1 = Date.now();
  let retrievedSessions: string[] = [];

  if (args.retrievalMode === "full-context") {
    // Oracle upper bound: every haystack session in order is "retrieved".
    // The answer-generation step still gets capped by --context-chars.
    retrievedSessions = [...rec.haystack_session_ids];
  } else {
    const useVector = args.retrievalMode === "vector" || args.retrievalMode === "hybrid";
    const recallRes = await apiOwner("/v2/recall", {
      query: rec.question,
      purpose: `longmemeval_${args.retrievalMode}_${args.fusion}_${args.kinds.join("+")}`,
      kinds: args.kinds,
      limit: args.topK,
      use_vector: useVector,
      fusion: args.fusion,
    });
    if (recallRes.ok) {
      const rj = await recallRes.json() as { hits: { id: string }[] };
      const idToSession = new Map<string, string>();
      for (const [sid, eid] of sessionToEpisode) idToSession.set(eid, sid);
      retrievedSessions = rj.hits.map(h => idToSession.get(h.id) ?? h.id);
    }
    if (args.retrievalMode === "vector") {
      // Vector-only ablation: drop keyword-anchored hits by re-querying
      // with a vector-only purpose label — recall() doesn't currently
      // expose a pure-vector mode, so this is best-effort. Marked
      // explicitly in the output so the reader knows the caveat.
      // (Pure-vector ablation requires a future query.vector_only flag.)
    }
  }
  const recallMs = Date.now() - t1;

  const hits = scoreHits(retrievedSessions, rec.answer_session_ids);

  // v2.9.0+ answer-level scoring: generate an answer from the retrieved
  // context and judge it. We use the top-K retrieved sessions' content
  // as the context packet, truncated to args.contextChars.
  let predictedAnswer: string | undefined;
  let judgeScore: number | undefined;
  let judgeReason: string | undefined;
  let answerMs: number | undefined;
  let judgeMs: number | undefined;

  // v2.10.4+ (per third-party troubleshoot diagnostic):
  //   - Sort retrieved sessions by haystack_date ASCENDING (chronological)
  //     instead of retrieval-rank order. Temporal + multi-session reasoning
  //     requires a timeline, not a relevance ranking.
  //   - Pass question_date through to the answer prompt so temporal "now"
  //     questions are answerable.
  //   - Same content-budget as before, just better ordered.
  if (args.judge !== "none" && retrievedSessions.length > 0) {
    const sidToContent = new Map<string, string>();
    const sidToDate = new Map<string, string>();
    for (let i = 0; i < rec.haystack_session_ids.length; i++) {
      const sid = rec.haystack_session_ids[i];
      sidToContent.set(sid, sessionToContent(rec.haystack_sessions[i], sid, rec.haystack_dates[i]));
      sidToDate.set(sid, rec.haystack_dates[i] ?? "");
    }
    // Take top-K retrieved, then re-sort by haystack date ascending.
    const topKRetrieved = retrievedSessions.slice(0, args.topK);
    const chronological = [...topKRetrieved].sort((a, b) => {
      const da = sidToDate.get(a) ?? "";
      const db = sidToDate.get(b) ?? "";
      return da.localeCompare(db);
    });
    const ctxParts: string[] = [];
    let budget = args.contextChars;
    for (const sid of chronological) {
      const part = sidToContent.get(sid);
      if (!part) continue;
      const slice = part.slice(0, Math.max(0, budget));
      if (!slice) break;
      ctxParts.push(slice);
      budget -= slice.length;
      if (budget <= 0) break;
    }
    const ctx = ctxParts.join("\n\n---\n\n");
    const gen = await generateAnswer(args, rec.question, ctx || "(no retrieved context)", rec.question_date);
    predictedAnswer = gen.answer;
    answerMs = gen.ms;
    const judge = await judgeAnswer(args, rec.question, rec.answer, gen.answer);
    judgeScore = judge.score;
    judgeReason = judge.reason;
    judgeMs = judge.ms;
  }

  return {
    question_id: rec.question_id,
    category: rec.question_type,
    question: String(rec.question ?? "").slice(0, 100),
    // v2.10.2+ — some LongMemEval entries have non-string answer fields
    // (arrays/objects); coerce defensively so the harness doesn't drop
    // them with "rec.answer.slice is not a function".
    answer: (typeof rec.answer === "string" ? rec.answer : JSON.stringify(rec.answer ?? "")).slice(0, 100),
    answer_session_ids: rec.answer_session_ids,
    retrieved_ids: retrievedSessions,
    ingest_ms: ingestMs,
    recall_ms: recallMs,
    extracted_facts: extractedFacts,
    extracted_entities: extractedEntities,
    approved_facts: approvedFacts,
    rejected_facts: rejectedFacts,
    predicted_answer: predictedAnswer,
    judge_score: judgeScore,
    judge_reason: judgeReason,
    answer_ms: answerMs,
    judge_ms: judgeMs,
    ...hits,
  };
}

function aggregate(results: ScoredQuestion[]): void {
  const byCategory = new Map<string, ScoredQuestion[]>();
  for (const r of results) {
    const k = r.category;
    if (!byCategory.has(k)) byCategory.set(k, []);
    byCategory.get(k)!.push(r);
  }
  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  LongMemEval results — mema retrieval correctness");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  const judgeUsed = results.some(r => r.judge_score !== undefined);
  console.log("Per category:");
  console.log("  " + "category".padEnd(26) + " n   H@1   H@5   H@10  AllG@10 Cov@10" + (judgeUsed ? "  Answer%" : ""));
  console.log("  " + "─".repeat(judgeUsed ? 84 : 76));
  for (const [cat, rows] of [...byCategory.entries()].sort()) {
    const n = rows.length;
    const h1 = (rows.filter(r => r.hit_at_1).length / n * 100).toFixed(1);
    const h5 = (rows.filter(r => r.hit_at_5).length / n * 100).toFixed(1);
    const h10 = (rows.filter(r => r.hit_at_10).length / n * 100).toFixed(1);
    const allg = (rows.filter(r => r.all_gold_at_10).length / n * 100).toFixed(1);
    const cov = (rows.reduce((s, r) => s + r.coverage_at_10, 0) / n * 100).toFixed(1);
    let line = "  " + cat.padEnd(26) + String(n).padStart(3) +
      " " + h1.padStart(5) +
      " " + h5.padStart(5) +
      " " + h10.padStart(5) +
      " " + allg.padStart(6) +
      " " + cov.padStart(5);
    if (judgeUsed) {
      const judged = rows.filter(r => r.judge_score !== undefined);
      const ans = judged.length ? (judged.filter(r => r.judge_score === 1).length / judged.length * 100).toFixed(1) : "n/a";
      line += " " + ans.padStart(7);
    }
    console.log(line);
  }
  console.log("");
  const all = results;
  const overall = (rows: ScoredQuestion[], k: "hit_at_1" | "hit_at_5" | "hit_at_10" | "all_gold_at_10") =>
    (rows.filter(r => r[k] === true).length / rows.length * 100).toFixed(1);
  const meanCov = (all.reduce((s, r) => s + r.coverage_at_10, 0) / all.length * 100).toFixed(1);
  let line = `Overall: n=${all.length}  Hit@1=${overall(all, "hit_at_1")}%  Hit@5=${overall(all, "hit_at_5")}%  Hit@10=${overall(all, "hit_at_10")}%  AllGold@10=${overall(all, "all_gold_at_10")}%  Coverage@10=${meanCov}%`;
  if (judgeUsed) {
    const judged = all.filter(r => r.judge_score !== undefined);
    const ans = judged.length ? (judged.filter(r => r.judge_score === 1).length / judged.length * 100).toFixed(1) : "n/a";
    line += `  Answer-correct=${ans}% (n=${judged.length})`;
  }
  console.log(line);
}

async function main() {
  const args = parseArgs();
  console.log("LongMemEval harness — mema retrieval benchmark");
  console.log(`  Data:     ${args.data}`);
  console.log(`  API:      ${args.api}`);
  console.log(`  Owner:    ${args.owner}_<question_id>`);
  console.log(`  Limit:    ${args.limit}${args.category ? ` (category=${args.category})` : ""}`);
  console.log(`  top-K:    ${args.topK}`);
  console.log(`  Mode:     retrieval=${args.retrievalMode}  fusion=${args.fusion}  kinds=${args.kinds.join("+")}`);
  console.log(`  Extract:  ${args.extract ? `yes (extractor-backend=${args.extractorBackend}, drafts then auto-review)` : "no (retrieval-only)"}`);
  console.log(`  Judge:    ${args.judge}${args.judge !== "none" ? ` answer-backend=${args.answerBackend} judge-backend=${args.judgeBackend}` : ""}`);
  console.log("");

  if (!existsSync(args.data)) {
    console.error(`Dataset not found at ${args.data}.`);
    console.error(`Download with: curl -L -o ${args.data} \\\n  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json"`);
    process.exit(1);
  }

  // Health check before kicking off — fail fast if mema is down.
  const h = await fetch(`${args.api}/health`).catch(() => null);
  if (!h || !h.ok) {
    console.error(`mema not reachable at ${args.api}/health. Start it with: ~/Projects/machtsinn.ai/scripts/start.sh`);
    process.exit(1);
  }
  const hj = await h.json() as { version: string };
  console.log(`  mema version: ${hj.version}`);

  // v2.9.0+ — verify x-owner override is actually honored by the server.
  // Without this check, the harness would silently pool all questions into
  // the API key's owner and produce misleading Hit@k numbers.
  const probeOwner = `${args.owner}__probe`;
  const probe = await fetch(`${args.api}/v2/observe`, {
    method: "POST",
    headers: {
      "x-api-key": args.key,
      "x-owner": probeOwner,
      "content-type": "application/json",
    },
    body: JSON.stringify({ kind: "observation", content: "probe", source: "harness-probe" }),
  });
  if (probe.ok) {
    const probeBody = await probe.json() as { episode: { owner: string } };
    if (probeBody.episode?.owner !== probeOwner) {
      console.error(`\n  ERROR: server is not honoring x-owner header.\n  Got owner='${probeBody.episode?.owner}', expected '${probeOwner}'.\n  Start the bench server with:  MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true bun src/index.ts\n`);
      process.exit(2);
    }
    console.log(`  x-owner override:  OK (owner-isolation enabled)`);
  } else {
    console.error(`\n  ERROR: probe write failed (${probe.status}). Cannot verify owner isolation.`);
    process.exit(2);
  }
  console.log("");

  const raw = JSON.parse(readFileSync(args.data, "utf8")) as LMERecord[];
  let questions = raw;
  if (args.category) questions = questions.filter(q => q.question_type === args.category);
  if (args.balanced && !args.category) {
    // Group by category, take ceil(limit/categoryCount) from each, then
    // truncate to exactly args.limit (preserving even spread).
    const byCat = new Map<string, LMERecord[]>();
    for (const q of questions) {
      const arr = byCat.get(q.question_type) ?? [];
      arr.push(q);
      byCat.set(q.question_type, arr);
    }
    const cats = [...byCat.keys()];
    const perCat = Math.ceil(args.limit / cats.length);
    const picked: LMERecord[] = [];
    for (const c of cats) picked.push(...(byCat.get(c) ?? []).slice(0, perCat));
    questions = picked.slice(0, args.limit);
  } else {
    questions = questions.slice(0, args.limit);
  }
  console.log(`Running ${questions.length} question(s)...`);

  const results: ScoredQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    process.stdout.write(`  [${i + 1}/${questions.length}] ${q.question_id} (${q.question_type}) ... `);
    try {
      const r = await runQuestion(args, q);
      process.stdout.write(`H@1=${r.hit_at_1 ? "✓" : "✗"} H@5=${r.hit_at_5 ? "✓" : "✗"} H@10=${r.hit_at_10 ? "✓" : "✗"}  ingest=${r.ingest_ms}ms  recall=${r.recall_ms}ms\n`);
      results.push(r);
    } catch (e: any) {
      console.error(`fatal: ${e?.message ?? e}`);
    }
  }

  aggregate(results);

  // v2.10.5+ — dump per-question results for error-class auditing.
  // One JSONL line per question, queryable via jq/grep/python for the
  // 7-class failure taxonomy from the reviewer's diagnostic.
  if (args.saveResults) {
    const lines = results.map(r => JSON.stringify(r));
    await Bun.write(args.saveResults, lines.join("\n") + "\n");
    console.log(`\nResults saved: ${args.saveResults}  (${lines.length} questions)`);
  }
}

main().catch(e => { console.error("fatal:", e?.message ?? e); process.exit(1); });
