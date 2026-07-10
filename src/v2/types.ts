// mema v2 — Six-layer memory architecture
// Ardin's spec: episodic / temporal-semantic / cognitive / governance / retrieval / audit
// Each layer has its own types; this file is the contract between layers.

// Clamp a confidence value to [0, 1] and convert NaN/±Infinity to 0.5.
// CRITICAL: applied at every write boundary to prevent retrieval-score poisoning.
export function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Convert arbitrary text into a filesystem- and Obsidian-friendly slug.
// Lowercase, ASCII, kebab-case, ≤80 chars. Empty/garbage input falls back to
// the caller-provided default. CRITICAL: used in filenames AND in wikilinks,
// so it must produce output that matches both SAFE_WIKILINK_ID and POSIX path
// conventions.
export function slugify(text: unknown, fallback = "item"): string {
  const raw = String(text ?? "").trim();
  if (!raw) return fallback;
  // Normalize accented chars then strip diacritics for ASCII output.
  const ascii = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")           // strip combining marks
    .replace(/[äÄ]/g, "a").replace(/[öÖ]/g, "o").replace(/[üÜ]/g, "u")
    .replace(/[ß]/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");                        // trim trailing - after slice
  return ascii || fallback;
}

// Build a filename for a v2 record: `{slug}--{ulid}.md`. The `--` separator
// is uncommon in slugs so we can reliably parse the ULID back out of the
// filename (used by readers to look up records by ID).
export function recordFilename(slug: string, id: string): string {
  return `${slug || "item"}--${id}.md`;
}

// Extract the ULID from a record filename, or null if not in the expected
// `{slug}--{ulid}.md` shape. Tolerates legacy `{ulid}.md` filenames for
// backwards compatibility during migration.
export function idFromFilename(filename: string): string | null {
  if (!filename.endsWith(".md")) return null;
  const stem = filename.slice(0, -3);
  const sep = stem.lastIndexOf("--");
  if (sep >= 0) {
    const id = stem.slice(sep + 2);
    return SAFE_WIKILINK_ID.test(id) ? id : null;
  }
  // Legacy: whole stem IS the ULID
  return SAFE_WIKILINK_ID.test(stem) ? stem : null;
}

// Validate an ID string for safe inclusion in an Obsidian wikilink `[[id]]`.
// Rejects path-traversal, pipe (alias-syntax), bracket-escape, empty, and
// non-printable characters. Strict whitelist: ULID-like alphanumerics +
// hyphen + underscore + dot, ≤128 chars.
const SAFE_WIKILINK_ID = /^[A-Za-z0-9._-]{1,128}$/;
export function isWikilinkSafeId(id: unknown): id is string {
  return typeof id === "string" && SAFE_WIKILINK_ID.test(id);
}
export function toWikilinks(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!isWikilinkSafeId(id)) continue;   // drop malformed IDs silently
    if (seen.has(id)) continue;             // dedup
    seen.add(id);
    out.push(`[[${id}]]`);
  }
  return out;
}

// ─── Layer 1: Episodic ──────────────────────────────────────────────
// Raw events as they happen: conversations, documents ingested, tool calls,
// observations made by an agent. The substrate for everything else.

export type EpisodeKind =
  | "conversation"   // a turn or session of dialogue
  | "document"       // a file or doc ingested into memory
  | "tool_call"      // an agent executed a tool with inputs/outputs
  | "observation";   // something the agent noticed without acting

export interface Episode {
  id: string;                  // ULID
  timestamp: string;           // ISO-8601 with timezone
  actor: string;               // who/what produced this episode
  owner: string;               // tenant ownership (carried for governance)
  kind: EpisodeKind;
  content: string;             // raw content (the only mandatory data)
  source?: string;             // origin (path, URL, conversation_id, etc.)
  refs?: string[];             // other episode IDs this references
}

// ─── Layer 2: Temporal Semantic (Zep-inspired) ──────────────────────
// Facts extracted from episodes, with bi-temporal validity.
// A fact's validity period (valid_from → valid_to) is what the world claims;
// invalidated_at is when WE learned it was false (epistemic, not ontological).

// ─── Acceptance lifecycle (v2.7+) ────────────────────────────────────
// LLM-derived facts and entities pass through a draft → approved/rejected
// lifecycle. Direct API writes default to "approved" for backward compat.
// Retrieval excludes drafts and rejected records unless explicitly requested.
export type RecordStatus = "draft" | "approved" | "rejected";

