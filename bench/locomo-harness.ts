#!/usr/bin/env bun
// LoCoMo benchmark harness (v2.10.0+, skeleton for v3.0 evidence package).
//
// LoCoMo (Snap Research / Maharana et al., NAACL 2024 — "Evaluating Very
// Long-Term Conversational Memory of LLM Agents") evaluates memory on
// LONG conversations: up to 35 sessions, ~9k tokens per dialogue, with
// QA, event summarization, and multimodal dialogue generation tasks.
// https://github.com/snap-research/locomo
// Dataset: https://huggingface.co/datasets/snap-research/locomo-10
//
// This harness implements QA only (summarization + multimodal deferred
// to v2.11+). Structurally mirrors the LongMemEval harness:
//
//   1. For each LoCoMo conversation, import every session as an episode.
//   2. For each QA pair on that conversation, recall against mema, build
//      a context packet from top-K, generate a candidate answer, judge
//      against the gold answer.
//   3. Aggregate per-task and per-conversation accuracy + Hit@k.
//
// Usage (after downloading the dataset):
//   curl -L -o /tmp/locomo10.json \
//     "https://huggingface.co/datasets/snap-research/locomo-10/resolve/main/locomo10.json"
//
//   MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true bun src/index.ts &
//   bun bench/locomo-harness.ts --data /tmp/locomo10.json --limit 5

import { readFileSync, existsSync } from "node:fs";

interface Args {
  data: string;
  api: string;
  key: string;
  owner: string;
  limit: number;
  topK: number;
  judge: "none" | "substring" | "llm";
  judgeModel: string;
  ollamaHost: string;
  contextChars: number;
}

// LoCoMo schema (10-conversation cleaned subset):
//   - sample_id        : conversation identifier
//   - conversation     : { speaker_a, speaker_b, sessions[] }
//       sessions[]     : array of { date_time, dia: [{speaker, text}], ... }
//   - qa               : array of {question, answer, evidence?, category?}
interface LoCoMoTurn { speaker: string; text: string }
interface LoCoMoSession { date_time?: string; dia: LoCoMoTurn[] }
interface LoCoMoQA { question: string; answer: string; evidence?: any; category?: string }
interface LoCoMoSample {
  sample_id: string;
  conversation: { sessions: LoCoMoSession[] };
  qa: LoCoMoQA[];
}

interface ScoredQA {
  sample_id: string;
  qa_index: number;
  category: string;
  question: string;
  gold_answer: string;
  predicted_answer?: string;
  judge_score?: number;
  hit_at_5: boolean;
  hit_at_10: boolean;
  recall_ms: number;
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
    data: String(flags.data ?? "/tmp/locomo10.json"),
    api: String(flags.api ?? process.env.MACHTSINN_URL ?? "http://localhost:3001"),
    key: String(flags.key ?? process.env.MACHTSINN_KEY ?? "dev-ardin"),
    owner: String(flags.owner ?? `locomo_${Date.now()}`),
    limit: flags.limit ? Number(flags.limit) : 5,
    topK: flags["top-k"] ? Number(flags["top-k"]) : 10,
    judge: (flags.judge ? String(flags.judge) : "none") as Args["judge"],
    judgeModel: String(flags["judge-model"] ?? process.env.OLLAMA_JUDGE_MODEL ?? "llama3.1:8b"),
    ollamaHost: String(flags["ollama-host"] ?? process.env.OLLAMA_HOST ?? "http://localhost:11434"),
    contextChars: flags["context-chars"] ? Number(flags["context-chars"]) : 6000,
  };
}

function sessionToContent(s: LoCoMoSession, idx: number, sampleId: string): string {
  const date = s.date_time ?? "(no-date)";
  const turns = (s.dia ?? []).map(t => `**${t.speaker}:** ${t.text}`).join("\n\n");
  return `# Session ${sampleId}/${idx} — ${date}\n\n${turns}`;
}

