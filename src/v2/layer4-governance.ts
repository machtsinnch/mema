// Layer 4: Governance — purpose limitation, provenance, retention, access policy,
// hard erasure. This is the trust moat for Swiss/EU enterprise.

import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { atomicWriteFile } from "./atomic";
import { join } from "node:path";
import matter from "gray-matter";
import type { Governance } from "./types";
import { appendAudit } from "./layer6-audit";

// Compute a canonical hash of source content for evidence chain integrity.
export function hashSource(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Build a governance block from source content + ingestion metadata.
export interface BuildGovernanceInput {
  source_content: string;
  actor: string;
  purpose: string[];
  retention_until?: string | null;
  jurisdiction?: string;
  data_classes?: string[];
  allowed_actors?: string[];
  excerpt_max_chars?: number;
}

export function buildGovernance(input: BuildGovernanceInput): Governance {
  const excerptMax = input.excerpt_max_chars ?? 500;
  return {
    purpose: input.purpose,
    retention_until: input.retention_until ?? null,
    jurisdiction: input.jurisdiction,
    data_classes: input.data_classes,
    allowed_actors: input.allowed_actors,
    evidence: {
      source_hash: hashSource(input.source_content),
      excerpt: input.source_content.slice(0, excerptMax),
      actor: input.actor,
      ingested_at: new Date().toISOString(),
    },
  };
}

// Policy decision: is this actor allowed to recall this record for this
// purpose? Policy mode controls how strict the engine is:
//
//   - "permissive" (default, dev mode): missing governance = allow.
//     Preserves v1 backward-compat for unannotated records.
//   - "strict" (Swiss enterprise / regulated mode): missing governance
//     = deny. Also rejects records that lack a purpose declaration or a
//     retention_until for personal-class data. Set via env var
//     `MEMA_POLICY_MODE=strict` or per-call via PolicyContext.mode.
//
// Personal / health / financial data classes are treated as "regulated"
// and trigger additional checks (jurisdiction, retention) in strict mode.
export type PolicyMode = "permissive" | "strict";

// v2.7.3+ P5 model-routing context: where the recalled content will be
// sent. Used to enforce jurisdiction-locked model routing. Optional —
// callers that don't pass this can still recall in non-confidential
// jurisdictions, but personal+CH with an unknown-region cloud model
// will be denied in strict mode.
export interface ModelContext {
  model?: string;              // e.g. "claude-opus-4-7", "ollama:llama3.1:8b"
  model_region?: string;       // e.g. "CH", "EU", "US", "unknown"
  deployment?: "local" | "cloud";
  human_review?: boolean;      // true if the recall is gated by human review
  approved_models?: string[];  // jurisdiction-approved model allowlist
}

export interface PolicyContext {
  actor: string;
  purpose: string;
  now?: string;                // for testability
  mode?: PolicyMode;           // overrides MEMA_POLICY_MODE env var
  jurisdiction?: string;       // jurisdiction of the recall (e.g. "CH")
  model?: ModelContext;        // where the content will flow
}

// Read the policy mode from PolicyContext.mode, falling back to the
// MEMA_POLICY_MODE env var, falling back to "permissive". Centralized
// so tests can override deterministically.
export function effectivePolicyMode(ctx: PolicyContext): PolicyMode {
  if (ctx.mode) return ctx.mode;
  const env = process.env.MEMA_POLICY_MODE?.toLowerCase();
  if (env === "strict") return "strict";
  return "permissive";
}

const REGULATED_DATA_CLASSES = new Set(["pii", "personal", "health", "financial", "phi"]);

function isRegulated(governance: Governance): boolean {
  if (!governance.data_classes) return false;
  return governance.data_classes.some(c => REGULATED_DATA_CLASSES.has(c.toLowerCase()));
}

export function policyCheck(
  governance: Governance | undefined,
  ctx: PolicyContext,
): { allowed: boolean; reason: string } {
  const mode = effectivePolicyMode(ctx);

  if (!governance) {
    // permissive: v1 legacy records and untagged content recall freely
    if (mode === "permissive") return { allowed: true, reason: "no_governance_block" };
    // strict: no governance block = deny. There is no implicit policy
    // for untagged records in regulated mode.
    return { allowed: false, reason: "strict_no_governance_block" };
  }
  const now = ctx.now ?? new Date().toISOString();

  // 1. Retention check — has the record expired?
  if (governance.retention_until && governance.retention_until < now) {
    return { allowed: false, reason: "retention_expired" };
  }
  // 1b. Strict-only: personal-class records MUST declare a retention.
  if (mode === "strict" && isRegulated(governance) && !governance.retention_until) {
    return { allowed: false, reason: "strict_regulated_missing_retention" };
  }
  // 2. Purpose match — is the recall purpose in the allowed list?
  if (governance.purpose.length === 0) {
    if (mode === "strict") return { allowed: false, reason: "strict_governance_missing_purpose" };
  } else if (!governance.purpose.includes(ctx.purpose)) {
    return { allowed: false, reason: `purpose_not_allowed (requested=${ctx.purpose})` };
  }
  // 3. Allowed actors — if set, is the recalling actor on the list?
  if (governance.allowed_actors && governance.allowed_actors.length > 0) {
    if (!governance.allowed_actors.includes(ctx.actor)) {
      return { allowed: false, reason: "actor_not_in_allowlist" };
    }
  }
  // 4. Strict-only: jurisdiction enforcement. If the record has a
  // declared jurisdiction and the recall context declares one that
  // doesn't match, deny — this is the cross-border data-flow guard.
  if (mode === "strict" && governance.jurisdiction && ctx.jurisdiction) {
    if (governance.jurisdiction.toUpperCase() !== ctx.jurisdiction.toUpperCase()) {
      return { allowed: false, reason: `strict_jurisdiction_mismatch (record=${governance.jurisdiction}, ctx=${ctx.jurisdiction})` };
    }
  }
  // 5. P5 model-routing policy (active in BOTH modes when a model
  // context is supplied — applies whenever the caller declares where
  // the content will flow). Rules:
  //   personal + non-record-jurisdiction cloud region = deny
  //   confidential / regulated + non-approved model = deny
  //   regulated + cloud + human_review !== true (in strict only) = deny
  if (ctx.model) {
    const m = ctx.model;
    if (isRegulated(governance) && m.deployment === "cloud") {
      // Cloud destination for regulated content: require matching jurisdiction
      // OR an explicit approved-model allowlist hit.
      const regionOk = !!(governance.jurisdiction && m.model_region
        && governance.jurisdiction.toUpperCase() === m.model_region.toUpperCase());
      const approvedOk = !!(m.approved_models && m.model && m.approved_models.includes(m.model));
      if (!regionOk && !approvedOk) {
        return { allowed: false, reason: `model_routing_denied (regulated content to unapproved cloud model_region=${m.model_region ?? "unknown"})` };
      }
      if (mode === "strict" && m.human_review !== true) {
        return { allowed: false, reason: "strict_regulated_cloud_requires_human_review" };
      }
    }
  }
  return { allowed: true, reason: "policy_pass" };
}

// HARD ERASE — overwrite the file content with a tombstone, keep audit entry.
// Distinct from v1's soft "forget" (which just flips a flag).
// Required for GDPR/nFADP DSAR erasure requests.
//
// v2.7.2+ (P6 from external review): capture the pre-erasure provenance
// BEFORE we destroy the content — original record_id, record_path,
// content_hash_before, metadata_hash_before, legal_basis — and store
// them in the audit log's `metadata` field. This preserves auditability
// of what was erased (and proof that the deletion happened) without
// retaining the original personal content. The metadata is part of the
// hash chain, so a later operator cannot rewrite it.
export interface HardEraseInput {
  vaultRoot: string;
  owner: string;
  record_path: string;         // relative or absolute path into the vault
  actor: string;
  reason: string;
  legal_basis?: string;        // e.g. "GDPR_Article_17_DSAR", "nFADP_25"
}

// Canonical metadata hash: sorted keys, JSON-serialized — same shape as
// what L7 asset wrapping uses, so erasure provenance is computable from
// any record regardless of frontmatter key order on disk.
function canonicalMetadataHash(fm: Record<string, unknown>): string {
  const keys = Object.keys(fm).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) canonical[k] = (fm as any)[k];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function hardErase(input: HardEraseInput): {
  erased: boolean;
  tombstone_id?: string;
  erased_record_id?: string;
  content_hash_before?: string;
  metadata_hash_before?: string;
} {
  const path = input.record_path.startsWith("/")
    ? input.record_path
    : join(input.vaultRoot, input.record_path);
  if (!existsSync(path)) return { erased: false };

  // Capture pre-erasure provenance.
  const originalRaw = readFileSync(path, "utf8");
  const originalParsed = matter(originalRaw);
  const originalFm = (originalParsed.data ?? {}) as Record<string, unknown>;
  const originalRecordId = (originalFm.id as string | undefined) ?? null;
  const contentHashBefore = createHash("sha256").update(originalParsed.content).digest("hex");
  const metadataHashBefore = canonicalMetadataHash(originalFm);

  const tombstoneId = `tomb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const erasedAt = new Date().toISOString();
  const tombstone = matter.stringify(
    `# ERASED\n\nThis record was hard-erased on ${erasedAt}.\nReason: ${input.reason}\nActor: ${input.actor}\nTombstone ID: ${tombstoneId}\n\nOriginal content destroyed. See audit log entry for provenance hashes.`,
    {
      tombstone: true,
      tombstone_id: tombstoneId,
      erased_at: erasedAt,
      erased_by: input.actor,
      reason: input.reason,
      owner: input.owner,
      // Hashes only — original record_id is intentionally NOT stored in the
      // tombstone frontmatter (it sits in the audit log instead, where the
      // chain protects it). Hashes let auditors prove what was erased
      // without exposing identifiers in the on-disk file.
      content_hash_before: contentHashBefore,
      metadata_hash_before: metadataHashBefore,
    },
  );
  atomicWriteFile(path, tombstone);

  appendAudit({
    op: "ERASE",
    actor: input.actor,
    owner: input.owner,
    record_ids: [tombstoneId],
    reason: input.reason,
    metadata: {
      erased_record_id: originalRecordId,
      erased_record_path: path,
      content_hash_before: contentHashBefore,
      metadata_hash_before: metadataHashBefore,
      tombstone_id: tombstoneId,
      erased_at: erasedAt,
      legal_basis: input.legal_basis ?? null,
    },
  });

  return {
    erased: true,
    tombstone_id: tombstoneId,
    erased_record_id: originalRecordId ?? undefined,
    content_hash_before: contentHashBefore,
    metadata_hash_before: metadataHashBefore,
  };
}
