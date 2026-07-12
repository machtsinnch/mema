#!/usr/bin/env bun
// Batch qualitative test of mema against Ardin's real ingested data.
// Walks a list of curated questions across categories, retrieves +
// generates an answer for each, and writes a structured report.
//
// Output: /tmp/QUALITATIVE-TEST-RESULTS.md — for Ardin's morning review.

import { callClaudeCLI } from "../bench/bench-utils";
import { writeFileSync } from "node:fs";

const API = "http://localhost:3001";
const KEY = "dev-ardin";
const OWNER = "ardin-v214test";

interface Question {
  category: "retrieval" | "synthesis" | "temporal" | "hallucination-probe" | "personalization";
  question: string;
  /** What would success look like? For the report. */
  expectedSignal: string;
}

const QUESTIONS: Question[] = [
  // Retrieval — find the right doc
  { category: "retrieval", question: "What is the Megatrend Diamond Hands investment thesis?",
    expectedSignal: "06-MEGATREND-DIAMOND-HANDS.md should be top hit" },
  { category: "retrieval", question: "What does the FINMA gap analysis say about regulatory exposure?",
    expectedSignal: "finma-gap-analysis-2026-05-06.md should be top hit" },
  { category: "retrieval", question: "What's the A3F strategic reframe from May 6?",
    expectedSignal: "A3F-strategic-reframe-2026-05-06.md should be top hit" },
  { category: "retrieval", question: "Where does the finance plan cover Swiss tax optimization?",
    expectedSignal: "07c-swiss-tax-optimization.md should be top hit" },

  // Synthesis — stitch multiple sources
  { category: "synthesis", question: "Compare my Tier 1 and Tier 2 technical investment picks",
    expectedSignal: "should mention both 09a-technical-tier1.md and 09b-technical-tier2.md content" },
  { category: "synthesis", question: "What is mema's strategic moat against Zep and Mem0?",
    expectedSignal: "should mention temporal grounding, Datalog, Swiss trust — multiple machtsinn docs" },

  // Temporal — what was the latest
  { category: "temporal", question: "What's my most recent strategic thinking about the architecture?",
    expectedSignal: "should pull newer docs (May 2026 dated) over March-dated finance ones" },

  // Hallucination probes — data does NOT contain these
  { category: "hallucination-probe", question: "What was my P&L for Q1 2026?",
    expectedSignal: "ABSTAIN — no P&L data was ingested" },
  { category: "hallucination-probe", question: "What's the acquisition price for Jungbunzlauer?",
    expectedSignal: "ABSTAIN — not in data" },
  { category: "hallucination-probe", question: "What did I write about quantum computing?",
    expectedSignal: "ABSTAIN — not in data" },
  { category: "hallucination-probe", question: "What does the Roaster Verdict say about my biotech holdings?",
    expectedSignal: "the roaster verdict file exists but biotech may not be mentioned — see how it handles partial relevance" },

  // Personalization — preferences should bias answer
  { category: "personalization", question: "What kind of investment approach do I prefer?",
    expectedSignal: "should use behavioral framework / portfolio strategy content; not generic" },
  { category: "personalization", question: "What style of system architecture should I prioritize?",
    expectedSignal: "should reference machtsinn architectural docs" },
];

async function recall(question: string): Promise<any> {
  const r = await fetch(`${API}/v2/recall/packet`, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "x-owner": OWNER,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: question,
      purpose: "v214_qual_batch",
      limit_evidence: 5,
      limit_memory: 10,
      use_vector: true,
      fusion: "weighted",
    }),
  });
  if (!r.ok) throw new Error(`recall ${r.status}: ${await r.text()}`);
  return r.json();
}

function renderContextForAnswerer(packet: any): string {
  const ev = packet.evidence_channel ?? [];
  const sections: string[] = [];
  if (ev.length > 0) {
    sections.push("<EVIDENCE_EPISODES>");
    for (const h of ev.slice(0, 5)) {
      const src = (h.excerpt ?? "").slice(0, 800);
      sections.push(`- ID:${h.id}`);
      sections.push(`  ${src}`);
    }
    sections.push("</EVIDENCE_EPISODES>");
  }
  return sections.join("\n") || "(no evidence retrieved)";
}

async function answer(question: string, context: string): Promise<string | null> {
  const prompt = `You answer questions about Ardin's own stored knowledge using only the supplied context.

Context (retrieved episodes from his vault):
${context}

Question:
${question}

How to choose your answer — two task classes with opposite failure modes:

  Factual recall ("when did I", "what did I say about", "who is", counting, "current"/"now", knowledge-update):
    - If the context truly lacks the answer, reply EXACTLY: I don't have that information in memory.
    - Do NOT make up facts that aren't in the context.

  Personalization ("recommend", "suggest", "what should I", "what kind of"):
    Filter the answer through stored preferences in the context. If exact-match preferences aren't there,
    transfer from adjacent stored facts. Refusing when relevant signal exists is the worst outcome.

Output: single short paragraph. Cite source IDs you used (e.g. "[ID:01KR...]"). Nothing else.`;
  return await callClaudeCLI(prompt, 60000);
}