export interface SemanticFact {
  id: string;
  subject: string;             // display string, verbatim from the source
  predicate: string;           // e.g., "lives_in", "founded", "rejected"
  object: string;              // display string or literal value
  // v2.15.1 — the fact↔entity link (implements the "entity ID or string"
  // promise that was previously only a comment). Resolved at write time
  // against the owner's entity records by exact name/alias match; null when
  // the subject/object is a literal or no entity record exists. Supersession
  // matches through subject_entity_id, so facts about "Marcel" and
  // "Marcel Schmidt" (same entity, different surface strings) can supersede
  // each other.
  subject_entity_id?: string | null;
  object_entity_id?: string | null;
  valid_from: string;          // when the fact became true in the world
  valid_to?: string | null;    // when the fact stops being true (open if null)
  invalidated_at?: string | null;  // when we learned it was wrong (epistemic)
  superseded_by?: string | null;   // newer fact that replaces this one
  derived_from: string[];      // episode IDs that justified this fact
  confidence: number;          // [0..1]
  owner: string;
  // Acceptance lifecycle. Records without a status field are treated as
  // "approved" by retrieval — this keeps existing vaults working unchanged.
  status?: RecordStatus;
  evidence_excerpt?: string;   // verbatim substring from source episode (≤500 chars)
  proposed_by?: string;        // extractor identifier (e.g., "llm-extractor:ollama:llama3.1:8b")
  proposed_at?: string;
  reviewed_by?: string;        // actor that approved/rejected
  reviewed_at?: string;
  review_reason?: string;
}

export interface Entity {
  id: string;
  name: string;
  aliases: string[];
  type: string;                // person | organization | concept | place | system
  first_seen: string;
  last_seen: string;
  owner: string;
  // Acceptance lifecycle — same semantics as SemanticFact.
  status?: RecordStatus;
  evidence_excerpt?: string;
  proposed_by?: string;
  proposed_at?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  review_reason?: string;
}

// ─── Layer 3: Cognitive (Hindsight-inspired) ────────────────────────
// Higher-order memory: experiences (what happened to the agent), observations
// (what was noticed), beliefs (what the agent holds to be true). Confidence-
// weighted. Beliefs can be superseded by newer reflection.

export type CognitiveKind = "experience" | "observation" | "belief";

export interface CognitiveRecord {
  id: string;
  kind: CognitiveKind;
  content: string;             // the experience/observation/belief in prose
  confidence: number;          // [0..1]
  derived_from: string[];      // episode IDs or fact IDs that produced this
  reflected_at: string;        // when reflection happened
  superseded_by?: string | null;
  owner: string;
}

// ─── Layer 4: Governance (the trust moat) ───────────────────────────
// Every retrievable record carries governance metadata. Policy decisions are
// recorded in the audit log.

export interface Governance {
  purpose: string[];           // allowed use cases (e.g., ["support", "compliance"])
  retention_until?: string | null;  // hard expiry date
  jurisdiction?: string;       // "CH" | "EU" | "US" | etc.
  data_classes?: string[];     // ["pii", "financial", "health", ...]
  evidence: {
    source_hash: string;       // SHA-256 of the source content
    excerpt: string;           // ≤500 chars verbatim from source
    actor: string;             // who ingested
    ingested_at: string;
  };
  allowed_actors?: string[];   // if set, restricts which actors can recall
}

// ─── Layer 5: Retrieval ─────────────────────────────────────────────
// Hybrid recall: keyword + vector + graph + temporal + policy-aware.

// v2.9.0+ entity is now a first-class retrieval candidate (P0-D from review).
// Pre-v2.9 vaults that called recall with kinds:["entity"] silently got
// nothing; now they get the v2-entities/ approved records.
export type RetrievalKind = "episode" | "fact" | "cognitive" | "entity";

export interface RetrievalQuery {
  query: string;
  owner: string;
  actor: string;
  purpose: string;             // why this recall is being made (logged + policy-checked)
  kinds?: RetrievalKind[];     // restrict to certain layers
  temporal?: { valid_at?: string };  // facts valid at this time
  limit?: number;
  use_vector?: boolean;        // stubbed in v2.0; real in v2.1
  // v2.7.3+ policy-routing inputs forwarded to policyCheck.
  jurisdiction?: string;       // recall-side jurisdiction (e.g. "CH")
  model?: {                    // where the recalled content will flow
    model?: string;
    model_region?: string;
    deployment?: "local" | "cloud";
    human_review?: boolean;
    approved_models?: string[];
  };
  policy_mode?: "permissive" | "strict";  // override env var per-call
  // v2.10.0+ fusion strategy (NEW; closes v3.0 RRF criterion). Default
  // "weighted" keeps the v2.5.1→v2.9.0 linear-sum scorer. Switch to
  // "rrf" to use Reciprocal Rank Fusion across keyword, vector, graph,
  // temporal, entity candidate lists — scale-free fusion that doesn't
  // depend on the per-signal score ranges.
  fusion?: "weighted" | "rrf";
}

