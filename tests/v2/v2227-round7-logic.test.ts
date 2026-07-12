// v2.22.7 — regression tests for review-round-7 findings:
//   1. [l3-reflect] A future-dated fact must NOT supersede a currently-valid
//      functional fact at write time. Before the fix, ingesting a future plan
//      ("works_at BMW starting 2027-03") stamped invalidated_at=now() on the
//      present employer, so current-state reads went EMPTY until the plan's
//      date arrived — a future plan retroactively ending a present fact.
//   2. [l3-reflect] Rule B must exclude future-dated plans from the current
//      set BEFORE counting distinct values, so a plan + a genuinely current
//      fact do not count as "2 distinct current values" and abstain; the
//      determinable current employer must be concluded.
//   3. [l3-judgment] A human-cleared judgment review flag must not resurrect
//      on a redundant (idempotent) fact re-approval — the living-loop flag is
//      bound to the approval EVENT, not to every approve call.
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
  const dir = mkdtempSync(join(tmpdir(), "mema-v2227-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

// A world date safely in the future regardless of when the suite runs.
const FUTURE_YEAR = String(new Date().getFullYear() + 3);
const FUTURE_DATE = `${FUTURE_YEAR}-03`;

// ── F1 ────────────────────────────────────────────────────────────────
describe("F1: a future-dated fact does not supersede a currently-valid fact", () => {
  const mkFact = (over: Partial<SemanticFact>): SemanticFact => ({
    id: over.id ?? "existing", subject: "Ardin", predicate: "works_at",
    object: over.object ?? "AUDI", valid_from: over.valid_from ?? "2020",
    valid_to: over.valid_to ?? null, invalidated_at: null, superseded_by: null,
    derived_from: [], confidence: 0.8, owner: "o", status: "approved", ...over,
  });

  test("pure classifyOnWrite: a future BMW plan does NOT supersede present AUDI", () => {
    const d = classifyOnWrite(
      { subject: "Ardin", predicate: "works_at", object: "BMW", event_date: FUTURE_DATE },
      [mkFact({})],
    );
    expect(d.kind).toBe("ADD");
  });

  test("a present-dated contradiction still supersedes (guard is future-only)", () => {
    const d = classifyOnWrite(
      { subject: "Ardin", predicate: "works_at", object: "BMW", event_date: "2024-05" },
      [mkFact({})],
    );
    expect(d.kind).toBe("UPDATE");
  });

  test("end-to-end: ingesting a future plan leaves the present employer live", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const audi = recordFactWithSupersession(vault, {
      subject: "Ardin", predicate: "works_at", object: "AUDI",
      valid_from: "2020", derived_from: [ep.id], actor: "t", owner: "o",
    }).written!;
    const res = recordFactWithSupersession(vault, {
      subject: "Ardin", predicate: "works_at", object: "BMW",
      valid_from: FUTURE_DATE, derived_from: [ep.id], actor: "t", owner: "o",
    });
    // The future plan is added, not treated as an update.
    expect(res.decision.kind).toBe("ADD");
    expect(res.supersededIds ?? []).toHaveLength(0);
    // The present employer was NOT invalidated: current-state reads AUDI, not
    // empty. (Before the fix AUDI.invalidated_at=now() and this was empty.)
    const current = getFactsValidAt(vault, "o", new Date().toISOString())
      .filter(f => f.predicate === "works_at");
    expect(current).toHaveLength(1);
    expect(current[0].object).toBe("AUDI");
    expect(current[0].id).toBe(audi.id);
    rmSync(vault, { recursive: true, force: true });
  });
});

// ── F2 ────────────────────────────────────────────────────────────────
describe("F2: Rule B excludes future plans before the distinct-value count", () => {
  test("a future plan + a current fact concludes the current one, no false abstention", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    // Ingest the future plan FIRST, then the (older) current fact as a backfill
    // ADD — nothing supersedes, so both stay live: exactly the state that made
    // Rule B count "2 distinct current values" and abstain.
    recordFactWithSupersession(vault, {
      subject: "Ardin", predicate: "works_at", object: "BMW", valid_from: FUTURE_DATE,
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    recordFactWithSupersession(vault, {
      subject: "Ardin", predicate: "works_at", object: "AUDI", valid_from: "2020",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    // The determinable current employer is concluded.
    expect(r.records.some(x => x.content.includes("Ardin currently works_at AUDI"))).toBe(true);
    // The future plan is not concluded as current.
    expect(r.records.some(x => x.content.includes("BMW") && x.content.includes("currently"))).toBe(false);
    // No fabricated "2 distinct current values" abstention.
    expect(r.abstained?.some(a =>
      a.rule === "current-state" && a.predicate === "works_at" && a.reason.includes("distinct"),
    )).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });

  test("all-future group abstains with a plan reason, not a distinct-value reason", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, {
      subject: "Ardin", predicate: "works_at", object: "BMW", valid_from: FUTURE_DATE,
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    expect(r.records.some(x => x.content.includes("currently"))).toBe(false);
    const ab = r.abstained?.find(a => a.rule === "current-state" && a.predicate === "works_at");
    expect(ab).toBeTruthy();
    expect(ab!.reason.includes("future") || ab!.reason.includes("plan")).toBe(true);
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

describe("F3: a cleared judgment flag does not resurrect on a redundant approve", () => {
  test("redundant approve is an idempotent no-op and re-adds no phantom flag", async () => {
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

    // First approve promotes the draft and flags the watching judgment.
    const appr1 = await req(app, "POST", `/v2/fact/${draft.data.fact.id}/approve`, {});
    expect(appr1.status).toBe(200);
    expect(appr1.data.judgments_flagged).toBeGreaterThan(0);
    expect(readJudgment(vault, "ardin", j.id)!.review_flags ?? []).toHaveLength(1);

    // A human reviews and clears the flag (judgment still stands).
    const clear = await req(app, "POST", `/v2/judgment/${j.id}/flags/clear`, {
      resolution: "reviewed — judgment still stands",
    });
    expect(clear.status).toBe(200);
    expect(readJudgment(vault, "ardin", j.id)!.review_flags ?? []).toHaveLength(0);

    // A retried/duplicate approve of the SAME (already-approved) fact must not
    // re-inject the cleared flag.
    const appr2 = await req(app, "POST", `/v2/fact/${draft.data.fact.id}/approve`, {});
    expect(appr2.status).toBe(200);
    expect(appr2.data.judgments_flagged).toBeUndefined();
    expect(readJudgment(vault, "ardin", j.id)!.review_flags ?? []).toHaveLength(0);
    rmSync(vault, { recursive: true, force: true });
  });
});
