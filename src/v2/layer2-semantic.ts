// Layer 2: Temporal Semantic — facts extracted from episodes with bi-temporal validity.
// Inspired by Zep/Graphiti's bi-temporal model. Facts have:
//   valid_from / valid_to  : when the fact is/was true in the world
//   invalidated_at         : when WE learned the fact was wrong (epistemic)
//   superseded_by          : newer fact that replaces this one
//
// v2.0 is caller-supplied (no auto-extraction). v2.1 will add LLM extraction in
// a SEPARATE ingestion pipeline (NOT on every write — principle preserved).

import { ulid } from "ulid";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { SemanticFact, RecordStatus } from "./types";
import { clampConfidence, toWikilinks, slugify, recordFilename, idFromFilename } from "./types";
import { appendAudit } from "./layer6-audit";

export interface RecordFactInput {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;         // defaults to now
  valid_to?: string | null;
  derived_from: string[];      // episode IDs
  confidence?: number;
  actor: string;
  owner: string;
  // v2.7+ acceptance lifecycle. Omitting status defaults to "approved" so
  // existing direct-API callers keep their current semantics. LLM extractors
  // and other untrusted producers should pass "draft" + evidence_excerpt.
  status?: RecordStatus;
  evidence_excerpt?: string;
  proposed_by?: string;
}

export function recordFact(vaultRoot: string, input: RecordFactInput): SemanticFact {
  const id = ulid();
  const now = new Date().toISOString();
  const status: RecordStatus = input.status ?? "approved";
  const fact: SemanticFact = {
    id,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    valid_from: input.valid_from ?? now,
    valid_to: input.valid_to ?? null,
    invalidated_at: null,
    superseded_by: null,
    derived_from: input.derived_from,
    confidence: clampConfidence(input.confidence ?? 0.8),
    owner: input.owner,
    status,
    ...(input.evidence_excerpt ? { evidence_excerpt: input.evidence_excerpt.slice(0, 500) } : {}),
    ...(input.proposed_by ? { proposed_by: input.proposed_by, proposed_at: now } : {}),
  };

  const dir = join(vaultRoot, "facts", input.owner);
  mkdirSync(dir, { recursive: true });
  const body = `# ${fact.subject} ${fact.predicate} ${fact.object}\n\nFact derived from ${fact.derived_from.length} episode(s).`;
  // Obsidian graph: wikilinks for every supporting episode + supersession edge.
  // toWikilinks validates and dedupes — caller errors (dup IDs in derived_from)
  // don't propagate to disk.
  const links = toWikilinks([
    ...fact.derived_from,
    ...(fact.superseded_by ? [fact.superseded_by] : []),
  ]);
  // Readable filename: `{subject}-{predicate}-{object}--{ulid}.md`
  const slug = slugify(`${fact.subject}-${fact.predicate}-${fact.object}`, "fact");
  const file = matter.stringify(body, {
    id: fact.id,
    slug,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    valid_from: fact.valid_from,
    valid_to: fact.valid_to,
    invalidated_at: fact.invalidated_at,
    superseded_by: fact.superseded_by,
    derived_from: fact.derived_from,
    confidence: fact.confidence,
    owner: fact.owner,
    status: fact.status,
    ...(fact.evidence_excerpt ? { evidence_excerpt: fact.evidence_excerpt } : {}),
    ...(fact.proposed_by ? { proposed_by: fact.proposed_by, proposed_at: fact.proposed_at } : {}),
    links,
  });
  writeFileSync(join(dir, recordFilename(slug, id)), file, "utf8");

  // Audit op: PROPOSE for drafts (untrusted), EXTRACT for approved (direct writes).
  appendAudit({
    op: status === "draft" ? "PROPOSE" : "EXTRACT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    evidence_chain: input.derived_from,
    ...(input.proposed_by ? { reason: `proposed_by:${input.proposed_by}` } : {}),
  });

  return fact;
}

