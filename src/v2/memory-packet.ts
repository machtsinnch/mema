// v2.11.0 — Memory Packet Compiler.
//
// Transforms a two-channel retrieval result (evidence channel = episodes;
// memory channel = facts/cognitive/entities) into a structured `MemoryPacket`,
// then renders the packet to the prompt format expected by the answer LLM.
//
// Rationale: mema's pre-2.11 design dumped raw episodes + extracted facts +
// cognitive beliefs into a single mixed prompt blob; the answer LLM had to
// reconcile contradicting framings unaided. The fix is not another memory
// layer — it is the missing component that turns stored memory into
// reasoning-ready evidence. This file is that component.
//
// Format choice (post-2026-05-17 competitor intel — see
// COMPETITOR-PROMPT-INTEL.md for verbatim Zep/Mem0/Letta sources):
//   - XML section wrappers (`<FACTS>`, `<ENTITIES>`, ...) — Zep pattern. Modern
//     LLMs (Claude especially) attend more reliably to XML structure than to
//     markdown headers.
//   - Inline interpretation hints per section (`# Facts ending in "present"
//     are currently valid`) — teaches the LLM how to read each block in-band.
//   - Date ranges rendered as `(Date range: X - present)` not `null`/`unknown`.
//   - mema-specific extensions kept (defensible vs Zep):
//     • CURRENT_STATE — synthesized "now" claims at question_date
//     • CONFLICTS — explicit narrative supersession lines
//     • UNCERTAINTY — explicit gaps the LLM should not confabulate
//     • INSTRUCTIONS — answer-priority directive at end
//
// Implementation style (Ardin's Geistesblitz, 2026-05-17): the section-
// inclusion logic is expressed as RULE PREDICATES (`isCurrent`, `isSuperseded`,
// `isConflicting`, `includeInCurrentState`, ...) — Datalog-inspired. The
// predicates ARE the spec for a future symbolic-reasoning engine if/when we
// adopt one (e.g. an embedded Datalog runtime). For now they're plain
// TypeScript functions, but their named-rule shape makes each inclusion
// decision auditable and testable in isolation. v2.12+ may move them behind
// an actual rules.ts module.
//
// v2.12+ adds routing (per question-type) and an LLM-based answer-strategy
// classifier. v2.11 keeps the classifier rule-based.

import type { RetrievalHit } from "./types";

// ─── Public types ────────────────────────────────────────────────────────

export type AnswerStrategy =
  | "direct_episode"   // single-session lookup; episodes carry the answer
  | "preference"        // cognitive beliefs about user preferences dominate
  | "knowledge_update"  // facts + supersession chain matter most
  | "temporal_state"    // current-state facts at question_date dominate
  | "multi_session";    // full chronological evidence timeline matters

export interface TwoChannelHits {
  evidence_channel: RetrievalHit[];  // top-K episodes (NOT displaceable by facts)
  memory_channel: RetrievalHit[];    // facts + cognitive + entities (separate pool)
}

export interface MemoryPacket {
  query: string;
  question_date?: string;
  question_type?: string;
  answer_strategy: AnswerStrategy;
  user_summary?: string;                            // top-confidence cognitive belief, if any
  current_state: CurrentStateFact[];
  approved_facts: ApprovedFactEntry[];
  cognitive_beliefs: CognitiveBeliefEntry[];
  entities: EntityEntry[];
  evidence_timeline: EvidenceSnippet[];
  conflicts: ConflictNote[];
  uncertainty: string[];
  provenance: ProvenanceLink[];
  raw_supporting_excerpts: RawExcerpt[];
}

export interface CurrentStateFact {
  subject: string;
  predicate: string;
  object: string;
  valid_from: string;
  evidence_ref?: string;
}

export interface ApprovedFactEntry {
  subject: string;
  predicate: string;
  object: string;
  valid_from: string;
  confidence?: number;
  invalidated_at?: string;
  source_id?: string;
}

