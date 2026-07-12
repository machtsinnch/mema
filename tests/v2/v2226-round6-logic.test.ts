// v2.22.6 — regression tests for review-round-6 findings:
//   1. L4 olderThanNew must compare coarse (year/month) event dates at the
//      SHARED precision, the same way isClosed already does — otherwise a
//      finer-dated existing functional fact is never superseded and two
//      contradictory "current" facts persist.
//   2. L3 Rule B must count DISTINCT object values, not fact count — same-value
//      corroboration must not trigger a false abstention that drops the belief.
//   3. POST /v2/fact must flag judgments only on APPROVAL, never on a draft
//      write — an unreviewed (later-rejected) draft must not leave a phantom
//      review flag, and the approve paths must fire the living loop.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordFact, recordFactWithSupersession, getFactsValidAt,
} from "../../src/v2/layer2-semantic";
import { classifyOnWrite } from "../../src/v2/layer4-supersession";
import { observe } from "../../src/v2/layer1-episodic";
import { reflect } from "../../src/v2/layer3-reflection";
import { recordJudgment, readJudgment } from "../../src/v2/layer3-judgment";
import type { SemanticFact } from "../../src/v2/types";
import { buildApi } from "../../src/api";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2226-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

// ── F1 ────────────────────────────────────────────────────────────────
describe("F1: olderThanNew compares coarse event dates at shared precision", () => {
  const mkFact = (over: Partial<SemanticFact>): SemanticFact => ({
    id: over.id ?? "existing", subject: "John", predicate: "works_at",
    object: over.object ?? "Google", valid_from: over.valid_from ?? "2023-05-31",
    valid_to: over.valid_to ?? null, invalidated_at: null, superseded_by: null,
    derived_from: [], confidence: 0.8, owner: "o", status: "approved", ...over,
  });

  test("pure classifyOnWrite: new coarse '2023' supersedes existing fine '2023-05-31'", () => {
    const d = classifyOnWrite(
      { subject: "John", predicate: "works_at", object: "Anthropic", event_date: "2023" },
      [mkFact({})],
    );
    expect(d.kind).toBe("UPDATE");
  });

  test("pure classifyOnWrite is symmetric: mirror ordering also supersedes (new wins)", () => {
    const d = classifyOnWrite(
      { subject: "John", predicate: "works_at", object: "Anthropic", event_date: "2023-05-31" },
      [mkFact({ valid_from: "2023" })],
    );
    expect(d.kind).toBe("UPDATE");
  });

  test("end-to-end: a bare-year new fact supersedes a same-year finer-dated one — one current employer", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const google = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Google",
      valid_from: "2023-05-31", derived_from: [ep.id], actor: "t", owner: "o",
    }).written!;
    const res = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Anthropic",
      valid_from: "2023", derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(res.decision.kind).toBe("UPDATE");
    expect(res.supersededIds).toContain(google.id);
    const current = getFactsValidAt(vault, "o", new Date().toISOString())
      .filter(f => f.predicate === "works_at");
    expect(current).toHaveLength(1);
    expect(current[0].object).toBe("Anthropic");
    rmSync(vault, { recursive: true, force: true });
  });
});

