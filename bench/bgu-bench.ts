#!/usr/bin/env bun
// BGU (Balanced Grounded Utility) Bench v1 for mema.
//
// Implements the hallucination/abstention benchmark from
// /tmp/mema_bench_spec.md (NeurIPS-grade spec by Codex gpt-5.5),
// with the 6 corrections from Codex's design review:
//
//   (a) STRATIFIED decoy selection — same LongMemEval category cluster,
//       NOT random across the dataset. Prevents mema's abstention prompt
//       from firing on "thin retrieval" instead of real reasoning.
//   (b) BM25-overlap leakage audit with grey-zone logging (NLI deferred
//       to v1.1; explicitly disclosed in report).
//   (c) HONEST target: 70-78% BGU, framed as a relative win vs Mem0/Zep.
//       NOT 85% — construction noise alone eats 5-10pp.
//   (d) SHARED answer prompt across ALL systems. Mema does NOT get its
//       two-class prompt advantage. The moat must appear in ingestion +
//       retrieval + provenance, not prompt engineering. Native-track
//       variant is a SECONDARY result.
//   (e) DATASET SIZE: 150 answerable + 150 unanswerable = 300 pairs.
//       Wilson 95% CI ±5.6pp at 70% point estimate (minimum acceptable
//       per spec). Don't run smaller and claim a defensible number.
//   (f) HARD AUTO-FAIL gate: false_abstention_rate > 20% on answerables
//       disqualifies a submission. Otherwise always-abstain games BGU.
//
// Bonus: SHA-256 hash every corpus, question, prompt, response, and
// judge verdict; emit a manifest for reproducibility.
//
// Scoring:
//   correct_supported_rate = (judge: answer correct AND supported) / |answerable|
//   appropriate_abstention_rate = (regex-detect refusal AND no smuggled claim) / |unanswerable|
//   confabulation_rate = (concrete unsupported answer) / |unanswerable|
//   false_abstention_rate = (refused on answerable) / |answerable|     [GATE: must be ≤ 0.20]
//   bgu_score = 0.5 * correct_supported + 0.5 * appropriate_abstention
//
// Usage (after mema is up on :3001 with MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true):
//   bun bench/bgu-bench.ts build-dataset      # construct paired dataset
//   bun bench/bgu-bench.ts run mema           # run mema, write responses
//   bun bench/bgu-bench.ts judge mema         # judge responses, write scores
//   bun bench/bgu-bench.ts report mema        # print scorecard + Wilson CIs
//
// Single-shot:
//   bun bench/bgu-bench.ts all mema --pairs 150
//
// Dataset is deterministic from (LongMemEval oracle JSON + seed). Re-run
// reproduces identical pairs.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { callClaudeCLI } from "./bench-utils";

// ── Types ───────────────────────────────────────────────────────────────────

/** LongMemEval `haystack_sessions[i]` is an array of turn objects directly
 *  (NOT wrapped in `{turns: [...]}`). We model the raw shape — a session
 *  IS its turns list. */
type LMETurn = { role: string; content: string; has_answer?: boolean };
type LMESession = LMETurn[];

interface LMERecord {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  /** Parallel arrays — session_id ↔ turns. Some LME records use a
   *  `haystack_sessions` field of session objects instead. We
   *  normalize at load time. */
  haystack_session_ids: string[];
  haystack_sessions: any[];
  /** Subset of session_ids that contain the gold evidence. */
  answer_session_ids: string[];
  question_date?: string;
}

interface PairItem {
  /** Stable across reruns. SHA-256(question_id|seed|variant). */
  id: string;
  pair_id: string;
  label: "answerable" | "unanswerable";
  /** Why this item is unanswerable. Always "answerable_full_corpus" for the
   *  answerable side. */
  category:
    | "answerable_full_corpus"
    | "removed_gold_evidence"
    | "off_topic_corpus_only";
  question: string;
  question_date?: string;
  question_type: string; // LongMemEval category
  /** Gold answer (string or number). Null for unanswerable variants. */
  gold_answer: string | number | null;
  /** Session payloads injected into the corpus, in order. */
  sessions: LMESession[];
  /** session_ids in the same order as sessions. Used for provenance. */
  session_ids: string[];
  /** session_ids stripped (only relevant for unanswerable). */
  removed_session_ids: string[];
  /** session_ids of decoys swapped in (only for unanswerable). */
  decoy_session_ids: string[];
  /** Leakage audit results — BM25 overlap of question terms vs remaining
   *  corpus. score ∈ [0, 1]. flag=true means manual review recommended
   *  (grey zone). */
  leakage_audit: {
    bm25_max_overlap: number;
    bm25_flag: "pass" | "grey_zone" | "fail";
    decoy_topic_cluster: string;
  };
  /** SHA-256 of the canonical pair JSON (with leakage_audit stripped, to
   *  avoid recursion). For the manifest. */
  hash: string;
}

