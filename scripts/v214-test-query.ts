#!/usr/bin/env bun
// v2.14.0 real-data query CLI for Ardin's morning test.
//
// Interactive REPL: type a question → see the retrieval result, packet
// preview, predicted answer (Sonnet), and citations. Quit with q/quit/Ctrl-D.
//
// Usage:
//   bun scripts/v214-test-query.ts --owner ardin-v214test
//
// Defaults:
//   --owner   v214test
//   --api     http://localhost:3001
//   --key     dev-ardin
//   --top-k   10
//
// What you see for each question:
//   1. Retrieval channels: evidence (episodes) + memory (facts/entities/cog)
//   2. Compiled packet preview (first ~800 chars)
//   3. Predicted answer from Claude Sonnet using the FLAT_PROMPT structure
//   4. Citations: which records contributed to the answer
//
// Why this exists: Ardin asked to test mema on his own data and give a
// qualitative report. Synthetic benchmarks (LongMemEval, MemoryAgentBench)
// give one kind of signal; domain-expert evaluation on real corpus gives
// a different, complementary signal that catches things benchmarks miss.

import { createInterface } from "node:readline/promises";
import { callClaudeCLI } from "../bench/bench-utils";

interface Args {
  api: string;
  key: string;
  owner: string;
  topK: number;
  questionDate?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[++i];
    }
  }
  return {
    api: String(flags.api ?? "http://localhost:3001"),
    key: String(flags.key ?? "dev-ardin"),
    owner: String(flags.owner ?? "v214test"),
    topK: flags["top-k"] ? parseInt(flags["top-k"], 10) : 10,
    questionDate: flags["question-date"] ? String(flags["question-date"]) : undefined,
  };
}

