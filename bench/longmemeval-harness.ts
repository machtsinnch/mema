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
import {
  buildMemoryPacket,
  compilePacketToPrompt,
  compilePacketAsZepFormat,
  type TwoChannelHits,
} from "../src/v2/memory-packet";
import type { RetrievalHit } from "../src/v2/types";
import {
  sanitizeEventDate,
  callClaudeCLI,
  callCodexCLI,
  callGeminiCLI,
  judgePrompt,
  substringMatch,
  retryVerdict,
  classifyAnswerShape,
  validateExtractorOutput,
  goldInContext,
  completenessPrompt,
  retryCompleteness,
  type AnswerShape,
  type CompletenessVerdict,
} from "./bench-utils";
import { buildExtractorPrompt } from "./extractor-prompt";

// v2.12.0+ — extractor prompt moved to bench/extractor-prompt.ts. Ported
// from Mem0's ADDITIVE_EXTRACTION_PROMPT (battle-tested extraction
// discipline) with mema's event_date + subject/predicate/object schema.
// Per GPT-5.5 review (2026-05-18): stop reinventing what works; copy.

async function extractViaClaude(text: string, observationDate: string): Promise<{ facts: any[]; entities: any[] }> {
  const prompt = buildExtractorPrompt({ observationDate, text });
  const r = await callClaudeCLI(prompt, 120000);
  return parseExtractorJSON(r ?? "");
}

async function extractViaCodex(text: string, observationDate: string): Promise<{ facts: any[]; entities: any[] }> {
  const prompt = buildExtractorPrompt({ observationDate, text });
  const r = await callCodexCLI(prompt, 180000);
  return parseExtractorJSON(r ?? "");
}

async function extractViaGemini(text: string, observationDate: string): Promise<{ facts: any[]; entities: any[] }> {
  const prompt = buildExtractorPrompt({ observationDate, text });
  const r = await callGeminiCLI(prompt, 180000);
  return parseExtractorJSON(r ?? "");
}

// (sanitizeEventDate now lives in bench/bench-utils.ts — shared with dump-packet.ts)

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

type AnswerBackend = "ollama" | "claude" | "codex" | "gemini";

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
  // Pre-2.11 fields previously set by parseArgs but missing from this
  // interface — declared here for type completeness.
  saveResults: string | null;
  extractorBackend: "ollama" | "claude" | "codex" | "gemini";
  // v2.11.0+ — context-compilation mode for the answer prompt.
  //   episode-only    — only the evidence channel reaches the answer LLM.
  //                     Matches v2.10.5 baseline (83.0% LongMemEval).
  //   flat-mixed      — sectioned packet from iter-1 (markdown headers,
  //                     no two-channel separation). The "current bad
  //                     architecture" reference for the bench.
  //   memory-packet   — MemoryPacket compiler + two-channel retrieval +
  //                     XML/inline-hints renderer + mema extensions
  //                     (CURRENT_STATE, CONFLICTS, UNCERTAINTY, INSTRUCTIONS).
  //                     The headline v2.11 mode.
  //   routed-packet   — memory-packet with answer-strategy classifier
  //                     applied per question (v2.11 routing is rule-based;
  //                     LLM classifier deferred to v2.12).
  //   zep-format      — same hits, Zep's exact format (FACTS / ENTITIES /
  //                     EPISODES) with NO mema extensions. The control
  //                     variant — if memory-packet >= zep-format on bench,
  //                     our extensions earn their keep.
  contextMode: "episode-only" | "flat-mixed" | "memory-packet" | "routed-packet" | "zep-format";
  // v2.12.0+ — when on, runs a SECOND LLM call per question to grade the
  // context packet's completeness (COMPLETE/PARTIAL/INSUFFICIENT). Zep's
  // 2nd primary metric. Adds ~30-60s per question when on.
  gradeCompleteness: boolean;
}

// v2.11.0+ — recall response hit, mirroring src/v2/types.ts RetrievalHit.
// The harness only needs id + kind + excerpt + payload; the full type is
// duplicated here to keep bench/ free of imports from src/ wherever possible.
interface RecallHit {
  kind: "episode" | "fact" | "cognitive" | "entity";
  id: string;
  excerpt: string;
  payload?: {
    // fact
    subject?: string;
    predicate?: string;
    object?: string;
    valid_from?: string;
    invalidated_at?: string;
    // cognitive
    content?: string;
    cognitive_kind?: "belief" | "observation" | "experience";
    confidence?: number;
    // entity
    name?: string;
    entity_type?: string;
    aliases?: string[];
  };
}