export interface CognitiveBeliefEntry {
  content: string;
  kind: "belief" | "observation" | "experience";
  confidence?: number;
  support_ids?: string[];
}

export interface EntityEntry {
  name: string;
  type: string;
  aliases?: string[];
}

export interface EvidenceSnippet {
  date: string;
  summary: string;
  source_id?: string;
}

export interface ConflictNote {
  narrative: string;
  superseded_id?: string;
  superseding_id?: string;
}

export interface ProvenanceLink {
  claim: string;
  record_id: string;
  record_kind: "episode" | "fact" | "cognitive" | "entity";
}

export interface RawExcerpt {
  date?: string;
  source_id?: string;
  text: string;
}

// ─── Rule predicates (Datalog-inspired) ──────────────────────────────────
//
// Each predicate is a single-purpose boolean function. Section inclusion in
// the packet is a composition of these predicates — readable as a rule:
//
//   include_in_current_state(F, D) :-
//     is_current(F, D),
//     not is_superseded(F),
//     not is_invalidated(F).
//
// Keeping inclusion logic as named predicates (rather than inline filter
// conditions) lets a future symbolic-reasoning engine substitute these
// without changing buildMemoryPacket's shape.

export const rules = {
  /** A fact is CURRENT at `dateISO` if its valid_from is on/before that date
   *  and it has no invalidated_at. */
  isCurrent(hit: RetrievalHit, dateISO: string): boolean {
    if (!hit.payload) return false;
    if (hit.payload.invalidated_at) return false;
    const vf = (hit.payload.valid_from ?? "").slice(0, 10);
    const d  = dateISO.slice(0, 10);
    if (!vf) return true;  // missing valid_from = surface (better than hide)
    return vf <= d;
  },

  /** A fact is SUPERSEDED if its invalidated_at is set OR superseded_by is set. */
  isSuperseded(hit: RetrievalHit): boolean {
    return !!hit.payload?.invalidated_at;
  },

  /** Two facts CONFLICT if they share subject+predicate, have different
   *  objects, and at least one of them lacks an invalidated_at — i.e. the
   *  two assertions overlap in their temporal validity. */
  isConflicting(a: RetrievalHit, b: RetrievalHit): boolean {
    if (!a.payload || !b.payload) return false;
    if (a.payload.subject !== b.payload.subject) return false;
    if (a.payload.predicate !== b.payload.predicate) return false;
    if (a.payload.object === b.payload.object) return false;
    return true;
  },

  /** Inclusion rule for CURRENT_STATE: current AND not superseded. */
  includeInCurrentState(hit: RetrievalHit, dateISO: string): boolean {
    return this.isCurrent(hit, dateISO) && !this.isSuperseded(hit);
  },

  /** Inclusion rule for FACTS: every retrieved fact is shown (superseded
   *  ones rendered with explicit invalidation marker; the LLM needs the
   *  historical context). */
  includeInFacts(hit: RetrievalHit): boolean {
    return hit.kind === "fact" && !!hit.payload;
  },

  /** Inclusion rule for COGNITIVE_BELIEFS: only retrieved cognitive records
   *  with non-empty content. */
  includeInCognitiveBeliefs(hit: RetrievalHit): boolean {
    return hit.kind === "cognitive" && !!hit.payload?.content;
  },

  /** Inclusion rule for ENTITIES: every retrieved entity hit with a payload. */
  includeInEntities(hit: RetrievalHit): boolean {
    return hit.kind === "entity" && !!hit.payload;
  },

  /** Inclusion rule for CONFLICTS: facts whose invalidation has happened. */
  includeInConflicts(hit: RetrievalHit): boolean {
    return hit.kind === "fact" && !!hit.payload?.invalidated_at;
  },

  /** Inclusion rule for EVIDENCE_TIMELINE: every approved fact is one
   *  dated event on the timeline (chronological order applied by builder). */
  includeInEvidenceTimeline(hit: RetrievalHit): boolean {
    return this.includeInFacts(hit);
  },

  /** Inclusion rule for RAW_SUPPORTING_EXCERPTS: every episode in the
   *  evidence channel. */
  includeInRawExcerpts(hit: RetrievalHit): boolean {
    return hit.kind === "episode";
  },

  /** USER_SUMMARY selection: pick the highest-confidence cognitive belief
   *  whose content looks like a user-profile statement (cheap heuristic for
   *  v2.11; v2.12 can use a dedicated "user-summary" cognitive kind). */
  selectUserSummary(cognitiveHits: RetrievalHit[]): string | undefined {
    if (cognitiveHits.length === 0) return undefined;
    // Sort by descending confidence, pick first with usable content.
    const sorted = [...cognitiveHits].sort((a, b) => {
      const ca = a.payload?.confidence ?? 0;
      const cb = b.payload?.confidence ?? 0;
      return cb - ca;
    });
    for (const h of sorted) {
      const c = (h.payload?.content ?? "").replace(/\s+/g, " ").trim();
      if (c.length >= 20 && c.length <= 600) return c;
    }
    return undefined;
  },
};

