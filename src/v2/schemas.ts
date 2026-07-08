// Runtime schema validation for all /v2/* request bodies (Pydantic-equivalent
// in the TypeScript ecosystem). Replaces the v2.0–v2.14 pattern where
// parseBody<T> was a compile-time-only typecast — the runtime accepted any
// JSON and crashed with 500 when a required field was missing.
//
// Now every endpoint declares its body schema here. parseBody runs the schema
// against the parsed JSON and returns 400 with field-level issues on failure.
//
// Naming convention: <route>Body — e.g. observeBody, factBody.

import { z } from "zod";

// ── Layer 1: Episode ─────────────────────────────────────────────
export const observeBody = z.object({
  kind: z.enum(["conversation", "document", "tool_call", "observation"]),
  content: z.string(),
  source: z.string().optional(),
  refs: z.array(z.string()).optional(),
  skip_extraction: z.boolean().optional(),
});

// ── Layer 2: Facts ───────────────────────────────────────────────
export const factBody = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  // v2.15.1 — optional fact↔entity links (the observe path resolves these
  // automatically; direct callers may pass known entity IDs).
  subject_entity_id: z.string().nullable().optional(),
  object_entity_id: z.string().nullable().optional(),
  valid_from: z.string().optional(),
  valid_to: z.string().nullable().optional(),
  derived_from: z.array(z.string()),
  confidence: z.number().optional(),
  status: z.enum(["draft", "approved"]).optional(),
  evidence_excerpt: z.string().optional(),
  proposed_by: z.string().optional(),
});

export const factInvalidateBody = z.object({
  superseded_by: z.string().optional(),
});

export const reasonForceBody = z.object({
  reason: z.string().optional(),
  force: z.boolean().optional(),
});

export const reasonBody = z.object({
  reason: z.string(),
});

export const factFindBody = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
});

// ── Layer 4: Entities ────────────────────────────────────────────
export const entityBody = z.object({
  name: z.string(),
  type: z.string(),
  aliases: z.array(z.string()).optional(),
  status: z.enum(["draft", "approved"]).optional(),
  evidence_excerpt: z.string().optional(),
  proposed_by: z.string().optional(),
  derived_from: z.array(z.string()).optional(),
});

export const entityResolveBody = z.object({
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  type: z.string().optional(),
  include_drafts: z.boolean().optional(),
  max_levenshtein: z.number().optional(),
});

// ── Layer 3: Cognitive ───────────────────────────────────────────
export const cognitiveBody = z.object({
  kind: z.enum(["experience", "observation", "belief"]),
  content: z.string(),
  confidence: z.number(),
  derived_from: z.array(z.string()),
});

export const derivedFromAddBody = z.object({
  add: z.array(z.string()),
});

export const supersedeBody = z.object({
  new_id: z.string(),
});

// ── Reflection ───────────────────────────────────────────────────
export const reflectBody = z.object({
  since: z.string().optional(),
  min_support: z.number().optional(),
  max_records_emitted: z.number().optional(),
  llm: z.boolean().optional(),
  llm_max_per_window: z.number().optional(),
});

// ── Governance ───────────────────────────────────────────────────
export const governanceBuildBody = z.object({
  source_content: z.string(),
  purpose: z.array(z.string()),
  retention_until: z.string().optional(),
  jurisdiction: z.string().optional(),
  data_classes: z.array(z.string()).optional(),
  allowed_actors: z.array(z.string()).optional(),
});

export const eraseBody = z.object({
  record_path: z.string(),
  reason: z.string(),
  legal_basis: z.string().optional(),
});

// ── Layer 5: Recall ──────────────────────────────────────────────
const modelContext = z.object({
  model: z.string().optional(),
  model_region: z.string().optional(),
  deployment: z.enum(["local", "cloud"]).optional(),
  human_review: z.boolean().optional(),
  approved_models: z.array(z.string()).optional(),
}).optional();

export const recallBody = z.object({
  query: z.string(),
  purpose: z.string(),
  kinds: z.array(z.enum(["episode", "fact", "cognitive", "entity"])).optional(),
  temporal: z.object({ valid_at: z.string().optional() }).optional(),
  limit: z.number().optional(),
  use_vector: z.boolean().optional(),
  jurisdiction: z.string().optional(),
  model: modelContext,
  policy_mode: z.enum(["permissive", "strict"]).optional(),
  fusion: z.enum(["weighted", "rrf"]).optional(),
});

export const recallPacketBody = z.object({
  query: z.string(),
  purpose: z.string(),
  temporal: z.object({ valid_at: z.string().optional() }).optional(),
  limit_evidence: z.number().optional(),
  limit_memory: z.number().optional(),
  use_vector: z.boolean().optional(),
  jurisdiction: z.string().optional(),
  model: modelContext,
  policy_mode: z.enum(["permissive", "strict"]).optional(),
  fusion: z.enum(["weighted", "rrf"]).optional(),
});

// ── Layer 7: UAL Assets ──────────────────────────────────────────
export const assetWrapBody = z.object({
  path: z.string(),
  kind: z.string(),
  scope: z.string(),
  id: z.string(),
});

export const assetPathBody = z.object({
  path: z.string(),
});

export const assetAnchorBody = z.object({
  path: z.string(),
  target: z.string(),
});

export const assetStatusBody = z.object({
  path: z.string(),
  status: z.enum(["unverified", "verified", "anchored"]),
});