interface ChatTurn { role: string; content: string }
interface LMERecord {
  question_id: string;
  question_type: string;
  question: string;
  // v2.12.1+ — LongMemEval multi-session counting questions have INTEGER
  // gold answers (e.g. 3, 2). Pre-coercion the harness crashed with
  // `.toLowerCase is not a function` and silently dropped those questions.
  answer: string | number;
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
  // v2.12.0+ — items rejected by zod schema validation at the extractor
  // boundary, before any /v2/fact or /v2/entity POST.
  rejected_invalid_facts?: number;
  rejected_invalid_entities?: number;
  // v2.12.0+ — was the gold answer string actually present in the rendered
  // packet sent to the answer LLM? Decomposes "answer wrong" into:
  //   gold_in_context=true  AND judge=0 → reading failure (LLM had it, missed it)
  //   gold_in_context=false AND judge=0 → context failure (retrieval/compile lost it)
  gold_in_context?: boolean;
  // v2.12.0+ — what actually made it into the rendered packet AFTER budget
  // truncation. Counts the structured items the LLM saw, not what was
  // retrieved. Tells us if our compiler is wasting structured signal.
  packet_usage?: {
    facts_rendered: number;
    cognitive_rendered: number;
    entities_rendered: number;
    episodes_rendered: number;
    total_chars: number;
  };
  // v2.12.0+ — LLM-graded context-completeness (Zep's 2nd primary metric).
  // Populated only when --grade-completeness flag is on.
  context_completeness?: CompletenessVerdict;
  predicted_answer?: string;
  // v2.11.1+ — null means judge infrastructure failed after retries
  // (distinct from 0 = genuine INCORRECT). Consumers of the JSONL should
  // treat null and undefined differently from 0 when aggregating Answer%.
  judge_score?: number | null;
  judge_reason?: string;
  answer_ms?: number;
  judge_ms?: number;
  // v2.11.2+ — answer shape classification (correct% vs wrong-confident% vs
  // no-answer% vs empty%). Empirical defense against INSTRUCTIONS-softening
  // hallucination risk: if a future bench shows no-answer% dropping while
  // wrong-confident% rises, the softening is trading abstention for
  // confabulation (BAD). Tracked alongside judge_score so the comparison
  // tool can break apart "judge said 0" into "LLM said no-answer" vs
  // "LLM confidently said wrong thing".
  answer_shape?: AnswerShape;
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
    // v2.11.0+ context-compilation mode. Default "flat-mixed" keeps the
    // iter-1 v2.11.0-rc.1 behavior for back-compat. The new headline mode
    // is "memory-packet" (compiler + two-channel retrieval + XML format).
    contextMode: (flags["context-mode"] ? String(flags["context-mode"]) : "flat-mixed") as Args["contextMode"],
    gradeCompleteness: !!flags["grade-completeness"],
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

// v2.12.1+ — context-mode-aware answer prompts. Three families, each
// written from scratch for mema's harness. The shared design principle:
// the prompt must match the SHAPE of the context the worker sees.
//
//   FLAT_PROMPT      — for raw conversational context (episode-only,
//                      flat-mixed, and zep-format). The context is text;
//                      the prompt asks for a short grounded answer.
//
//   PACKET_PROMPT    — for the Memory Packet's typed sections (facts +
//                      entities + episodes + Datalog rules). The prompt
//                      explicitly references mema's structural artifacts
//                      so the worker exploits them.
//
// All prompts are mema-original. The fair-comparison property is
// preserved by giving every mode an equally tight, equally well-formed
// prompt — not by copying a competitor's exact prose.

const FLAT_PROMPT = (question: string, context: string, questionDate?: string) =>
  `You answer questions about a user's past conversations using only the supplied context.

${questionDate ? `Reference date for the question: ${questionDate}
Treat any session or statement dated AFTER this reference date as not-yet-known.

` : ""}Context (chronological transcript, oldest first):
${context}

Question:
${question}

How to choose your answer — two task classes with opposite failure modes:

  Factual recall ("when did I", "what did I say about", "who is", counting, "current"/"now", knowledge-update):
    • Counting / multi-session — enumerate every relevant occurrence across the transcript before answering.
    • "Current" / "now" — use the LATEST relevant statement on or before the reference date.
    • Knowledge-update — prefer the newer statement over older contradicting ones.
    • If the context truly lacks the answer, reply: no answer

  Personalization ("recommend", "suggest", "what should I", "help me pick", "what kind of"):
    Filter the answer through the user's stored preferences, tastes, and patterns. If exact-match preferences for the topic are absent, transfer from adjacent stored facts (past choices, stated likes, recurring patterns, related domains). Refusing to answer when relevant signal exists is the worst outcome — personalize imperfectly over abstaining.

Output: a single short sentence. Nothing else.`;

const PACKET_PROMPT = (question: string, context: string, questionDate?: string) =>
  `You answer questions about a user's past conversations using a structured Memory Packet.

The packet contains three typed sections:
  <FACTS>     — extracted subject/predicate/object assertions with event_date and Datalog
                rules. A fact tagged isCurrent is true as of the reference date below;
                a fact tagged isSuperseded has been invalidated by a later contradicting fact.
  <ENTITIES>  — typed entities (person, organization, product, system, place, concept, event).
  <EPISODES>  — chronological session events for cases the facts don't cover.

${questionDate ? `Reference date for the question: ${questionDate}
Treat facts and episodes dated AFTER this reference date as not-yet-known. Trust the Datalog
rules — they have already resolved supersession; do not re-derive them from raw dates.

` : ""}Memory Packet:
${context}

Question:
${question}

How to choose your answer — two task classes with opposite failure modes:

  Factual recall (counting, "current"/"now", knowledge-update, "when did I", "what did I say"):
    • Prefer FACTS over EPISODES when both apply — facts are typed assertions with explicit dates.
    • Counting / multi-session — enumerate every relevant fact AND every relevant episode.
    • "Current" / "now" — pick the fact tagged isCurrent. If multiple, pick the highest-confidence one.
    • Knowledge-update — use the fact tagged isCurrent. Ignore facts tagged isSuperseded.
    • If the packet truly lacks the answer, reply: no answer

  Personalization ("recommend", "suggest", "what should I", "help me pick", "what kind of"):
    Filter the answer through the user's stored preferences in FACTS and ENTITIES. If exact-match preferences for the topic are absent, transfer from adjacent stored facts (past choices, stated likes, recurring patterns, related domains). Treat facts with confidence ≥ 0.85 as durable preferences; lower-confidence facts and episodes are corroborative. Refusing to answer when relevant signal exists is the worst outcome — personalize imperfectly over abstaining.

Output: a single short sentence. Nothing else.`;

function selectAnswerPrompt(contextMode: Args["contextMode"]) {
  if (contextMode === "memory-packet" || contextMode === "routed-packet") return PACKET_PROMPT;
  return FLAT_PROMPT;
}

// v2.11.2+ — JUDGE_PROMPT lives in bench/bench-utils.ts as judgePrompt().
const JUDGE_PROMPT = (question: string, gold: string, predicted: string) =>
  judgePrompt("LongMemEval", question, gold, predicted);

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

// v2.11.2+ — callClaudeCLI + callCodexCLI live in bench/bench-utils.ts.
async function callBackend(backend: AnswerBackend, args: Args, model: string, prompt: string, timeoutMs?: number): Promise<string | null> {
  if (backend === "claude") return callClaudeCLI(prompt, timeoutMs ?? 120000);
  if (backend === "codex") return callCodexCLI(prompt, timeoutMs ?? 180000);
  if (backend === "gemini") return callGeminiCLI(prompt, timeoutMs ?? 180000);
  return callOllama(args.ollamaHost, model, prompt, timeoutMs ?? 60000);
}

async function generateAnswer(
  args: Args,
  question: string,
  context: string,
  questionDate?: string,
): Promise<{ answer: string; ms: number }> {
  const t = Date.now();
  // v2.12.1+ — select prompt by context mode so each mode gets a prompt
  // matched to its context shape. See selectAnswerPrompt above.
  const promptFn = selectAnswerPrompt(args.contextMode);
  const a = await callBackend(args.answerBackend, args, args.judgeModel, promptFn(question, context, questionDate));
  return { answer: (a ?? "no answer").slice(0, 500), ms: Date.now() - t };
}

// v2.11.1+ — judge with retry + secondary-judge fallback. The original
// implementation called the judge backend ONCE and silently returned
// score=0 on empty response. The N=30 bench showed ~10% of judge calls
// returned empty (9/90), polluting the headline number by ~10pp. Pattern:
//   1. Call primary judge (args.judgeBackend), up to 3 attempts on empty
//   2. If still no response, fall back to the OTHER backend (claude if
//      primary was codex, codex if primary was claude), up to 2 attempts
//   3. Only if both fail across all retries, return score=null +
//      reason="judge-no-response-after-retries". score=null lets the
//      consumer distinguish "judge failed" from a genuine "INCORRECT".
export async function judgeWithRetry(
  args: Args,
  question: string,
  gold: string,
  predicted: string,
): Promise<{ score: number | null; reason: string; ms: number }> {
  const t = Date.now();
  if (args.judge === "substring") {
    const ok = substringMatch(gold, predicted);
    return { score: ok ? 1 : 0, reason: ok ? "substring-match" : "substring-miss", ms: Date.now() - t };
  }
  if (args.judge !== "llm") {
    return { score: 0, reason: "judge-disabled", ms: 0 };
  }

  // Primary judge (args.judgeBackend), up to 3 attempts via the shared
  // retryVerdict kernel.
  const primary = args.judgeBackend;
  const primaryPrompt = JUDGE_PROMPT(question, gold, predicted);
  const primaryResult = await retryVerdict(
    primary,
    () => callBackend(primary, args, args.judgeModel, primaryPrompt),
    3,
  );
  if (primaryResult.verdict === "CORRECT") {
    return { score: 1, reason: primaryResult.reason, ms: Date.now() - t };
  }
  if (primaryResult.verdict === "INCORRECT") {
    return { score: 0, reason: primaryResult.reason, ms: Date.now() - t };
  }

  // Primary failed all retries. Fall back to secondary judge (OTHER backend),
  // up to 2 attempts.
  const secondary: AnswerBackend = primary === "codex" ? "claude" : "codex";
  const secondaryResult = await retryVerdict(
    secondary,
    () => callBackend(secondary, args, args.judgeModel, primaryPrompt),
    2,
  );
  if (secondaryResult.verdict === "CORRECT") {
    return { score: 1, reason: `${secondary}-fallback: ${secondaryResult.reason}`, ms: Date.now() - t };
  }
  if (secondaryResult.verdict === "INCORRECT") {
    return { score: 0, reason: `${secondary}-fallback: ${secondaryResult.reason}`, ms: Date.now() - t };
  }

  // Both judges failed all retries. Return null score so consumer can
  // distinguish judge failure from a genuine "INCORRECT".
  return {
    score: null,
    reason: `judge-no-response-after-retries (primary=${primaryResult.reason.slice(0, 60)}, secondary=${secondaryResult.reason.slice(0, 60)})`,
    ms: Date.now() - t,
  };
}

// (judgeAnswer back-compat shim removed v2.11.1 — runQuestion calls
// judgeWithRetry directly and preserves the score=null distinction in
// ScoredQuestion.judge_score so JSONL consumers see judge failures.)

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
  // v2.12.0+ — items rejected by zod schema validation (malformed
  // event_date, missing fields, generic predicates, etc.) BEFORE they
  // reach the mema /v2/fact and /v2/entity endpoints.
  let rejectedInvalidFacts = 0, rejectedInvalidEntities = 0;
  if (args.extract) {
    // v2.10.6+ extractor-backend selection.
    const ollamaExtractor = args.extractorBackend === "ollama" ? await pickExtractor() : null;
    const extractorName = args.extractorBackend === "claude" ? "claude-cli"
      : args.extractorBackend === "codex" ? "codex-cli"
      : args.extractorBackend === "gemini" ? "gemini-cli"
      : ollamaExtractor!.name;
    const AUTO_APPROVE_THRESHOLD = 0.9;
    for (const [sid, epId] of sessionToEpisode) {
      const idx = rec.haystack_session_ids.indexOf(sid);
      const body = sessionToContent(rec.haystack_sessions[idx], sid, "");
      // v2.11.1+ — pass the session's haystack date as OBSERVATION_DATE so
      // the extractor can ground relative temporal refs ("yesterday", "today")
      // to the actual conversation time, not to extractor-run time.
      // v2.11.1+ — temporal-grounding rule: NEVER fall back to wall-clock
      // now() here. If the LongMemEval record has neither a haystack_date
      // nor a question_date, fail loudly rather than silently re-introduce
      // the v2.11.0-rc.1 bug. Per critic review of v2.11.1.
      const observationDate = rec.haystack_dates[idx] ?? rec.question_date;
      if (!observationDate) {
        throw new Error(`[harness] missing haystack_dates[${idx}] and question_date for question ${rec.question_id}; cannot ground extraction temporally`);
      }
      // v2.11.1+ — Ollama extractor doesn't thread observationDate yet (v2.13
      // work). Warn loudly so a Claude-grounded bench's results aren't quietly
      // compared against an Ollama-extracted run.
      if (args.extractorBackend === "ollama") {
        console.warn(`[harness] WARNING: --extractor-backend ollama does NOT propagate observation_date to the extractor. Facts will be stamped with extraction-time (today), reproducing the v2.11.0-rc.1 temporal-grounding bug. Use --extractor-backend claude or codex for honest bench numbers.`);
      }
      let result;
      try {
        if (args.extractorBackend === "claude") {
          result = await extractViaClaude(body, observationDate);
        } else if (args.extractorBackend === "codex") {
          result = await extractViaCodex(body, observationDate);
        } else if (args.extractorBackend === "gemini") {
          result = await extractViaGemini(body, observationDate);
        } else {
          // Ollama path doesn't yet thread observation_date; future v2.13 work.
          result = await ollamaExtractor!.extract(body);
        }
      } catch { continue; }
      // v2.12.0+ — Zod schema validation on extractor output. Reject malformed
      // facts/entities at the boundary so polluted memory never enters the vault.
      // The validated result has accepted items + per-item rejection reasons.
      const validated = validateExtractorOutput(result);
      rejectedInvalidFacts += validated.rejections.filter(r => r.kind === "fact").length;
      rejectedInvalidEntities += validated.rejections.filter(r => r.kind === "entity").length;
      // Write entity drafts first.
      for (const e of validated.entities) {
        const name = e.name.trim();
        try {
          await apiOwner("/v2/entity", {
            name, type: e.type,
            status: "draft", derived_from: [epId],
            evidence_excerpt: body.slice(0, 400),
            proposed_by: `lmebench:${extractorName}`,
          });
          extractedEntities++;
        } catch { /* dedup/etc */ }
      }
      // Write fact drafts + auto-approve high-confidence ones with evidence.
      for (const f of validated.facts) {
        const subj = f.subject.trim();
        const pred = f.predicate.trim();
        const obj  = f.object.trim();
        const conf = f.confidence;
        // Schema already enforced non-empty subject/predicate/object and conf >= 0.75
        // and event_date format. Soft check below is defense in depth.
        if (!subj || !pred || !obj) continue;
        // v2.11.1+ — sanitize the extractor's event_date and use it as
        // valid_from on the fact record. Falls back to observationDate via
        // sanitizeEventDate when missing or malformed.
        const validFrom = sanitizeEventDate(f.event_date, observationDate);
        let createdId: string | null = null;
        try {
          const r = await apiOwner("/v2/fact", {
            subject: subj, predicate: pred, object: obj,
            derived_from: [epId],
            confidence: Math.min(Math.max(conf, 0), 1),
            valid_from: validFrom,
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

  // 3. Recall — v2.11.0+ mode-aware dispatch.
  //
  // contextMode dictates retrieval shape:
  //   episode-only     — single /v2/recall, kinds=["episode"]
  //   flat-mixed       — single /v2/recall, kinds=args.kinds (the iter-1
  //                      sectioned-packet baseline; the "bad architecture"
  //                      reference for the bench)
  //   memory-packet    — /v2/recall/packet (two channels, no displacement)
  //   routed-packet    — /v2/recall/packet + answer-strategy routing
  //   zep-format       — /v2/recall/packet (same hits, Zep-format render)
  const t1 = Date.now();
  let retrievedSessions: string[] = [];
  let factHits: RecallHit[] = [];
  let cognitiveHits: RecallHit[] = [];
  let entityHits: RecallHit[] = [];
  let twoChannelHits: TwoChannelHits | null = null;

  const useTwoChannel =
    args.contextMode === "memory-packet" ||
    args.contextMode === "routed-packet" ||
    args.contextMode === "zep-format";

  if (args.retrievalMode === "full-context") {
    // Oracle upper bound: every haystack session in order is "retrieved".
    retrievedSessions = [...rec.haystack_session_ids];
  } else if (useTwoChannel) {
    // Two-channel retrieval — evidence (episodes) + memory (facts/cog/ent)
    // returned as independent pools. No shared top-K, no displacement.
    const useVector = args.retrievalMode === "vector" || args.retrievalMode === "hybrid";
    const recallRes = await apiOwner("/v2/recall/packet", {
      query: rec.question,
      purpose: `longmemeval_${args.contextMode}_${args.fusion}`,
      limit_evidence: args.topK,
      limit_memory: Math.max(args.topK * 2, 20),
      use_vector: useVector,
      fusion: args.fusion,
      // v2.13.1 reverted v2.13.0's `temporal: { valid_at: rec.question_date }`
      // pass-through. Measurement showed memory-packet regressing 83.3% → 75.9%
      // (-7.4pp), with -20pp drops on temporal-reasoning, multi-session, and
      // single-session-preference. Root cause: src/v2/layer5-retrieval.ts uses
      // `validAt` for BOTH (a) fact-validity filter (intended use) AND (b)
      // recency-scoring nowMs (unintended side effect). With validAt = past
      // question_date, recency for ALL candidates is computed relative to
      // the past, changing which top-K hits get ranked highest.
      // Re-enable after src/v2/layer5-retrieval.ts is changed to separate
      // filtering validAt from recency nowMs.
    });
    if (recallRes.ok) {
      const rj = await recallRes.json() as {
        evidence_channel: RetrievalHit[];
        memory_channel: RetrievalHit[];
      };
      twoChannelHits = {
        evidence_channel: rj.evidence_channel,
        memory_channel: rj.memory_channel,
      };
      // Map episode hits → session IDs for the Hit@K scoring.
      const idToSession = new Map<string, string>();
      for (const [sid, eid] of sessionToEpisode) idToSession.set(eid, sid);
      retrievedSessions = rj.evidence_channel
        .filter(h => h.kind === "episode")
        .map(h => idToSession.get(h.id) ?? h.id);
    }
  } else {
    // Single-pool recall (episode-only or flat-mixed modes).
    const effectiveKinds =
      args.contextMode === "episode-only" ? ["episode"] : args.kinds;
    const useVector = args.retrievalMode === "vector" || args.retrievalMode === "hybrid";
    const recallRes = await apiOwner("/v2/recall", {
      query: rec.question,
      purpose: `longmemeval_${args.contextMode}_${args.fusion}_${effectiveKinds.join("+")}`,
      kinds: effectiveKinds,
      limit: args.topK,
      use_vector: useVector,
      fusion: args.fusion,
      // v2.13.1 reverted (see note in /v2/recall/packet call above).
    });
    if (recallRes.ok) {
      const rj = await recallRes.json() as { hits: RecallHit[] };
      const idToSession = new Map<string, string>();
      for (const [sid, eid] of sessionToEpisode) idToSession.set(eid, sid);
      retrievedSessions = rj.hits
        .filter(h => h.kind === "episode")
        .map(h => idToSession.get(h.id) ?? h.id);
      factHits = rj.hits.filter(h => h.kind === "fact" && h.payload);
      cognitiveHits = rj.hits.filter(h => h.kind === "cognitive" && h.payload?.content);
      entityHits = rj.hits.filter(h => h.kind === "entity" && h.payload);
    }
  }
  const recallMs = Date.now() - t1;

  const hits = scoreHits(retrievedSessions, rec.answer_session_ids);

  // v2.9.0+ answer-level scoring: generate an answer from the retrieved
  // context and judge it. We use the top-K retrieved sessions' content
  // as the context packet, truncated to args.contextChars.
  let predictedAnswer: string | undefined;
  let judgeScore: number | null | undefined;
  let judgeReason: string | undefined;
  let answerMs: number | undefined;
  let judgeMs: number | undefined;
  // v2.12.0+ — diagnostic metrics populated during packet render + answer + judge.
  let goldInCtx: boolean | undefined;
  let packetUsage: ScoredQuestion["packet_usage"];
  let contextCompleteness: CompletenessVerdict | undefined;

  // v2.10.4+: chronological ordering by haystack_date for the evidence
  // timeline. v2.11.0+: contextMode dispatches the rendering strategy.
  const hasAnyContent =
    retrievedSessions.length > 0 ||
    factHits.length > 0 ||
    cognitiveHits.length > 0 ||
    entityHits.length > 0 ||
    (twoChannelHits !== null && (
      twoChannelHits.evidence_channel.length > 0 ||
      twoChannelHits.memory_channel.length > 0
    ));

  if (args.judge !== "none" && hasAnyContent) {
    const sidToContent = new Map<string, string>();
    const sidToDate = new Map<string, string>();
    for (let i = 0; i < rec.haystack_session_ids.length; i++) {
      const sid = rec.haystack_session_ids[i];
      sidToContent.set(sid, sessionToContent(rec.haystack_sessions[i], sid, rec.haystack_dates[i]));
      sidToDate.set(sid, rec.haystack_dates[i] ?? "");
    }

    let ctx = "";

    // ── modes memory-packet / routed-packet / zep-format ─────────────
    if (twoChannelHits !== null && (
      args.contextMode === "memory-packet" ||
      args.contextMode === "routed-packet" ||
      args.contextMode === "zep-format"
    )) {
      // Map episode hit id → session content + date for the raw-excerpts section.
      const idToSession = new Map<string, string>();
      for (const [sid, eid] of sessionToEpisode) idToSession.set(eid, sid);
      const rawSessionText = new Map<string, { date?: string; text: string }>();
      for (const h of twoChannelHits.evidence_channel) {
        const sid = idToSession.get(h.id);
        if (!sid) continue;
        const text = sidToContent.get(sid);
        const date = sidToDate.get(sid);
        if (text) rawSessionText.set(h.id, { ...(date ? { date } : {}), text });
      }

      const packet = buildMemoryPacket({
        query: rec.question,
        question_date: rec.question_date,
        // routed-packet uses the LongMemEval category to pick a strategy.
        // memory-packet and zep-format use the rule classifier (or default).
        ...(args.contextMode === "routed-packet"
          ? { question_type: rec.question_type }
          : {}),
        hits: twoChannelHits,
        raw_session_text: rawSessionText,
      });

      // mode E (zep-format) renders the SAME packet without mema extensions.
      ctx = args.contextMode === "zep-format"
        ? compilePacketAsZepFormat(packet)
        : compilePacketToPrompt(packet, { budget: args.contextChars });

      // Defensive cap for the zep-format renderer (which doesn't budget itself).
      if (ctx.length > args.contextChars) ctx = ctx.slice(0, args.contextChars);

      // v2.12.0+ — packet usage stats from the actually-rendered packet object.
      packetUsage = {
        facts_rendered: packet.approved_facts.length,
        cognitive_rendered: packet.cognitive_beliefs.length,
        entities_rendered: packet.entities.length,
        episodes_rendered: packet.raw_supporting_excerpts.length,
        total_chars: ctx.length,
      };
    }

    // ── mode episode-only ────────────────────────────────────────────
    else if (args.contextMode === "episode-only") {
      const ctxParts: string[] = [];
      const topKRetrieved = retrievedSessions.slice(0, args.topK);
      const chronological = [...topKRetrieved].sort((a, b) => {
        const da = sidToDate.get(a) ?? "";
        const db = sidToDate.get(b) ?? "";
        return da.localeCompare(db);
      });
      let budget = args.contextChars;
      let episodesRendered = 0;
      for (const sid of chronological) {
        const part = sidToContent.get(sid);
        if (!part) continue;
        const slice = part.slice(0, Math.max(0, budget));
        if (!slice) break;
        ctxParts.push(slice);
        budget -= slice.length;
        episodesRendered++;
        if (budget <= 0) break;
      }
      ctx = ctxParts.join("\n\n---\n\n");
      packetUsage = {
        facts_rendered: 0,
        cognitive_rendered: 0,
        entities_rendered: 0,
        episodes_rendered: episodesRendered,
        total_chars: ctx.length,
      };
    }

    // ── mode flat-mixed (iter-1 sectioned packet, the "bad architecture" ref) ─
    else {
      const ctxParts: string[] = [];
      const totalBudget = args.contextChars;
      const nonEpisodeReserve = Math.floor(totalBudget * 0.25);
      let nonEpUsed = 0;

      // ── Section 1: APPROVED FACTS ─────────────────────────────────
      if (factHits.length > 0) {
      const sorted = [...factHits].sort((a, b) => {
        const va = a.payload?.valid_from ?? "";
        const vb = b.payload?.valid_from ?? "";
        return va.localeCompare(vb);
      });
      const lines: string[] = ["# APPROVED FACTS (sorted by validity)"];
      for (const f of sorted) {
        const date = (f.payload?.valid_from ?? "").slice(0, 10) || "unknown-date";
        const inv = f.payload?.invalidated_at
          ? `  (invalidated ${String(f.payload.invalidated_at).slice(0, 10)})`
          : "";
        const subj = f.payload?.subject ?? "?";
        const pred = f.payload?.predicate ?? "?";
        const obj = f.payload?.object ?? "?";
        lines.push(`- [${date}] ${subj} ${pred} ${obj}${inv}`);
      }
      const block = lines.join("\n");
      const room = nonEpisodeReserve - nonEpUsed;
      const slice = block.length <= room ? block : block.slice(0, Math.max(0, room));
      if (slice) {
        ctxParts.push(slice);
        nonEpUsed += slice.length;
      }
    }

    // ── Section 2: COGNITIVE BELIEFS ──────────────────────────────
    if (cognitiveHits.length > 0 && nonEpUsed < nonEpisodeReserve) {
      const lines: string[] = ["# COGNITIVE BELIEFS"];
      for (const c of cognitiveHits) {
        const kind = c.payload?.cognitive_kind ?? "belief";
        const content = (c.payload?.content ?? "").replace(/\s+/g, " ").trim();
        lines.push(`- [${kind}] ${content}`);
      }
      const block = lines.join("\n");
      const room = nonEpisodeReserve - nonEpUsed;
      const slice = block.length <= room ? block : block.slice(0, Math.max(0, room));
      if (slice) {
        ctxParts.push(slice);
        nonEpUsed += slice.length;
      }
    }

    // ── Section 3: ENTITIES ───────────────────────────────────────
    if (entityHits.length > 0 && nonEpUsed < nonEpisodeReserve) {
      const lines: string[] = ["# ENTITIES"];
      for (const e of entityHits) {
        const name = e.payload?.name ?? "?";
        const type = e.payload?.entity_type ?? "?";
        const aliases = e.payload?.aliases && e.payload.aliases.length > 0
          ? `, aliases: ${e.payload.aliases.join(", ")}`
          : "";
        lines.push(`- ${name} (${type})${aliases}`);
      }
      const block = lines.join("\n");
      const room = nonEpisodeReserve - nonEpUsed;
      const slice = block.length <= room ? block : block.slice(0, Math.max(0, room));
      if (slice) {
        ctxParts.push(slice);
        nonEpUsed += slice.length;
      }
    }

      // ── Section 4: EVIDENCE TIMELINE (episodes, chronological) ────
      // Episode budget = full budget MINUS what non-episode sections actually used.
      // (Unused non-episode reserve rolls back to episodes.)
      if (retrievedSessions.length > 0) {
        const topKRetrieved = retrievedSessions.slice(0, args.topK);
        const chronological = [...topKRetrieved].sort((a, b) => {
          const da = sidToDate.get(a) ?? "";
          const db = sidToDate.get(b) ?? "";
          return da.localeCompare(db);
        });
        const header = "# EVIDENCE TIMELINE";
        let epBudget = totalBudget - nonEpUsed - header.length;
        if (epBudget > 0) {
          ctxParts.push(header);
          for (const sid of chronological) {
            const part = sidToContent.get(sid);
            if (!part) continue;
            const slice = part.slice(0, Math.max(0, epBudget));
            if (!slice) break;
            ctxParts.push(slice);
            epBudget -= slice.length;
            if (epBudget <= 0) break;
          }
        }
      }

      ctx = ctxParts.join("\n\n---\n\n");
      // flat-mixed packet usage (counts what we retrieved that COULD have been
      // rendered; budget truncation in sections 1-3 is best-effort tracked by
      // counting items intended to render — accurate within ~1 item).
      packetUsage = {
        facts_rendered: factHits.length,
        cognitive_rendered: cognitiveHits.length,
        entities_rendered: entityHits.length,
        episodes_rendered: Math.min(retrievedSessions.length, args.topK),
        total_chars: ctx.length,
      };
    }

    // v2.12.0+ — gold-in-context: was the gold answer string actually IN the
    // rendered packet? Computed BEFORE the answer LLM sees it, so we can
    // distinguish "context lacked answer" from "LLM missed the answer".
    goldInCtx = goldInContext(rec.answer, ctx);

    const gen = await generateAnswer(args, rec.question, ctx || "(no retrieved context)", rec.question_date);
    predictedAnswer = gen.answer;
    answerMs = gen.ms;
    const judge = await judgeWithRetry(args, rec.question, rec.answer, gen.answer);
    judgeScore = judge.score;  // may be null when both judges failed after retries
    judgeReason = judge.reason;
    judgeMs = judge.ms;

    // v2.12.0+ — context-completeness grading (Zep's 2nd primary metric).
    // When enabled, a separate LLM call grades the packet itself: did it
    // contain enough information to answer the question? Independent of
    // what the answer LLM did. Catches retrieval-good/compilation-bad.
    //
    // v2.12.0 (post-GPT-5.5) — uses retryCompleteness directly so the
    // three-class COMPLETE/PARTIAL/INSUFFICIENT verdict isn't crushed
    // through the binary retryVerdict (the prior bug).
    if (args.gradeCompleteness) {
      const cPrompt = completenessPrompt(rec.question, rec.answer, ctx || "(no retrieved context)");
      const cResult = await retryCompleteness(
        args.judgeBackend,
        () => callBackend(args.judgeBackend, args, args.judgeModel, cPrompt),
        3,
      );
      contextCompleteness = cResult.verdict;
    }
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
    rejected_invalid_facts: rejectedInvalidFacts,
    rejected_invalid_entities: rejectedInvalidEntities,
    ...(goldInCtx !== undefined ? { gold_in_context: goldInCtx } : {}),
    ...(packetUsage ? { packet_usage: packetUsage } : {}),
    ...(contextCompleteness !== undefined ? { context_completeness: contextCompleteness } : {}),
    predicted_answer: predictedAnswer,
    judge_score: judgeScore,
    judge_reason: judgeReason,
    answer_ms: answerMs,
    judge_ms: judgeMs,
    // v2.11.2+ — classify the LLM's response shape so the comparison tool
    // can break apart correct% / wrong-confident% / no-answer% / empty%.
    answer_shape: classifyAnswerShape(predictedAnswer),
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
  const judgeUsed = results.some(r => r.judge_score !== undefined && r.judge_score !== null);
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
      const judged = rows.filter(r => r.judge_score !== undefined && r.judge_score !== null);
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
    const judged = all.filter(r => r.judge_score !== undefined && r.judge_score !== null);
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
  console.log(`  Mode:     retrieval=${args.retrievalMode}  fusion=${args.fusion}  kinds=${args.kinds.join("+")}  context=${args.contextMode}`);
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

// v2.11.1+ — only run main() when invoked as a script; allow test files
// to import judgeWithRetry/etc. without triggering the bench loop.
if (import.meta.main) {
  main().catch(e => { console.error("fatal:", e?.message ?? e); process.exit(1); });
}
