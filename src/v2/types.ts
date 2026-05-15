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

export interface SemanticFact {
  id: string;
  subject: string;             // entity ID or string
  predicate: string;           // e.g., "lives_in", "founded", "rejected"
  object: string;              // entity ID or literal value
  valid_from: string;          // when the fact became true in the world
  valid_to?: string | null;    // when the fact stops being true (open if null)
  invalidated_at?: string | null;  // when we learned it was wrong (epistemic)
  superseded_by?: string | null;   // newer fact that replaces this one
  derived_from: string[];      // episode IDs that justified this fact
  confidence: number;          // [0..1]
  owner: string;
}

export interface Entity {
  id: string;
  name: string;
  aliases: string[];
  type: string;                // person | organization | concept | place | system
  first_seen: string;
  last_seen: string;
  owner: string;
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

export type RetrievalKind = "episode" | "fact" | "cognitive";

export interface RetrievalQuery {
  query: string;
  owner: string;
  actor: string;
  purpose: string;             // why this recall is being made (logged + policy-checked)
  kinds?: RetrievalKind[];     // restrict to certain layers
  temporal?: { valid_at?: string };  // facts valid at this time
  limit?: number;
  use_vector?: boolean;        // stubbed in v2.0; real in v2.1
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
  | "ERASE";            // L4 hard erasure

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
  prev_hash: string | null;    // hash chain
  curr_hash: string;
}
