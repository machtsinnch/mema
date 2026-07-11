// v2.19.0 — judgment records: the heart of Layer 3 (Ardin's design,
// 2026-07-10). Whole-record supersession with a written reason; the
// living loop flags (never rewrites) judgments when new facts touch
// their foundations; the chain is walkable both ways.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordJudgment, readJudgment, listJudgments, supersedeJudgment,
  flagJudgmentsForFact, clearJudgmentFlags,
} from "../../src/v2/layer3-judgment";
import { recordFact } from "../../src/v2/layer2-semantic";
import { observe } from "../../src/v2/layer1-episodic";
import { recall } from "../../src/v2/layer5-retrieval";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2190-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("the Arachne story in miniature (decision → new facts → revision)", () => {
  test("full life of a judgment: record, flag on new evidence, supersede with reason, walk the chain", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "design notes", actor: "a", owner: "o" });

    // Foundations: facts the decision stands on.
    const f1 = recordFact(vault, {
      subject: "Chimera", predicate: "targets", object: "multiple database types",
      derived_from: [ep1.id], actor: "a", owner: "o",
    });
    const f2 = recordFact(vault, {
      subject: "Chimera", predicate: "uses", object: "type inheritance",
      derived_from: [ep1.id], actor: "a", owner: "o",
    });

    // ADR-015: the original decision.
    const j1 = recordJudgment(vault, {
      question: "How can modules read and write data across different databases?",
      decision: "Build Chimera: one abstract data model with type inheritance",
      rationale: "Expressive, lets types share attributes, fits Datomic and graph stores",
      alternatives: [{ option: "ORMs", reason_rejected: "leaky abstraction, tied to relational databases" }],
      consequences: ["every adapter must implement the inheritance logic"],
      based_on: [f1.id, f2.id, ep1.id],
      actor: "a", owner: "o",
    });
    expect(j1.belief_kind).toBe("judgment");
    expect(j1.judgment_status).toBe("accepted");
    expect(j1.watches).toContain("chimera");

    // Implementation reality arrives: a new fact about a watched subject.
    const ep2 = observe(vault, { kind: "document", content: "impl findings", actor: "a", owner: "o" });
    const f3 = recordFact(vault, {
      subject: "Chimera", predicate: "requires", object: "multi-table transactional migrations",
      derived_from: [ep2.id], actor: "a", owner: "o",
    });
    const flagged = flagJudgmentsForFact(vault, "o", f3, "a");
    expect(flagged).toBe(1);
    const j1Flagged = readJudgment(vault, "o", j1.id)!;
    expect(j1Flagged.review_flags).toHaveLength(1);
    expect(j1Flagged.review_flags![0].because).toContain("multi-table");
    expect(listJudgments(vault, "o", { flagged: true })).toHaveLength(1);

    // ADR-017: the human revises — new judgment supersedes the old WITH REASON.
    const j2 = recordJudgment(vault, {
      question: "Should Chimera keep type inheritance?",
      decision: "Remove supertypes and inheritance; keep the model flat",
      rationale: "Inheritance does not provide benefits proportional to the cost",
      consequences: ["adapters much simpler", "attributes repeated across types"],
      based_on: [f3.id, ep2.id],
      actor: "a", owner: "o",
    });
    const ok = supersedeJudgment(vault, "o", j1.id, j2.id,
      "type inheritance does not provide benefits proportional to the cost", "a");
    expect(ok).toBe(true);

    // Walk the chain BOTH ways — Ardin's backtracking promise.
    const oldJ = readJudgment(vault, "o", j1.id)!;
    const newJ = readJudgment(vault, "o", j2.id)!;
    expect(oldJ.superseded_by).toBe(j2.id);
    expect(oldJ.judgment_status).toBe("superseded");
    expect(oldJ.supersession_reason).toContain("proportional to the cost");
    expect(newJ.supersedes).toEqual([j1.id]);
    expect(newJ.iteration).toBe(2);
    // ...and down into Layer 2/1: foundations still linked.
    expect(oldJ.derived_from).toContain(f2.id);
    expect(newJ.derived_from).toContain(f3.id);

    // Old judgment keeps everything but leaves the active list.
    expect(listJudgments(vault, "o").map(j => j.id)).toEqual([j2.id]);
    expect(listJudgments(vault, "o", { include_superseded: true })).toHaveLength(2);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("flag mechanics", () => {
  test("no flag for its own foundations, unrelated subjects, or duplicates", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "a", owner: "o" });
    const f1 = recordFact(vault, { subject: "Terraform", predicate: "deploys", object: "Azure", derived_from: [ep.id], actor: "a", owner: "o" });
    const j = recordJudgment(vault, {
      question: "Which tool for infrastructure?",
      decision: "Use Terraform",
      rationale: "team experience",
      based_on: [f1.id],
      actor: "a", owner: "o",
    });
    // Its own foundation fact → no flag.
    expect(flagJudgmentsForFact(vault, "o", f1, "a")).toBe(0);
    // Unrelated subject → no flag.
    const fx = recordFact(vault, { subject: "Kubernetes", predicate: "runs", object: "containers", derived_from: [ep.id], actor: "a", owner: "o" });
    expect(flagJudgmentsForFact(vault, "o", fx, "a")).toBe(0);
    // Watched subject → flag once, not twice.
    const f2 = recordFact(vault, { subject: "Terraform", predicate: "lacks", object: "native testing", derived_from: [ep.id], actor: "a", owner: "o" });
    expect(flagJudgmentsForFact(vault, "o", f2, "a")).toBe(1);
    expect(flagJudgmentsForFact(vault, "o", f2, "a")).toBe(0);
    // Clearing after review works and is idempotent.
    expect(clearJudgmentFlags(vault, "o", j.id, "a", "decision still stands")).toBe(true);
    expect(readJudgment(vault, "o", j.id)!.review_flags).toEqual([]);
    expect(clearJudgmentFlags(vault, "o", j.id, "a", "again")).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });

  test("superseded judgments are not flagged anymore", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "a", owner: "o" });
    const f1 = recordFact(vault, { subject: "Pulumi", predicate: "supports", object: "TypeScript", derived_from: [ep.id], actor: "a", owner: "o" });
    const j1 = recordJudgment(vault, { question: "q", decision: "d1", rationale: "r", based_on: [f1.id], actor: "a", owner: "o" });
    const j2 = recordJudgment(vault, { question: "q", decision: "d2", rationale: "r", based_on: [f1.id], actor: "a", owner: "o" });
    supersedeJudgment(vault, "o", j1.id, j2.id, "reasons", "a");
    const f2 = recordFact(vault, { subject: "Pulumi", predicate: "adds", object: "YAML support", derived_from: [ep.id], actor: "a", owner: "o" });
    // Only the ACTIVE judgment gets the flag.
    expect(flagJudgmentsForFact(vault, "o", f2, "a")).toBe(1);
    expect(readJudgment(vault, "o", j1.id)!.review_flags ?? []).toEqual([]);
    expect(readJudgment(vault, "o", j2.id)!.review_flags).toHaveLength(1);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("judgments in retrieval", () => {
  test("a judgment is findable and ranks like a belief", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "infra decision doc", actor: "a", owner: "o" });
    const f = recordFact(vault, { subject: "machtsinn", predicate: "deploys_on", object: "Azure", derived_from: [ep.id], actor: "a", owner: "o" });
    recordJudgment(vault, {
      question: "Which cloud for the machtsinn platform?",
      decision: "Deploy the machtsinn platform on Azure using zorbex-grade isolation",
      rationale: "customer tenancy requirements",
      based_on: [f.id],
      actor: "a", owner: "o",
    });
    const r = await recall(vault, { query: "zorbex-grade isolation", owner: "o", actor: "a", purpose: "test" });
    const hit = r.hits.find(h => h.kind === "cognitive");
    expect(hit).toBeDefined();
    expect(hit!.excerpt.toLowerCase()).toContain("zorbex");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("two-stage flags: relevance screening (v2.19.2)", () => {
  test("candidates are kept as relevant or dropped per the screener's verdicts", async () => {
    const { screenJudgmentCandidates } = await import("../../src/v2/layer3-judgment");
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "a", owner: "o" });
    const f1 = recordFact(vault, { subject: "Pulumi", predicate: "supports", object: "TypeScript", derived_from: [ep.id], actor: "a", owner: "o" });
    const j = recordJudgment(vault, {
      question: "Which tool for infrastructure?", decision: "Use Pulumi", rationale: "fits the team",
      based_on: [f1.id], actor: "a", owner: "o",
    });
    const fGood = recordFact(vault, { subject: "Pulumi", predicate: "lacks", object: "native testing", derived_from: [ep.id], actor: "a", owner: "o" });
    const fNoise = recordFact(vault, { subject: "Pulumi", predicate: "sponsors", object: "a conference", derived_from: [ep.id], actor: "a", owner: "o" });
    flagJudgmentsForFact(vault, "o", fGood, "a");
    flagJudgmentsForFact(vault, "o", fNoise, "a");
    expect(readJudgment(vault, "o", j.id)!.review_flags).toHaveLength(2);

    const r = await screenJudgmentCandidates(vault, "o", "a", {
      screener: async (_j, cands) => cands.map(c => ({
        fact_id: c.fact_id,
        relevant: c.fact_id === fGood.id,
        reason: c.fact_id === fGood.id ? "missing capability affects the choice" : "sponsorship is unrelated",
      })),
    });
    expect(r.judgments_screened).toBe(1);
    expect(r.kept).toBe(1);
    expect(r.dropped).toBe(1);

    const after = readJudgment(vault, "o", j.id)!;
    expect(after.review_flags).toHaveLength(1);
    expect(after.review_flags![0].fact_id).toBe(fGood.id);
    expect(after.review_flags![0].status).toBe("relevant");
    expect(after.review_flags![0].screen_reason).toContain("capability");

    // Second run: nothing left to screen → screener not called.
    const r2 = await screenJudgmentCandidates(vault, "o", "a", {
      screener: async () => { throw new Error("must not be called"); },
    });
    expect(r2.judgments_screened).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("screener failure leaves candidates untouched for the next run", async () => {
    const { screenJudgmentCandidates } = await import("../../src/v2/layer3-judgment");
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "a", owner: "o" });
    const f1 = recordFact(vault, { subject: "Zig", predicate: "compiles", object: "C", derived_from: [ep.id], actor: "a", owner: "o" });
    recordJudgment(vault, { question: "q", decision: "d", rationale: "r", based_on: [f1.id], actor: "a", owner: "o" });
    const f2 = recordFact(vault, { subject: "Zig", predicate: "adds", object: "async", derived_from: [ep.id], actor: "a", owner: "o" });
    flagJudgmentsForFact(vault, "o", f2, "a");

    const r = await screenJudgmentCandidates(vault, "o", "a", {
      screener: async () => { throw new Error("model unavailable"); },
    });
    expect(r.errors).toHaveLength(1);
    const j = listJudgments(vault, "o", { flagged: true })[0];
    expect((j.review_flags![0].status ?? "candidate")).toBe("candidate");
    rmSync(vault, { recursive: true, force: true });
  });
});