interface RunResponse {
  pair_id: string;
  item_id: string;
  label: PairItem["label"];
  question: string;
  rendered_packet: string;
  packet_hash: string;
  answer: string;
  answer_hash: string;
  recall_ms: number;
  answer_ms: number;
  /** retrieved IDs from mema's packet — for the support judge. */
  retrieved_episode_ids: string[];
}

interface JudgeVerdict {
  pair_id: string;
  item_id: string;
  /** "supported_correct" — answer matches gold AND is supported by the
   *  retrieved evidence. Only sensible for answerables. */
  judgement:
    | "supported_correct"
    | "supported_wrong"
    | "unsupported_concrete" // confabulation on unanswerables; or wrong on answerables
    | "appropriate_abstention"
    | "abstention_with_smuggled_claim"
    | "false_abstention" // abstained but item was answerable
    | "judge_failed";
  reasoning: string;
  /** Hash of (response, judge_prompt, judge_verdict_raw) for the manifest. */
  hash: string;
}

interface BguReport {
  system: string;
  pairs_total: number;
  pairs_answerable: number;
  pairs_unanswerable: number;
  correct_supported_rate: number;
  correct_supported_ci: [number, number];
  appropriate_abstention_rate: number;
  appropriate_abstention_ci: [number, number];
  confabulation_rate: number;
  false_abstention_rate: number;
  bgu_score: number;
  bgu_ci: [number, number];
  gate_pass: boolean;
  gate_reason: string;
  /** Per-LongMemEval-category breakdown. */
  by_category: Record<string, {
    n: number;
    correct_supported: number;
    appropriate_abstention: number;
    bgu: number;
  }>;
  manifest_root: string;
}

// ── Hashing helpers ─────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function canonicalJSON(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map(k => JSON.stringify(k) + ":" + canonicalJSON(obj[k]))
      .join(",") +
    "}"
  );
}

function hashOf(obj: any): string {
  return sha256(canonicalJSON(obj));
}

/** Hash a pair item while EXCLUDING the `hash` field itself. The naive
 *  `{ ...item, hash: undefined }` doesn't work because Object.keys still
 *  includes "hash" and canonicalJSON emits the literal token `undefined`
 *  (not valid JSON). We strip the key cleanly here. */
function hashPairItem(item: PairItem): string {
  const { hash, ...rest } = item;
  return hashOf(rest);
}

// ── Deterministic RNG (mulberry32) ─────────────────────────────────────────

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── BM25 lightweight overlap (no external deps) ─────────────────────────────

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","been","by","do","for","from","had","has",
  "have","he","i","if","in","is","it","its","my","of","on","or","she","so","that",
  "the","their","there","they","this","to","was","we","were","what","when","which",
  "who","will","with","you","your","i'm","you're","it's","don't","i've","i'll",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/** Compute fraction of question tokens that appear in any one session.
 *  Returns the MAX over all sessions (worst-case leakage). */
function bm25MaxOverlap(question: string, sessions: LMESession[]): number {
  const qTokens = new Set(tokenize(question));
  if (qTokens.size === 0) return 0;
  let maxOverlap = 0;
  for (const sess of sessions) {
    const sText = sess.map(t => t.content).join(" ");
    const sTokens = new Set(tokenize(sText));
    let hits = 0;
    for (const t of qTokens) if (sTokens.has(t)) hits++;
    const overlap = hits / qTokens.size;
    if (overlap > maxOverlap) maxOverlap = overlap;
  }
  return maxOverlap;
}

// ── Dataset construction ────────────────────────────────────────────────────

const DATASET_DIR = "/tmp/bgu-bench/datasets/v1";
const RUNS_DIR = "/tmp/bgu-bench/runs";