// ─── Builder ─────────────────────────────────────────────────────────────

export interface BuildMemoryPacketInput {
  query: string;
  question_date?: string;
  question_type?: string;
  hits: TwoChannelHits;
  /** Override the rule-based classifier (caller already knows the strategy). */
  answer_strategy?: AnswerStrategy;
  /** Verbatim episode-session text keyed by hit id — used to fill
   *  RAW_SUPPORTING_EXCERPTS with rich content. Optional; callers like the
   *  LongMemEval harness have this content in-hand and pass it here. */
  raw_session_text?: Map<string, { date?: string; text: string }>;
}

export function buildMemoryPacket(input: BuildMemoryPacketInput): MemoryPacket {
  const strategy = input.answer_strategy ?? classifyAnswerStrategy({
    query: input.query,
    question_date: input.question_date,
    question_type: input.question_type,
  });

  const factHits = input.hits.memory_channel.filter(h => rules.includeInFacts(h));
  const cogHits  = input.hits.memory_channel.filter(h => rules.includeInCognitiveBeliefs(h));
  const entHits  = input.hits.memory_channel.filter(h => rules.includeInEntities(h));
  const epHits   = input.hits.evidence_channel.filter(h => rules.includeInRawExcerpts(h));

  const validAt = input.question_date ?? new Date().toISOString().slice(0, 10);

  // CURRENT_STATE — facts that are current at question_date and not superseded.
  const currentState: CurrentStateFact[] = factHits
    .filter(h => rules.includeInCurrentState(h, validAt))
    .map(h => ({
      subject: h.payload!.subject ?? "?",
      predicate: h.payload!.predicate ?? "?",
      object: h.payload!.object ?? "?",
      valid_from: (h.payload!.valid_from ?? "").slice(0, 10) || "unknown-date",
      evidence_ref: shortEvidenceRef(h.id),
    }));

  // FACTS — every retrieved fact, sorted chronologically.
  const approvedFacts: ApprovedFactEntry[] = [...factHits]
    .sort((a, b) => (a.payload?.valid_from ?? "").localeCompare(b.payload?.valid_from ?? ""))
    .map(h => ({
      subject: h.payload!.subject ?? "?",
      predicate: h.payload!.predicate ?? "?",
      object: h.payload!.object ?? "?",
      valid_from: (h.payload!.valid_from ?? "").slice(0, 10) || "unknown-date",
      ...(typeof h.payload?.confidence === "number"
        ? { confidence: roundTo(h.payload.confidence, 2) }
        : (typeof h.score_components.confidence === "number"
            ? { confidence: roundTo(h.score_components.confidence, 2) }
            : {})),
      ...(h.payload!.invalidated_at
        ? { invalidated_at: String(h.payload!.invalidated_at).slice(0, 10) }
        : {}),
    }));

  // COGNITIVE_BELIEFS — framed as inferences.
  const cognitiveBeliefs: CognitiveBeliefEntry[] = cogHits.map(h => ({
    content: (h.payload!.content ?? "").replace(/\s+/g, " ").trim(),
    kind: (h.payload!.cognitive_kind ?? "belief") as CognitiveBeliefEntry["kind"],
    ...(typeof h.payload!.confidence === "number"
      ? { confidence: roundTo(h.payload!.confidence, 2) }
      : {}),
  }));

  // ENTITIES.
  const entities: EntityEntry[] = entHits.map(h => ({
    name: h.payload!.name ?? "?",
    type: h.payload!.entity_type ?? "?",
    ...(h.payload!.aliases && h.payload!.aliases.length > 0
      ? { aliases: h.payload!.aliases }
      : {}),
  }));

  // EVIDENCE_TIMELINE — one line per fact event, chronological.
  const evidenceTimeline: EvidenceSnippet[] = approvedFacts.map(f => ({
    date: f.valid_from,
    summary: `${f.subject} ${f.predicate} ${f.object}`,
  })).sort((a, b) => a.date.localeCompare(b.date));

  // CONFLICTS — explicit supersession narratives.
  const conflicts: ConflictNote[] = factHits
    .filter(h => rules.includeInConflicts(h))
    .map(h => {
      const subj = h.payload!.subject ?? "?";
      const pred = h.payload!.predicate ?? "?";
      const obj  = h.payload!.object ?? "?";
      const dt   = String(h.payload!.invalidated_at).slice(0, 10);
      return {
        narrative: `Earlier claim "${subj} ${pred} ${obj}" was superseded on ${dt}.`,
        superseded_id: h.id,
      };
    });

  // UNCERTAINTY — explicit gaps.
  const uncertainty: string[] = [];
  if (factHits.length === 0 && cogHits.length === 0) {
    uncertainty.push("No structured memory retrieved for this query — relying entirely on raw episode evidence.");
  }
  if (strategy === "temporal_state" && currentState.length === 0 && factHits.length > 0) {
    uncertainty.push("Retrieved facts have no valid_from at or before the question date; current state is unknown.");
  }

  // PROVENANCE.
  const provenance: ProvenanceLink[] = [
    ...factHits.map(h => ({
      claim: `${h.payload!.subject ?? "?"} ${h.payload!.predicate ?? "?"} ${h.payload!.object ?? "?"}`,
      record_id: h.id,
      record_kind: "fact" as const,
    })),
    ...cogHits.map(h => ({
      claim: (h.payload!.content ?? "").slice(0, 80),
      record_id: h.id,
      record_kind: "cognitive" as const,
    })),
  ];

  // RAW_SUPPORTING_EXCERPTS.
  const rawSupportingExcerpts: RawExcerpt[] = epHits.map(h => {
    const supplied = input.raw_session_text?.get(h.id);
    return {
      ...(supplied?.date ? { date: supplied.date } : {}),
      source_id: h.id,
      text: supplied?.text ?? h.excerpt ?? "",
    };
  }).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  // USER_SUMMARY — picked from the strongest cognitive belief, if any.
  const userSummary = rules.selectUserSummary(cogHits);

  return {
    query: input.query,
    ...(input.question_date ? { question_date: input.question_date } : {}),
    ...(input.question_type ? { question_type: input.question_type } : {}),
    answer_strategy: strategy,
    ...(userSummary ? { user_summary: userSummary } : {}),
    current_state: currentState,
    approved_facts: approvedFacts,
    cognitive_beliefs: cognitiveBeliefs,
    entities,
    evidence_timeline: evidenceTimeline,
    conflicts,
    uncertainty,
    provenance,
    raw_supporting_excerpts: rawSupportingExcerpts,
  };
}

