// LLM-augmented fact + entity extraction. Pluggable across providers:
//
//   OllamaExtractor   — local, default. No data leaves the machine. Free.
//                       Models: llama3.1:8b, qwen2.5:7b, mistral-nemo, etc.
//                       Speaks the Ollama HTTP API at localhost:11434.
//
//   AnthropicExtractor — fallback when ANTHROPIC_API_KEY is set. Claude
//                       3.5 Haiku for cost; Sonnet for quality.
//
//   OpenAIExtractor   — fallback when OPENAI_API_KEY is set. gpt-4o-mini.
//
// v2.16.1: consensus vote keys use canonicalPredicate (see predicates.ts).

import { canonicalPredicate } from "./predicates";
//
// All three return the SAME JSON shape:
//   { facts: [{subject, predicate, object, confidence}],
//     entities: [{name, type}] }
//
// Used by scripts/extract-facts-llm.ts to replace the heuristic v2.5
// extractor. The heuristic produced ~30% noise; LLM extraction with a
// conservative prompt should be ≤5%.

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  // v2.15.0 — the date the fact became true IN THE WORLD, extracted from the
  // text itself (Bug B fix). YYYY, YYYY-MM, or YYYY-MM-DD; null when the text
  // does not state or clearly imply one. Callers pass this as valid_from so
  // bi-temporal ordering follows world time, not ingestion time.
  event_date?: string | null;
  // v2.16.0 — consensus metadata: how many of the successful extraction
  // passes emitted this triple, out of how many. Written into the fact's
  // proposed_by provenance by /v2/observe.
  votes?: number;
  passes?: number;
  // v2.20.0 — the ONE verbatim sentence from the source that states this
  // fact. Used by the evidence-rescue gate: a below-majority fact survives
  // only if this quote appears character-for-character in the source text.
  evidence?: string | null;
  // Set by consensusMerge when a below-majority fact passed the verbatim-
  // evidence gate. /v2/observe marks provenance "+evidence" and lowers
  // confidence accordingly.
  evidence_verified?: boolean;
}
export interface ExtractedEntity {
  name: string;
  type: string;     // person | organization | concept | place | system
}
export interface ExtractionResult {
  facts: ExtractedFact[];
  entities: ExtractedEntity[];
  // v2.15.0 — populated by chunked extraction so /v2/observe can report
  // "partial" instead of pretending a run with dead chunks was "complete".
  // v2.21.0 — truncated: input exceeded MAX_CHARS and the tail was never
  // extracted; /v2/observe must report partial, not complete.
  chunk_stats?: { total: number; failed: number; truncated?: boolean };
}

// v2.15.0 — validate a model-supplied event_date at the boundary. Accepts
// YYYY, YYYY-MM, or YYYY-MM-DD with a sane year; anything else (prose,
// ISO timestamps with invented precision, years like 0001 or 9999) → null,
// which callers treat as "no world date known" and fall back to now().
// v2.19.3 — self-referential triple guard (Arachne replay finding: the
// extractor emitted "Arachne supersedes Arachne runtime" — subject and
// object are the same thing under two names). A fact whose subject's
// words are a subset of its object's words (or vice versa) says nothing
// about the world beyond naming; better to lose a marginal tautology
// ("Arachne includes Arachne runtime") than keep garbage.
export function isSelfReferentialTriple(subject: string, object: string): boolean {
  const tokens = (s: string): Set<string> => new Set(
    s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0),
  );
  const a = tokens(subject);
  const b = tokens(object);
  if (a.size === 0 || b.size === 0) return false;
  const subset = (x: Set<string>, y: Set<string>): boolean =>
    [...x].every(t => y.has(t));
  return subset(a, b) || subset(b, a);
}

export function sanitizeEventDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return null;
  const year = Number(v.slice(0, 4));
  if (year < 1000 || year > 2100) return null;
  if (Number.isNaN(Date.parse(v))) return null;  // rejects 2026-13, 2026-02-31
  return v;
}

export interface LLMExtractor {
  name: string;
  extract(text: string): Promise<ExtractionResult>;
}

// Strict prompt with explicit anti-noise rules + few-shot examples.
const SYSTEM_PROMPT = `You are a strict structured-fact extractor. You read a markdown document and extract:

1. FACTS — explicit subject-predicate-object claims that the text directly states.
2. ENTITIES — named referents (people, organizations, products, technical systems, places, important concepts).

Rules:
- Only extract claims that are explicit and verifiable from the text. Reject:
  · vague or hypothetical statements ("if we did X", "could be Y")
  · metaphors and rhetorical flourishes
  · author opinions presented as facts
  · sentence fragments
- Predicates must be specific verbs/relations: "founded", "owns", "uses", "rejected", "supersedes", "deploys_to", "depends_on", "is_a", "located_in", "reports_to", "manages", "supports", "integrates_with", "built_on". NEVER use "is", "has", "at" — too generic.
- Subjects and objects must be ENTITIES (proper nouns, products, organizations), not pronouns, articles, or generic words.
- Reject facts where subject or object is a currency amount ("CHF 22"), a number alone, a date alone, or a fragment ("Co-Marketing").
- For entities, type must be one of: person | organization | product | system | place | concept | event.
- Confidence: 0.95 for explicitly stated, 0.85 for clearly implied, ≤0.75 means don't emit.
- event_date: the date the fact became true IN THE WORLD, as "YYYY", "YYYY-MM", or "YYYY-MM-DD" — ONLY when the text states or clearly implies it (a stated year, a dated announcement, "since 2019"). If the text gives no date for the fact, use null. NEVER invent a date, NEVER use today's date, NEVER use the document's date unless the fact is about the document itself.
- evidence: the ONE sentence from the text that states this fact, copied EXACTLY, character for character. Never paraphrase, never shorten, never merge two sentences. If no single sentence states it, the claim is not explicit enough — do not emit the fact.

Output ONLY valid JSON. No prose, no markdown fences. Schema:
{
  "facts": [
    {"subject": "...", "predicate": "...", "object": "...", "confidence": 0.95, "event_date": "YYYY-MM-DD or null", "evidence": "exact sentence from the text"}
  ],
  "entities": [
    {"name": "...", "type": "..."}
  ]
}

If the document contains zero extractable facts, return {"facts": [], "entities": []}.`;