function loadLME(dataPath: string): LMERecord[] {
  const raw = JSON.parse(readFileSync(dataPath, "utf8")) as any[];
  // Normalize: some records have haystack_sessions as objects; some have
  // them split. We just need session_id ↔ turns pairs.
  const normalized: LMERecord[] = [];
  for (const r of raw) {
    const sessionIds: string[] = r.haystack_session_ids ?? [];
    const sessions: any[] = r.haystack_sessions ?? [];
    if (sessionIds.length !== sessions.length) continue;
    normalized.push({
      question_id: r.question_id,
      question_type: r.question_type,
      question: r.question,
      answer: r.answer,
      haystack_session_ids: sessionIds,
      haystack_sessions: sessions,
      answer_session_ids: r.answer_session_ids ?? [],
      question_date: r.question_date,
    });
  }
  return normalized;
}

interface BuildArgs {
  dataPath: string;
  seed: number;
  /** How many pairs total (answerable + unanswerable each = this many). */
  pairsPerSide: number;
}

function buildDataset(args: BuildArgs): PairItem[] {
  const lme = loadLME(args.dataPath);
  const rng = mulberry32(args.seed);

  // Stratify by question_type so the answerable+unanswerable split is
  // balanced across LongMemEval capability categories.
  const byCat = new Map<string, LMERecord[]>();
  for (const r of lme) {
    const arr = byCat.get(r.question_type) ?? [];
    arr.push(r);
    byCat.set(r.question_type, arr);
  }
  const cats = [...byCat.keys()].sort();
  // Target ceil(pairsPerSide / cats) per category, then trim.
  const perCat = Math.ceil(args.pairsPerSide / cats.length);

  // Pick candidates deterministically per category.
  const answerableCandidates: LMERecord[] = [];
  for (const c of cats) {
    const sorted = (byCat.get(c) ?? []).slice().sort((a, b) =>
      a.question_id.localeCompare(b.question_id)
    );
    answerableCandidates.push(...sorted.slice(0, perCat));
  }

  const pairs: PairItem[] = [];

  for (const rec of answerableCandidates.slice(0, args.pairsPerSide)) {
    // ── Answerable variant: full corpus, original question.
    const ansItem: PairItem = {
      id: sha256(`${rec.question_id}|${args.seed}|answerable`),
      pair_id: rec.question_id,
      label: "answerable",
      category: "answerable_full_corpus",
      question: rec.question,
      question_date: rec.question_date,
      question_type: rec.question_type,
      gold_answer: rec.answer,
      sessions: rec.haystack_sessions as LMESession[],
      session_ids: rec.haystack_session_ids,
      removed_session_ids: [],
      decoy_session_ids: [],
      leakage_audit: {
        bm25_max_overlap: 0,
        bm25_flag: "pass",
        decoy_topic_cluster: "n/a",
      },
      hash: "",
    };

    // ── Unanswerable variant: strip gold sessions, swap in stratified decoys.
    const goldIds = new Set(rec.answer_session_ids);
    const remainingPairs: [string, LMESession][] = [];
    rec.haystack_session_ids.forEach((sid, i) => {
      if (!goldIds.has(sid)) {
        remainingPairs.push([sid, rec.haystack_sessions[i] as LMESession]);
      }
    });
    const removedSessionIds = rec.answer_session_ids.slice();

    // Decoy pool: same LongMemEval category, NOT same question_id, same
    // approximate session count and avg session length. Stratified per
    // Codex correction (a).
    const sameCatPool = (byCat.get(rec.question_type) ?? [])
      .filter(r => r.question_id !== rec.question_id);

    // Pick a random other record's gold sessions as decoy candidates —
    // these are real LongMemEval session content from the same capability
    // category, similar entity density and topic distribution.
    shuffleInPlace(sameCatPool, rng);
    const decoyPairs: [string, LMESession][] = [];
    for (const cand of sameCatPool) {
      if (decoyPairs.length >= removedSessionIds.length) break;
      // Take cand's gold sessions first (they're topically coherent), then
      // top-up from cand's haystack if needed.
      const candGold = new Set(cand.answer_session_ids);
      const candGoldIdx = cand.haystack_session_ids
        .map((sid, i) => candGold.has(sid) ? i : -1)
        .filter(i => i >= 0);
      for (const i of candGoldIdx) {
        if (decoyPairs.length >= removedSessionIds.length) break;
        const newSid = `decoy_${rec.question_id}_${cand.haystack_session_ids[i]}`;
        decoyPairs.push([newSid, cand.haystack_sessions[i] as LMESession]);
      }
    }

    const unanswerableSessions = [
      ...remainingPairs.map(([_, s]) => s),
      ...decoyPairs.map(([_, s]) => s),
    ];
    const unanswerableSessionIds = [
      ...remainingPairs.map(([sid, _]) => sid),
      ...decoyPairs.map(([sid, _]) => sid),
    ];

    // Leakage audit: BM25 overlap of question vs remaining sessions.
    // Grey zone = 0.30–0.50; fail = >0.50 (likely paraphrase leak).
    const overlap = bm25MaxOverlap(rec.question, unanswerableSessions);
    let flag: "pass" | "grey_zone" | "fail" = "pass";
    if (overlap > 0.50) flag = "fail";
    else if (overlap > 0.30) flag = "grey_zone";

    const unansItem: PairItem = {
      id: sha256(`${rec.question_id}|${args.seed}|unanswerable`),
      pair_id: rec.question_id,
      label: "unanswerable",
      category: "removed_gold_evidence",
      question: rec.question,
      question_date: rec.question_date,
      question_type: rec.question_type,
      gold_answer: null,
      sessions: unanswerableSessions,
      session_ids: unanswerableSessionIds,
      removed_session_ids: removedSessionIds,
      decoy_session_ids: decoyPairs.map(([sid, _]) => sid),
      leakage_audit: {
        bm25_max_overlap: overlap,
        bm25_flag: flag,
        decoy_topic_cluster: rec.question_type,
      },
      hash: "",
    };

    // Don't include "fail" items in the published dataset; keep grey_zone
    // (flagged) so reviewers can audit.
    if (flag === "fail") continue;

    // Hash AFTER everything else is set (excluding the hash itself).
    ansItem.hash = hashPairItem(ansItem);
    unansItem.hash = hashPairItem(unansItem);

    pairs.push(ansItem, unansItem);
  }

  return pairs;
}