// v2.7+ acceptance lifecycle — approve a draft fact, promoting it to
// "approved" so it surfaces in retrieval. The actor and reason are
// recorded both on the record and in the audit chain.
export function approveFact(
  vaultRoot: string,
  factId: string,
  owner: string,
  actor: string,
  reason?: string,
): SemanticFact | null {
  const path = factPath(vaultRoot, owner, factId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  // Idempotent: re-approving an approved record is a no-op + no audit churn.
  if (fm.status === "approved") return fm as SemanticFact;
  fm.status = "approved";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  if (reason) fm.review_reason = reason;
  writeFileSync(path, matter.stringify(parsed.content, fm), "utf8");
  appendAudit({
    op: "APPROVE",
    actor,
    owner,
    record_ids: [factId],
    evidence_chain: (fm.derived_from ?? []) as string[],
    reason,
  });
  return fm as SemanticFact;
}

// v2.7+ acceptance lifecycle — reject a draft fact. Sets status="rejected"
// and records the reviewer + reason. Rejected records remain on disk for
// audit, but retrieval excludes them.
export function rejectFact(
  vaultRoot: string,
  factId: string,
  owner: string,
  actor: string,
  reason: string,
): SemanticFact | null {
  const path = factPath(vaultRoot, owner, factId);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as any;
  if (fm.owner !== owner) return null;
  if (fm.status === "rejected") return fm as SemanticFact;
  fm.status = "rejected";
  fm.reviewed_by = actor;
  fm.reviewed_at = new Date().toISOString();
  fm.review_reason = reason;
  writeFileSync(path, matter.stringify(parsed.content, fm), "utf8");
  appendAudit({
    op: "REJECT",
    actor,
    owner,
    record_ids: [factId],
    evidence_chain: (fm.derived_from ?? []) as string[],
    reason,
  });
  return fm as SemanticFact;
}

// Mark a fact as invalidated (we now know it was wrong, or it's no longer true).
// Optionally point to the fact that supersedes it.
// Find a fact file path by ULID; tolerates legacy ULID-only filenames AND
// the new slug--ulid filenames. Exported so tests + asset/erase callers
// can find the file without knowing the naming schema.
export function pathForFact(vaultRoot: string, owner: string, id: string): string | null {
  return factPath(vaultRoot, owner, id);
}
function factPath(vaultRoot: string, owner: string, id: string): string | null {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return null;
  const legacy = join(dir, `${id}.md`);
  if (existsSync(legacy)) return legacy;
  for (const f of readdirSync(dir)) {
    if (idFromFilename(f) === id) return join(dir, f);
  }
  return null;
}

export function invalidateFact(
  vaultRoot: string,
  factId: string,
  owner: string,
  actor: string,
  supersededBy?: string,
): SemanticFact | null {
  const path = factPath(vaultRoot, owner, factId);
  if (!path) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  parsed.data.invalidated_at = new Date().toISOString();
  if (supersededBy) parsed.data.superseded_by = supersededBy;
  // Rebuild Obsidian links to include the new supersession edge.
  parsed.data.links = toWikilinks([
    ...((parsed.data.derived_from ?? []) as string[]),
    ...(parsed.data.superseded_by ? [parsed.data.superseded_by] : []),
  ]);
  writeFileSync(path, matter.stringify(parsed.content, parsed.data), "utf8");
  appendAudit({
    op: "INVALIDATE",
    actor,
    owner,
    record_ids: [factId],
    evidence_chain: supersededBy ? [supersededBy] : undefined,
  });
  return readFact(vaultRoot, owner, factId);
}

export function readFact(vaultRoot: string, owner: string, id: string): SemanticFact | null {
  const path = factPath(vaultRoot, owner, id);
  if (!path) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  return parsed.data as SemanticFact;
}

// Get all facts for an owner that were valid at a given point in time.
// Skips facts invalidated before `at`, or whose valid_to is before `at`.
// v2.7+: skips drafts and rejected records unless includeDrafts is true.
export function getFactsValidAt(
  vaultRoot: string,
  owner: string,
  at: string,
  includeDrafts = false,
): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      // Acceptance lifecycle filter. Missing status = approved (back-compat).
      const status = fact.status ?? "approved";
      if (status === "rejected") continue;
      if (status === "draft" && !includeDrafts) continue;
      if (fact.valid_from > at) continue;
      if (fact.valid_to && fact.valid_to < at) continue;
      // <= : if invalidated AT the query timestamp, we already knew it was wrong
      if (fact.invalidated_at && fact.invalidated_at <= at) continue;
      out.push(fact);
    } catch { /* skip malformed */ }
  }
  return out;
}

// v2.7+ list all draft facts for an owner (used by review CLI + endpoints).
export function listDraftFacts(vaultRoot: string, owner: string): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      if (parsed.data.status === "draft") out.push(parsed.data as SemanticFact);
    } catch { /* skip malformed */ }
  }
  return out;
}

// v2.7+ evidence check: does the proposed fact's subject AND object actually
// appear (case-insensitive substring) in the source episode body? This is
// a structural guard against LLM hallucination. Subjects and objects can be
// multiword entities like "machtsinn AG" — substring match is the right shape.
// Returns {ok: true} when both terms appear; {ok: false, missing} otherwise.
export function evidenceCheck(
  subject: string,
  object: string,
  episodeBody: string,
): { ok: true } | { ok: false; missing: string[] } {
  const haystack = episodeBody.toLowerCase();
  const missing: string[] = [];
  const s = subject.trim().toLowerCase();
  const o = object.trim().toLowerCase();
  if (s && !haystack.includes(s)) missing.push("subject");
  if (o && !haystack.includes(o)) missing.push("object");
  return missing.length ? { ok: false, missing } : { ok: true };
}
