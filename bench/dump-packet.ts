#!/usr/bin/env bun
// One-off diagnostic: take a LongMemEval question_id, replay the
// memory-packet pipeline against the bench mema, and DUMP the full
// rendered prompt the answer LLM would have seen. Helps diagnose
// why a particular question failed under memory-packet mode.
//
// Usage:
//   bun bench/dump-packet.ts <question_id> [--owner X] [--mode memory-packet|zep-format]
//
// Example:
//   bun bench/dump-packet.ts 6a1eabeb

import { readFileSync, existsSync } from "node:fs";
import { pickExtractor } from "../src/v2/llm-extractor";
import {
  buildMemoryPacket,
  compilePacketToPrompt,
  compilePacketAsZepFormat,
  type TwoChannelHits,
} from "../src/v2/memory-packet";
import type { RetrievalHit } from "../src/v2/types";
import { sanitizeEventDate, callClaudeCLI } from "./bench-utils";

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

const argv = process.argv.slice(2);
const qid = argv[0];
if (!qid || qid.startsWith("--")) {
  console.error("usage: bun bench/dump-packet.ts <question_id> [--mode memory-packet|zep-format] [--owner X]");
  process.exit(2);
}
const flags: Record<string, string> = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
    flags[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
}
const mode = flags.mode ?? "memory-packet";
const owner = flags.owner ?? `dump_${qid}_${Date.now()}`;
const api = "http://localhost:3002";
const key = "bench-key";
const dataPath = "/tmp/longmemeval/data/longmemeval_oracle.json";

console.error(`[dump] qid=${qid} mode=${mode} owner=${owner}`);

if (!existsSync(dataPath)) {
  console.error(`[dump] no dataset at ${dataPath}`);
  process.exit(2);
}
const data = JSON.parse(readFileSync(dataPath, "utf8")) as LMERecord[];
const rec = data.find(r => r.question_id === qid);
if (!rec) {
  console.error(`[dump] no question with id=${qid}`);
  process.exit(2);
}
console.error(`[dump] found: category=${rec.question_type}, ${rec.haystack_session_ids.length} haystack sessions`);

