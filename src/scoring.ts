// machtsinn.ai — hybrid retrieval scoring.
// score = w_r * relevance + w_t * recency + w_i * importance + w_s * trust
// Inspired by Generative Agents (Park et al. 2023), extended with trust.

import type { Memory, SearchHit } from "./types";
import type { RipgrepHit } from "./search";

export interface ScoringWeights {
  relevance: number;
  recency: number;
  importance: number;
  trust: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  relevance: 0.4,
  recency: 0.3,
  importance: 0.2,
  trust: 0.1,
};

// recency decay constant — 30 days half-life
const RECENCY_DECAY_DAYS = 30;

function recencyScore(updatedISO: string): number {
  const ageMs = Date.now() - new Date(updatedISO).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / RECENCY_DECAY_DAYS);
}

function importanceScore(memory: Memory): number {
  const fm = memory.frontmatter;
  // tag-based + link in-degree placeholder. More tags + links = more important.
  const tagBoost = Math.min(fm.tags.length / 5, 1) * 0.5;
  const linkBoost = Math.min(fm.links.length / 5, 1) * 0.5;
  return tagBoost + linkBoost;
}

function relevanceScore(memory: Memory, matchCount: number, query: string): number {
  // Combine match count with frontmatter-tag query overlap.
  const queryTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tagOverlap = memory.frontmatter.tags.filter(t =>
    queryTokens.some(q => t.toLowerCase().includes(q))
  ).length;
  const bodyComponent = Math.min(matchCount / 5, 1) * 0.7;
  const tagComponent = Math.min(tagOverlap / 3, 1) * 0.3;
  return bodyComponent + tagComponent;
}

export function scoreHits(
  hits: RipgrepHit[],
  query: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): SearchHit[] {
  return hits
    .map(h => {
      const rel = relevanceScore(h.memory, h.matches.length, query);
      const rec = recencyScore(h.memory.frontmatter.updated);
      const imp = importanceScore(h.memory);
      const tru = h.memory.frontmatter.trust;
      const score =
        weights.relevance * rel +
        weights.recency * rec +
        weights.importance * imp +
        weights.trust * tru;
      const snippets = h.matches.slice(0, 3).map(m => m.text);
      return {
        memory: h.memory,
        score,
        components: { relevance: rel, recency: rec, importance: imp, trust: tru },
        snippets,
      } satisfies SearchHit;
    })
    .sort((a, b) => b.score - a.score);
}