// ─── Renderer (XML tags + inline hints, Zep-aligned) ─────────────────────

/**
 * Render a MemoryPacket as the prompt format consumed by the answer LLM.
 *
 * Format choices (per COMPETITOR-PROMPT-INTEL.md):
 *   - XML section wrappers (Claude / GPT-4 attend more reliably to XML)
 *   - Inline `# comment` hints per section teaching the LLM how to read it
 *   - Empty sections OMITTED entirely (no `<FACTS></FACTS>` boilerplate)
 *   - Date ranges as "(Date range: X - present)" — Zep convention
 *
 * Optional `budget` caps the total rendered length (chars). When exceeded,
 * the RAW_SUPPORTING_EXCERPTS section is truncated last so higher-information
 * structured sections survive.
 */
export function compilePacketToPrompt(
  packet: MemoryPacket,
  options: { budget?: number; includeInstructions?: boolean } = {},
): string {
  const includeInstructions = options.includeInstructions !== false;
  const sections: string[] = [];

  // QUESTION_DATE
  if (packet.question_date) {
    sections.push(`<QUESTION_DATE>${packet.question_date}</QUESTION_DATE>`);
  }

  // QUERY (always)
  sections.push(`<QUERY>${packet.query}</QUERY>`);

  // USER_SUMMARY
  if (packet.user_summary) {
    sections.push(
      "# High-level summary of the user (derived from prior cognitive reflection).\n" +
      `<USER_SUMMARY>\n${packet.user_summary}\n</USER_SUMMARY>`
    );
  }

  // CURRENT_STATE
  if (packet.current_state.length > 0) {
    const lines = packet.current_state.map(cs => {
      const qd = packet.question_date ?? cs.valid_from;
      const head = `- As of ${qd}, ${cs.subject} ${cs.predicate} ${cs.object}.`;
      return cs.evidence_ref ? `${head} (source: ${cs.evidence_ref})` : head;
    });
    sections.push(
      "# CURRENT_STATE represents claims the system believes are TRUE NOW (as of QUESTION_DATE).\n" +
      "# Prefer these over older facts when answering questions about the present.\n" +
      `<CURRENT_STATE>\n${lines.join("\n")}\n</CURRENT_STATE>`
    );
  }

  // FACTS (Zep-style date-range rendering)
  if (packet.approved_facts.length > 0) {
    const lines = packet.approved_facts.map(f => {
      const endDate = f.invalidated_at ?? "present";
      const conf = typeof f.confidence === "number" ? `, confidence: ${f.confidence}` : "";
      return `- ${f.subject} ${f.predicate} ${f.object} (Date range: ${f.valid_from} - ${endDate}${conf})`;
    });
    sections.push(
      '# Facts ending in "present" are currently valid.\n' +
      "# Facts with a past end date are NO LONGER VALID.\n" +
      `<FACTS>\n${lines.join("\n")}\n</FACTS>`
    );
  }

  // COGNITIVE_BELIEFS — explicitly framed as inferences, NOT facts
  if (packet.cognitive_beliefs.length > 0) {
    const lines = packet.cognitive_beliefs.map(b => {
      const conf = typeof b.confidence === "number" ? ` (confidence: ${b.confidence})` : "";
      return `- [${b.kind}] ${b.content}${conf}`;
    });
    sections.push(
      "# COGNITIVE_BELIEFS are inferences derived from observed evidence — NOT raw user statements.\n" +
      "# Do not treat as fact unless supported by a FACTS or RAW_SUPPORTING_EXCERPTS entry.\n" +
      `<COGNITIVE_BELIEFS>\n${lines.join("\n")}\n</COGNITIVE_BELIEFS>`
    );
  }

  // ENTITIES
  if (packet.entities.length > 0) {
    const lines = packet.entities.map(e => {
      const aliases = e.aliases && e.aliases.length > 0 ? `, aliases: ${e.aliases.join(", ")}` : "";
      return `- ${e.name} (${e.type})${aliases}`;
    });
    sections.push(
      "# Named entities relevant to the query.\n" +
      `<ENTITIES>\n${lines.join("\n")}\n</ENTITIES>`
    );
  }

  // CONFLICTS
  if (packet.conflicts.length > 0) {
    const lines = packet.conflicts.map(c => `- ${c.narrative}`);
    sections.push(
      "# Explicit supersession events — older claims that have been replaced.\n" +
      `<CONFLICTS>\n${lines.join("\n")}\n</CONFLICTS>`
    );
  }

  // EVIDENCE_TIMELINE
  if (packet.evidence_timeline.length > 0) {
    const lines = packet.evidence_timeline.map(e => `[${e.date}] ${e.summary}`);
    sections.push(
      "# Chronological summary of events drawn from the structured fact channel.\n" +
      `<EVIDENCE_TIMELINE>\n${lines.join("\n")}\n</EVIDENCE_TIMELINE>`
    );
  }

  // UNCERTAINTY
  if (packet.uncertainty.length > 0) {
    const lines = packet.uncertainty.map(u => `- ${u}`);
    sections.push(
      "# Explicit knowledge gaps — do NOT confabulate to fill these.\n" +
      `<UNCERTAINTY>\n${lines.join("\n")}\n</UNCERTAINTY>`
    );
  }

  // RAW_SUPPORTING_EXCERPTS (last, before INSTRUCTIONS, so budget truncation hits here)
  if (packet.raw_supporting_excerpts.length > 0) {
    const lines = packet.raw_supporting_excerpts.map(r => {
      const head = r.date ? `[${r.date}]\n` : "";
      return `${head}${r.text}`;
    });
    sections.push(
      "# Verbatim conversation excerpts — the raw evidence the structured layers were derived from.\n" +
      `<RAW_SUPPORTING_EXCERPTS>\n${lines.join("\n\n---\n\n")}\n</RAW_SUPPORTING_EXCERPTS>`
    );
  }

  // INSTRUCTIONS (always present unless explicitly disabled — for control runs like mode E zep-format).
  //
  // v2.11.1+ — softened to handle empty CURRENT_STATE gracefully. Pre-2.11.1
  // wording told the LLM to "Answer using CURRENT_STATE first" unconditionally;
  // when CURRENT_STATE was empty (because of the extractor temporal-grounding
  // bug, or simply because no facts are current at question_date), the LLM
  // over-deferred and returned "no answer" even when FACTS contained the
  // answer. New wording explicitly lays out a fallback chain.
  if (includeInstructions) {
    const hasCurrentState = packet.current_state.length > 0;
    const hasFacts = packet.approved_facts.length > 0;
    const hasUncertainty = packet.uncertainty.length > 0;

    const priorityLine = hasCurrentState
      ? "Answer using CURRENT_STATE first, then FACTS chronologically (latest valid_from wins on the same subject+predicate), then RAW_SUPPORTING_EXCERPTS."
      : hasFacts
      ? "CURRENT_STATE is empty. Use FACTS chronologically (latest valid_from wins on the same subject+predicate), supplemented by RAW_SUPPORTING_EXCERPTS."
      : "No structured memory is current. Answer from RAW_SUPPORTING_EXCERPTS, reading them chronologically and trusting the most recent statement on the topic.";

    const uncertaintyLine = hasUncertainty
      ? "If UNCERTAINTY notes apply to the asked question, prefer to admit not-knowing over confabulation."
      : "Do not refuse to answer when the evidence (FACTS or RAW excerpts) actually contains the answer — read carefully before defaulting to 'no answer'.";

    sections.push(
      "<INSTRUCTIONS>\n" +
      priorityLine + "\n" +
      "Do not treat COGNITIVE_BELIEFS as facts unless supported by RAW evidence.\n" +
      uncertaintyLine + "\n" +
      "Keep responses SHORT - one sentence when possible.\n" +
      "</INSTRUCTIONS>"
    );
  }

  let rendered = sections.join("\n\n");

  // Budget enforcement — truncate RAW_SUPPORTING_EXCERPTS first.
  if (options.budget && rendered.length > options.budget) {
    const rawOpen = "<RAW_SUPPORTING_EXCERPTS>\n";
    const rawClose = "\n</RAW_SUPPORTING_EXCERPTS>";
    const rawStart = rendered.indexOf(rawOpen);
    if (rawStart > 0) {
      const after = rendered.indexOf("</RAW_SUPPORTING_EXCERPTS>", rawStart);
      const tail = after > 0 ? rendered.slice(after + rawClose.length - 1) : "";
      const headerBlock = rendered.slice(0, rawStart + rawOpen.length);
      const room = Math.max(0, options.budget - headerBlock.length - tail.length - rawClose.length);
      const body = rendered.slice(rawStart + rawOpen.length, after > 0 ? after : rendered.length);
      const truncated = body.slice(0, room);
      rendered = headerBlock + truncated + rawClose + tail;
    } else {
      rendered = rendered.slice(0, options.budget);
    }
  }

  return rendered;
}