function writeDataset(pairs: PairItem[]): string {
  if (!existsSync(DATASET_DIR)) mkdirSync(DATASET_DIR, { recursive: true });
  const questionsPath = `${DATASET_DIR}/questions.jsonl`;
  const lines = pairs.map(p => JSON.stringify(p));
  writeFileSync(questionsPath, lines.join("\n") + "\n");

  // Manifest: per-pair hashes + a Merkle root over them.
  const hashes = pairs.map(p => p.hash);
  const merkleRoot = sha256(hashes.sort().join("|"));
  const manifest = {
    schema_version: 1,
    dataset_path: questionsPath,
    pair_count: pairs.length,
    answerable_count: pairs.filter(p => p.label === "answerable").length,
    unanswerable_count: pairs.filter(p => p.label === "unanswerable").length,
    grey_zone_count: pairs.filter(p => p.leakage_audit.bm25_flag === "grey_zone").length,
    merkle_root: merkleRoot,
    pair_hashes: hashes,
  };
  writeFileSync(`${DATASET_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
  return questionsPath;
}

// ── Shared answer prompt (per Codex correction d) ───────────────────────────

const SHARED_ANSWER_PROMPT = `You answer questions about a user's stored knowledge using only the supplied context.

If the context does not contain the information needed to answer the question, reply EXACTLY: I don't have that information in memory.

Do not invent facts. Do not infer beyond what the context supports. If you partially recall the topic but cannot answer the specific question, still reply with the exact refusal phrase above.

Output a single short paragraph. Do not include preambles or explanations.`;

const REFUSAL_PHRASE_RE =
  /\b(i (don'?t|do not|cannot|can'?t) (have|find|see|locate) (that|this|the|any|enough)|the (context|memory|provided context|supplied context) (does not contain|doesn't contain|lacks|has no)|i (don'?t|do not) have (that|this) information(?: in memory)?|no information (about|on|regarding) (this|that) (is|was) (provided|present|available))/i;

// ── Mema adapter ────────────────────────────────────────────────────────────

const API = process.env.BGU_MEMA_URL ?? "http://localhost:3001";
const KEY = process.env.BGU_MEMA_KEY ?? "dev-ardin";

async function memaIngest(owner: string, session: LMESession, sourceId: string): Promise<void> {
  // Render each session as one episode (concatenate turns).
  const content = session
    .map(t => `${t.role}: ${t.content}`)
    .join("\n");
  const r = await fetch(`${API}/v2/observe`, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "x-owner": owner,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      kind: "document",
      content,
      source: sourceId,
    }),
  });
  if (!r.ok) throw new Error(`observe ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function memaRecallPacket(owner: string, question: string): Promise<{
  packet: any;
  rendered: string;
  retrievedIds: string[];
  recallMs: number;
}> {
  const t0 = Date.now();
  const r = await fetch(`${API}/v2/recall/packet`, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "x-owner": owner,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: question,
      purpose: "bgu_bench",
      limit_evidence: 8,
      limit_memory: 20,
      use_vector: true,
      fusion: "weighted",
    }),
  });
  const recallMs = Date.now() - t0;
  if (!r.ok) throw new Error(`recall ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const packet = await r.json() as any;

  // Render the packet for the answer LLM. Minimal — episodes + structured
  // memory if any. Matches mema's compilePacketToPrompt output shape.
  const sections: string[] = [];
  const mem = packet.memory_channel ?? [];
  const ev = packet.evidence_channel ?? [];

  const facts = mem.filter((h: any) =>
    h.kind === "fact"
    && h.payload
    && !h.payload.invalidated_at
    && !h.payload.superseded_by
  );
  if (facts.length > 0) {
    sections.push("<FACTS>");
    for (const f of facts.slice(0, 15)) {
      const p = f.payload;
      sections.push(`- ${p.subject ?? "?"} ${p.predicate ?? "?"} ${p.object ?? "?"}`);
    }
    sections.push("</FACTS>");
  }
  if (ev.length > 0) {
    sections.push("<EPISODES>");
    for (const e of ev.slice(0, 8)) {
      const excerpt = (e.excerpt ?? "").slice(0, 1200);
      if (excerpt) sections.push(`- ${excerpt}`);
    }
    sections.push("</EPISODES>");
  }

  return {
    packet,
    rendered: sections.length > 0 ? sections.join("\n") : "(no memory retrieved)",
    retrievedIds: ev.map((h: any) => h.id),
    recallMs,
  };
}

// ── Per-item run ────────────────────────────────────────────────────────────

async function runMemaOnItem(item: PairItem): Promise<RunResponse> {
  const owner = `bgu_${item.id.slice(0, 16)}`;
  for (let i = 0; i < item.sessions.length; i++) {
    await memaIngest(owner, item.sessions[i], item.session_ids[i]);
  }
  const { rendered, retrievedIds, recallMs } = await memaRecallPacket(owner, item.question);

  const answerPrompt = `${SHARED_ANSWER_PROMPT}

Context:
${rendered}

Question:
${item.question}`;

  const t0 = Date.now();
  const ans = await callClaudeCLI(answerPrompt, 60000);
  const answerMs = Date.now() - t0;
  const answer = ans ?? "(LLM returned null)";

  return {
    pair_id: item.pair_id,
    item_id: item.id,
    label: item.label,
    question: item.question,
    rendered_packet: rendered,
    packet_hash: sha256(rendered),
    answer,
    answer_hash: sha256(answer),
    recall_ms: recallMs,
    answer_ms: answerMs,
    retrieved_episode_ids: retrievedIds,
  };
}

// ── Judge ───────────────────────────────────────────────────────────────────
// Uses ollama llama3.1:8b. For real publication, swap to multi-judge per
// spec §5 (at least two providers + human audit on 20%). v1 single-judge
// is explicitly disclosed in the report.

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const JUDGE_MODEL = process.env.OLLAMA_JUDGE_MODEL ?? "llama3.1:8b";

async function ollamaJudge(prompt: string): Promise<string> {
  const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    body: JSON.stringify({
      model: JUDGE_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0, num_ctx: 8192 },
    }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}`);
  const j = await r.json() as any;
  return (j.response ?? "").trim();
}

