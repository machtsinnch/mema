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
import type { SemanticFact } from "./types";
import { clampConfidence } from "./types";
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
}

export function recordFact(vaultRoot: string, input: RecordFactInput): SemanticFact {
  const id = ulid();
  const now = new Date().toISOString();
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
  };

  const dir = join(vaultRoot, "facts", input.owner);
  mkdirSync(dir, { recursive: true });
  const body = `# ${fact.subject} ${fact.predicate} ${fact.object}\n\nFact derived from ${fact.derived_from.length} episode(s).`;
  const file = matter.stringify(body, {
    id: fact.id,
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
  });
  writeFileSync(join(dir, `${id}.md`), file, "utf8");

  appendAudit({
    op: "EXTRACT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    evidence_chain: input.derived_from,
  });

  return fact;
}

// Mark a fact as invalidated (we now know it was wrong, or it's no longer true).
// Optionally point to the fact that supersedes it.
export function invalidateFact(
  vaultRoot: string,
  factId: string,
  owner: string,
  actor: string,
  supersededBy?: string,
): SemanticFact | null {
  const path = join(vaultRoot, "facts", owner, `${factId}.md`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  parsed.data.invalidated_at = new Date().toISOString();
  if (supersededBy) parsed.data.superseded_by = supersededBy;
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
  const path = join(vaultRoot, "facts", owner, `${id}.md`);
  if (!existsSync(path)) return null;
  const parsed = matter(readFileSync(path, "utf8"));
  return parsed.data as SemanticFact;
}

// Get all facts for an owner that were valid at a given point in time.
// Skips facts invalidated before `at`, or whose valid_to is before `at`.
export function getFactsValidAt(vaultRoot: string, owner: string, at: string): SemanticFact[] {
  const dir = join(vaultRoot, "facts", owner);
  if (!existsSync(dir)) return [];
  const out: SemanticFact[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const fact = parsed.data as SemanticFact;
      if (fact.valid_from > at) continue;
      if (fact.valid_to && fact.valid_to < at) continue;
      // <= : if invalidated AT the query timestamp, we already knew it was wrong
      if (fact.invalidated_at && fact.invalidated_at <= at) continue;
      out.push(fact);
    } catch { /* skip malformed */ }
  }
  return out;
}