function api2(path: string, body?: any) {
  return fetch(`${api}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "x-owner": owner,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function sessionToContent(turns: ChatTurn[], sid: string, date: string): string {
  const head = `# Session ${sid} — ${date}\n\n`;
  return head + turns.map(t => `**${t.role}:** ${t.content}`).join("\n\n");
}

// 1. Ingest haystack
const sessionToEpisode = new Map<string, string>();
for (let i = 0; i < rec.haystack_sessions.length; i++) {
  const sid = rec.haystack_session_ids[i];
  const date = rec.haystack_dates[i];
  const content = sessionToContent(rec.haystack_sessions[i], sid, date);
  const r = await api2("/v2/observe", { kind: "conversation", content, source: `dump:${sid}` });
  if (!r.ok) { console.error(`[dump] observe failed ${sid}: ${r.status}`); continue; }
  const j = await r.json() as { episode: { id: string } };
  sessionToEpisode.set(sid, j.episode.id);
}
console.error(`[dump] ingested ${sessionToEpisode.size} episodes`);

// 2. Extract facts (claude)
const AUTO_APPROVE = 0.9;
let extractedFacts = 0, approvedFacts = 0, extractedEntities = 0;
// v2.11.1+ — abbreviated temporal-grounding prompt for diagnostic dumps.
// Kept separate from bench/longmemeval-harness.ts EXTRACTOR_SYSTEM (40 lines)
// to keep dump output short — the full prompt is for production benching;
// this minimal one is enough to verify the temporal-grounding pipeline.
const EXTRACTOR_SYSTEM = `You are a strict structured-fact extractor.

Output JSON: {"facts": [{"subject":"...","predicate":"...","object":"...","event_date":"YYYY-MM-DD","confidence":0.95}], "entities": [{"name":"...","type":"..."}]}

TEMPORAL GROUNDING: every fact's "event_date" must be YYYY-MM-DD. Use the OBSERVATION_DATE supplied below as the anchor for relative refs ("today", "yesterday", "recently"). If a specific date is mentioned in the text, use that. NEVER use today's real-world date as event_date.`;

// v2.11.2+ — uses shared callClaudeCLI from bench-utils.
for (const [sid, epId] of sessionToEpisode) {
  const idx = rec.haystack_session_ids.indexOf(sid);
  const body = sessionToContent(rec.haystack_sessions[idx], sid, "");
  const observationDate = rec.haystack_dates[idx] ?? rec.question_date ?? new Date().toISOString().slice(0, 10);
  const out = await callClaudeCLI(`${EXTRACTOR_SYSTEM}\n\nOBSERVATION_DATE: ${observationDate}\n\nText:\n${body}`);
  if (!out) continue;
  let parsed: any = null;
  try {
    const stripped = out.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(stripped);
  } catch {
    const m = out.match(/\{[\s\S]*"facts"[\s\S]*"entities"[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch {}
  }
  if (!parsed || !Array.isArray(parsed.facts)) continue;
  for (const e of parsed.entities ?? []) {
    const name = String(e.name ?? "").trim();
    if (name.length < 2 || name.length > 80) continue;
    try {
      await api2("/v2/entity", {
        name, type: String(e.type ?? "concept"),
        status: "draft", derived_from: [epId],
        evidence_excerpt: body.slice(0, 400),
        proposed_by: `dump:claude-cli`,
      });
      extractedEntities++;
    } catch {}
  }
  for (const f of parsed.facts) {
    const subj = String(f.subject ?? "").trim();
    const pred = String(f.predicate ?? "").trim();
    const obj  = String(f.object ?? "").trim();
    const conf = Number(f.confidence ?? 0);
    if (!subj || !pred || !obj || conf < 0.75) continue;
    const validFrom = sanitizeEventDate(f.event_date, observationDate);
    let createdId: string | null = null;
    try {
      const r = await api2("/v2/fact", {
        subject: subj, predicate: pred, object: obj,
        derived_from: [epId],
        confidence: Math.min(Math.max(conf, 0), 1),
        valid_from: validFrom,
        status: "draft",
        evidence_excerpt: body.slice(0, 500),
        proposed_by: `dump:claude-cli`,
      });
      if (r.ok) {
        const j = await r.json() as { fact: { id: string } };
        createdId = j.fact.id;
        extractedFacts++;
      }
    } catch {}
    if (createdId && conf >= AUTO_APPROVE) {
      try {
        const ap = await api2(`/v2/fact/${createdId}/approve`, {
          reason: `auto: confidence=${conf.toFixed(2)} via dump-packet`,
        });
        if (ap.ok) approvedFacts++;
      } catch {}
    }
  }
}
console.error(`[dump] extracted ${extractedFacts} facts (${approvedFacts} approved) + ${extractedEntities} entities`);

// 3. Two-channel recall
const r = await api2("/v2/recall/packet", {
  query: rec.question,
  purpose: `dump_packet_${mode}`,
  limit_evidence: 10,
  limit_memory: 20,
  use_vector: true,
  fusion: "weighted",
});
if (!r.ok) { console.error(`[dump] recall failed: ${r.status}`); process.exit(1); }
const channels = await r.json() as {
  evidence_channel: RetrievalHit[];
  memory_channel: RetrievalHit[];
};
console.error(`[dump] evidence: ${channels.evidence_channel.length} hits, memory: ${channels.memory_channel.length} hits`);

// 4. Build & render packet
const idToSession = new Map<string, string>();
for (const [sid, eid] of sessionToEpisode) idToSession.set(eid, sid);
const sidToContent = new Map<string, string>();
const sidToDate = new Map<string, string>();
for (let i = 0; i < rec.haystack_session_ids.length; i++) {
  const sid = rec.haystack_session_ids[i];
  sidToContent.set(sid, sessionToContent(rec.haystack_sessions[i], sid, rec.haystack_dates[i]));
  sidToDate.set(sid, rec.haystack_dates[i] ?? "");
}
const rawSessionText = new Map<string, { date?: string; text: string }>();
for (const h of channels.evidence_channel) {
  const sid = idToSession.get(h.id);
  if (!sid) continue;
  const text = sidToContent.get(sid);
  const date = sidToDate.get(sid);
  if (text) rawSessionText.set(h.id, { ...(date ? { date } : {}), text });
}

const hits: TwoChannelHits = {
  evidence_channel: channels.evidence_channel,
  memory_channel: channels.memory_channel,
};
const packet = buildMemoryPacket({
  query: rec.question,
  question_date: rec.question_date,
  question_type: rec.question_type,
  hits,
  raw_session_text: rawSessionText,
});

console.error(`[dump] packet sections: current_state=${packet.current_state.length} facts=${packet.approved_facts.length} beliefs=${packet.cognitive_beliefs.length} entities=${packet.entities.length} timeline=${packet.evidence_timeline.length} conflicts=${packet.conflicts.length} uncertainty=${packet.uncertainty.length} raw=${packet.raw_supporting_excerpts.length}`);

console.log("════════════════════════════════════════════════════════════════════");
console.log(`  QUESTION_ID: ${qid}  |  category: ${rec.question_type}`);
console.log(`  GOLD ANSWER: ${rec.answer}`);
console.log(`  MODE: ${mode}`);
console.log("════════════════════════════════════════════════════════════════════");
console.log("");

const rendered = mode === "zep-format"
  ? compilePacketAsZepFormat(packet)
  : compilePacketToPrompt(packet, { budget: 200000 });
console.log(rendered);

console.log("");
console.log("════════════════════════════════════════════════════════════════════");
console.log(`  END PACKET. Total chars: ${rendered.length}`);
console.log("════════════════════════════════════════════════════════════════════");