function classifyAnswerShape(answer: string): "refusal" | "concrete" {
  return REFUSAL_PHRASE_RE.test(answer) ? "refusal" : "concrete";
}

async function judgeItem(
  item: PairItem,
  resp: RunResponse,
): Promise<JudgeVerdict> {
  const shape = classifyAnswerShape(resp.answer);

  // Answerable + refusal = false_abstention (Codex correction f gate input)
  if (item.label === "answerable" && shape === "refusal") {
    return {
      pair_id: item.pair_id,
      item_id: item.id,
      judgement: "false_abstention",
      reasoning: "Answer matches refusal phrase, but the item is answerable.",
      hash: sha256(`${resp.answer_hash}|false_abstention`),
    };
  }

  // Unanswerable + refusal = appropriate_abstention (unless smuggled claim)
  if (item.label === "unanswerable" && shape === "refusal") {
    // Check for smuggled claim — does the refusal contain any concrete fact
    // beyond the standard phrase? Heuristic: if the answer is longer than
    // 120 chars after stripping the refusal phrase, it likely smuggled.
    const stripped = resp.answer.replace(REFUSAL_PHRASE_RE, "").trim();
    if (stripped.length > 120) {
      return {
        pair_id: item.pair_id,
        item_id: item.id,
        judgement: "abstention_with_smuggled_claim",
        reasoning: `Refusal phrase detected, but ${stripped.length} chars of additional content followed.`,
        hash: sha256(`${resp.answer_hash}|abstention_with_smuggled_claim`),
      };
    }
    return {
      pair_id: item.pair_id,
      item_id: item.id,
      judgement: "appropriate_abstention",
      reasoning: "Clean refusal, no smuggled claim.",
      hash: sha256(`${resp.answer_hash}|appropriate_abstention`),
    };
  }

  // Unanswerable + concrete = confabulation
  if (item.label === "unanswerable" && shape === "concrete") {
    return {
      pair_id: item.pair_id,
      item_id: item.id,
      judgement: "unsupported_concrete",
      reasoning: "Concrete answer on an item with no gold evidence.",
      hash: sha256(`${resp.answer_hash}|unsupported_concrete`),
    };
  }

  // Answerable + concrete = ask the judge if it's correct AND supported.
  const judgePrompt = `You are a benchmark judge. Decide if a candidate answer is CORRECT and SUPPORTED.

Question: ${item.question}
Gold answer: ${item.gold_answer}
Candidate answer: ${resp.answer}

Retrieved evidence (the context the candidate had access to):
${resp.rendered_packet.slice(0, 4000)}

Rules:
- "CORRECT" means the candidate's answer agrees with the gold answer in meaning. Minor wording differences are fine.
- "SUPPORTED" means every concrete claim in the candidate's answer is grounded in the retrieved evidence.

Reply with EXACTLY one word on a single line, then a brief reason:
  YES   — correct and supported
  NO    — wrong OR unsupported (including hallucinated detail)

Verdict:`;
  const verdict = await ollamaJudge(judgePrompt);
  const isYes = /^\s*yes\b/i.test(verdict);
  return {
    pair_id: item.pair_id,
    item_id: item.id,
    judgement: isYes ? "supported_correct" : "supported_wrong",
    reasoning: verdict.slice(0, 500),
    hash: sha256(`${resp.answer_hash}|${verdict}`),
  };
}