// Few-shot demo content. Chosen to be in a domain (open-source tech history)
// that is extremely unlikely to appear verbatim in user content. Weaker
// open-weight models (llama3.1:8b, qwen2.5:7b) sometimes regurgitate this
// demo when they can't extract anything substantive from the real input —
// the defense below catches that.
const FEW_SHOT_USER = `Text:
PostgreSQL supports JSONB indexing. The Apache Software Foundation manages the Kafka project. Linus Torvalds founded the Linux kernel project in 1991.`;

const FEW_SHOT_ASSISTANT = `{
  "facts": [
    {"subject": "PostgreSQL", "predicate": "supports", "object": "JSONB indexing", "confidence": 0.95, "event_date": null, "evidence": "PostgreSQL supports JSONB indexing."},
    {"subject": "Apache Software Foundation", "predicate": "manages", "object": "Kafka project", "confidence": 0.95, "event_date": null, "evidence": "The Apache Software Foundation manages the Kafka project."},
    {"subject": "Linus Torvalds", "predicate": "founded", "object": "Linux kernel project", "confidence": 0.95, "event_date": "1991", "evidence": "Linus Torvalds founded the Linux kernel project in 1991."}
  ],
  "entities": [
    {"name": "PostgreSQL", "type": "system"},
    {"name": "JSONB indexing", "type": "concept"},
    {"name": "Apache Software Foundation", "type": "organization"},
    {"name": "Kafka project", "type": "product"},
    {"name": "Linus Torvalds", "type": "person"},
    {"name": "Linux kernel project", "type": "product"}
  ]
}`;

// Defense-in-depth: if a weak model echoes the few-shot demo verbatim,
// drop those exact triples and entities post-hoc. Real user content with
// these exact triples is extremely unlikely; if it happens, update the
// demo (it's cheap).
const FEW_SHOT_TRIPLES = new Set([
  "postgresql|supports|jsonb indexing",
  "apache software foundation|manages|kafka project",
  "linus torvalds|founded|linux kernel project",
]);
// Partial-regurgitation defense: weaker models sometimes keep the few-shot's
// (predicate, object) pair but swap in a subject from the real input
// (e.g. "PAI supports JSONB indexing" — JSONB was nowhere in the source).
// Drop any fact where (predicate, object) matches the demo regardless of
// subject. Loses recall on the unlikely case that real user content
// genuinely contains those exact (predicate, object) pairs; acceptable
// because the few-shot uses tech-history examples that are easy to swap
// if collision occurs.
const FEW_SHOT_PRED_OBJ = new Set([
  "supports|jsonb indexing",
  "manages|kafka project",
  "founded|linux kernel project",
]);
const FEW_SHOT_ENTITY_NAMES = new Set([
  "postgresql", "jsonb indexing", "apache software foundation",
  "kafka project", "linus torvalds", "linux kernel project",
]);

// Distinctive multi-word demo phrases used for substring matching against
// scrambled regurgitations. "postgresql" alone is too short to substring-
// match safely, so we keep the high-signal multi-word phrases here.
const FEW_SHOT_PHRASES = [
  "jsonb indexing", "apache software foundation", "kafka project",
  "linus torvalds", "linux kernel project",
];

function containsFewShotEntity(slot: string): boolean {
  const v = slot.trim().toLowerCase();
  if (FEW_SHOT_ENTITY_NAMES.has(v)) return true;
  // Strip leading articles before exact-set check.
  const stripped = v.replace(/^(the|a|an)\s+/, "");
  if (FEW_SHOT_ENTITY_NAMES.has(stripped)) return true;
  // Substring check for the high-signal multi-word phrases.
  return FEW_SHOT_PHRASES.some(phrase => v.includes(phrase));
}

