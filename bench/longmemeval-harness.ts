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
  ingest_ms: number;
  recall_ms: number;
  extracted_facts: number;
  extracted_entities: number;
  approved_facts: number;
  rejected_facts: number;
  // v2.9.0+ answer-level scoring (P1 — judge layer).
  predicted_answer?: string;
  judge_score?: number;     // 1 if judged correct, 0 otherwise
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
    contextChars: flags["context-chars"] ? Number(flags["context-chars"]) : 4000,
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
function scoreHits(retrievedSessionIds: string[], gold: string[]): {
  hit_at_1: boolean; hit_at_5: boolean; hit_at_10: boolean;
} {
  const goldSet = new Set(gold);
  const isHit = (slice: string[]) => slice.some(id => goldSet.has(id));
  return {
    hit_at_1: isHit(retrievedSessionIds.slice(0, 1)),
    hit_at_5: isHit(retrievedSessionIds.slice(0, 5)),
    hit_at_10: isHit(retrievedSessionIds.slice(0, 10)),
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

const ANSWER_PROMPT = (question: string, context: string) =>
  `You are a memory assistant. Use ONLY the context below to answer the question. If the context doesn't support an answer, say "no answer".

CONTEXT:
${context}

QUESTION: ${question}

Answer in one short sentence, or say "no answer".`;

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

async function generateAnswer(
  args: Args,
  question: string,
  context: string,
): Promise<{ answer: string; ms: number }> {
  const t = Date.now();
  const a = await callOllama(args.ollamaHost, args.judgeModel, ANSWER_PROMPT(question, context), 60000);
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
    const verdict = await callOllama(args.ollamaHost, args.judgeModel, JUDGE_PROMPT(question, gold, predicted), 60000);
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
    const extractor = await pickExtractor();
    const AUTO_APPROVE_THRESHOLD = 0.9;
    for (const [sid, epId] of sessionToEpisode) {
      const body = sessionToContent(rec.haystack_sessions[rec.haystack_session_ids.indexOf(sid)], sid, "");
      let result;
      try {
        result = await extractor.extract(body);
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
            proposed_by: `lmebench:${extractor.name}`,
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
            proposed_by: `lmebench:${extractor.name}`,
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

  // 3. Recall — single hybrid query against the question text. We score
  //    on whether any retrieved episode corresponds to a gold session.
  const t1 = Date.now();
  const recallRes = await apiOwner("/v2/recall", {
    query: rec.question,
    purpose: "longmemeval_benchmark",
    kinds: ["episode"],
    limit: args.topK,
    use_vector: true,
  });
  const recallMs = Date.now() - t1;

  let retrievedSessions: string[] = [];
  if (recallRes.ok) {
    const rj = await recallRes.json() as { hits: { id: string }[] };
    const idToSession = new Map<string, string>();
    for (const [sid, eid] of sessionToEpisode) idToSession.set(eid, sid);
    retrievedSessions = rj.hits.map(h => idToSession.get(h.id) ?? h.id);
  }

  const hits = scoreHits(retrievedSessions, rec.answer_session_ids);

  // v2.9.0+ answer-level scoring: generate an answer from the retrieved
  // context and judge it. We use the top-K retrieved sessions' content
  // as the context packet, truncated to args.contextChars.
  let predictedAnswer: string | undefined;
  let judgeScore: number | undefined;
  let judgeReason: string | undefined;
  let answerMs: number | undefined;
  let judgeMs: number | undefined;

  if (args.judge !== "none" && recallRes.ok) {
    // Pull the retrieved sessions' content from rec.haystack_sessions by
    // session_id — no extra HTTP round-trip needed.
    const sidToContent = new Map<string, string>();
    for (let i = 0; i < rec.haystack_session_ids.length; i++) {
      sidToContent.set(rec.haystack_session_ids[i], sessionToContent(rec.haystack_sessions[i], rec.haystack_session_ids[i], rec.haystack_dates[i]));
    }
    const ctxParts: string[] = [];
    let budget = args.contextChars;
    for (const sid of retrievedSessions.slice(0, args.topK)) {
      const part = sidToContent.get(sid);
      if (!part) continue;
      const slice = part.slice(0, Math.max(0, budget));
      if (!slice) break;
      ctxParts.push(slice);
      budget -= slice.length;
      if (budget <= 0) break;
    }
    const ctx = ctxParts.join("\n\n---\n\n");
    const gen = await generateAnswer(args, rec.question, ctx || "(no retrieved context)");
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
    question: rec.question.slice(0, 100),
    answer: rec.answer.slice(0, 100),
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
  if (judgeUsed) {
    console.log("  " + "category".padEnd(26) + " n   H@1   H@5   H@10  Answer%");
  } else {
    console.log("  " + "category".padEnd(26) + " n   H@1   H@5   H@10  ingest_ms recall_ms");
  }
  console.log("  " + "─".repeat(78));
  for (const [cat, rows] of [...byCategory.entries()].sort()) {
    const n = rows.length;
    const h1 = (rows.filter(r => r.hit_at_1).length / n * 100).toFixed(1);
    const h5 = (rows.filter(r => r.hit_at_5).length / n * 100).toFixed(1);
    const h10 = (rows.filter(r => r.hit_at_10).length / n * 100).toFixed(1);
    if (judgeUsed) {
      const judged = rows.filter(r => r.judge_score !== undefined);
      const ans = judged.length ? (judged.filter(r => r.judge_score === 1).length / judged.length * 100).toFixed(1) : "n/a";
      console.log(
        "  " + cat.padEnd(26) +
        String(n).padStart(3) +
        " " + h1.padStart(5) +
        " " + h5.padStart(5) +
        " " + h10.padStart(5) +
        " " + ans.padStart(7)
      );
    } else {
      const ing = (rows.reduce((s, r) => s + r.ingest_ms, 0) / n).toFixed(0);
      const rec = (rows.reduce((s, r) => s + r.recall_ms, 0) / n).toFixed(0);
      console.log(
        "  " + cat.padEnd(26) +
        String(n).padStart(3) +
        " " + h1.padStart(5) +
        " " + h5.padStart(5) +
        " " + h10.padStart(5) +
        " " + ing.padStart(9) +
        "ms " + rec.padStart(8) + "ms"
      );
    }
  }
  console.log("");
  const all = results;
  const overall = (rows: ScoredQuestion[], k: "hit_at_1" | "hit_at_5" | "hit_at_10") =>
    (rows.filter(r => r[k]).length / rows.length * 100).toFixed(1);
  let line = `Overall: n=${all.length}  Hit@1=${overall(all, "hit_at_1")}%  Hit@5=${overall(all, "hit_at_5")}%  Hit@10=${overall(all, "hit_at_10")}%`;
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
  console.log(`  Extract:  ${args.extract ? "yes (LLM-extracted drafts then auto-review)" : "no (retrieval-only)"}`);
  console.log(`  Judge:    ${args.judge}${args.judge !== "none" ? ` (model=${args.judgeModel})` : ""}`);
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
  questions = questions.slice(0, args.limit);
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
}

main().catch(e => { console.error("fatal:", e?.message ?? e); process.exit(1); });
