// Layer 3 — Automated reflection: synthesize cognitive records (beliefs/
// observations/experiences) from a window of recent episodes + facts.
//
// IMPORTANT: this runs OFFLINE / on-demand, never on the write path. The
// no-LLM-on-every-write principle is preserved. Reflection can be triggered
// via POST /v2/reflect or via a scheduled cron job (operator choice).
//
// v2.0 strategy: rule-based synthesis. We aggregate evidence by entity and
// produce three kinds of cognitive records:
//   - experience  : an episode marked with kind "tool_call" or "observation"
//                   becomes an experience record summarizing what happened
//   - observation : pattern across N+ episodes mentioning the same entity
//                   becomes an observation about that entity
//   - belief      : when 3+ supporting episodes/facts converge on a fact,
//                   produce a belief with confidence proportional to support
//
// v2.1 will add LLM-backed reflection as an opt-in upgrade.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Episode, SemanticFact, CognitiveRecord } from "./types";
import { recordCognitive } from "./layer3-cognitive";
import { factValidSince } from "./temporal";
import { pickExtractor } from "./llm-extractor";

export interface ReflectInput {
  vaultRoot: string;
  owner: string;
  actor: string;
  since?: string;              // ISO timestamp; default: last 7 days
  min_support?: number;        // minimum evidence count for a belief; default 3
  max_records_emitted?: number;
  // v2.9.0+ — opt-in LLM-driven belief synthesis (NEW; closes Hindsight gap).
  // When true, after the rule-based pass runs, the same window of episodes
  // is fed to a structured-prompt LLM that proposes beliefs/observations as
  // DRAFTS with evidence excerpts. Drafts go through the acceptance gate
  // before they surface in retrieval — same governance as fact extraction.
  llm?: boolean;
  llm_max_per_window?: number;  // cap on LLM-proposed drafts per call (default 10)
}

export interface ReflectionReport {
  reflected_at: string;
  windowed_episodes: number;
  windowed_facts: number;
  cognitive_records_created: number;
  records: CognitiveRecord[];
  // v2.9.0+ separate counts for the LLM-driven pass — surfaces how much
  // of the report came from the heuristic strategies vs. the LLM.
  llm_drafts_proposed?: number;
  llm_errors?: number;
}

// Walk owner's episode directory for episodes since `since`.
function loadEpisodes(vaultRoot: string, owner: string, since: string): Episode[] {
  const ownerDir = join(vaultRoot, "episodes", owner);
  if (!existsSync(ownerDir)) return [];
  const out: Episode[] = [];
  for (const bucket of readdirSync(ownerDir)) {
    const bucketPath = join(ownerDir, bucket);
    let files: string[] = [];
    try { files = readdirSync(bucketPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      try {
        const parsed = matter(readFileSync(join(bucketPath, f), "utf8"));
        const ep = { ...parsed.data, content: parsed.content.trim() } as Episode;
        if (ep.timestamp >= since) out.push(ep);
      } catch { /* skip */ }
    }
  }
  return out;
}

function loadFacts(vaultRoot: string, owner: string, since: string): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      // v2.7.4+ epoch-ms temporal comparison (W8).
      if (factValidSince(fact, since)) out.push(fact);
    } catch { /* skip */ }
  }
  return out;
}

// Tokenize content to extract candidate entities (capitalized multi-word phrases
// or quoted strings). This is intentionally crude — proper extraction is v2.1.
function candidateEntities(text: string): string[] {
  const out = new Set<string>();
  // Multi-word capitalized phrases (e.g., "Marcel Schmidt", "Säule 3a")
  const phrases = text.match(/\b([A-ZÄÖÜ][\wäöü]+(?:\s+[A-ZÄÖÜ0-9][\wäöü0-9]+){0,3})\b/g) ?? [];
  for (const p of phrases) {
    if (p.length >= 3 && p.length <= 80) out.add(p);
  }
  return [...out];
}