// v2.14.3+ entity-type whitelist (codex review). The extractor prompt says
// types must be one of seven, but qwen2.5:7b regularly returns invented
// types like "command", "path", "issue", "fix", "stock", "index", "pattern",
// "platform", "feature", "document", "runtime". Drop those at the boundary
// so downstream (createEntity, retrieval scoring, graph view) never sees
// invalid types. Common mistypes can be remapped to the right canonical
// type if obvious; everything else is dropped.
const ALLOWED_ENTITY_TYPES = new Set([
  "person", "organization", "product", "system", "place", "concept", "event",
]);
const TYPE_REMAP: Record<string, string> = {
  // OS/platform names — qwen2.5:7b labels these as "place" too. Anything
  // that's clearly a software runtime/OS becomes "system".
  command: "concept",
  path: "concept",
  pattern: "concept",
  runtime: "system",
  platform: "system",
  feature: "concept",
  document: "concept",
  stock: "product",
  index: "product",
  fund: "product",
  // bug-tracker artifacts the model invented from PLATFORM/SECURITY docs
  issue: "concept",
  fix: "concept",
  bug: "concept",
};

function filterFewShotLeak(r: ExtractionResult): ExtractionResult {
  return {
    facts: r.facts.filter(f => {
      const s = (f.subject ?? "").toLowerCase();
      const p = (f.predicate ?? "").toLowerCase();
      const o = (f.object ?? "").toLowerCase();
      if (FEW_SHOT_TRIPLES.has(`${s}|${p}|${o}`)) return false;
      if (FEW_SHOT_PRED_OBJ.has(`${p}|${o}`)) return false;
      // v2.14.3+: drop any fact whose subject OR object CONTAINS a few-shot
      // entity name. Weak models scramble the demo — "ASML founded Linus
      // Torvalds" reuses a demo subject as an object; "ardin founded the
      // linux kernel project" wraps it in an article. Substring match (not
      // exact) defeats both the article-prefix ("the linux kernel project")
      // and partial-phrase variants. These tech-history terms never appear
      // in the user's finance/business content except as regurgitation, so
      // substring matching is safe here.
      if (containsFewShotEntity(s) || containsFewShotEntity(o)) return false;
      // v2.14.3+: drop role-inverted facts — "Linux fully_supported by PAI"
      // patterns are nearly always model errors (real meaning: PAI supports
      // Linux, with the subject and object swapped). The retrieval scorer
      // can't surface these usefully and they pollute the graph.
      if (o.startsWith("by ")) return false;
      return true;
    }),
    entities: (r.entities
      .filter(e => !FEW_SHOT_ENTITY_NAMES.has((e.name ?? "").toLowerCase()))
      .map(e => {
        const t = (e.type ?? "").toLowerCase().trim();
        if (ALLOWED_ENTITY_TYPES.has(t)) return { ...e, type: t };
        const remapped = TYPE_REMAP[t];
        if (remapped) return { ...e, type: remapped };
        return null;
      })
      .filter((e): e is ExtractedEntity => e !== null)
    ),
  };
}

function parseStrictJson(raw: string): ExtractionResult {
  // Strip code fences if model emitted them despite instructions.
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  // Some models prepend "Here is the JSON:" — strip leading non-{ chars.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`no JSON object in response: ${raw.slice(0, 200)}`);
  const obj = JSON.parse(cleaned.slice(start, end + 1));
  return filterFewShotLeak({
    facts: Array.isArray(obj.facts) ? obj.facts : [],
    entities: Array.isArray(obj.entities) ? obj.entities : [],
  });
}

// ── Chunking helpers (v2.14.4) ───────────────────────────────────────
//
// The full-content ClaudeCLIExtractor call timed out (180s / 0 facts) on a
// 65 KB episode. Rather than truncate (Bug A) we split the FULL content into
// boundary-aligned pieces, extract each, and merge. These are module-level
// function declarations (hoisted) so the extractor below can use them.

