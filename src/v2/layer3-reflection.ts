// Layer 3 — Automated reflection: synthesize cognitive records (beliefs/
// observations/experiences) from a window of recent episodes + facts.
//
// IMPORTANT: this runs OFFLINE / on-demand, never on the write path. The
// no-LLM-on-every-write principle is preserved. Reflection can be triggered
// via POST /v2/reflect or via a scheduled cron job (operator choice).
//
// v2.17.0 strategy — evidence rules only, no filler (the pronoun-counter
// and episode-photocopier strategies were deleted after the 2026-07-10
// small-batch autopsy). Two deterministic rules produce beliefs:
//   RULE A  corroboration — the same claim (entity-resolved subject,
//           canonical predicate, object) stated independently in >=2
//           distinct documents.
//   RULE B  current state — for one-value relations (works_at, lives_in,
//           ...), the single current value, but ONLY when time is
//           orderable (world date or supersession history). No dates ->
//           no conclusion; abstentions are reported (Ardin's rule).
// Idempotent via claim_key: re-runs update or skip, never duplicate.
// LLM-assisted reflection (opt-in) is scheduled for the next round.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Episode, SemanticFact, CognitiveRecord, BeliefKind } from "./types";
import {
  recordCognitive, findCognitiveByClaimKey, updateCognitiveSupport, supersedeBelief,
} from "./layer3-cognitive";
import { canonicalPredicate } from "./predicates";
import { isFunctionalFor } from "./layer4-supersession";
import { readEntity } from "./layer2-entities";
import { annotateFactCorroboration } from "./layer2-semantic";
import { pickExtractor } from "./llm-extractor";

export interface ReflectInput {
  vaultRoot: string;
  owner: string;
  actor: string;
  since?: string;              // ISO timestamp; default: last 7 days
  min_support?: number;        // minimum evidence count for a belief; default 3
  max_records_emitted?: number;
  // v2.18.0 — names/aliases that identify the OWNER's own world (their
  // person entity, their projects/systems). Rule A only creates beliefs
  // for self subjects; everything else is a WORLD claim and stays in
  // Layer 2 with a corroboration annotation (Ardin's boundary rule).
  // Defaults to tokens derived from owner + actor.
  self_names?: string[];
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
  // v2.17.0 — idempotency + transparency counters. Re-running reflection
  // over unchanged evidence yields created=0 and only `unchanged` grows.
  // `abstained` lists conclusions reflection REFUSED to draw and why
  // (Ardin's rule 2026-07-10: better silent than wrong) — silence must be
  // visible, not implicit.
  updated?: number;
  unchanged?: number;
  abstained?: Array<{ rule: string; subject: string; predicate: string; reason: string }>;
  // v2.18.0 — world claims several documents agree on. NOT beliefs (world
  // claims stay in Layer 2); listed here for transparency, and the facts
  // involved carry corroboration_sources.
  world_claims?: Array<{ subject: string; predicate: string; object: string; sources: number }>;
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

// v2.17.0 — load ALL approved facts. Conclusions are properties of the
// whole vault (two documents corroborating a claim may be months apart),
// so reflection no longer windows the fact set. The old code windowed on
// valid_from, which after v2.15's event-date fix meant WORLD time: your
// 2023 certification fell "outside last week" and was invisible to
// reflection. The `since` window is now informational only (report counts).
function loadFacts(vaultRoot: string, owner: string): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      if ((fact.status ?? "approved") !== "approved") continue;
      out.push(fact);
    } catch { /* skip */ }
  }
  return out;
}

// Learn-time of a fact: when mema first stored it (proposed_at from the
// consensus extractor), falling back to valid_from for hand-written facts.
function learnTime(f: SemanticFact): string {
  return (f as { proposed_at?: string }).proposed_at ?? f.valid_from ?? "";
}

// A world date is a plain YYYY / YYYY-MM / YYYY-MM-DD from the source text;
// ingestion fallbacks are full ISO timestamps. Length distinguishes them.
function hasWorldDate(f: SemanticFact): boolean {
  return typeof f.valid_from === "string" && f.valid_from.length <= 10 && f.valid_from.length >= 4;
}