export function reflect(input: ReflectInput): ReflectionReport {
  const cutoff = input.since
    ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const minSupport = input.min_support ?? 3;
  const cap = input.max_records_emitted ?? 50;

  const episodes = loadEpisodes(input.vaultRoot, input.owner, cutoff);
  const facts = loadFacts(input.vaultRoot, input.owner, cutoff);

  const records: CognitiveRecord[] = [];

  // ── Strategy 1: each tool_call / observation episode becomes an experience
  for (const ep of episodes) {
    if (records.length >= cap) break;
    if (ep.kind !== "tool_call" && ep.kind !== "observation") continue;
    const r = recordCognitive(input.vaultRoot, {
      kind: "experience",
      content: ep.content.slice(0, 280),
      confidence: 0.7,
      derived_from: [ep.id],
      actor: input.actor,
      owner: input.owner,
    });
    records.push(r);
  }

  // ── Strategy 2: entity-mention frequency → observation
  const entityCounts = new Map<string, { count: number; episode_ids: Set<string> }>();
  for (const ep of episodes) {
    const cands = candidateEntities(ep.content);
    for (const c of cands) {
      const entry = entityCounts.get(c) ?? { count: 0, episode_ids: new Set<string>() };
      entry.count++;
      entry.episode_ids.add(ep.id);
      entityCounts.set(c, entry);
    }
  }
  for (const [entity, { count, episode_ids }] of entityCounts) {
    if (records.length >= cap) break;
    if (count < minSupport) continue;
    if (episode_ids.size < 2) continue;  // mentioned in only 1 episode is too narrow
    const r = recordCognitive(input.vaultRoot, {
      kind: "observation",
      content: `Entity "${entity}" mentioned ${count} times across ${episode_ids.size} episodes since ${cutoff}.`,
      confidence: Math.min(0.5 + count / 20, 0.9),
      derived_from: [...episode_ids],
      actor: input.actor,
      owner: input.owner,
    });
    records.push(r);
  }

  // ── Strategy 3: subject-predicate frequency → belief
  // Group facts by subject+predicate; if N≥minSupport facts converge, form a belief.
  const groupedFacts = new Map<string, SemanticFact[]>();
  for (const f of facts) {
    if ((f as any).invalidated_at) continue;
    const k = `${f.subject}::${f.predicate}`;
    const arr = groupedFacts.get(k) ?? [];
    arr.push(f);
    groupedFacts.set(k, arr);
  }
  for (const [key, group] of groupedFacts) {
    if (records.length >= cap) break;
    if (group.length < minSupport) continue;
    const [subj, pred] = key.split("::");
    const objs = [...new Set(group.map(f => f.object))];
    const avgConf = group.reduce((s, f) => s + f.confidence, 0) / group.length;
    const r = recordCognitive(input.vaultRoot, {
      kind: "belief",
      content: `${subj} ${pred} ${objs.join(" / ")} (supported by ${group.length} convergent fact(s); avg confidence ${avgConf.toFixed(2)}).`,
      confidence: Math.min(avgConf * Math.min(group.length / 5, 1.0) + 0.3, 0.95),
      derived_from: group.map(f => f.id),
      actor: input.actor,
      owner: input.owner,
    });
    records.push(r);
  }

  return {
    reflected_at: new Date().toISOString(),
    windowed_episodes: episodes.length,
    windowed_facts: facts.length,
    cognitive_records_created: records.length,
    records,
  };
}

// v2.9.0+ LLM-driven reflection (NEW — closes Hindsight "reflection
// quality" gap). Runs ASYNCHRONOUSLY because it makes one or more LLM
// calls. Produces DRAFT cognitive records (status: "draft") that go
// through the acceptance gate before retrieval surfaces them — same
// governance posture as fact extraction. Reuses pickExtractor() so the
// same model selection (Ollama / Anthropic / OpenAI) applies.
//
// Prompt strategy: feed the LLM a structured window of episodes + facts
// and ask for high-confidence (subject, predicate, claim) beliefs that
// the evidence supports. Each belief carries an evidence_excerpt so the
// acceptance gate can verify it before promoting.
const REFLECT_SYSTEM = `You are a careful reflection assistant for an AI memory system. Given a window of recent conversation episodes and extracted facts, propose HIGH-CONFIDENCE beliefs the agent should hold about the user, their world, or their preferences.

Rules:
- Only emit beliefs the evidence DIRECTLY supports — no speculation, no extrapolation.
- Each belief must reference at least one episode or fact ID as evidence.
- Reject:
  · single-incident generalizations ("user once mentioned X" is not a belief)
  · contradicted patterns (do not synthesize beliefs from one-off contradictions)
  · social-graph fabrications (do not claim relationships not stated)
- Prefer beliefs about persistent preferences, roles, decisions, or commitments — not transient mentions.
- Confidence: 0.95 only when explicitly stated across multiple episodes; 0.85 for clearly implied by 2+ pieces of evidence; ≤0.75 → don't emit.

Output ONLY valid JSON, no prose, no markdown fences. Schema:
{ "beliefs": [
    {"content": "concise belief sentence", "evidence_excerpt": "verbatim ≤200-char span from the window that supports this", "confidence": 0.9}
  ]
}
If the window contains zero high-confidence beliefs, return {"beliefs": []}.`;