// Split text into <= maxChars pieces, preferring paragraph (blank-line) then
// line boundaries so a fact is never severed mid-sentence. A single oversize
// paragraph is hard-split on newlines (then on raw length) as a last resort.
export function chunkOnBoundaries(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n\n+/);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => { if (buf.trim()) chunks.push(buf); buf = ""; };
  for (const para of paras) {
    if (para.length > maxChars) {
      flush();
      let rest = para;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf("\n", maxChars);
        if (cut <= 0) cut = maxChars;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      buf = rest;
      continue;
    }
    if (buf.length + para.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

// Merge per-chunk results, deduping facts by (subject|predicate|object) and
// entities by (name|type), case-insensitively. Cross-chunk duplicates are
// common (an entity recurs across sections); the write layer dedups too, but
// collapsing here avoids redundant writes + audit noise. First write wins.
export function mergeExtractionResults(results: ExtractionResult[]): ExtractionResult {
  const entities: ExtractedEntity[] = [];
  const seenE = new Set<string>();
  // v2.21.0 — general-review fix: cross-chunk dedup was first-wins, so a
  // 0.6-confidence evidence-rescued copy from an early chunk shadowed a
  // 3/3-majority copy of the SAME fact from a later chunk. Keep the
  // strongest copy: more votes first, then confidence.
  const factByKey = new Map<string, ExtractedFact>();
  const strength = (f: ExtractedFact) => (f.votes ?? 1) * 10 + (f.confidence ?? 0);
  for (const r of results) {
    for (const f of r.facts ?? []) {
      const k = `${(f.subject ?? "").toLowerCase()}|${(f.predicate ?? "").toLowerCase()}|${(f.object ?? "").toLowerCase()}`;
      const prev = factByKey.get(k);
      if (!prev || strength(f) > strength(prev)) factByKey.set(k, f);
    }
    for (const e of r.entities ?? []) {
      const k = `${(e.name ?? "").toLowerCase()}|${(e.type ?? "").toLowerCase()}`;
      if (seenE.has(k)) continue;
      seenE.add(k); entities.push(e);
    }
  }
  return { facts: [...factByKey.values()], entities };
}

// ── Consensus extraction (v2.16.0) ──────────────────────────────────
//
// The LLM gate is the ONE nondeterministic step in the L1→L2 transition:
// the same chunk yielded 4 facts on one run and 25 on the next. mema's
// determinism principle applies to everything after the gate — so the gate
// itself gets stabilized by majority vote: N parallel passes per chunk,
// and only triples a majority of successful passes agree on survive.
//
// Threshold = majority of SUCCESSFUL passes (3→2, 2→2, 1→1), so a single
// flaky CLI call cannot zero a document. Deterministic given the pass
// outputs: keys are normalized, ties resolve by first appearance.
// v2.20.0 — evidence-rescue gate. Diagnosed on Arachne ADR-016: on dense
// design prose the three passes each notice DIFFERENT true facts (5/7/8
// proposed, ~2 overlapping), so majority voting kept correctness but
// destroyed coverage (~80% loss). The rescue: a below-majority fact
// survives when its quoted evidence sentence appears VERBATIM in the
// source text AND names both sides of the triple. Deterministic, zero
// extra model calls. Agreement stays the gold gate; verbatim evidence is
// the silver one — rescued facts enter with capped confidence and
// explicit "+evidence" provenance.
// v2.21.0 — general-review fix: the first version accepted ANY token >= 3
// chars as a raw substring, so "The Board" matched via "the" and "plan"
// matched "planning" — the quote never actually had to name the triple's
// sides. Now: stopwords excluded, word-boundary matching, and an empty
// side always fails.
const GATE_STOPWORDS = new Set([
  "the", "and", "for", "nor", "but", "with", "that", "this", "these",
  "those", "from", "into", "onto", "are", "was", "were", "has", "have",
  "had", "its", "their", "our", "your", "all", "any", "not", "can",
  "will", "would", "should", "may", "might", "also", "than", "then",
  "when", "where", "which", "who", "how", "what", "why", "only", "very",
  "more", "most", "some", "such", "each", "per", "via", "one", "two",
  "new", "now", "out", "over", "under", "about",
]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// v2.21.1 — breaker finding: ASCII-only boundaries split "Zürich" into
// "z"+"rich" and matched quotes about "rich history". Unicode-aware
// token splitting and boundaries.
const wordBoundaryHit = (haystack: string, needle: string): boolean =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}([^\\p{L}\\p{N}]|$)`, "u").test(haystack);

export function evidencePassesGate(f: ExtractedFact, sourceText: string): boolean {
  const ev = (f.evidence ?? "").trim();
  if (ev.length < 20) return false;
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm(sourceText).includes(norm(ev))) return false;
  const evNorm = norm(ev);
  const mentions = (side: string): boolean => {
    const phrase = norm(side);
    if (phrase.length < 2) return false;
    const toks = phrase.split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length >= 3 && !GATE_STOPWORDS.has(t));
    // v2.21.1 — breaker finding: the phrase fallback let stopword-only
    // sides ("This", "It") match nearly any sentence. A side with no
    // distinctive token can never be verified — fail closed.
    if (toks.length === 0) return false;
    return toks.some(t => wordBoundaryHit(evNorm, t));
  };
  return mentions(f.subject ?? "") && mentions(f.object ?? "");
}

export function consensusMerge(perPass: ExtractionResult[], sourceText?: string): ExtractionResult {
  const ok = perPass.length;
  if (ok === 0) return { facts: [], entities: [] };
  if (ok === 1) {
    // No vote possible — annotate and pass through.
    return {
      facts: perPass[0].facts.map(f => ({ ...f, votes: 1, passes: 1 })),
      entities: perPass[0].entities,
    };
  }
  const threshold = Math.floor(ok / 2) + 1;

  // v2.16.2 — subject/object surface normalization, anchored to the
  // extractor's OWN entity declarations. "Princeton" and "Princeton
  // research team" must tally as one candidate — but only when the passes'
  // entity lists justify it:
  //   1. exact entity-name match wins first ("Claude model family" never
  //      collapses into "Claude" when BOTH are declared entities);
  //   2. otherwise a ref maps to an entity name contained in it on token
  //      boundaries, and only when exactly ONE entity matches — ambiguous
  //      or unanchored strings keep their surface form.
  const entityCased = new Map<string, string>();   // lc name → first cased name
  for (const pass of perPass) {
    for (const e of pass.entities ?? []) {
      const lc = (e.name ?? "").trim().toLowerCase();
      if (lc && !entityCased.has(lc)) entityCased.set(lc, e.name.trim());
    }
  }
  // v2.22.1 (round-2 finding): unicode-aware split — the ASCII-only
  // /[^a-z0-9]+/ fragmented accented names ("Zürich" -> ["z","rich"]) and
  // falsely anchored unrelated subjects. Mirrors the evidence-gate fix.
  const tokensOf = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const containsTokens = (haystack: string[], needle: string[]): boolean => {
    if (needle.length === 0 || needle.length > haystack.length) return false;
    for (let i = 0; i + needle.length <= haystack.length; i++) {
      if (needle.every((t, j) => haystack[i + j] === t)) return true;
    }
    return false;
  };
  const normalizeRef = (raw: string): string => {
    const s = (raw ?? "").trim().toLowerCase();
    if (!s || entityCased.has(s)) return s;          // exact match (or literal) stays
    const refTokens = tokensOf(s);
    let hit: string | null = null;
    for (const name of entityCased.keys()) {
      if (name.length < 3) continue;                 // too short to anchor safely
      if (!containsTokens(refTokens, tokensOf(name))) continue;
      if (hit) return s;                             // ambiguous → keep surface form
      hit = name;
    }
    return hit ?? s;
  };

  // v2.16.1 — vote on the CANONICAL predicate so synonym phrasings tally
  // together ("developed"/"created"/"founded" = one candidate, 3 votes)
  // instead of dying as 1-vote strangers.
  const factKey = (f: ExtractedFact) =>
    `${normalizeRef(f.subject)}|${canonicalPredicate(f.predicate ?? "")}|${normalizeRef(f.object)}`;

  // Tally facts: one vote per pass per triple (dupes within a pass don't
  // double-count). First surface form wins for display.
  const factTally = new Map<string, {
    first: ExtractedFact; subjKey: string; objKey: string;
    votes: number; confidences: number[]; dates: (string | null)[];
  }>();
  for (const pass of perPass) {
    const seenThisPass = new Set<string>();
    for (const f of pass.facts ?? []) {
      const k = factKey(f);
      if (seenThisPass.has(k)) continue;
      seenThisPass.add(k);
      const entry = factTally.get(k);
      if (entry) {
        entry.votes++;
        entry.confidences.push(f.confidence ?? 0.8);
        entry.dates.push(sanitizeEventDate(f.event_date));
      } else {
        factTally.set(k, {
          first: f, subjKey: normalizeRef(f.subject), objKey: normalizeRef(f.object),
          votes: 1,
          confidences: [f.confidence ?? 0.8],
          dates: [sanitizeEventDate(f.event_date)],
        });
      }
    }
  }

  const facts: ExtractedFact[] = [];
  for (const { first, subjKey, objKey, votes, confidences, dates } of factTally.values()) {
    if (votes < threshold) {
      // v2.20.0 — evidence rescue (see evidencePassesGate above).
      if (!sourceText || !evidencePassesGate(first, sourceText)) continue;
      const d = sanitizeEventDate(first.event_date);
      facts.push({
        ...first,
        subject: entityCased.get(subjKey) ?? first.subject,
        object: entityCased.get(objKey) ?? first.object,
        // Silver gate = lower ceiling: never above 0.6.
        confidence: Math.min(0.6, confidences.reduce((a, b) => a + b, 0) / confidences.length),
        // "Never invent" extends to dates: a rescued fact keeps its date
        // only when the quoted evidence itself contains the year.
        event_date: d && (first.evidence ?? "").includes(d.slice(0, 4)) ? d : null,
        votes,
        passes: ok,
        evidence_verified: true,
      });
      continue;
    }
    // event_date must ITSELF win a majority — "never invent" extends to
    // dates: a date one pass hallucinated onto an agreed triple is dropped.
    const dateCounts = new Map<string, number>();
    for (const d of dates) if (d) dateCounts.set(d, (dateCounts.get(d) ?? 0) + 1);
    let eventDate: string | null = null;
    for (const [d, n] of dateCounts) {
      if (n >= threshold && (eventDate === null || n > (dateCounts.get(eventDate) ?? 0))) {
        eventDate = d;
      }
    }
    facts.push({
      ...first,
      // v2.16.2 — display the canonical entity name when the vote key was
      // anchored to one ("Princeton research team" → "Princeton"), so the
      // downstream exact-match entity linking fires. Literals keep their
      // first surface form.
      subject: entityCased.get(subjKey) ?? first.subject,
      object: entityCased.get(objKey) ?? first.object,
      confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
      event_date: eventDate,
      votes,
      passes: ok,
    });
  }

  // Entities: same majority rule, PLUS a rescue — an entity referenced as
  // subject/object by a surviving fact is kept even below threshold, so a
  // winning fact never loses its link target.
  const entKey = (e: ExtractedEntity) =>
    `${(e.name ?? "").trim().toLowerCase()}|${(e.type ?? "").trim().toLowerCase()}`;
  const entTally = new Map<string, { first: ExtractedEntity; votes: number }>();
  for (const pass of perPass) {
    const seenThisPass = new Set<string>();
    for (const e of pass.entities ?? []) {
      const k = entKey(e);
      if (seenThisPass.has(k)) continue;
      seenThisPass.add(k);
      const entry = entTally.get(k);
      if (entry) entry.votes++;
      else entTally.set(k, { first: e, votes: 1 });
    }
  }
  const referencedNames = new Set<string>();
  for (const f of facts) {
    referencedNames.add((f.subject ?? "").trim().toLowerCase());
    referencedNames.add((f.object ?? "").trim().toLowerCase());
  }
  const entities: ExtractedEntity[] = [];
  for (const { first, votes } of entTally.values()) {
    const name = (first.name ?? "").trim().toLowerCase();
    if (votes >= threshold || referencedNames.has(name)) entities.push(first);
  }

  return { facts, entities };
}

// Bounded-concurrency map. Unbounded parallel `claude` subprocesses risk OAuth
// quota throttling + resource spikes; cap to `limit` in flight. Preserves
// input order in the output array.
async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── OllamaExtractor ──────────────────────────────────────────────────

export class OllamaExtractor implements LLMExtractor {
  readonly name: string;
  private url: string;
  private model: string;
  constructor(opts: { url?: string; model?: string } = {}) {
    this.url = opts.url ?? process.env.OLLAMA_URL ?? "http://localhost:11434";
    this.model = opts.model ?? process.env.OLLAMA_MODEL ?? "llama3.1:8b";
    this.name = `ollama:${this.model}`;
  }
  async extract(text: string): Promise<ExtractionResult> {
    const r = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        format: "json",
        stream: false,
        options: { temperature: 0.1 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: FEW_SHOT_USER },
          { role: "assistant", content: FEW_SHOT_ASSISTANT },
          { role: "user", content: `Text:\n${text.slice(0, 8000)}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as { message: { content: string } };
    return parseStrictJson(d.message.content);
  }
}

