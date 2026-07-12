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
  // v2.19.2 — two-stage flagging (Ardin's call): structural watch writes a
  // "candidate"; a model relevance check promotes it to "relevant" or
  // removes it. Missing status (pre-v2.19.2 flags) = candidate.
  status?: "candidate" | "relevant";
  screen_reason?: string;
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
    let f: SemanticFact | null = null;
    try {
      f = readFact(vaultRoot, owner, id);
    } catch {
      continue;                // malformed foundation file — treat like a missing one
    }
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
  // v2.22.0 SECURITY parity (mirrors observe()/recordCognitive): a decision
  // that begins with a "---" YAML fence made gray-matter MERGE that fence
  // into our frontmatter and DROP it from the stored body. Guard: a leading
  // newline keeps the fence in the body; judgment readers .trim() it back off.
  const body = /^\s*---/.test(record.content) ? "\n" + record.content : record.content;
  const file = matter.stringify(body, {
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

  // v2.21.1 — breaker finding: validate the NEW record BEFORE mutating
  // the old one. The previous order half-wrote the old file when the new
  // id was invalid (e.g. a belief id), bricking the judgment with no
  // audit row and no recovery path. Also refuse a superseded record as
  // the superseder — that closed the A↔B cycle that emptied the active
  // list and made chain walkers loop forever.
  const newParsed = matter(readFileSync(newPath, "utf8"));
  const newFm = newParsed.data as Record<string, unknown>;
  if (newFm.owner !== owner || newFm.kind !== "judgment") return false;
  if (newFm.superseded_by) return false;

  const oldParsed = matter(readFileSync(oldPath, "utf8"));
  const oldFm = oldParsed.data as Record<string, unknown>;
  if (oldFm.owner !== owner || oldFm.kind !== "judgment") return false;
  // v2.21.0 — general-review fix: re-superseding an already-superseded
  // judgment would overwrite the original written reason and fork the
  // chain into two live heads. The chain is the design story — refuse.
  if (oldFm.superseded_by) return false;
  if (oldId === newId) return false;
  oldFm.superseded_by = newId;
  oldFm.judgment_status = "superseded";
  oldFm.supersession_reason = reason;
  atomicWriteFile(oldPath, matter.stringify(oldParsed.content, oldFm));
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
      status: "candidate",
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

// v2.19.2 — the relevance gate (Ardin, 2026-07-10): candidates from the
// wide structural net are screened per judgment by ONE model call; facts
// that bear on the decision become "relevant" flags, the rest are
// removed with the screener's reason in the audit log. Injectable
// screener keeps tests deterministic.
import type { FlagCandidate, FlagVerdict, JudgmentSummary } from "./llm-flag-screener";
import { screenFlagsWithCLI } from "./llm-flag-screener";

export interface ScreenResult {
  judgments_screened: number;
  kept: number;
  dropped: number;
  errors: Array<{ judgment_id: string; error: string }>;
  // v2.21.0 — which flags the screener removed and why (also audited).
  dropped_flags: Array<{ judgment_id: string; fact_id: string; reason: string }>;
}

// v2.22.4 — flag screening is an INDEPENDENT job type from web fact-checking.
// It is a plain relevance model call (no web-search quota spend), so it must
// NOT share the MEMA_FACTCHECK_AUTO switch: an operator turning web
// fact-checking off to save quota was silently disabling judgment flag
// screening entirely, stranding every candidate flag on its judgment forever
// and never writing the "dropped with reason" audit rows. On by default; off
// under `bun test` (no hidden model calls in tests) unless explicitly forced;
// MEMA_FLAG_SCREEN_AUTO=false turns it off anywhere.
export function flagScreenAutoEnabled(): boolean {
  const flag = process.env.MEMA_FLAG_SCREEN_AUTO;
  if (flag === "false") return false;
  if (flag === "true") return true;
  return process.env.NODE_ENV !== "test";
}

export async function screenJudgmentCandidates(
  vaultRoot: string,
  owner: string,
  actor: string,
  opts: {
    limit?: number;
    screener?: (j: JudgmentSummary, c: FlagCandidate[]) => Promise<FlagVerdict[]>;
  } = {},
): Promise<ScreenResult> {
  const limit = opts.limit ?? 5;
  const screener = opts.screener ?? screenFlagsWithCLI;
  const out: ScreenResult = { judgments_screened: 0, kept: 0, dropped: 0, errors: [], dropped_flags: [] };
  const dir = join(vaultRoot, "cognitive", owner, "judgment");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (out.judgments_screened >= limit) break;
    if (!f.endsWith(".md")) continue;
    let parsed: matter.GrayMatterFile<string>;
    try { parsed = matter(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const fm = parsed.data as Record<string, unknown>;
    if (fm.kind !== "judgment" || fm.superseded_by) continue;
    const flags = (fm.review_flags as JudgmentReviewFlag[]) ?? [];
    const candidates = flags.filter(fl => (fl.status ?? "candidate") === "candidate");
    if (candidates.length === 0) continue;

    out.judgments_screened++;
    let verdicts: FlagVerdict[];
    try {
      verdicts = await screener(
        {
          question: String(fm.question ?? ""),
          decision: String(fm.decision ?? ""),
          rationale: String(fm.rationale ?? ""),
        },
        candidates.map(c => ({ fact_id: c.fact_id, because: c.because })),
      );
    } catch (e) {
      out.errors.push({ judgment_id: String(fm.id), error: (e as Error).message });
      continue;
    }
    // v2.21.0 — CRITICAL general-review fix: re-read the file AFTER the
    // model call. Flags appended during the await (fact writes are not
    // blocked by screening) must survive; verdicts apply only to the
    // candidates THIS run screened. There is no await between this
    // re-read and the write, so in-process interleaving cannot occur
    // (single-threaded event loop); cross-process runs stay best-effort.
    let fresh: ReturnType<typeof matter>;
    try { fresh = matter(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    const freshFm = fresh.data as Record<string, unknown>;
    if (freshFm.superseded_by) continue;
    const freshFlags = (freshFm.review_flags as JudgmentReviewFlag[]) ?? [];
    const byId = new Map(verdicts.map(v => [v.fact_id, v]));
    const screenedIds = new Set(candidates.map(c => c.fact_id));
    const next: JudgmentReviewFlag[] = [];
    const droppedDetails: Array<{ fact_id: string; reason: string }> = [];
    let kept = 0, dropped = 0;
    for (const fl of freshFlags) {
      if ((fl.status ?? "candidate") !== "candidate" || !screenedIds.has(fl.fact_id)) {
        next.push(fl);                               // untouched: already screened OR arrived mid-await
        continue;
      }
      const v = byId.get(fl.fact_id);
      if (!v) { next.push(fl); continue; }          // no verdict → stays candidate, retried next run
      if (v.relevant) {
        next.push({ ...fl, status: "relevant", screen_reason: v.reason });
        kept++;
      } else {
        dropped++;
        droppedDetails.push({ fact_id: fl.fact_id, reason: v.reason });
      }
    }
    freshFm.review_flags = next;
    atomicWriteFile(join(dir, f), matter.stringify(fresh.content, freshFm));
    // v2.21.0 — general-review fix: dropped flags are audited PER FACT
    // (id in the evidence chain, screener reason in the reason string) —
    // a removed review signal must stay discoverable.
    appendAudit({
      op: "REFLECT",
      actor,
      owner,
      record_ids: [String(freshFm.id)],
      evidence_chain: droppedDetails.map(d => d.fact_id),
      reason: `judgment_flags_screened:kept=${kept},dropped=${dropped}`
        + (droppedDetails.length
          ? `;${droppedDetails.map(d => `${d.fact_id}=${d.reason}`).join("|")}`.slice(0, 900)
          : ""),
    });
    out.kept += kept;
    out.dropped += dropped;
    out.dropped_flags.push(...droppedDetails.map(d => ({ judgment_id: String(freshFm.id), ...d })));
  }
  return out;
}
