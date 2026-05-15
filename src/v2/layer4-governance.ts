// Layer 4: Governance — purpose limitation, provenance, retention, access policy,
// hard erasure. This is the trust moat for Swiss/EU enterprise.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
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

// Policy decision: is this actor allowed to recall this record for this purpose?
export interface PolicyContext {
  actor: string;
  purpose: string;
  now?: string;                // for testability
}

export function policyCheck(
  governance: Governance | undefined,
  ctx: PolicyContext,
): { allowed: boolean; reason: string } {
  if (!governance) return { allowed: true, reason: "no_governance_block" };  // v1 legacy records
  const now = ctx.now ?? new Date().toISOString();

  // 1. Retention check — has the record expired?
  if (governance.retention_until && governance.retention_until < now) {
    return { allowed: false, reason: "retention_expired" };
  }
  // 2. Purpose match — is the recall purpose in the allowed list?
  if (governance.purpose.length > 0 && !governance.purpose.includes(ctx.purpose)) {
    return { allowed: false, reason: `purpose_not_allowed (requested=${ctx.purpose})` };
  }
  // 3. Allowed actors — if set, is the recalling actor on the list?
  if (governance.allowed_actors && governance.allowed_actors.length > 0) {
    if (!governance.allowed_actors.includes(ctx.actor)) {
      return { allowed: false, reason: "actor_not_in_allowlist" };
    }
  }
  return { allowed: true, reason: "policy_pass" };
}

// HARD ERASE — overwrite the file content with a tombstone, keep audit entry.
// Distinct from v1's soft "forget" (which just flips a flag).
// Required for GDPR/nFADP DSAR erasure requests.
export interface HardEraseInput {
  vaultRoot: string;
  owner: string;
  record_path: string;         // relative or absolute path into the vault
  actor: string;
  reason: string;
}

export function hardErase(input: HardEraseInput): { erased: boolean; tombstone_id?: string } {
  const path = input.record_path.startsWith("/")
    ? input.record_path
    : join(input.vaultRoot, input.record_path);
  if (!existsSync(path)) return { erased: false };

  const tombstoneId = `tomb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const tombstone = matter.stringify(
    `# ERASED\n\nThis record was hard-erased on ${new Date().toISOString()}.\nReason: ${input.reason}\nActor: ${input.actor}\nTombstone ID: ${tombstoneId}\n\nOriginal content destroyed. See audit log entry for provenance.`,
    {
      tombstone: true,
      tombstone_id: tombstoneId,
      erased_at: new Date().toISOString(),
      erased_by: input.actor,
      reason: input.reason,
      owner: input.owner,
    },
  );
  writeFileSync(path, tombstone, "utf8");

  appendAudit({
    op: "ERASE",
    actor: input.actor,
    owner: input.owner,
    record_ids: [tombstoneId],
    reason: input.reason,
  });

  return { erased: true, tombstone_id: tombstoneId };
}