interface Result {
  q: Question;
  retrieved_count: number;
  top_3_ids: string[];
  top_3_excerpts: string[];
  rendered_context_len: number;
  answer: string | null;
  recall_ms: number;
  answer_ms: number;
}

async function main() {
  const results: Result[] = [];
  console.log(`Running ${QUESTIONS.length} qualitative-test questions against owner=${OWNER}\n`);

  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    process.stdout.write(`[${i + 1}/${QUESTIONS.length}] (${q.category}) ${q.question.slice(0, 60)}... `);
    const t0 = Date.now();
    let packet: any;
    try { packet = await recall(q.question); }
    catch (e: any) { console.log(`RECALL_FAIL: ${e.message?.slice(0, 60)}`); continue; }
    const recallMs = Date.now() - t0;

    const ev = packet.evidence_channel ?? [];
    const top3ids = ev.slice(0, 3).map((h: any) => h.id);
    const top3excerpts = ev.slice(0, 3).map((h: any) => (h.excerpt ?? "").slice(0, 120));
    const context = renderContextForAnswerer(packet);

    const t1 = Date.now();
    const ans = await answer(q.question, context);
    const ansMs = Date.now() - t1;

    results.push({
      q, retrieved_count: ev.length, top_3_ids: top3ids, top_3_excerpts: top3excerpts,
      rendered_context_len: context.length, answer: ans,
      recall_ms: recallMs, answer_ms: ansMs,
    });
    console.log(`${ev.length}hits ${recallMs+ansMs}ms ${ans ? "OK" : "NULL"}`);
  }

  // Write structured report
  const lines: string[] = [];
  lines.push(`# Qualitative Test Results — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`**Run by:** Claude (autonomous overnight) — not Ardin himself.`);
  lines.push(`**Purpose:** stand-in qualitative eval to surface obvious hits/misses Ardin should focus on in the morning.`);
  lines.push(`**Data:** owner=\`${OWNER}\`, 300 episodes from ~/Documents/pai/{finance-plan,machtsinn} (no fact extraction).`);
  lines.push("");
  lines.push(`Total questions: ${results.length}.`);
  lines.push(`Note: I can ONLY evaluate retrieval shape and abstention behavior. Ardin must judge factual accuracy because I don't know his data ground truth.`);
  lines.push("");

  for (const r of results) {
    lines.push(`## [${r.q.category}] ${r.q.question}`);
    lines.push("");
    lines.push(`**Expected signal:** ${r.q.expectedSignal}`);
    lines.push(``);
    lines.push(`**Retrieval:** ${r.retrieved_count} hits | recall ${r.recall_ms}ms | answer ${r.answer_ms}ms`);
    lines.push("");
    if (r.top_3_ids.length > 0) {
      lines.push(`**Top 3 retrieved:**`);
      for (let i = 0; i < r.top_3_ids.length; i++) {
        lines.push(`  ${i+1}. \`${r.top_3_ids[i]}\` :: ${r.top_3_excerpts[i].replace(/\n/g, " ")}`);
      }
    }
    lines.push("");
    lines.push(`**Answer:**`);
    lines.push("```");
    lines.push(r.answer ?? "(LLM returned null — usually timeout or contamination check)");
    lines.push("```");
    lines.push("");
    lines.push(`---`);
    lines.push("");
  }

  // Roll-up
  lines.push(`## Roll-up`);
  lines.push("");
  const byCat = new Map<string, { n: number; abstained: number; nulls: number }>();
  for (const r of results) {
    if (!byCat.has(r.q.category)) byCat.set(r.q.category, { n: 0, abstained: 0, nulls: 0 });
    const c = byCat.get(r.q.category)!;
    c.n++;
    if (!r.answer) c.nulls++;
    else if (r.answer.toLowerCase().includes("i don't have") || r.answer.toLowerCase().includes("not in") || r.answer.toLowerCase().includes("no information")) c.abstained++;
  }
  lines.push(`| Category | n | abstained | LLM-null |`);
  lines.push(`|---|---|---|---|`);
  for (const [cat, c] of byCat) {
    lines.push(`| ${cat} | ${c.n} | ${c.abstained} | ${c.nulls} |`);
  }
  lines.push("");
  lines.push(`**What to look for as you (Ardin) read this:**`);
  lines.push(`1. **Retrieval correctness:** do the top-3 IDs / excerpts match what you'd expect?`);
  lines.push(`2. **Hallucination probes:** the 4 hallucination-probe questions should mostly abstain. If they CONFIDENTLY answered with made-up info, that's a critical hallucination.`);
  lines.push(`3. **Synthesis:** does the answer cite sources or just hand-wave? Cited = trustworthy.`);
  lines.push(`4. **Personalization:** does it actually reflect your preferences from the context, or generic advice?`);
  lines.push("");

  writeFileSync("/tmp/QUALITATIVE-TEST-RESULTS.md", lines.join("\n"));
  console.log(`\n✓ Report written to /tmp/QUALITATIVE-TEST-RESULTS.md (${lines.length} lines)`);
}

main().catch(e => { console.error(e); process.exit(1); });