export interface RetrievalHit {
  kind: RetrievalKind;
  id: string;
  score: number;
  score_components: Record<string, number>;
  excerpt: string;             // snippet shown to the agent
  governance: { allowed: boolean; reason: string };
  // Verifiable asset metadata (present when the record has been wrapped as an asset)
  ual?: string;                // mema://... stable identifier
  content_hash?: string;       // SHA-256 of the body
  metadata_hash?: string;      // SHA-256 of the canonical frontmatter
  asset_version?: number;
  verification_status?: "unverified" | "verified" | "anchored";
  why_retrieved?: string;      // human-readable explanation of why this hit ranked here
  // v2.11.0+ — per-kind structured payload for downstream prompt construction
  // (bench harnesses, agent prompts). Additive + optional; pre-2.11 consumers ignore.
  // Without this, callers had only `excerpt` (240 chars of the first matched line),
  // which is fine for diagnostics but insufficient to format facts/beliefs/entities
  // into a context packet for an answer LLM. Populated when the hit's kind has
  // structured fields worth surfacing.
  payload?: RetrievalHitPayload;
}

// v2.11.0+ structured per-kind content carried by a RetrievalHit. Fields are
// union-typed across kinds; only the subset relevant to the hit's `kind` is set.
export interface RetrievalHitPayload {
  // fact
  subject?: string;
  predicate?: string;
  object?: string;
  valid_from?: string;
  invalidated_at?: string;
  // cognitive (content is the record body, not a frontmatter field)
  content?: string;
  cognitive_kind?: "belief" | "observation" | "experience";
  confidence?: number;
  // entity
  name?: string;
  entity_type?: string;
  aliases?: string[];
  // v2.16.5 — provenance inline on fact/entity hits: the episode IDs this
  // record was derived from, so consumers can credit a hit back to its
  // source document without a second lookup.
  derived_from?: string[];
}

export interface RetrievalResult {
  query: string;
  actor: string;
  purpose: string;
  hits: RetrievalHit[];
  evidence_chain: string[];    // IDs of records that supported each hit
  audit_id: string;            // links to audit log entry
}

// ─── Layer 6: Audit ─────────────────────────────────────────────────
// Append-only with hash chain. Records all operations including reads.

export type AuditOp =
  | "OBSERVE"           // L1 episodic write
  | "EXTRACT"           // L2 fact created/updated
  | "INVALIDATE"        // L2 fact invalidated
  | "REFLECT"           // L3 cognitive record produced
  | "RECALL"            // L5 retrieval performed
  | "POLICY_DENY"       // L4 policy refused access
  | "ERASE"             // L4 hard erasure
  | "PROPOSE"           // L2 draft fact/entity proposed by extractor (v2.7+)
  | "APPROVE"           // L2 draft promoted to approved (v2.7+)
  | "REJECT"            // L2 draft rejected (v2.7+)
  // L7 UAL asset ops (v2.14.3+ — restores invariant #5: every mutation audited).
  // Previously layer7-assets.ts mutated frontmatter (ual, hashes, anchor_targets,
  // verification_status) without an audit row, breaking tamper-evidence.
  | "WRAP"              // L7 record wrapped as asset (UAL minted, hashes computed)
  | "ANCHOR"            // L7 asset anchored to a target (local/customer-audit/origintrail)
  | "VERIFY";           // L7 verification status changed (unverified/verified/anchored)

export interface AuditEntry {
  seq: number;
  ts: string;
  op: AuditOp;
  actor: string;
  owner: string;
  purpose?: string;
  record_ids: string[];        // what was touched
  evidence_chain?: string[];   // for RECALL: what supported the hits
  reason?: string;
  // v2.7.2+ op-specific structured metadata. For ERASE this carries the
  // pre-erasure provenance ({erased_record_id, erased_record_path,
  // content_hash_before, metadata_hash_before, legal_basis}). Included
  // in the chained hash payload.
  metadata?: Record<string, unknown>;
  prev_hash: string | null;    // hash chain
  curr_hash: string;
}