// ── F2 ────────────────────────────────────────────────────────────────
describe("F2: Rule B counts distinct object values, not fact count", () => {
  test("two live facts asserting the SAME value yield a belief, not a false abstention", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    // Same value confirmed twice — the ordinary accumulate path (both live).
    recordFact(vault, {
      subject: "Ardin", predicate: "works_at", object: "AUDI", valid_from: "2022-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    recordFact(vault, {
      subject: "Ardin", predicate: "works_at", object: "AUDI", valid_from: "2023-06",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    // The unambiguous current-state belief is drawn (earliest valid_from = "since 2022-01").
    expect(r.records.some(x => x.content.includes("Ardin currently works_at AUDI"))).toBe(true);
    expect(r.records.some(x => x.content.includes("since 2022-01"))).toBe(true);
    expect(r.cognitive_records_created).toBeGreaterThan(0);
    // No fabricated "N candidate values" abstention.
    expect(r.abstained?.some(a => a.rule === "current-state" && a.predicate === "works_at")).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });

  test("two DISTINCT live values still abstain (design intent preserved)", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFact(vault, {
      subject: "Ardin", predicate: "works_at", object: "AUDI", valid_from: "2022-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    recordFact(vault, {
      subject: "Ardin", predicate: "works_at", object: "BMW", valid_from: "2023-06",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    expect(r.records.some(x => x.content.includes("Ardin currently works_at"))).toBe(false);
    expect(r.abstained?.some(a => a.rule === "current-state" && a.predicate === "works_at")).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });
});

// ── F3 ────────────────────────────────────────────────────────────────
const KEYS = { "dev-ardin": "ardin" };
async function req(app: any, method: string, path: string, body?: any) {
  const r = await app.request(path, {
    method,
    headers: { "x-api-key": "dev-ardin", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: JSON.parse((await r.text()) || "{}") };
}

describe("F3: judgment flagging is bound to approval, not to any write", () => {
  test("a draft write does not flag; rejecting it leaves no phantom flag", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    // Foundation fact + judgment that WATCHES "pulumi".
    const ep0 = observe(vault, { kind: "document", content: "pulumi uses go", actor: "t", owner: "ardin" });
    const f1 = recordFact(vault, {
      subject: "pulumi", predicate: "uses", object: "go", derived_from: [ep0.id], actor: "t", owner: "ardin",
    });
    const j = recordJudgment(vault, {
      question: "adopt pulumi?", decision: "yes", rationale: "IaC fit",
      based_on: [f1.id], actor: "t", owner: "ardin",
    });
    expect(readJudgment(vault, "ardin", j.id)!.watches).toContain("pulumi");

    // An episode whose body supports the draft (so approve's evidence gate can pass later).
    const ep1 = observe(vault, {
      kind: "document", content: "pulumi lacks native testing", actor: "t", owner: "ardin",
    });
    const draft = await req(app, "POST", "/v2/fact", {
      subject: "pulumi", predicate: "lacks", object: "native testing",
      derived_from: [ep1.id], status: "draft",
    });
    expect(draft.data.fact.status).toBe("draft");
    // The draft must NOT flag the judgment.
    expect(draft.data.judgments_flagged).toBeUndefined();
    expect(readJudgment(vault, "ardin", j.id)!.review_flags ?? []).toHaveLength(0);

    // Reject the draft — still no phantom flag.
    const rej = await req(app, "POST", `/v2/fact/${draft.data.fact.id}/reject`, { reason: "false claim" });
    expect(rej.status).toBe(200);
    expect(readJudgment(vault, "ardin", j.id)!.review_flags ?? []).toHaveLength(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("approving a draft fires the living loop and flags the watching judgment", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep0 = observe(vault, { kind: "document", content: "pulumi uses go", actor: "t", owner: "ardin" });
    const f1 = recordFact(vault, {
      subject: "pulumi", predicate: "uses", object: "go", derived_from: [ep0.id], actor: "t", owner: "ardin",
    });
    const j = recordJudgment(vault, {
      question: "adopt pulumi?", decision: "yes", rationale: "IaC fit",
      based_on: [f1.id], actor: "t", owner: "ardin",
    });
    const ep1 = observe(vault, {
      kind: "document", content: "pulumi lacks native testing", actor: "t", owner: "ardin",
    });
    const draft = await req(app, "POST", "/v2/fact", {
      subject: "pulumi", predicate: "lacks", object: "native testing",
      derived_from: [ep1.id], status: "draft",
    });
    expect(readJudgment(vault, "ardin", j.id)!.review_flags ?? []).toHaveLength(0);

    const appr = await req(app, "POST", `/v2/fact/${draft.data.fact.id}/approve`, {});
    expect(appr.status).toBe(200);
    expect(appr.data.judgments_flagged).toBeGreaterThan(0);
    const flags = readJudgment(vault, "ardin", j.id)!.review_flags ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0].fact_id).toBe(draft.data.fact.id);
    rmSync(vault, { recursive: true, force: true });
  });

  test("an approved direct write still flags immediately (over-catch for trusted facts kept)", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep0 = observe(vault, { kind: "document", content: "pulumi uses go", actor: "t", owner: "ardin" });
    const f1 = recordFact(vault, {
      subject: "pulumi", predicate: "uses", object: "go", derived_from: [ep0.id], actor: "t", owner: "ardin",
    });
    const j = recordJudgment(vault, {
      question: "adopt pulumi?", decision: "yes", rationale: "IaC fit",
      based_on: [f1.id], actor: "t", owner: "ardin",
    });
    const ep1 = observe(vault, {
      kind: "document", content: "pulumi runs on kubernetes", actor: "t", owner: "ardin",
    });
    const approved = await req(app, "POST", "/v2/fact", {
      subject: "pulumi", predicate: "runs_on", object: "kubernetes",
      derived_from: [ep1.id], status: "approved",
    });
    expect(approved.data.judgments_flagged).toBeGreaterThan(0);
    expect((readJudgment(vault, "ardin", j.id)!.review_flags ?? []).length).toBeGreaterThan(0);
    rmSync(vault, { recursive: true, force: true });
  });
});
