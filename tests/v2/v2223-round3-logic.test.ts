// v2.22.3 — regression tests for review-round-3 findings:
//   1. L2 covered-window restatement must merge provenance (write + approve).
//   2. Extractor sanitizeEventDate must reject calendar-invalid day overflow.
//   3. L3 Rule B location gate must resolve subject type via the name registry.
//   4. POST /v2/judgment must return the post-supersession record, not a stale one.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordFact, recordFactWithSupersession, readFact, approveFact,
} from "../../src/v2/layer2-semantic";
import { createEntity } from "../../src/v2/layer2-entities";
import { observe } from "../../src/v2/layer1-episodic";
import { reflect } from "../../src/v2/layer3-reflection";
import { sanitizeEventDate } from "../../src/v2/llm-extractor";
import { buildApi } from "../../src/api";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2223-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

describe("F1: covered-window restatement merges its corroborating episode", () => {
  test("direct write — the covering fact learns the restatement's episode id", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    const covering = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Google",
      valid_from: "2020-01-01", valid_to: "2024-01-01", derived_from: [ep1.id], actor: "t", owner: "o",
    }).written!;
    // A second independent document restates the fact, dated INSIDE the window.
    const restate = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Google", valid_from: "2021-06-01",
      derived_from: [ep2.id], actor: "t", owner: "o",
    });
    expect(restate.written).toBeNull();                       // still classified NONE
    const df = readFact(vault, "o", covering.id)!.derived_from ?? [];
    expect(df).toContain(ep1.id);
    expect(df).toContain(ep2.id);                             // ep2 was NOT dropped
    rmSync(vault, { recursive: true, force: true });
  });

  test("approve path — approving a draft restatement inside a closed window merges too", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    const covering = recordFactWithSupersession(vault, {
      subject: "Mary", predicate: "works_at", object: "Acme",
      valid_from: "2020-01-01", valid_to: "2024-01-01", derived_from: [ep1.id], actor: "t", owner: "o",
    }).written!;
    // Restatement arrives as a DRAFT (supersession deferred to approval).
    const draft = recordFact(vault, {
      subject: "Mary", predicate: "works_at", object: "Acme", valid_from: "2021-06-01",
      derived_from: [ep2.id], actor: "t", owner: "o", status: "draft",
    });
    const res = approveFact(vault, draft.id, "o", "reviewer");
    expect(res.supersededIds).toEqual([]);                    // nothing superseded
    const df = readFact(vault, "o", covering.id)!.derived_from ?? [];
    expect(df).toContain(ep1.id);
    expect(df).toContain(ep2.id);                             // merged on approve
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("F2: sanitizeEventDate rejects calendar-invalid dates on Bun/JSC", () => {
  test("day-overflow dates are rejected, not rolled forward", () => {
    expect(sanitizeEventDate("2026-06-31")).toBeNull();   // June has 30 days
    expect(sanitizeEventDate("2026-02-31")).toBeNull();
    expect(sanitizeEventDate("2023-02-29")).toBeNull();   // non-leap Feb 29
    expect(sanitizeEventDate("2100-02-29")).toBeNull();   // non-leap century
    expect(sanitizeEventDate("2026-13-01")).toBeNull();   // month overflow (unchanged)
    expect(sanitizeEventDate("2026-00-01")).toBeNull();
    expect(sanitizeEventDate("2026-05-00")).toBeNull();   // day-00
  });
  test("legitimate dates and coarser precisions still pass", () => {
    expect(sanitizeEventDate("2026-06-30")).toBe("2026-06-30");
    expect(sanitizeEventDate("2024-02-29")).toBe("2024-02-29");  // real leap day
    expect(sanitizeEventDate("2026-06")).toBe("2026-06");
    expect(sanitizeEventDate("2026")).toBe("2026");
  });
});

describe("F3: Rule B location gate resolves subject type via the name registry", () => {
  test("an unlinked residence fact about a registered person is not silently dropped", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const ardin = createEntity(vault, { name: "Ardin", type: "person", actor: "t", owner: "o" });
    // Linked, older residence.
    recordFact(vault, {
      subject: "Ardin", predicate: "lives_in", object: "Zurich", valid_from: "2020",
      subject_entity_id: ardin.id, derived_from: [ep.id], actor: "t", owner: "o",
    });
    // Unlinked (pre-entity), NEWER residence — same person group via the registry.
    recordFact(vault, {
      subject: "Ardin", predicate: "lives_in", object: "Bern", valid_from: "2023",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    // Two active current values → the correct behavior is to ABSTAIN, never to
    // assert the older Zurich residence as current.
    expect(r.records.some(x => x.content.includes("currently") && x.content.includes("Zurich"))).toBe(false);
    expect(r.abstained?.some(a => a.rule === "current-state" && a.predicate === "lives_in")).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });
});

const KEYS = { "dev-ardin": "ardin" };
async function req(app: any, method: string, path: string, body?: any) {
  const r = await app.request(path, {
    method,
    headers: { "x-api-key": "dev-ardin", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: JSON.parse((await r.text()) || "{}") };
}

describe("F4: POST /v2/judgment returns the post-supersession record", () => {
  test("the response reflects the persisted iteration bump and supersedes back-link", async () => {
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const ep = await req(app, "POST", "/v2/observe", {
      kind: "document", content: "infra decision", source: "t", skip_extraction: true,
    });
    const based = [ep.data.episode.id];
    const old = await req(app, "POST", "/v2/judgment", {
      question: "q1", decision: "d1", rationale: "r1", based_on: based,
    });
    const oldId = old.data.judgment.id;
    const created = await req(app, "POST", "/v2/judgment", {
      question: "q2", decision: "d2", rationale: "r2", based_on: based,
      supersedes_id: oldId, supersession_reason: "we learned more",
    });
    expect(created.data.superseded_old).toBe(true);
    // The immediate response must match a subsequent GET, not the stale object.
    expect(created.data.judgment.iteration).toBe(2);
    expect(created.data.judgment.supersedes).toEqual([oldId]);
    const got = await req(app, "GET", `/v2/judgment/${created.data.judgment.id}`);
    expect(got.data.judgment.iteration).toBe(2);
    expect(got.data.judgment.supersedes).toEqual([oldId]);
    rmSync(vault, { recursive: true, force: true });
  });
});