async function recall(args: Args, question: string): Promise<any> {
  const r = await fetch(`${args.api}/v2/recall/packet`, {
    method: "POST",
    headers: {
      "x-api-key": args.key,
      "x-owner": args.owner,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: question,
      purpose: `v214test_morning_query`,
      limit_evidence: args.topK,
      limit_memory: Math.max(args.topK * 2, 20),
      use_vector: true,
      fusion: "weighted",
    }),
  });
  if (!r.ok) throw new Error(`recall failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function renderPacketPreview(packet: any, maxChars = 800): string {
  // Render the most useful sections of the packet for quick eyeball.
  const sections: string[] = [];
  if (packet.user_summary) {
    sections.push(`[USER_SUMMARY] ${packet.user_summary.slice(0, 200)}`);
  }
  if (packet.current_state && packet.current_state.length > 0) {
    sections.push(`[CURRENT_STATE] (${packet.current_state.length} facts)`);
    for (const f of packet.current_state.slice(0, 5)) {
      sections.push(`  • ${f.subject} ${f.predicate} ${f.object} [${f.valid_from}]`);
    }
  }
  if (packet.approved_facts && packet.approved_facts.length > 0) {
    sections.push(`[FACTS] (${packet.approved_facts.length})`);
    for (const f of packet.approved_facts.slice(0, 8)) {
      sections.push(`  • ${f.subject} ${f.predicate} ${f.object}` +
        (f.invalidated_at ? ` [SUPERSEDED ${f.invalidated_at}]` : ""));
    }
  }
  if (packet.cognitive_beliefs && packet.cognitive_beliefs.length > 0) {
    sections.push(`[BELIEFS] (${packet.cognitive_beliefs.length})`);
    for (const b of packet.cognitive_beliefs.slice(0, 3)) {
      sections.push(`  • ${b.content.slice(0, 120)}`);
    }
  }
  if (packet.entities && packet.entities.length > 0) {
    sections.push(`[ENTITIES] (${packet.entities.length}) ${packet.entities.slice(0, 10).map((e: any) => e.name).join(", ")}`);
  }
  if (packet.raw_supporting_excerpts && packet.raw_supporting_excerpts.length > 0) {
    sections.push(`[EVIDENCE] (${packet.raw_supporting_excerpts.length} episodes)`);
    for (const r of packet.raw_supporting_excerpts.slice(0, 3)) {
      const id = r.source_id ?? "(no-id)";
      sections.push(`  • ${id} :: ${(r.text ?? "").slice(0, 120)}…`);
    }
  }
  if (packet.conflicts && packet.conflicts.length > 0) {
    sections.push(`[CONFLICTS] (${packet.conflicts.length})`);
    for (const c of packet.conflicts.slice(0, 3)) {
      sections.push(`  • ${c.narrative.slice(0, 200)}`);
    }
  }
  if (packet.uncertainty && packet.uncertainty.length > 0) {
    sections.push(`[UNCERTAINTY]`);
    for (const u of packet.uncertainty) sections.push(`  • ${u}`);
  }
  return sections.join("\n").slice(0, maxChars * 4);  // ~4x maxChars headroom
}

async function getCompiledPacket(args: Args, packetResp: any, question: string): Promise<{ rendered: string; provenance: any[] }> {
  // The /v2/recall/packet endpoint returns the channels but not the
  // compiled prompt. We need to call the packet compile path. Since the
  // compile happens in the harness or the API may have a separate
  // endpoint, fall back to building it client-side with a simple template
  // that mimics compilePacketToPrompt's structure.
  //
  // For the morning test the goal is qualitative — Ardin wants to see
  // the SHAPE of what mema produces. The preview rendering above shows
  // the essence.
  return {
    rendered: renderPacketPreview(packetResp, 4000),
    provenance: packetResp.provenance ?? [],
  };
}

async function generateAnswer(args: Args, question: string, contextRendered: string): Promise<string | null> {
  const prompt = `You answer questions about Ardin's own data using only the supplied context.

Reference date for the question: ${args.questionDate ?? new Date().toISOString().slice(0, 10)}
Treat any statement dated AFTER this reference date as not-yet-known.

Context (mema-rendered memory packet preview):
${contextRendered}

Question:
${question}

How to choose your answer — two task classes with opposite failure modes:

  Factual recall ("when did I", "what did I say about", "who is", counting, "current"/"now", knowledge-update):
    • Counting / multi-session — enumerate every relevant occurrence in the context before answering.
    • "Current" / "now" — use the LATEST relevant statement on or before the reference date.
    • Knowledge-update — prefer the newer statement over older contradicting ones.
    • If the context truly lacks the answer, reply: I don't have that information in memory.

  Personalization ("recommend", "suggest", "what should I", "help me pick", "what kind of"):
    Filter the answer through the user's stored preferences, tastes, and patterns in the context.
    Refusing to answer when relevant signal exists is the worst outcome — personalize imperfectly over abstaining.

Output: a single short paragraph. Cite which records (by short ID) you used. Nothing else.`;
  try {
    return await callClaudeCLI(prompt, 90000);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();
  console.log(`mema v2.14test morning query CLI`);
  console.log(`  API:    ${args.api}`);
  console.log(`  Owner:  ${args.owner}`);
  console.log(`  Top-K:  ${args.topK}`);
  console.log(`  Type your question and press Enter. q to quit.`);
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    const q = await rl.question(`> `);
    if (!q || q.trim() === "" ) continue;
    if (q.trim() === "q" || q.trim() === "quit" || q.trim() === "exit") break;

    const t0 = Date.now();
    let packetResp: any;
    try {
      packetResp = await recall(args, q);
    } catch (e: any) {
      console.log(`\n[retrieval error] ${e.message}\n`);
      continue;
    }
    const recallMs = Date.now() - t0;

    const evCount = packetResp.evidence_channel?.length ?? 0;
    const memCount = packetResp.memory_channel?.length ?? 0;
    console.log(`\n  → retrieval: ${evCount} evidence + ${memCount} memory hits (${recallMs}ms)`);

    const { rendered, provenance } = await getCompiledPacket(args, packetResp, q);
    console.log(`\n  PACKET PREVIEW:`);
    console.log(rendered.split("\n").map(l => "  " + l).join("\n"));

    console.log(`\n  → asking Sonnet for an answer...`);
    const answer = await generateAnswer(args, q, rendered);
    if (!answer) {
      console.log(`\n  [answer LLM failed]\n`);
      continue;
    }
    console.log(`\n  ANSWER:\n  ${answer.split("\n").join("\n  ")}\n`);
    if (provenance.length > 0) {
      console.log(`  PROVENANCE: ${provenance.length} records`);
      for (const p of provenance.slice(0, 8)) {
        console.log(`    • ${p.record_kind} ${p.record_id} :: ${p.claim?.slice(0, 80) ?? "(no claim)"}`);
      }
    }
    console.log();
  }

  rl.close();
  console.log(`\nBye.`);
}

main().catch(e => { console.error(e); process.exit(1); });