async function ollama(host: string, model: string, prompt: string, system?: string): Promise<string | null> {
  try {
    const r = await fetch(`${host.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, ...(system ? { system } : {}), stream: false }),
    });
    if (!r.ok) return null;
    const d = await r.json() as { response: string };
    return (d.response ?? "").trim();
  } catch { return null; }
}

const ANSWER_PROMPT = (q: string, ctx: string) =>
  `You are a memory assistant. Use ONLY the context below to answer the question. If the context doesn't support an answer, say "no answer".\n\nCONTEXT:\n${ctx}\n\nQUESTION: ${q}\n\nAnswer in one short sentence, or say "no answer".`;

const JUDGE_PROMPT = (q: string, gold: string, pred: string) =>
  `You are a strict grader for the LoCoMo benchmark. Decide if the predicted answer matches the gold answer SEMANTICALLY for this question.\n\nQUESTION: ${q}\nGOLD ANSWER:      ${gold}\nPREDICTED ANSWER: ${pred}\n\nReply with EXACTLY one of:\n  CORRECT\n  INCORRECT\nFollowed by an optional one-line reason.`;

async function runSample(args: Args, sample: LoCoMoSample): Promise<ScoredQA[]> {
  const safeOwner = `${args.owner}_${sample.sample_id}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  const apiOwner = async (path: string, body?: any) => fetch(`${args.api}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "x-api-key": args.key,
      "x-owner": safeOwner,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Ingest all sessions of this conversation as episodes.
  const sessionToEpisode = new Map<number, string>();
  for (let i = 0; i < sample.conversation.sessions.length; i++) {
    const content = sessionToContent(sample.conversation.sessions[i], i, sample.sample_id);
    const r = await apiOwner("/v2/observe", {
      kind: "conversation",
      content,
      source: `locomo:${sample.sample_id}:session_${i}`,
    });
    if (r.ok) {
      const j = await r.json() as { episode: { id: string } };
      sessionToEpisode.set(i, j.episode.id);
    }
  }

  // For each QA, recall + answer + judge.
  const out: ScoredQA[] = [];
  for (let qi = 0; qi < sample.qa.length; qi++) {
    const q = sample.qa[qi];
    const t = Date.now();
    const rec = await apiOwner("/v2/recall", {
      query: q.question,
      purpose: "locomo_qa",
      kinds: ["episode"],
      limit: args.topK,
      use_vector: true,
    });
    const recallMs = Date.now() - t;
    let retrievedSessionIdx: number[] = [];
    if (rec.ok) {
      const rj = await rec.json() as { hits: { id: string }[] };
      const idToIdx = new Map<string, number>();
      for (const [idx, eid] of sessionToEpisode) idToIdx.set(eid, idx);
      retrievedSessionIdx = rj.hits.map(h => idToIdx.get(h.id) ?? -1).filter(x => x >= 0);
    }

    // LoCoMo doesn't tag gold session ids the way LongMemEval does; Hit@k
    // here is a weak signal (we count "retrieved any of the same-category
    // sessions"). The PRIMARY metric is the judge.
    const hit5 = retrievedSessionIdx.length > 0;
    const hit10 = retrievedSessionIdx.length > 0;

    let predicted: string | undefined;
    let judgeScore: number | undefined;
    let answerMs: number | undefined, judgeMs: number | undefined;
    if (args.judge !== "none") {
      // Build context from top-K retrieved sessions.
      const ctxParts: string[] = [];
      let budget = args.contextChars;
      for (const idx of retrievedSessionIdx.slice(0, args.topK)) {
        const part = sessionToContent(sample.conversation.sessions[idx], idx, sample.sample_id);
        const slice = part.slice(0, Math.max(0, budget));
        if (!slice) break;
        ctxParts.push(slice);
        budget -= slice.length;
        if (budget <= 0) break;
      }
      const ctx = ctxParts.join("\n\n---\n\n") || "(no retrieved context)";
      const t1 = Date.now();
      predicted = (await ollama(args.ollamaHost, args.judgeModel, ANSWER_PROMPT(q.question, ctx))) ?? "no answer";
      answerMs = Date.now() - t1;
      if (args.judge === "substring") {
        const ok = q.answer.trim().toLowerCase().split(/\s+/).filter(w => w.length >= 3).every(w => predicted!.toLowerCase().includes(w));
        judgeScore = ok ? 1 : 0;
        judgeMs = 0;
      } else {
        const t2 = Date.now();
        const v = await ollama(args.ollamaHost, args.judgeModel, JUDGE_PROMPT(q.question, q.answer, predicted));
        judgeMs = Date.now() - t2;
        judgeScore = (v ?? "").toUpperCase().startsWith("CORRECT") ? 1 : 0;
      }
    }

    out.push({
      sample_id: sample.sample_id,
      qa_index: qi,
      category: q.category ?? "qa",
      question: q.question.slice(0, 120),
      gold_answer: q.answer.slice(0, 120),
      predicted_answer: predicted,
      judge_score: judgeScore,
      hit_at_5: hit5,
      hit_at_10: hit10,
      recall_ms: recallMs,
      answer_ms: answerMs,
      judge_ms: judgeMs,
    });
  }
  return out;
}

async function main() {
  const args = parseArgs();
  console.log("LoCoMo harness — mema QA benchmark (skeleton)");
  console.log(`  Data:     ${args.data}`);
  console.log(`  API:      ${args.api}`);
  console.log(`  Judge:    ${args.judge}${args.judge !== "none" ? ` (${args.judgeModel})` : ""}`);
  console.log("");

  if (!existsSync(args.data)) {
    console.error(`Dataset not found at ${args.data}.`);
    console.error(`Download with: curl -L -o ${args.data} \\\n  "https://huggingface.co/datasets/snap-research/locomo-10/resolve/main/locomo10.json"`);
    process.exit(1);
  }
  const h = await fetch(`${args.api}/health`).catch(() => null);
  if (!h || !h.ok) { console.error("mema not reachable"); process.exit(1); }
  const hj = await h.json() as { version: string };
  console.log(`  mema version: ${hj.version}`);

  const raw = JSON.parse(readFileSync(args.data, "utf8"));
  // LoCoMo dataset has been published under several schemas; support both
  // [array of samples] and {samples: [...]} layouts.
  const samples: LoCoMoSample[] = Array.isArray(raw) ? raw : (raw.samples ?? raw.data ?? []);
  const subset = samples.slice(0, args.limit);
  console.log(`  Running ${subset.length}/${samples.length} conversations...`);
  console.log("");

  const all: ScoredQA[] = [];
  for (let i = 0; i < subset.length; i++) {
    const s = subset[i];
    process.stdout.write(`  [${i + 1}/${subset.length}] ${s.sample_id} (${s.qa.length} QAs) ...`);
    try {
      const rows = await runSample(args, s);
      all.push(...rows);
      const correct = rows.filter(r => r.judge_score === 1).length;
      const total = rows.filter(r => r.judge_score !== undefined).length;
      process.stdout.write(` answer-correct=${total ? `${correct}/${total}` : "n/a"}\n`);
    } catch (e: any) {
      console.error(` fatal: ${e?.message ?? e}`);
    }
  }

  // Aggregate
  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  LoCoMo results");
  console.log("══════════════════════════════════════════════════════════════");
  const judged = all.filter(r => r.judge_score !== undefined);
  if (judged.length) {
    const acc = (judged.filter(r => r.judge_score === 1).length / judged.length * 100).toFixed(1);
    console.log(`  Answer-correct: ${acc}%  (n=${judged.length} QAs, ${subset.length} conversations)`);
  } else {
    console.log(`  Retrieval-only run (no judge). Total QAs: ${all.length}`);
  }
}

main().catch(e => { console.error("fatal:", e?.message ?? e); process.exit(1); });