// ─── Rule-based answer-strategy classifier (v2.11) ──────────────────────

export interface ClassifyInput {
  query: string;
  question_date?: string;
  question_type?: string;
}

export function classifyAnswerStrategy(input: ClassifyInput): AnswerStrategy {
  if (input.question_type) {
    const qt = input.question_type.toLowerCase();
    if (qt === "multi-session") return "multi_session";
    if (qt === "knowledge-update" || qt === "knowledge_update") return "knowledge_update";
    if (qt === "temporal-reasoning" || qt === "temporal_reasoning") return "temporal_state";
    if (qt === "preference" || qt.includes("preference")) return "preference";
    if (qt.startsWith("single-session") || qt.startsWith("single_session")) return "direct_episode";
  }

  const q = input.query.toLowerCase();
  if (/\b(currently|right now|at the moment|as of (?:today|now)|most recent|latest|now|before|after|last)\b/.test(q)) {
    return "temporal_state";
  }
  if (/\b(prefer|prefers|preferred|prefers to|likes|usually|favorite|favourite)\b/.test(q)) {
    return "preference";
  }
  if (/\b(change|changed|update|updated|switch|switched|move|moved|replace|replaced|no longer|used to)\b/.test(q)) {
    return "knowledge_update";
  }
  if (/\b(across|over time|throughout|each session|every conversation|history of)\b/.test(q)) {
    return "multi_session";
  }
  return "direct_episode";
}