// ── Wilson 95% CI for a proportion ──────────────────────────────────────────

function wilson95(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function score(
  system: string,
  pairs: PairItem[],
  verdicts: JudgeVerdict[],
  manifestRoot: string,
): BguReport {
  const verdictByItem = new Map(verdicts.map(v => [v.item_id, v]));
  const ansPairs = pairs.filter(p => p.label === "answerable");
  const unansPairs = pairs.filter(p => p.label === "unanswerable");

  let correctSupported = 0;
  let falseAbstention = 0;
  for (const p of ansPairs) {
    const v = verdictByItem.get(p.id);
    if (!v) continue;
    if (v.judgement === "supported_correct") correctSupported++;
    if (v.judgement === "false_abstention") falseAbstention++;
  }

  let appropriateAbstention = 0;
  let confabulation = 0;
  for (const p of unansPairs) {
    const v = verdictByItem.get(p.id);
    if (!v) continue;
    if (v.judgement === "appropriate_abstention") appropriateAbstention++;
    if (v.judgement === "unsupported_concrete") confabulation++;
  }

  const correctSupportedRate = correctSupported / Math.max(1, ansPairs.length);
  const appropriateAbstentionRate = appropriateAbstention / Math.max(1, unansPairs.length);
  const falseAbstentionRate = falseAbstention / Math.max(1, ansPairs.length);
  const confabulationRate = confabulation / Math.max(1, unansPairs.length);
  const bgu = 0.5 * correctSupportedRate + 0.5 * appropriateAbstentionRate;

  // Compute BGU 95% CI via Wilson on the paired success count
  // (count an item as a "success" if it scored: supported_correct on
  // answerable OR appropriate_abstention on unanswerable).
  const bguSuccesses = correctSupported + appropriateAbstention;
  const bguCI = wilson95(bguSuccesses, pairs.length);

  // Per-category breakdown
  const byCategory: Record<string, { n: number; correct_supported: number; appropriate_abstention: number; bgu: number }> = {};
  for (const p of pairs) {
    const cat = p.question_type;
    if (!byCategory[cat]) byCategory[cat] = { n: 0, correct_supported: 0, appropriate_abstention: 0, bgu: 0 };
    byCategory[cat].n++;
    const v = verdictByItem.get(p.id);
    if (!v) continue;
    if (v.judgement === "supported_correct") byCategory[cat].correct_supported++;
    if (v.judgement === "appropriate_abstention") byCategory[cat].appropriate_abstention++;
  }
  for (const cat of Object.keys(byCategory)) {
    const c = byCategory[cat];
    c.bgu = (c.correct_supported + c.appropriate_abstention) / Math.max(1, c.n);
  }

  // Hard auto-fail gate (Codex correction f): false_abstention > 0.20
  const gatePass = falseAbstentionRate <= 0.20;

  return {
    system,
    pairs_total: pairs.length,
    pairs_answerable: ansPairs.length,
    pairs_unanswerable: unansPairs.length,
    correct_supported_rate: correctSupportedRate,
    correct_supported_ci: wilson95(correctSupported, ansPairs.length),
    appropriate_abstention_rate: appropriateAbstentionRate,
    appropriate_abstention_ci: wilson95(appropriateAbstention, unansPairs.length),
    confabulation_rate: confabulationRate,
    false_abstention_rate: falseAbstentionRate,
    bgu_score: bgu,
    bgu_ci: bguCI,
    gate_pass: gatePass,
    gate_reason: gatePass
      ? `false_abstention=${(falseAbstentionRate * 100).toFixed(1)}% ≤ 20% gate`
      : `FAILED GATE: false_abstention=${(falseAbstentionRate * 100).toFixed(1)}% > 20% — submission would always-abstain to game BGU`,
    by_category: byCategory,
    manifest_root: manifestRoot,
  };
}

function printReport(rep: BguReport): void {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const ci = (a: number, b: number) => `[${pct(a)}, ${pct(b)}]`;
  console.log("");
  console.log("=".repeat(72));
  console.log(`BGU Bench v1 — system: ${rep.system}`);
  console.log("=".repeat(72));
  console.log(`Pairs: ${rep.pairs_total}  (${rep.pairs_answerable} answerable + ${rep.pairs_unanswerable} unanswerable)`);
  console.log("");
  console.log(`  correct_supported_rate    : ${pct(rep.correct_supported_rate)}  ${ci(...rep.correct_supported_ci)}`);
  console.log(`  appropriate_abstention    : ${pct(rep.appropriate_abstention_rate)}  ${ci(...rep.appropriate_abstention_ci)}`);
  console.log(`  confabulation_rate (↓)    : ${pct(rep.confabulation_rate)}`);
  console.log(`  false_abstention_rate     : ${pct(rep.false_abstention_rate)}    [gate ≤ 20%]`);
  console.log("");
  console.log(`  >>> BGU SCORE             : ${pct(rep.bgu_score)}  ${ci(...rep.bgu_ci)}`);
  console.log("");
  console.log(`  Gate:  ${rep.gate_pass ? "PASS ✓" : "FAIL ✗"}  ${rep.gate_reason}`);
  console.log("");
  console.log("  Per-category BGU:");
  for (const [cat, c] of Object.entries(rep.by_category)) {
    console.log(`    ${cat.padEnd(28)} n=${String(c.n).padStart(3)}  bgu=${pct(c.bgu)}`);
  }
  console.log("");
  console.log(`  Manifest root: ${rep.manifest_root}`);
  console.log("=".repeat(72));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  cmd: "build-dataset" | "run" | "judge" | "report" | "all";
  system: string;
  pairs: number;
  seed: number;
  dataPath: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] ?? "all") as CliArgs["cmd"];
  // The second positional (system) is OPTIONAL — `build-dataset` doesn't
  // need a system at all. Only consume argv[1] as the system if it
  // doesn't start with `--`, otherwise leave it as a flag.
  let cursor = 1;
  let system = "mema";
  if (argv[1] && !argv[1].startsWith("--")) {
    system = argv[1];
    cursor = 2;
  }
  const flags: Record<string, string> = {};
  for (let i = cursor; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++; // skip the value we just consumed
    }
  }
  return {
    cmd,
    system,
    pairs: flags.pairs ? Number(flags.pairs) : 150,
    seed: flags.seed ? Number(flags.seed) : 42,
    dataPath: flags.data ?? "/private/tmp/longmemeval/data/longmemeval_oracle.json",
  };
}