export async function reflectLLM(input: ReflectInput): Promise<ReflectionReport> {
  // Run the rule-based pass first.
  const base = reflect(input);

  // Build a structured window for the LLM. Cap aggregate window size so a
  // single call doesn't exhaust the model's context.
  const cap = input.max_records_emitted ?? 50;
  const maxDrafts = input.llm_max_per_window ?? 10;
  const cutoff = input.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const episodes = loadEpisodes(input.vaultRoot, input.owner, cutoff);
  const facts = loadFacts(input.vaultRoot, input.owner, cutoff);

  const windowParts: string[] = [];
  let budget = 8000;  // chars
  for (const ep of episodes.slice(0, 30)) {
    const line = `[episode ${ep.id}] (${ep.kind}) ${ep.content.replace(/\s+/g, " ").slice(0, 400)}`;
    if (line.length > budget) break;
    windowParts.push(line);
    budget -= line.length + 2;
  }
  for (const f of facts.slice(0, 30)) {
    const line = `[fact ${f.id}] ${f.subject} ${f.predicate} ${f.object} (conf=${f.confidence})`;
    if (line.length > budget) break;
    windowParts.push(line);
    budget -= line.length + 2;
  }
  const window = windowParts.join("\n");

  let errors = 0;
  let proposed = 0;
  if (window) {
    try {
      const extractor = await pickExtractor();
      // Reuse the extractor's HTTP plumbing by going through its extract()
      // method, but with a reflection-specific prompt. The extractor returns
      // {facts, entities} — we shoehorn beliefs into the facts channel and
      // ignore entities. (Future refactor: add a generic LLM call interface.)
      // For now we make a direct request mirroring the extractor's contract.
      const response = await callReflectionLLM(extractor, window);
      for (const belief of (response.beliefs ?? []).slice(0, maxDrafts)) {
        if (proposed >= maxDrafts) break;
        const content = String(belief?.content ?? "").trim();
        const conf = Number(belief?.confidence ?? 0);
        const excerpt = String(belief?.evidence_excerpt ?? "").trim();
        if (!content || conf < 0.75) continue;
        // Find a supporting episode for derived_from — match by excerpt
        // substring against each loaded episode body.
        const supports: string[] = [];
        const eLower = excerpt.toLowerCase();
        for (const ep of episodes) {
          if (ep.content.toLowerCase().includes(eLower)) supports.push(ep.id);
          if (supports.length >= 3) break;
        }
        if (supports.length === 0) continue;  // can't anchor → drop
        if (base.records.length >= cap) break;
        const r = recordCognitive(input.vaultRoot, {
          kind: "belief",
          content,
          confidence: Math.min(Math.max(conf, 0), 1),
          derived_from: supports,
          actor: input.actor,
          owner: input.owner,
          status: "draft",
          evidence_excerpt: excerpt,
          proposed_by: `reflect-llm:${extractor.name}`,
        } as any);
        base.records.push(r);
        proposed++;
      }
    } catch {
      errors++;
    }
  }
  base.cognitive_records_created = base.records.length;
  base.llm_drafts_proposed = proposed;
  base.llm_errors = errors;
  return base;
}

async function callReflectionLLM(
  extractor: { name: string; extract(text: string): Promise<any> },
  window: string,
): Promise<{ beliefs: Array<{ content: string; evidence_excerpt: string; confidence: number }> }> {
  // We piggy-back on the extractor's HTTP call. To keep the change tightly
  // scoped, we go directly to Ollama/Anthropic/OpenAI based on the extractor
  // name. (Future cleanup: the LLM-extractor module should expose a generic
  // `chat(systemPrompt, userPrompt)` method.)
  const userPrompt = `Window:\n${window}\n\nReturn the JSON.`;
  const isOllama = extractor.name.startsWith("ollama:");
  const model = isOllama ? extractor.name.slice("ollama:".length) : "claude-haiku-4-5";

  if (isOllama) {
    const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    const r = await fetch(`${host.replace(/\/+$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, system: REFLECT_SYSTEM, prompt: userPrompt, stream: false }),
    });
    if (!r.ok) throw new Error(`reflect-llm ollama failed ${r.status}`);
    const d = await r.json() as { response: string };
    return parseBeliefs(d.response ?? "");
  }
  // Anthropic / OpenAI fallback — minimal implementation.
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: REFLECT_SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!r.ok) throw new Error(`reflect-llm anthropic failed ${r.status}`);
    const d = await r.json() as { content: Array<{ text: string }> };
    return parseBeliefs(d.content?.[0]?.text ?? "");
  }
  throw new Error("no LLM backend available for reflection");
}

function parseBeliefs(raw: string): { beliefs: any[] } {
  // The model sometimes wraps JSON in ```json ... ``` fences despite the prompt.
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const j = JSON.parse(stripped);
    if (j && Array.isArray(j.beliefs)) return j;
  } catch { /* fall through */ }
  return { beliefs: [] };
}