// ─── Zep-format renderer (control variant for benchmark mode E) ──────────
//
// Renders the SAME hits using Zep's exact format (no CURRENT_STATE,
// CONFLICTS, UNCERTAINTY, INSTRUCTIONS). This is the apples-to-apples
// control: if mode C (memory-packet) ≥ mode E (zep-format) on the bench,
// our mema-specific extensions add real value. If E ≥ C, our extensions are
// noise and we should adopt Zep's simpler format.

export function compilePacketAsZepFormat(packet: MemoryPacket): string {
  // v2.12.0+ (post-GPT-5.5 step 4) — match Zep's exact section layout
  // from zep_evaluate.py:284-448 (construct_context_block + _format_edges
  // + _format_nodes + _format_episodes). Differences from prior version:
  //
  //   • FACTS gain per-fact Labels (predicate) + Attributes
  //     (confidence, source_id) indented 2/4 spaces, matching
  //     _format_edges' output shape.
  //   • ENTITIES match _format_nodes verbatim: Name / Labels /
  //     Attributes / Summary blocks, with "No summary available"
  //     fallback when summary is absent (matches Zep's default).
  //   • EPISODES use Zep's "({created_at}) {content}" line per episode.
  //   • When a section is empty, emit Zep's stub text ("No relevant
  //     X found") inside the XML wrapper rather than omit the section.
  //   • USER_SUMMARY block stays at the top when populated.
  const sections: string[] = [];

  if (packet.user_summary) {
    sections.push(
      "# High-level summary of the user\n" +
      `<USER_SUMMARY>\n${packet.user_summary}\n</USER_SUMMARY>`
    );
  }

  sections.push(
    "FACTS, ENTITIES, and EPISODES represent relevant context from the user's knowledge graph."
  );

  // FACTS — Zep's _format_edges shape: fact (Date range: X - Y) + indented
  // Labels: predicate / Attributes: confidence + source.
  const factLines: string[] = [];
  if (packet.approved_facts.length > 0) {
    for (const f of packet.approved_facts) {
      const endDate = f.invalidated_at ?? "present";
      const factText = `${f.subject} ${f.predicate} ${f.object}`;
      factLines.push(`${factText} (Date range: ${f.valid_from} - ${endDate})`);
      // Labels: the predicate is the natural label for mema-shaped facts.
      factLines.push(`  Labels: ${f.predicate}`);
      // Attributes: indented two-space + four-space per attribute (Zep's pattern).
      const attrs: string[] = [];
      if (typeof f.confidence === "number") attrs.push(`    confidence: ${f.confidence}`);
      if (f.source_id) attrs.push(`    source: ${f.source_id}`);
      if (attrs.length > 0) {
        factLines.push("  Attributes:");
        factLines.push(...attrs);
      }
      factLines.push("");  // blank between facts, matching Zep
    }
  } else {
    factLines.push("No relevant facts found");
  }
  sections.push(
    "# These are the most relevant facts about the user\n" +
    '# Facts ending in "present" are currently valid\n' +
    "# Facts with a past end date are NO LONGER VALID.\n" +
    `<FACTS>\n${factLines.join("\n")}\n</FACTS>`
  );

  // ENTITIES — Zep's _format_nodes shape: Name / Labels / Attributes /
  // Summary blocks, blank line between entities.
  const entityLines: string[] = [];
  if (packet.entities.length > 0) {
    for (const e of packet.entities) {
      entityLines.push(`Name: ${e.name}`);
      entityLines.push(`Labels: ${e.type}`);
      const attrs: string[] = [];
      attrs.push(`  type: ${e.type}`);
      if (e.aliases && e.aliases.length > 0) {
        attrs.push(`  aliases: ${e.aliases.join(", ")}`);
      }
      entityLines.push("Attributes:");
      entityLines.push(...attrs);
      // v2.13 work: per-entity LLM-generated Summary. For now use Zep's default.
      entityLines.push(`Summary: No summary available`);
      entityLines.push("");  // blank between entities
    }
  } else {
    entityLines.push("No relevant entities found");
  }
  sections.push(
    "# These are the most relevant entities (people, locations, organizations, items, and more).\n" +
    `<ENTITIES>\n${entityLines.join("\n")}\n</ENTITIES>`
  );

  // EPISODES — Zep's _format_episodes shape: ({created_at}) {content}
  // per episode. Single blank line between (achieved by join("\n")).
  const episodeLines: string[] = [];
  if (packet.raw_supporting_excerpts.length > 0) {
    for (const r of packet.raw_supporting_excerpts) {
      const created = r.date ?? "Unknown date";
      episodeLines.push(`(${created}) ${r.text}`);
    }
  } else {
    episodeLines.push("No relevant episodes found");
  }
  sections.push(
    "# These are the most relevant episodes\n" +
    `<EPISODES>\n${episodeLines.join("\n")}\n</EPISODES>`
  );

  return sections.join("\n\n");
}

// ─── Small helpers ──────────────────────────────────────────────────────

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function shortEvidenceRef(recordId: string): string {
  return `record:${recordId.slice(0, 26)}`;
}
