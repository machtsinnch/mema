// Layer 3: Judgments — "the heart of Layer 3" (Ardin, 2026-07-10).
//
// A judgment is an iterative craft conclusion: a decision with its
// question, rationale, rejected alternatives and accepted consequences,
// standing on Layer 2 facts. There is no "right answer" to check on the
// internet — a judgment is checked against its CONSTRAINTS (the linked
// facts), and revised when reality moves.
//
// Design decisions (Ardin, 2026-07-10 evening):
//   - Partial reversals: WHOLE-RECORD supersession + a written reason.
//     The reason says which part changed; both records stay readable.
//     The supersession chain IS the design story (arc42/ADR pattern —
//     validated against Arachne ADR-015 → ADR-017).
//   - Living loop: when a new fact touches a judgment's foundations the
//     judgment is FLAGGED for review. mema NEVER rewrites a judgment on
//     its own — a judgment is craft, not calculation.
//   - Created explicitly (API) or via LLM-assisted extraction from
//     decision documents; both paths land here.

import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { ulid } from "ulid";
import { atomicWriteFile } from "./atomic";
import type { CognitiveRecord, SemanticFact } from "./types";
import { toWikilinks, slugify, recordFilename, clampConfidence } from "./types";
import { pathForCognitive } from "./layer3-cognitive";
import { readFact } from "./layer2-semantic";
import { appendAudit } from "./layer6-audit";

export interface JudgmentAlternative {
  option: string;
  reason_rejected: string;
}

export interface JudgmentReviewFlag {
  flagged_at: string;
  fact_id: string;
  because: string;             // plain English: what new evidence arrived
}

export interface Judgment extends CognitiveRecord {
  question: string;            // what was being decided
  decision: string;            // the conclusion itself
  rationale: string;           // the why
  alternatives: JudgmentAlternative[];
  consequences: string[];      // what we knowingly accept
  judgment_status: "proposed" | "accepted" | "superseded";
  iteration: number;
  supersedes?: string[];       // older judgment(s) this one replaces
  supersession_reason?: string; // set on the OLD record when superseded
  watches: string[];           // entity ids + lowercase subjects it stands on
  review_flags?: JudgmentReviewFlag[];
}

export interface RecordJudgmentInput {
  question: string;
  decision: string;
  rationale: string;
  alternatives?: JudgmentAlternative[];
  consequences?: string[];
  /** fact and/or episode IDs the judgment stands on (the backtracking chain) */
  based_on: string[];
  judgment_status?: "proposed" | "accepted";
  iteration?: number;
  confidence?: number;
  actor: string;
  owner: string;
  proposed_by?: string;        // extractor id when LLM-assisted
}

// Foundations to watch: the subject entities (and subject strings) of the
// facts this judgment stands on. New facts about the same subjects flag
// the judgment for review.
function deriveWatches(vaultRoot: string, owner: string, basedOn: string[]): string[] {
  const watches = new Set<string>();
  for (const id of basedOn) {
    const f = readFact(vaultRoot, owner, id);
    if (!f) continue;          // episode IDs land here — episodes aren't watched
    if (f.subject_entity_id) watches.add(f.subject_entity_id);
    if (f.subject) watches.add(f.subject.trim().toLowerCase());
  }
  return [...watches];
}

export function recordJudgment(vaultRoot: string, input: RecordJudgmentInput): Judgment {
  const id = ulid();
  const now = new Date().toISOString();
  const record: Judgment = {
    id,
    kind: "judgment",
    belief_kind: "judgment",
    content: `${input.decision}\n\nWhy: ${input.rationale}`,
    confidence: clampConfidence(input.confidence ?? 0.9),
    derived_from: [...new Set(input.based_on)],
    reflected_at: now,
    superseded_by: null,
    owner: input.owner,
    question: input.question,
    decision: input.decision,
    rationale: input.rationale,
    alternatives: input.alternatives ?? [],
    consequences: input.consequences ?? [],
    judgment_status: input.judgment_status ?? "accepted",
    iteration: input.iteration ?? 1,
    watches: deriveWatches(vaultRoot, input.owner, input.based_on),
  };

  const dir = join(vaultRoot, "cognitive", input.owner, "judgment");
  mkdirSync(dir, { recursive: true });
  const slug = slugify(`judgment-${input.question.split(/\s+/).slice(0, 8).join(" ")}`, "judgment");
  const file = matter.stringify(record.content, {
    id: record.id,
    slug,
    kind: "judgment",
    belief_kind: "judgment",
    question: record.question,
    decision: record.decision,
    rationale: record.rationale,
    alternatives: record.alternatives,
    consequences: record.consequences,
    judgment_status: record.judgment_status,
    iteration: record.iteration,
    watches: record.watches,
    confidence: record.confidence,
    derived_from: record.derived_from,
    reflected_at: record.reflected_at,
    superseded_by: null,
    owner: record.owner,
    status: "approved",
    ...(input.proposed_by ? { proposed_by: input.proposed_by, proposed_at: now } : {}),
    links: toWikilinks(record.derived_from),
  });
  atomicWriteFile(join(dir, recordFilename(slug, id)), file);

  appendAudit({
    op: "REFLECT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    evidence_chain: record.derived_from,
    reason: `judgment_recorded:${record.judgment_status}`,
  });
  return record;
}