export function reflect(input: ReflectInput): ReflectionReport {
  const cutoff = input.since
    ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const cap = input.max_records_emitted ?? 50;
  // v2.17.0 — corroboration needs at least this many DISTINCT source
  // documents agreeing on the same claim (was: >=3 facts regardless of
  // source, which let one document corroborate itself).
  const minSources = Math.max(2, input.min_support ?? 2);

  const episodes = loadEpisodes(input.vaultRoot, input.owner, cutoff);
  const facts = loadFacts(input.vaultRoot, input.owner);
  const windowedFacts = facts.filter(f => learnTime(f) >= cutoff).length;

  // v2.21.0 — general-review fix (split groups): facts ingested BEFORE
  // their entity existed carry no subject_entity_id, so the same subject
  // split into two claim groups and corroboration counts halved. Resolve
  // unlinked subjects through the entity registry (name + aliases).
  const entityIdByName = new Map<string, string>();
  const entDir = join(input.vaultRoot, "v2-entities", input.owner);
  if (existsSync(entDir)) {
    for (const ef of readdirSync(entDir)) {
      if (!ef.endsWith(".md")) continue;
      try {
        const e = matter(readFileSync(join(entDir, ef), "utf8")).data as
          { id?: string; name?: string; aliases?: string[] };
        if (!e.id) continue;
        for (const n of [e.name, ...(e.aliases ?? [])]) {
          const lc = (n ?? "").trim().toLowerCase();
          if (lc && !entityIdByName.has(lc)) entityIdByName.set(lc, e.id);
        }
      } catch { /* skip malformed */ }
    }
  }
  const subjKeyOf = (f: SemanticFact): string =>
    f.subject_entity_id
    ?? entityIdByName.get(f.subject.trim().toLowerCase())
    ?? f.subject.trim().toLowerCase();

  const records: CognitiveRecord[] = [];
  let created = 0, updated = 0, unchanged = 0;
  const abstained: NonNullable<ReflectionReport["abstained"]> = [];
  const worldClaims: NonNullable<ReflectionReport["world_claims"]> = [];

  // v2.18.0 — is this subject part of the owner's own world? Token match
  // against self names (default: owner + actor identifiers). "Ardin
  // Ibraimi" and "ardin.me" match owner "ardin-pai"; "Hock Tan" does not.
  const selfTokens = new Set(
    (input.self_names ?? [input.owner, input.actor])
      .flatMap(n => n.toLowerCase().split(/[^a-z0-9]+/))
      .filter(t => t.length >= 3),
  );
  const isSelfSubject = (subject: string): boolean =>
    subject.toLowerCase().split(/[^a-z0-9]+/).some(t => t.length >= 3 && selfTokens.has(t));

  // Write-or-update through the claim key: re-running reflection over
  // unchanged evidence must not duplicate (the autopsy found 150 copies of
  // 50 records after three runs).
  const upsert = (args: {
    kind: "belief"; content: string; confidence: number;
    derived_from: string[]; claim_key: string; subject_entity_id?: string | null;
    belief_kind: BeliefKind;
  }): void => {
    if (records.length >= cap) return;
    const existing = findCognitiveByClaimKey(input.vaultRoot, input.owner, args.claim_key);
    if (existing) {
      const sameSupport =
        JSON.stringify([...new Set(existing.derived_from)].sort())
        === JSON.stringify([...new Set(args.derived_from)].sort());
      const sameContent = existing.content.trim() === args.content.trim();
      // v2.18.0 — records written before labels existed get the label
      // backfilled in place instead of counting as unchanged.
      const sameKind = existing.belief_kind === args.belief_kind;
      if (sameSupport && sameContent && sameKind) { unchanged++; return; }
      // v2.21.0 — general-review fix: the source COUNT baked into the text
      // ("in 2 documents" -> "in 3 documents") is new evidence, not a new
      // conclusion. Compare with counts normalized so growth updates in
      // place instead of superseding an unchanged conclusion every time.
      const stripVolatile = (s: string) => s
        .replace(/independently stated in \d+ documents/g, "independently stated in N documents")
        .replace(/replaced \d+ earlier value\(s\)/g, "replaced N earlier value(s)");
      const sameConclusion = stripVolatile(existing.content.trim()) === stripVolatile(args.content.trim());
      if (!sameConclusion && existing.kind === "belief") {
        // The conclusion itself changed (e.g. a new current employer):
        // keep history — supersede the old belief with a fresh record.
        const fresh = recordCognitive(input.vaultRoot, {
          kind: args.kind, content: args.content, confidence: args.confidence,
          derived_from: args.derived_from, actor: input.actor, owner: input.owner,
          claim_key: args.claim_key, belief_kind: args.belief_kind,
          ...(args.subject_entity_id ? { subject_entity_id: args.subject_entity_id } : {}),
        });
        supersedeBelief(input.vaultRoot, existing.id, fresh.id, input.owner, input.actor);
        records.push(fresh); created++;
        return;
      }
      // Same conclusion, new evidence — refresh support in place.
      const upd = updateCognitiveSupport(input.vaultRoot, input.owner, existing.id, {
        content: args.content, confidence: args.confidence, derived_from: args.derived_from,
        belief_kind: args.belief_kind,
      }, input.actor);
      if (upd) { records.push(upd); updated++; }
      return;
    }
    const r = recordCognitive(input.vaultRoot, {
      kind: args.kind, content: args.content, confidence: args.confidence,
      derived_from: args.derived_from, actor: input.actor, owner: input.owner,
      claim_key: args.claim_key, belief_kind: args.belief_kind,
      ...(args.subject_entity_id ? { subject_entity_id: args.subject_entity_id } : {}),
    });
    records.push(r); created++;
  };

  // ── RULE A — corroboration: the SAME claim stated independently in
  // several documents becomes a belief. Grouped by entity-or-name subject,
  // canonical predicate and object, so alias spellings and predicate
  // synonyms tally together (same normalization the consensus vote uses).
  interface Group {
    facts: SemanticFact[]; episodes: Set<string>;
    subject: string; predicate: string; object: string;
    subjectEntityId: string | null;
  }
  const groups = new Map<string, Group>();
  const active = facts.filter(f => !f.invalidated_at && !f.superseded_by);
  for (const f of active) {
    const subjKey = subjKeyOf(f);
    const key = `${subjKey}|${canonicalPredicate(f.predicate)}|${f.object.trim().toLowerCase()}`;
    const g = groups.get(key) ?? {
      facts: [], episodes: new Set<string>(),
      subject: f.subject, predicate: f.predicate, object: f.object,
      subjectEntityId: f.subject_entity_id ?? null,
    };
    g.facts.push(f);
    for (const ep of f.derived_from ?? []) g.episodes.add(ep);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    if (g.episodes.size < minSources) continue;
    // v2.18.0 — world claims stay in Layer 2 (Ardin's boundary rule +
    // France rule: our own documents agreeing does not make it true).
    // Only claims about the owner's own world become beliefs; everything
    // else annotates the facts with the corroboration count and waits for
    // the fact-check pass to establish truth.
    if (!isSelfSubject(g.subject)) {
      for (const f of g.facts) {
        annotateFactCorroboration(input.vaultRoot, input.owner, f.id, g.episodes.size, input.actor);
      }
      worldClaims.push({
        subject: g.subject, predicate: g.predicate, object: g.object,
        sources: g.episodes.size,
      });
      continue;
    }
    const meanConf = g.facts.reduce((s, f) => s + f.confidence, 0) / g.facts.length;
    const confidence = Math.min(0.95, meanConf * (0.75 + 0.1 * g.episodes.size));
    upsert({
      kind: "belief",
      content: `${g.subject} ${g.predicate} ${g.object} — independently stated in ${g.episodes.size} documents.`,
      confidence,
      derived_from: [...new Set([...g.facts.map(f => f.id), ...g.episodes])],
      claim_key: `corro|${key}`,
      subject_entity_id: g.subjectEntityId,
      belief_kind: "personal",
    });
  }

  // ── RULE B — current state of one-value relations (works_at, lives_in,
  // ...): conclude which value is CURRENT, but only when the evidence can
  // actually order time. Ardin's rule (2026-07-10): no dates -> no
  // conclusion; abstentions are reported, never silent.
  interface StateGroup {
    current: SemanticFact[]; superseded: number;
    subject: string; predicate: string; subjectEntityId: string | null;
  }
  const stateGroups = new Map<string, StateGroup>();
  // v2.17.1 — Rule B must know WHO the subject is: "currently lives_in /
  // located_in" only makes sense for persons. A company holds many
  // locations at once, so no single one is "current" — concluding
  // "TSMC currently located_in Germany" from the Dresden fab was wrong.
  // Entity types are read once per entity and cached.
  const entityTypeCache = new Map<string, string | null>();
  const subjectTypeOf = (f: SemanticFact): string | null => {
    if (!f.subject_entity_id) return null;
    let t = entityTypeCache.get(f.subject_entity_id);
    if (t === undefined) {
      t = readEntity(input.vaultRoot, input.owner, f.subject_entity_id)?.type ?? null;
      entityTypeCache.set(f.subject_entity_id, t);
    }
    return t;
  };
  const today = new Date().toISOString().slice(0, 10);
  for (const f of facts) {
    if (!isFunctionalFor(f.predicate, subjectTypeOf(f))) continue;
    const subjKey = subjKeyOf(f);
    const key = `${subjKey}|${canonicalPredicate(f.predicate)}`;
    const g = stateGroups.get(key) ?? {
      current: [], superseded: 0,
      subject: f.subject, predicate: f.predicate,
      subjectEntityId: f.subject_entity_id ?? null,
    };
    if (f.invalidated_at || f.superseded_by) g.superseded++;
    else g.current.push(f);
    stateGroups.set(key, g);
  }
  for (const [key, g] of stateGroups) {
    if (g.current.length === 0) continue;
    if (g.current.length > 1) {
      abstained.push({
        rule: "current-state", subject: g.subject, predicate: g.predicate,
        reason: `${g.current.length} candidate values and no dates to order them — refusing to guess which is current`,
      });
      continue;
    }
    const f = g.current[0];
    // v2.17.1 — a fact dated in the FUTURE ("starts at X in 2027-03") is a
    // plan, not a current state. Refuse to conclude "currently" from it,
    // and say so visibly.
    if (hasWorldDate(f) && (f.valid_from ?? "") > today) {
      abstained.push({
        rule: "current-state", subject: g.subject, predicate: g.predicate,
        reason: `stated date ${f.valid_from} is in the future — a plan, not a current state`,
      });
      continue;
    }
    // A lone undated fact with no superseded history would make the belief
    // a photocopy of the fact — no added knowledge. Conclude only when
    // either history exists (supersession established currency) or the
    // fact carries a world date.
    if (g.superseded === 0 && !hasWorldDate(f)) continue;
    const since = hasWorldDate(f) ? ` since ${f.valid_from}` : "";
    const history = g.superseded > 0 ? `; replaced ${g.superseded} earlier value(s)` : "";
    upsert({
      kind: "belief",
      content: `${g.subject} currently ${g.predicate} ${f.object}${since}${history}.`,
      confidence: Math.min(0.95, f.confidence + 0.05 * g.superseded),
      derived_from: [...new Set([f.id, ...(f.derived_from ?? [])])],
      claim_key: `current|${key}`,
      subject_entity_id: g.subjectEntityId,
      belief_kind: "personal",
    });
  }

  return {
    reflected_at: new Date().toISOString(),
    windowed_episodes: episodes.length,
    windowed_facts: windowedFacts,
    cognitive_records_created: created,
    records,
    updated,
    unchanged,
    abstained,
    world_claims: worldClaims,
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
  const facts = loadFacts(input.vaultRoot, input.owner).filter(f => learnTime(f) >= cutoff);

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
        // v2.21.0 — general-review fix: includes("") matches EVERY episode,
        // so a missing excerpt anchored beliefs to arbitrary documents.
        // No usable quote -> no anchor -> drop (fail-closed for the
        // untrusted LLM path).
        if (excerpt.length < 10) continue;
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
