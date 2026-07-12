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
  recordCognitive, findCognitiveByClaimKey, findCognitiveMatch,
  updateCognitiveSupport, supersedeBelief,
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
  // v2.22.4 — reverse map (entity id -> its names/aliases, lowercased) built
  // for ALL entities regardless of status. Powers the entity->raw key-migration
  // fallback below: a belief keyed by a now-rejected entity's id can still be
  // matched back to the raw-name group by resolving its subject_entity_id here.
  const entityNamesById = new Map<string, Set<string>>();
  const entDir = join(input.vaultRoot, "v2-entities", input.owner);
  if (existsSync(entDir)) {
    for (const ef of readdirSync(entDir)) {
      if (!ef.endsWith(".md")) continue;
      try {
        const e = matter(readFileSync(join(entDir, ef), "utf8")).data as
          { id?: string; name?: string; aliases?: string[]; status?: string };
        if (!e.id) continue;
        const names = new Set<string>();
        for (const n of [e.name, ...(e.aliases ?? [])]) {
          const lc = (n ?? "").trim().toLowerCase();
          if (lc) names.add(lc);
        }
        entityNamesById.set(e.id, names);
        // v2.22.1 (round-2 finding): skip rejected AND draft entities — a
        // reviewer-rejected (e.g. hallucinated) entity's aliases must NOT
        // glue distinct subjects together and mint false corroboration.
        if ((e.status ?? "approved") !== "approved") continue;
        for (const lc of names) {
          if (!entityIdByName.has(lc)) entityIdByName.set(lc, e.id);
        }
      } catch { /* skip malformed */ }
    }
  }
  const subjKeyOf = (f: SemanticFact): string =>
    f.subject_entity_id
    ?? entityIdByName.get(f.subject.trim().toLowerCase())
    ?? f.subject.trim().toLowerCase();
  // v2.22.5 — shared entity->raw resolution for the bidirectional key-migration
  // fallback. Both Rule A (corroboration) and Rule B (current-state) use it to
  // decide whether an entity-id-keyed belief belongs to a raw-name group whose
  // entity was rejected between runs: true when the reverse map resolves `id`
  // back to this group's raw subject. entityNamesById is all-status on purpose.
  const namesResolveTo = (rawSubj: string, id: string | null | undefined): boolean =>
    !!id && (entityNamesById.get(id)?.has(rawSubj) ?? false);

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
    // v2.22.1 (round-2 finding): the claim_key changes when a subject's
    // entity gets registered between runs (raw-name key -> entity-id key),
    // which minted a DUPLICATE belief. alt_claim_key is the pre-entity
    // (raw-subject) key; if the primary lookup misses but the alt hits, we
    // update that record in place AND migrate its key so it's stable after.
    alt_claim_key?: string;
    // v2.22.4 — the OTHER migration direction. When the primary + raw-alt keys
    // both miss (the subject's entity was REJECTED between runs, so the group
    // reverted to a raw-name key while the surviving belief is still keyed by
    // the entity-id), this locates that entity-id-keyed belief so we update it
    // in place instead of minting a duplicate. Consulted only when the raw-alt
    // lookup could not disambiguate (alt === primary).
    entity_fallback?: () => ReturnType<typeof findCognitiveByClaimKey>;
  }): void => {
    if (records.length >= cap) return;
    let migrateKey: string | undefined;
    let existing = findCognitiveByClaimKey(input.vaultRoot, input.owner, args.claim_key);
    if (!existing && args.alt_claim_key && args.alt_claim_key !== args.claim_key) {
      existing = findCognitiveByClaimKey(input.vaultRoot, input.owner, args.alt_claim_key);
      if (existing) migrateKey = args.claim_key;   // heal the key on this pass
    }
    if (!existing && args.entity_fallback) {
      existing = args.entity_fallback();
      // heal the surviving record onto the current (raw-name) key so future
      // runs hit the primary lookup directly.
      if (existing && existing.claim_key !== args.claim_key) migrateKey = args.claim_key;
    }
    if (existing) {
      const sameSupport =
        JSON.stringify([...new Set(existing.derived_from)].sort())
        === JSON.stringify([...new Set(args.derived_from)].sort());
      const sameContent = existing.content.trim() === args.content.trim();
      // v2.18.0 — records written before labels existed get the label
      // backfilled in place instead of counting as unchanged.
      const sameKind = existing.belief_kind === args.belief_kind;
      if (sameSupport && sameContent && sameKind) {
        // v2.22.5 — even when nothing else changed, heal a drifting key onto
        // the current (raw-name) form when a migration probe matched an
        // entity-id-keyed survivor; otherwise the key never converges and
        // every future run re-runs the fallback scan.
        if (migrateKey && existing.claim_key !== migrateKey) {
          const healed = updateCognitiveSupport(input.vaultRoot, input.owner, existing.id, {
            content: existing.content, confidence: existing.confidence,
            derived_from: existing.derived_from, belief_kind: existing.belief_kind,
            claim_key: migrateKey,
          }, input.actor);
          if (healed) { records.push(healed); updated++; return; }
        }
        unchanged++; return;
      }
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
        ...(migrateKey ? { claim_key: migrateKey } : {}),
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
    const primaryClaimKey = `corro|${key}`;
    // v2.22.4 — entity->raw migration probe: when the group is on a raw-name
    // key (the subject's entity was REJECTED between runs), find the surviving
    // belief still keyed by that entity's id. Matches on the (predicate|object)
    // key suffix AND requires the key's subject segment to be an entity id that
    // the all-status reverse map resolves back to THIS group's raw subject (or
    // the record's subject_entity_id to do so), so we never fold a different
    // subject that merely shares the same predicate/object.
    const rawSubj = g.subject.trim().toLowerCase();
    const keySuffix = `|${canonicalPredicate(g.predicate)}|${g.object.trim().toLowerCase()}`;
    const namesResolveToSubj = (id: string | null | undefined): boolean =>
      namesResolveTo(rawSubj, id);
    upsert({
      kind: "belief",
      content: `${g.subject} ${g.predicate} ${g.object} — independently stated in ${g.episodes.size} documents.`,
      confidence,
      derived_from: [...new Set([...g.facts.map(f => f.id), ...g.episodes])],
      claim_key: primaryClaimKey,
      alt_claim_key: `corro|${rawSubj}${keySuffix}`,
      entity_fallback: () => findCognitiveMatch(input.vaultRoot, input.owner, r => {
        const ck = r.claim_key;
        if (typeof ck !== "string" || ck === primaryClaimKey) return false;
        if (!ck.startsWith("corro|") || !ck.endsWith(keySuffix)) return false;
        const subjPart = ck.slice("corro|".length, ck.length - keySuffix.length);
        return namesResolveToSubj(subjPart) || namesResolveToSubj(r.subject_entity_id);
      }),
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
    // v2.22.3 (round-3 finding): resolve the subject the SAME way subjKeyOf
    // does (id first, then the entity-name registry). An unlinked residence
    // fact about a registered person previously returned type null, so the
    // person-only location-predicate gate (isFunctionalFor) dropped it out of
    // Rule B entirely — desyncing filtering from grouping and asserting an
    // outdated residence as current. Consult entityIdByName too.
    const eid = f.subject_entity_id ?? entityIdByName.get(f.subject.trim().toLowerCase());
    if (!eid) return null;
    let t = entityTypeCache.get(eid);
    if (t === undefined) {
      t = readEntity(input.vaultRoot, input.owner, eid)?.type ?? null;
      entityTypeCache.set(eid, t);
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
    // v2.22.1 (round-2 finding): a fact whose validity window already ended
    // (valid_to in the past) is HISTORY — count it like a superseded value,
    // never as a current one. Without this, "worked at OldCorp 2018-2020"
    // was asserted as "currently works_at OldCorp", and once a real current
    // job arrived Rule B saw two "current" values and abstained wrongly.
    const ended = f.valid_to && String(f.valid_to).slice(0, 10) <= today;
    if (f.invalidated_at || f.superseded_by || ended) g.superseded++;
    else g.current.push(f);
    stateGroups.set(key, g);
  }
  for (const [key, g] of stateGroups) {
    if (g.current.length === 0) continue;
    // v2.22.6 (round-6 finding): count DISTINCT object values, not fact
    // count. Same-value corroboration (e.g. "works_at AUDI" confirmed
    // twice) leaves several live facts asserting ONE value — that is not a
    // conflict, it is agreement. Collapsing by normalized object stops a
    // fabricated "N candidate values" abstention from suppressing an
    // unambiguous current-state belief. Only >=2 DISTINCT values abstain.
    // v2.22.7 (l3-reflect finding): partition the live facts into
    // NOT-YET-CURRENT (future-dated plans) vs ACTUALLY-CURRENT *before*
    // counting distinct values. The future-date guard used to live only
    // inside the single-value branch (below), AFTER this multi-value
    // abstention — so a future plan and a genuinely current fact together
    // counted as "2 distinct current values" and abstained, when the future
    // date in fact ORDERS them (the plan is not yet current). Exclude
    // future-dated facts here so the multi-value branch is consistent with
    // the single-value future guard.
    const actuallyCurrent = g.current.filter(
      cf => !(hasWorldDate(cf) && (cf.valid_from ?? "") > today),
    );
    // v2.22.6 — count DISTINCT object values, not fact count (same-value
    // corroboration is agreement, not a conflict).
    const byObject = new Map<string, SemanticFact[]>();
    for (const cf of actuallyCurrent) {
      const ok = cf.object.trim().toLowerCase();
      (byObject.get(ok) ?? byObject.set(ok, []).get(ok)!).push(cf);
    }
    if (byObject.size === 0) {
      // Every live value is future-dated — all plans, nothing current yet.
      abstained.push({
        rule: "current-state", subject: g.subject, predicate: g.predicate,
        reason: `all current-state facts are future-dated — a plan, not a current state`,
      });
      continue;
    }
    if (byObject.size > 1) {
      abstained.push({
        rule: "current-state", subject: g.subject, predicate: g.predicate,
        reason: `${byObject.size} distinct current values with no supersession history to order them — refusing to guess which is current`,
      });
      continue;
    }
    // One distinct value. derived_from is unioned across every same-value
    // fact so the belief cites all its corroborating evidence.
    const sameObject = [...byObject.values()][0];
    // v2.22.9 — determine world-datedness and the "since" value across ALL
    // same-value facts, not just the single earliest-by-valid_from fact.
    // valid_from mixes short world dates ('2020-01-01') with long ISO
    // ingestion-timestamp fallbacks ('2019-05-10T12:00:00.000Z'); an ISO
    // timestamp that sorts earlier than a genuinely world-dated same-value
    // fact must NOT mask that real currency. Otherwise the current-state
    // belief was silently dropped (no record, nothing in `abstained`) or
    // rendered without its real "since" date.
    const worldDated = sameObject.filter(hasWorldDate);
    // Earliest-overall fact is kept only as the ordering representative
    // (object value, confidence base, future-date tiebreak below).
    const f = sameObject.reduce((a, b) =>
      (a.valid_from ?? "") <= (b.valid_from ?? "") ? a : b);
    const unionedDerivedFrom = [...new Set(
      sameObject.flatMap(x => [x.id, ...(x.derived_from ?? [])]),
    )];
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
    // either history exists (supersession established currency) or SOME
    // same-value fact carries a world date. Keying on `worldDated` (not the
    // single earliest fact) stops an ISO ingestion-timestamp fallback that
    // merely sorts earliest from suppressing a genuinely world-dated value.
    if (g.superseded === 0 && worldDated.length === 0) continue;
    // Use the earliest world date among the same-value facts for "since".
    const sinceFact = worldDated.length > 0
      ? worldDated.reduce((a, b) => (a.valid_from ?? "") <= (b.valid_from ?? "") ? a : b)
      : undefined;
    const since = sinceFact ? ` since ${sinceFact.valid_from}` : "";
    const history = g.superseded > 0 ? `; replaced ${g.superseded} earlier value(s)` : "";
    // v2.22.5 — Rule B gets the same entity->raw migration fallback Rule A has.
    // When the subject's entity is REJECTED between runs the group key reverts
    // from `current|<ENTID>|<pred>` to `current|<raw>|<pred>`; the primary and
    // raw-alt lookups both miss the surviving entity-id-keyed belief (here alt
    // === primary, so the alt probe is skipped), and without this fallback a
    // SECOND identical live belief was minted. This locates the entity-id-keyed
    // survivor by (predicate) key suffix, requiring the key's subject segment —
    // or the record's subject_entity_id — to resolve back to THIS raw subject.
    const rawSubj = g.subject.trim().toLowerCase();
    const keySuffix = `|${canonicalPredicate(g.predicate)}`;
    const namesResolveToSubj = (id: string | null | undefined): boolean =>
      namesResolveTo(rawSubj, id);
    const primaryClaimKey = `current|${key}`;
    upsert({
      kind: "belief",
      content: `${g.subject} currently ${g.predicate} ${f.object}${since}${history}.`,
      confidence: Math.min(0.95, f.confidence + 0.05 * g.superseded),
      derived_from: unionedDerivedFrom,
      claim_key: primaryClaimKey,
      alt_claim_key: `current|${rawSubj}${keySuffix}`,
      entity_fallback: () => findCognitiveMatch(input.vaultRoot, input.owner, r => {
        const ck = r.claim_key;
        if (typeof ck !== "string" || ck === primaryClaimKey) return false;
        if (!ck.startsWith("current|") || !ck.endsWith(keySuffix)) return false;
        const subjPart = ck.slice("current|".length, ck.length - keySuffix.length);
        return namesResolveToSubj(subjPart) || namesResolveToSubj(r.subject_entity_id);
      }),
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
  // v2.22.1 (round-2 finding): the LLM pass only ever CREATES drafts
  // (proposed), it never updates existing records. Add its creations to
  // the rule-based created count instead of overwriting with records.length
  // (which folded rule-based in-place UPDATES in as if they were created).
  base.cognitive_records_created += proposed;
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
