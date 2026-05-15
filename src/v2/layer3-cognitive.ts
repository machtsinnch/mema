// Layer 3: Cognitive — experiences, observations, beliefs the agent holds.
// Inspired by Hindsight's epistemic separation. Records here are derived from
// L1 episodes and/or L2 facts via *reflection* (which can be triggered manually
// or scheduled, never on every write).
//
// v2.0: caller-driven reflection. Pass derived_from IDs and a content summary.
// v2.1: spawn a reflection agent that synthesizes cognitive records from new
//       episodes nightly.

import { ulid } from "ulid";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { CognitiveRecord, CognitiveKind } from "./types";
import { clampConfidence } from "./types";
import { appendAudit } from "./layer6-audit";

export interface RecordCognitiveInput {
  kind: CognitiveKind;
  content: string;
  confidence: number;
  derived_from: string[];      // episode or fact IDs
  actor: string;
  owner: string;
}

export function recordCognitive(vaultRoot: string, input: RecordCognitiveInput): CognitiveRecord {
  const id = ulid();
  const record: CognitiveRecord = {
    id,
    kind: input.kind,
    content: input.content,
    confidence: clampConfidence(input.confidence),
    derived_from: input.derived_from,
    reflected_at: new Date().toISOString(),
    superseded_by: null,
    owner: input.owner,
  };

  const dir = join(vaultRoot, "cognitive", input.owner, input.kind);
  mkdirSync(dir, { recursive: true });
  const body = record.content;
  const file = matter.stringify(body, {
    id: record.id,
    kind: record.kind,
    confidence: record.confidence,
    derived_from: record.derived_from,
    reflected_at: record.reflected_at,
    superseded_by: record.superseded_by,
    owner: record.owner,
  });
  writeFileSync(join(dir, `${id}.md`), file, "utf8");

  appendAudit({
    op: "REFLECT",
    actor: input.actor,
    owner: input.owner,
    record_ids: [id],
    evidence_chain: input.derived_from,
  });

  return record;
}

// Soft-supersede an older belief with a newer one. The old record stays in the
// vault (audit trail), just points to its successor and stops being authoritative.
export function supersedeBelief(
  vaultRoot: string,
  oldId: string,
  newId: string,
  owner: string,
  actor: string,
): CognitiveRecord | null {
  for (const kind of ["belief", "observation", "experience"] as const) {
    const path = join(vaultRoot, "cognitive", owner, kind, `${oldId}.md`);
    if (!existsSync(path)) continue;
    const parsed = matter(readFileSync(path, "utf8"));
    parsed.data.superseded_by = newId;
    writeFileSync(path, matter.stringify(parsed.content, parsed.data), "utf8");
    appendAudit({
      op: "REFLECT",
      actor,
      owner,
      record_ids: [oldId, newId],
      reason: "superseded",
    });
    return parsed.data as CognitiveRecord;
  }
  return null;
}