export function readJudgment(vaultRoot: string, owner: string, id: string): Judgment | null {
  const path = pathForCognitive(vaultRoot, owner, id);
  if (!path) return null;
  try {
    const parsed = matter(readFileSync(path, "utf8"));
    if ((parsed.data as Judgment).kind !== "judgment") return null;
    return { ...(parsed.data as Judgment), content: parsed.content.trim() };
  } catch { return null; }
}

export function listJudgments(
  vaultRoot: string,
  owner: string,
  opts: { flagged?: boolean; include_superseded?: boolean } = {},
): Judgment[] {
  const dir = join(vaultRoot, "cognitive", owner, "judgment");
  if (!existsSync(dir)) return [];
  const out: Judgment[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try {
      const parsed = matter(readFileSync(join(dir, f), "utf8"));
      const j = { ...(parsed.data as Judgment), content: parsed.content.trim() };
      if (!opts.include_superseded && j.superseded_by) continue;
      if (opts.flagged && !(j.review_flags?.length)) continue;
      out.push(j);
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => (a.reflected_at < b.reflected_at ? -1 : 1));
}

// Whole-record supersession with a WRITTEN REASON (Ardin's call). The old
// judgment keeps everything and gains superseded_by + the reason; the new
// one gains the supersedes back-link. Nothing is deleted — walking
// supersedes/superseded_by IS reading the design story.
export function supersedeJudgment(
  vaultRoot: string,
  owner: string,
  oldId: string,
  newId: string,
  reason: string,
  actor: string,
): boolean {
  const oldPath = pathForCognitive(vaultRoot, owner, oldId);
  const newPath = pathForCognitive(vaultRoot, owner, newId);
  if (!oldPath || !newPath) return false;

  const oldParsed = matter(readFileSync(oldPath, "utf8"));
  const oldFm = oldParsed.data as Record<string, unknown>;
  if (oldFm.owner !== owner || oldFm.kind !== "judgment") return false;
  oldFm.superseded_by = newId;
  oldFm.judgment_status = "superseded";
  oldFm.supersession_reason = reason;
  atomicWriteFile(oldPath, matter.stringify(oldParsed.content, oldFm));

  const newParsed = matter(readFileSync(newPath, "utf8"));
  const newFm = newParsed.data as Record<string, unknown>;
  if (newFm.owner !== owner || newFm.kind !== "judgment") return false;
  newFm.supersedes = [...new Set([...(newFm.supersedes as string[] ?? []), oldId])];
  const newIter = (oldFm.iteration as number ?? 1) + 1;
  if ((newFm.iteration as number ?? 1) < newIter) newFm.iteration = newIter;
  atomicWriteFile(newPath, matter.stringify(newParsed.content, newFm));

  appendAudit({
    op: "REFLECT",
    actor,
    owner,
    record_ids: [oldId, newId],
    reason: `judgment_superseded:${reason.slice(0, 160)}`,
  });
  return true;
}

// The living loop (Ardin's Terraform→Pulumi story): a new fact whose
// subject is among a judgment's watched foundations flags that judgment
// for review. Called by the API after every fact write. Never modifies
// the judgment's substance — only appends a visible flag.
export function flagJudgmentsForFact(
  vaultRoot: string,
  owner: string,
  fact: Pick<SemanticFact, "id" | "subject" | "predicate" | "object" | "subject_entity_id">,
  actor: string,
): number {
  const dir = join(vaultRoot, "cognitive", owner, "judgment");
  if (!existsSync(dir)) return 0;
  let flagged = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    let parsed: matter.GrayMatterFile<string>;
    try { parsed = matter(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const fm = parsed.data as Record<string, unknown>;
    if (fm.kind !== "judgment" || fm.superseded_by) continue;
    const watches = new Set((fm.watches as string[]) ?? []);
    const hit = (fact.subject_entity_id && watches.has(fact.subject_entity_id))
      || watches.has(fact.subject.trim().toLowerCase());
    if (!hit) continue;
    if ((fm.derived_from as string[] ?? []).includes(fact.id)) continue;   // its own foundation
    const flags = (fm.review_flags as JudgmentReviewFlag[]) ?? [];
    if (flags.some(fl => fl.fact_id === fact.id)) continue;               // already flagged
    flags.push({
      flagged_at: new Date().toISOString(),
      fact_id: fact.id,
      because: `new fact: ${fact.subject} ${fact.predicate} ${fact.object}`,
    });
    fm.review_flags = flags;
    atomicWriteFile(join(dir, f), matter.stringify(parsed.content, fm));
    appendAudit({
      op: "REFLECT",
      actor,
      owner,
      record_ids: [String(fm.id)],
      evidence_chain: [fact.id],
      reason: "judgment_review_flag",
    });
    flagged++;
  }
  return flagged;
}

// After a human reviewed the flags (revised the judgment or decided it
// still stands), clear them. Audit keeps the history.
export function clearJudgmentFlags(
  vaultRoot: string,
  owner: string,
  id: string,
  actor: string,
  resolution: string,
): boolean {
  const path = pathForCognitive(vaultRoot, owner, id);
  if (!path) return false;
  const parsed = matter(readFileSync(path, "utf8"));
  const fm = parsed.data as Record<string, unknown>;
  if (fm.owner !== owner || fm.kind !== "judgment") return false;
  if (!(fm.review_flags as unknown[])?.length) return false;
  fm.review_flags = [];
  atomicWriteFile(path, matter.stringify(parsed.content, fm));
  appendAudit({
    op: "REFLECT",
    actor,
    owner,
    record_ids: [id],
    reason: `judgment_flags_cleared:${resolution.slice(0, 160)}`,
  });
  return true;
}
