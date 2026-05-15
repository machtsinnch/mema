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

export interface ReflectInput {
  vaultRoot: string;
  owner: string;
  actor: string;
  since?: string;              // ISO timestamp; default: last 7 days
  min_support?: number;        // minimum evidence count for a belief; default 3
  max_records_emitted?: number;
}

export interface ReflectionReport {
  reflected_at: string;
  windowed_episodes: number;
  windowed_facts: number;
  cognitive_records_created: number;
  records: CognitiveRecord[];
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
      if ((fact as any).valid_from >= since) out.push(fact);
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