// ── AnthropicExtractor ───────────────────────────────────────────────

export class AnthropicExtractor implements LLMExtractor {
  readonly name: string;
  private apiKey: string;
  private model: string;
  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    // v2.15.0 — was claude-3-5-haiku-20241022, RETIRED 2026-02-19: with an
    // ANTHROPIC_API_KEY set, pickExtractor preferred this extractor and every
    // extraction 404'd. claude-sonnet-5 is the current quality/cost sweet
    // spot for structured extraction (1M context, so no truncation needed).
    this.model = opts.model ?? "claude-sonnet-5";
    this.name = `anthropic:${this.model}`;
  }
  // v2.21.0 — general-review fix: the single-shot path sent up to 600 KB
  // of input against a fixed 8192-token OUTPUT ceiling, so large documents
  // truncated mid-JSON and deterministically failed on every retry. Inputs
  // beyond one comfortable call are now chunked (single pass per chunk —
  // this path never had consensus) and merged, with honest chunk_stats.
  private static readonly SINGLE_SHOT_CHARS = 24_000;

  async extract(text: string): Promise<ExtractionResult> {
    if (text.length <= AnthropicExtractor.SINGLE_SHOT_CHARS) return this.extractOnce(text);
    const chunks = chunkOnBoundaries(text, 20_000);
    const parts: ExtractionResult[] = [];
    let failed = 0;
    for (const chunk of chunks) {
      try { parts.push(await this.extractOnce(chunk)); }
      catch { failed++; }
    }
    if (chunks.length === 0) return { facts: [], entities: [], chunk_stats: { total: 0, failed: 0 } };
    if (parts.length === 0) throw new Error(`anthropic extractor: all ${chunks.length} chunk(s) failed`);
    const merged = mergeExtractionResults(parts);
    return { ...merged, chunk_stats: { total: chunks.length, failed } };
  }

  private async extractOnce(text: string): Promise<ExtractionResult> {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [
          { role: "user", content: FEW_SHOT_USER },
          { role: "assistant", content: FEW_SHOT_ASSISTANT },
          // v2.15.0 — Bug A closed on the API path too: full content, capped
          // only at the same 600 KB sanity bound as the CLI extractor.
          { role: "user", content: `Text:\n${text.slice(0, 600_000)}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as { content: { text: string }[] };
    return parseStrictJson(d.content[0].text);
  }
}

// ── ClaudeCLIExtractor ────────────────────────────────────────────────
//
// v2.14.2+: shells out to the locally-installed `claude` CLI so users on
// OAuth Max plans (no ANTHROPIC_API_KEY) can still use Claude as their
// extractor. The CLI's auth + quota are inherited from the user's session.
//
// Default model is `haiku` (5-10× higher quota than sonnet on Max plan;
// strong enough for grounded extraction without regurgitating few-shot
// demos the way llama3.1:8b does). Override via constructor or
// MEMA_CLAUDE_EXTRACTOR_MODEL env.
//
// Sterilization flags match bench/bench-utils.ts::callClaudeCLI:
//   --no-session-persistence    don't write a resumable session
//   --disable-slash-commands    no skill resolution
//   --allowedTools ""           empty allowlist = no tools
//   --system-prompt <SYSTEM>    OVERRIDE the user's default system prompt
//                               (where CLAUDE.md / PAI persona would load)
//
// MACHTSINN_PORT=65535 in child env so any SessionStart/SessionEnd hooks
// (start.sh / stop.sh) target a throwaway port instead of the real mema
// on 3001.

// v2.14.4+ — the "entity-extractor" agent. A Claude invocation via the CLI
// (OAuth, no API key) acting as a dedicated structured-fact extractor. The
// defining change vs. the v2.14.2 ClaudeCLIExtractor:
//
//   • NO 8 KB truncation. Reads the FULL raw episode body (capped only at a
//     600 KB / ~150k-token sanity bound, well inside the 1M context window).
//     This closes Bug A — large episodes are now extracted in their entirety
//     instead of just their first 8 KB.
//   • Defaults to `sonnet` (1M-context capable, strong instruction-following
//     so it does not regurgitate few-shot demos the way qwen2.5:7b/llama do,
//     better Max-plan quota than opus). Override via MEMA_CLAUDE_EXTRACTOR_MODEL.
//   • Larger timeout — full-content extraction is slower than the 8 KB path.
//
// The 1M context window means a single call can read an entire long document
// episode; future batch mode (B) can feed many episodes per call.
export class ClaudeCLIExtractor implements LLMExtractor {
  readonly name: string;
  private model: string;
  private timeoutMs: number;
  // v2.14.4 — chunking parameters. Large episodes are split into <= chunkChars
  // pieces and extracted with bounded parallelism (see extract()). All three
  // are env-overridable for tuning without a redeploy.
  private chunkChars: number;
  private concurrency: number;
  private consensusPasses: number;
  // 600 KB ≈ 150k tokens — full episodes (walk caps source files at 200 KB)
  // fit comfortably; the bound only guards against pathological input and
  // macOS ARG_MAX when the text is passed as a CLI argument.
  private static readonly MAX_CHARS = 600_000;
  constructor(opts: { model?: string; timeoutMs?: number; chunkChars?: number; concurrency?: number; consensusPasses?: number } = {}) {
    this.model = opts.model ?? process.env.MEMA_CLAUDE_EXTRACTOR_MODEL ?? "sonnet";
    // v2.16.0 — number of independent extraction passes per chunk. 3 gives
    // a real majority; 1 restores single-pass behavior (no voting).
    this.consensusPasses = Math.max(1, opts.consensusPasses ?? Number(process.env.MEMA_EXTRACT_CONSENSUS_PASSES ?? 3));
    // v2.15.0 — defaults re-tuned from the 2026-07-08 live run: an 8,000-char
    // chunk timed out at the old 120s default even on haiku (CLI overhead
    // dominates), silently zeroing the run; 4,500-char chunks at 300s
    // completed reliably (~2:53 wall for 2 parallel chunks). Both remain
    // env-overridable.
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.MEMA_EXTRACT_TIMEOUT_MS ?? 300000);
    this.chunkChars = opts.chunkChars ?? Number(process.env.MEMA_EXTRACT_CHUNK_CHARS ?? 4500);
    this.concurrency = opts.concurrency ?? Number(process.env.MEMA_EXTRACT_CONCURRENCY ?? 3);
    this.name = `entity-extractor:${this.model}`;
  }

  // v2.16.0 — chunk-then-consensus-then-merge. The full content is split on
  // text boundaries into <= chunkChars pieces; EACH chunk is extracted by
  // `consensusPasses` independent parallel passes; only majority-agreed
  // triples survive (see consensusMerge). Per-pass failures are isolated; a
  // chunk counts as failed only when ALL of its passes died. Bug A
  // (truncation) stays closed; the v2.15.1 variance finding (4 vs 25 facts
  // from the same document) is what this stabilizes.
  async extract(text: string): Promise<ExtractionResult> {
    const truncated = text.length > ClaudeCLIExtractor.MAX_CHARS;
    const capped = truncated
      ? text.slice(0, ClaudeCLIExtractor.MAX_CHARS)
      : text;
    const chunks = chunkOnBoundaries(capped, this.chunkChars);
    const passes = this.consensusPasses;

    // Flatten chunk × pass into one bounded-concurrency job list so passes
    // of different chunks interleave (no barrier between chunks).
    const jobs: Array<{ ci: number; pi: number }> = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      for (let pi = 0; pi < passes; pi++) jobs.push({ ci, pi });
    }
    const raw = await mapWithConcurrency(jobs, this.concurrency, async job => {
      try { return await this.extractOne(chunks[job.ci]); }
      catch { return null; }
    });

    // Optional per-pass debug dump: MEMA_EXTRACT_DEBUG_DIR=/path writes one
    // JSON per (chunk, pass) so "why did this fact get dropped?" is
    // answerable after the fact.
    const debugDir = process.env.MEMA_EXTRACT_DEBUG_DIR;
    if (debugDir) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      try {
        mkdirSync(debugDir, { recursive: true });
        jobs.forEach((job, i) => writeFileSync(
          `${debugDir}/chunk${job.ci}-pass${job.pi}.json`,
          JSON.stringify(raw[i] ?? { failed: true }, null, 2),
        ));
      } catch { /* debug only — never fail extraction over it */ }
    }

    let failedChunks = 0;
    const perChunkConsensus: ExtractionResult[] = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const okPasses = jobs
        .map((job, i) => (job.ci === ci ? raw[i] : null))
        .filter((r): r is ExtractionResult => r !== null);
      if (okPasses.length === 0) { failedChunks++; continue; }
      perChunkConsensus.push(consensusMerge(okPasses, chunks[ci]));
    }
    // Every chunk failed (CLI unavailable / all passes timed out) — surface
    // it so /v2/observe records pending_retry instead of silently zero facts.
    if (perChunkConsensus.length === 0) {
      // v2.22.1 (round-2 finding): zero chunks means the input had no
      // extractable text (e.g. whitespace only) — return empty, don't
      // throw a misleading "all 0 chunks failed" that forces pending_retry.
      if (chunks.length === 0) return { facts: [], entities: [], chunk_stats: { total: 0, failed: 0 } };
      throw new Error(`claude CLI extractor: all ${chunks.length} chunk(s) failed (${passes} passes each)`);
    }
    const merged = mergeExtractionResults(perChunkConsensus);
    merged.chunk_stats = {
      total: chunks.length,
      failed: failedChunks,
      ...(truncated ? { truncated: true } : {}),
    };
    return merged;
  }

  // One sterilized CLI call over a single chunk, with a hard timeout.
  private async extractOne(text: string): Promise<ExtractionResult> {
    const userPrompt =
      `${FEW_SHOT_USER}\n\n${FEW_SHOT_ASSISTANT}\n\nNow extract from this text:\n${text}`;
    const proc = Bun.spawn([
      "claude",
      "--model", this.model,
      "--no-session-persistence",
      "--disable-slash-commands",
      "--allowedTools", "",
      // v2.14.4 — kill per-call startup overhead. Measured ~50s of fixed
      // latency per invocation was the CLI loading MCP servers + settings +
      // hooks. --strict-mcp-config (with no --mcp-config) loads ZERO MCP
      // servers; --setting-sources "" skips CLAUDE.md/skills/plugins/hooks/
      // MCP settings. MACHTSINN_PORT below still guards hooks belt-and-suspenders.
      "--strict-mcp-config",
      "--setting-sources", "",
      "--system-prompt", SYSTEM_PROMPT,
      "-p", userPrompt,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MACHTSINN_PORT: "65535" },
      cwd: "/tmp",
    });
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<"__timeout__">(resolve => {
      timerId = setTimeout(() => resolve("__timeout__"), this.timeoutMs);
    });
    const reader = (async () => {
      if (!proc.stdout) return "";
      return new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
    })();
    const result = await Promise.race([reader, timer]);
    // v2.21.0 — general-review fix: an uncancelled timer kept the process
    // alive for up to timeoutMs after every successful call.
    if (timerId !== undefined) clearTimeout(timerId);
    if (result === "__timeout__") {
      try { proc.kill(); } catch {}
      setTimeout(() => { try { proc.kill(9); } catch {} }, 2000);
      throw new Error(`claude CLI extractor timed out after ${this.timeoutMs}ms`);
    }
    return parseStrictJson(result as string);
  }
}

// ── OpenAIExtractor ──────────────────────────────────────────────────

export class OpenAIExtractor implements LLMExtractor {
  readonly name: string;
  private apiKey: string;
  private model: string;
  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "gpt-4o-mini";
    this.name = `openai:${this.model}`;
  }
  async extract(text: string): Promise<ExtractionResult> {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: FEW_SHOT_USER },
          { role: "assistant", content: FEW_SHOT_ASSISTANT },
          { role: "user", content: `Text:\n${text.slice(0, 8000)}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json() as { choices: { message: { content: string } }[] };
    return parseStrictJson(d.choices[0].message.content);
  }
}

// ── Auto-pick ────────────────────────────────────────────────────────
// v2.14.2+ Priority: Anthropic API > Claude CLI (OAuth) > OpenAI > Ollama > throw.
//
// Ollama llama3.1:8b empirically regurgitates few-shot examples instead of
// extracting from the input (verified 2026-05-19 on LongMemEval bench:
// every observe extracted the same 3 prompt-example facts about Marcel/
// machtsinn AG regardless of source content). Demoted from default.
// Force via MEMA_EXTRACTOR env: "ollama" | "anthropic" | "claude_cli" | "openai".

export async function pickExtractor(): Promise<LLMExtractor> {
  const forced = process.env.MEMA_EXTRACTOR?.toLowerCase();
  if (forced === "anthropic" || (!forced && process.env.ANTHROPIC_API_KEY)) {
    return new AnthropicExtractor({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  if (forced === "claude_cli" || forced === "claude-cli"
      || (!forced && await claudeCliAvailable())) {
    return new ClaudeCLIExtractor();
  }
  if (forced === "openai" || (!forced && process.env.OPENAI_API_KEY)) {
    return new OpenAIExtractor({ apiKey: process.env.OPENAI_API_KEY! });
  }
  if (forced === "ollama" || (!forced && await ollamaAvailable())) {
    return new OllamaExtractor();
  }
  throw new Error(
    "No LLM extractor available. Either:\n" +
    "  • install the Claude CLI and log in: brew install claude / claude login\n" +
    "  • set ANTHROPIC_API_KEY or OPENAI_API_KEY\n" +
    "  • install Ollama as fallback: brew install ollama && ollama pull llama3.1:8b\n" +
    "(Ollama is the weakest option — regurgitates few-shot examples.)"
  );
}

async function claudeCliAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    // v2.16.2 — was 2s, which a cold fnm-shimmed Node CLI start can exceed:
    // on 2026-07-09 the probe timed out and mema SILENTLY degraded to the
    // Ollama extractor (truncated, no consensus, banned predicates leaked).
    // 10s is cheap insurance; the result is only consulted once per request.
    const exited = await Promise.race([
      proc.exited,
      new Promise<number>(r => setTimeout(() => r(-1), 10000)),
    ]);
    return exited === 0;
  } catch { return false; }
}

async function ollamaAvailable(): Promise<boolean> {
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
