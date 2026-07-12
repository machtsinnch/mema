// v2.21.0 — regression tests for the general-review fixes (2026-07-12).
// Each test reproduces a CONFIRMED finding's failure scenario and proves
// the fix. Finding numbers refer to research/2026-07-12-general-review-findings.json.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import {
  recordFact, recordFactWithSupersession, readFact, approveFact, rejectFact,
  invalidateFact, pathForFact, mergeFactProvenance,
} from "../../src/v2/layer2-semantic";
import { classifyOnWrite } from "../../src/v2/layer4-supersession";
import { createEntity } from "../../src/v2/layer2-entities";
import { observe } from "../../src/v2/layer1-episodic";
import { reflect } from "../../src/v2/layer3-reflection";
import {
  recordJudgment, readJudgment, supersedeJudgment, flagJudgmentsForFact, screenJudgmentCandidates,
} from "../../src/v2/layer3-judgment";
import { mergeExtractionResults, evidencePassesGate } from "../../src/v2/llm-extractor";
import type { SemanticFact } from "../../src/v2/types";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2210-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

describe("CRITICAL: drafts never supersede approved facts", () => {
  test("a draft update leaves the approved fact untouched; rejection changes nothing", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const approved = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Google", valid_from: "2020-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    }).written!;

    const draft = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Anthropic", valid_from: "2026-01",
      derived_from: [ep.id], actor: "evil-llm", owner: "o", status: "draft",
    });
    expect(draft.decision).toMatchObject({ kind: "ADD", reason: "draft_supersession_deferred_to_approval" });
    expect(draft.supersededIds).toEqual([]);
    // The approved fact is untouched.
    const g = readFact(vault, "o", approved.id)!;
    expect(g.invalidated_at ?? null).toBeNull();
    expect(g.superseded_by ?? null).toBeNull();

    // Rejecting the draft also changes nothing.
    rejectFact(vault, draft.written!.id, "o", "reviewer", "hallucinated");
    const g2 = readFact(vault, "o", approved.id)!;
    expect(g2.invalidated_at ?? null).toBeNull();
    rmSync(vault, { recursive: true, force: true });
  });

  test("APPROVING a draft runs the deferred supersession", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const approved = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Google", valid_from: "2020-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    }).written!;
    const draft = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Anthropic", valid_from: "2026-01",
      derived_from: [ep.id], actor: "llm", owner: "o", status: "draft",
    }).written!;

    approveFact(vault, draft.id, "o", "reviewer");
    const oldFact = readFact(vault, "o", approved.id)!;
    expect(oldFact.superseded_by).toBe(draft.id);
    expect(oldFact.invalidated_at).toBeTruthy();
    expect(readFact(vault, "o", draft.id)!.status).toBe("approved");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("CRITICAL: screening cannot clobber flags added during the model call", () => {
  test("a flag appended mid-screen survives; verdicts still apply to screened candidates", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "a", owner: "o" });
    const f1 = recordFact(vault, { subject: "Pulumi", predicate: "supports", object: "TypeScript", derived_from: [ep.id], actor: "a", owner: "o" });
    const j = recordJudgment(vault, {
      question: "Which tool?", decision: "Use Pulumi", rationale: "fits",
      based_on: [f1.id], actor: "a", owner: "o",
    });
    const fA = recordFact(vault, { subject: "Pulumi", predicate: "lacks", object: "native testing", derived_from: [ep.id], actor: "a", owner: "o" });
    flagJudgmentsForFact(vault, "o", fA, "a");

    // Screener that simulates the race: while it "thinks", a new fact
    // arrives and flags the same judgment.
    const fB = recordFact(vault, { subject: "Pulumi", predicate: "drops", object: "YAML support", derived_from: [ep.id], actor: "a", owner: "o" });
    const r = await screenJudgmentCandidates(vault, "o", "a", {
      screener: async (_j, cands) => {
        flagJudgmentsForFact(vault, "o", fB, "a");   // happens during the await
        return cands.map(c => ({ fact_id: c.fact_id, relevant: true, reason: "capability change" }));
      },
    });
    expect(r.kept).toBe(1);
    const after = readJudgment(vault, "o", j.id)!;
    const ids = (after.review_flags ?? []).map(fl => fl.fact_id).sort();
    // BOTH survive: fA screened to relevant, fB still a candidate.
    expect(ids).toEqual([fA.id, fB.id].sort());
    expect(after.review_flags!.find(fl => fl.fact_id === fA.id)!.status).toBe("relevant");
    expect(after.review_flags!.find(fl => fl.fact_id === fB.id)!.status).toBe("candidate");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("mixed date formats no longer decide supersession", () => {
  const fact = (id: string, object: string, valid_from: string): SemanticFact => ({
    id, subject: "Mara", predicate: "works_at", object, valid_from,
    valid_to: null, invalidated_at: null, superseded_by: null,
    derived_from: [], confidence: 0.9, owner: "o", status: "approved",
  });
  const NEW = (object: string, event_date: string) =>
    ({ subject: "Mara", predicate: "works_at", object, event_date });

  test("dated new fact supersedes a same-day full-timestamp fact (was ADD)", () => {
    const d = classifyOnWrite(NEW("Anthropic", "2026-07-12"), [fact("f1", "Google", "2026-07-12T07:38:10Z")], "person");
    expect(d.kind).toBe("UPDATE");
  });
  test("full-timestamp new fact still supersedes a same-day dated fact", () => {
    const d = classifyOnWrite(NEW("Anthropic", "2026-07-12T09:00:00Z"), [fact("f1", "Google", "2026-07-12")], "person");
    expect(d.kind).toBe("UPDATE");
  });
  test("two dated facts on the same day: no guess, ADD", () => {
    const d = classifyOnWrite(NEW("Anthropic", "2026-07-12"), [fact("f1", "Google", "2026-07-12")], "person");
    expect(d.kind).toBe("ADD");
  });
  test("v2.14.1 regression: both full timestamps same day, later wins", () => {
    const d = classifyOnWrite(NEW("Anthropic", "2026-07-12T09:00:00Z"), [fact("f1", "Google", "2026-07-12T07:38:10Z")], "person");
    expect(d.kind).toBe("UPDATE");
  });
  test("closed facts (valid_to passed) are never superseded", () => {
    const closed = { ...fact("f1", "Google", "2020-01-01"), valid_to: "2023-05-31" };
    const d = classifyOnWrite(NEW("Anthropic", "2026-01-01"), [closed], "person");
    expect(d.kind).toBe("ADD");
  });
});

describe("duplicate skip keeps provenance", () => {
  test("second document's episode lands on the surviving fact; corroboration becomes reachable", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    const first = recordFactWithSupersession(vault, {
      subject: "TSMC", predicate: "supplies", object: "Nvidia", valid_from: "2024-01",
      derived_from: [ep1.id], actor: "t", owner: "o",
    }).written!;
    const dup = recordFactWithSupersession(vault, {
      subject: "TSMC", predicate: "supplies", object: "Nvidia", valid_from: "2024-01",
      derived_from: [ep2.id], actor: "t", owner: "o",
    });
    expect(dup.written).toBeNull();
    const survivor = readFact(vault, "o", first.id)!;
    expect([...survivor.derived_from].sort()).toEqual([ep1.id, ep2.id].sort());
    // Rule A can now see 2 independent sources for the world claim.
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r.world_claims).toHaveLength(1);
    expect(r.world_claims![0].sources).toBe(2);
    rmSync(vault, { recursive: true, force: true });
  });

  test("mergeFactProvenance is idempotent", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const f = recordFact(vault, { subject: "A", predicate: "uses", object: "B", derived_from: [ep.id], actor: "t", owner: "o" });
    expect(mergeFactProvenance(vault, "o", f.id, [ep.id])).toBe(false);
    expect(mergeFactProvenance(vault, "o", f.id, ["01NEWEP"])).toBe(true);
    expect(mergeFactProvenance(vault, "o", f.id, ["01NEWEP"])).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("judgment chain cannot be forked or overwritten", () => {
  test("re-superseding an already-superseded judgment is refused; original reason survives", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "a", owner: "o" });
    const f = recordFact(vault, { subject: "X", predicate: "uses", object: "Y", derived_from: [ep.id], actor: "a", owner: "o" });
    const j1 = recordJudgment(vault, { question: "q", decision: "d1", rationale: "r", based_on: [f.id], actor: "a", owner: "o" });
    const j2 = recordJudgment(vault, { question: "q", decision: "d2", rationale: "r", based_on: [f.id], actor: "a", owner: "o" });
    const j3 = recordJudgment(vault, { question: "q", decision: "d3", rationale: "r", based_on: [f.id], actor: "a", owner: "o" });
    expect(supersedeJudgment(vault, "o", j1.id, j2.id, "original reason", "a")).toBe(true);
    expect(supersedeJudgment(vault, "o", j1.id, j3.id, "usurper reason", "a")).toBe(false);
    expect(supersedeJudgment(vault, "o", j3.id, j3.id, "self", "a")).toBe(false);
    const old = readJudgment(vault, "o", j1.id)!;
    expect(old.superseded_by).toBe(j2.id);
    expect(old.supersession_reason).toBe("original reason");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("evidence gate: stopwords and word boundaries", () => {
  const SRC = "The quarterly report was published on the internal site. The Board planning session is in May.";
  test("common-word sides no longer sneak through", () => {
    expect(evidencePassesGate(
      { subject: "The Board", predicate: "approved", object: "the acquisition plan",
        object_: undefined as never, confidence: 0.9,
        evidence: "The quarterly report was published on the internal site." } as never,
      SRC,
    )).toBe(false);
  });
  test("'plan' does not match 'planning'", () => {
    expect(evidencePassesGate(
      { subject: "The Board", predicate: "runs", object: "plan", confidence: 0.9,
        evidence: "The Board planning session is in May." } as never,
      SRC,
    )).toBe(false);
  });
  test("legitimate rescue still passes", () => {
    expect(evidencePassesGate(
      { subject: "quarterly report", predicate: "published_on", object: "internal site", confidence: 0.9,
        evidence: "The quarterly report was published on the internal site." } as never,
      SRC,
    )).toBe(true);
  });
});

describe("superseded facts keep their entity links", () => {
  test("invalidateFact rebuilds links including entity ids", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const marcel = createEntity(vault, { name: "Marcel", type: "person", actor: "t", owner: "o" });
    const f = recordFact(vault, {
      subject: "Marcel", predicate: "works_at", object: "Google",
      subject_entity_id: marcel.id, derived_from: [ep.id], actor: "t", owner: "o",
    });
    invalidateFact(vault, f.id, "o", "t", "01SOMENEWFACT");
    const raw = matter(readFileSync(pathForFact(vault, "o", f.id)!, "utf8"));
    expect(String(raw.data.links)).toContain(marcel.id);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("cross-chunk dedup keeps the strongest copy", () => {
  test("3/3 majority beats an earlier evidence-rescued 1/3", () => {
    const weak = { subject: "mema", predicate: "built_on", object: "Bun", confidence: 0.6, votes: 1, passes: 3, evidence_verified: true };
    const strong = { subject: "mema", predicate: "built_on", object: "Bun", confidence: 0.95, votes: 3, passes: 3 };
    const merged = mergeExtractionResults([
      { facts: [weak], entities: [] },
      { facts: [strong], entities: [] },
    ]);
    expect(merged.facts).toHaveLength(1);
    expect(merged.facts[0].votes).toBe(3);
    expect(merged.facts[0].confidence).toBe(0.95);
    rmSync; // no vault used
  });
});

describe("reflection grouping bridges linked and unlinked facts", () => {
  test("a fact ingested before its entity existed still counts toward the same claim", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "ardin", owner: "ardin-pai" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "ardin", owner: "ardin-pai" });
    // Fact 1 BEFORE the entity exists: unlinked.
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [ep1.id], actor: "ardin", owner: "ardin-pai" });
    // Entity appears; fact 2 is linked.
    const ent = createEntity(vault, { name: "ardin.me", type: "system", actor: "ardin", owner: "ardin-pai" });
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", subject_entity_id: ent.id, derived_from: [ep2.id], actor: "ardin", owner: "ardin-pai" });

    const r = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    // One group, two sources -> one personal belief (subject is owner-world).
    expect(r.cognitive_records_created).toBe(1);
    expect(r.records[0].content).toContain("2 documents");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("growing corroboration updates the belief in place", () => {
  test("2 -> 3 documents refreshes support instead of superseding", () => {
    const vault = fresh();
    const eps = [1, 2, 3].map(i => observe(vault, { kind: "document", content: `d${i}`, actor: "ardin", owner: "ardin-pai" }));
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [eps[0].id], actor: "ardin", owner: "ardin-pai" });
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [eps[1].id], actor: "ardin", owner: "ardin-pai" });
    const r1 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r1.cognitive_records_created).toBe(1);

    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [eps[2].id], actor: "ardin", owner: "ardin-pai" });
    const r2 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r2.cognitive_records_created).toBe(0);   // no superseding copy
    expect(r2.updated).toBe(1);                     // refreshed in place
    expect(r2.records[0].content).toContain("3 documents");
    rmSync(vault, { recursive: true, force: true });
  });
});