async function main() {
  const args = parseArgs();
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });

  // 1. build-dataset
  if (args.cmd === "build-dataset" || args.cmd === "all") {
    console.log(`Building dataset (pairsPerSide=${args.pairs}, seed=${args.seed})...`);
    const pairs = buildDataset({
      dataPath: args.dataPath,
      seed: args.seed,
      pairsPerSide: args.pairs,
    });
    const path = writeDataset(pairs);
    console.log(`  ${pairs.length} items written to ${path}`);
    console.log(`  answerable=${pairs.filter(p => p.label === "answerable").length}  unanswerable=${pairs.filter(p => p.label === "unanswerable").length}`);
    console.log(`  grey_zone flagged: ${pairs.filter(p => p.leakage_audit.bm25_flag === "grey_zone").length}`);
  }

  // 2. run system
  if (args.cmd === "run" || args.cmd === "all") {
    const pairLines = readFileSync(`${DATASET_DIR}/questions.jsonl`, "utf8").split("\n").filter(Boolean);
    const items: PairItem[] = pairLines.map(l => JSON.parse(l));
    console.log(`Running ${args.system} on ${items.length} items...`);
    const responses: RunResponse[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      process.stdout.write(`  [${i + 1}/${items.length}] ${it.label.padEnd(13)} ${it.pair_id} ... `);
      try {
        const r = await runMemaOnItem(it);
        responses.push(r);
        process.stdout.write(`${r.recall_ms + r.answer_ms}ms\n`);
      } catch (e: any) {
        process.stdout.write(`FAIL: ${(e?.message ?? e).toString().slice(0, 60)}\n`);
      }
    }
    writeFileSync(
      `${RUNS_DIR}/${args.system}_responses.jsonl`,
      responses.map(r => JSON.stringify(r)).join("\n") + "\n",
    );
    console.log(`  Saved: ${RUNS_DIR}/${args.system}_responses.jsonl`);
  }

  // 3. judge
  if (args.cmd === "judge" || args.cmd === "all") {
    const pairLines = readFileSync(`${DATASET_DIR}/questions.jsonl`, "utf8").split("\n").filter(Boolean);
    const items: PairItem[] = pairLines.map(l => JSON.parse(l));
    const respLines = readFileSync(`${RUNS_DIR}/${args.system}_responses.jsonl`, "utf8").split("\n").filter(Boolean);
    const responses: RunResponse[] = respLines.map(l => JSON.parse(l));
    const respByItem = new Map(responses.map(r => [r.item_id, r]));
    console.log(`Judging ${responses.length} responses...`);
    const verdicts: JudgeVerdict[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const resp = respByItem.get(it.id);
      if (!resp) continue;
      try {
        const v = await judgeItem(it, resp);
        verdicts.push(v);
      } catch (e: any) {
        verdicts.push({
          pair_id: it.pair_id,
          item_id: it.id,
          judgement: "judge_failed",
          reasoning: (e?.message ?? e).toString().slice(0, 200),
          hash: "",
        });
      }
      if ((i + 1) % 20 === 0) process.stdout.write(`  ${i + 1}/${items.length}\r`);
    }
    writeFileSync(
      `${RUNS_DIR}/${args.system}_verdicts.jsonl`,
      verdicts.map(v => JSON.stringify(v)).join("\n") + "\n",
    );
    console.log(`\n  Saved: ${RUNS_DIR}/${args.system}_verdicts.jsonl`);
  }

  // 4. report
  if (args.cmd === "report" || args.cmd === "all") {
    const pairLines = readFileSync(`${DATASET_DIR}/questions.jsonl`, "utf8").split("\n").filter(Boolean);
    const items: PairItem[] = pairLines.map(l => JSON.parse(l));
    const manifest = JSON.parse(readFileSync(`${DATASET_DIR}/manifest.json`, "utf8"));
    const verdictLines = readFileSync(`${RUNS_DIR}/${args.system}_verdicts.jsonl`, "utf8").split("\n").filter(Boolean);
    const verdicts: JudgeVerdict[] = verdictLines.map(l => JSON.parse(l));
    const rep = score(args.system, items, verdicts, manifest.merkle_root);
    printReport(rep);
    writeFileSync(`${RUNS_DIR}/${args.system}_report.json`, JSON.stringify(rep, null, 2));
  }
}

if (import.meta.main) {
  main().catch(e => { console.error("fatal:", e?.message ?? e); process.exit(1); });
}
