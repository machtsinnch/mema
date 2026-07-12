// v2.17.1 — the two fixes Ardin approved 2026-07-10:
//   (1) location predicates only REPLACE for person subjects; companies
//       accumulate locations ("TSMC located_in Taiwan" must survive the
//       Dresden fab). Unknown subject type → accumulate (safe default).
//   (2) a fact dated in the future is a plan, not a current state — Rule B
//       must not conclude "currently" from it, and must abstain visibly.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFunctionalFor } from "../../src/v2/layer4-supersession";
import { recordFactWithSupersession } from "../../src/v2/layer2-semantic";
import { createEntity } from "../../src/v2/layer2-entities";
import { observe } from "../../src/v2/layer1-episodic";
import { reflect } from "../../src/v2/layer3-reflection";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2171-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

describe("isFunctionalFor — one-value-ness depends on subject type", () => {
  test("location predicates: person yes, organization no, unknown no", () => {
    expect(isFunctionalFor("lives_in", "person")).toBe(true);
    expect(isFunctionalFor("located_in", "organization")).toBe(false);
    expect(isFunctionalFor("based_in", "organization")).toBe(false);
    expect(isFunctionalFor("located_in", null)).toBe(false);
    expect(isFunctionalFor("located_in", undefined)).toBe(false);
  });

  test("non-location functional predicates keep replacing regardless of type", () => {
    expect(isFunctionalFor("works_at", "person")).toBe(true);
    expect(isFunctionalFor("ceo_of", "person")).toBe(true);
    expect(isFunctionalFor("works_at", null)).toBe(true);
  });

  test("non-functional predicates stay non-functional for everyone", () => {
    expect(isFunctionalFor("owns", "person")).toBe(false);
    expect(isFunctionalFor("uses", "organization")).toBe(false);
  });
});

describe("write-time: company locations accumulate, person residence replaces", () => {
  test("a company's second location ADDs — first location survives", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const tsmc = createEntity(vault, { name: "TSMC", type: "organization", actor: "t", owner: "o" });
    const r1 = recordFactWithSupersession(vault, {
      subject: "TSMC", predicate: "located_in", object: "Taiwan", valid_from: "1987-02",
      subject_entity_id: tsmc.id, derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r2 = recordFactWithSupersession(vault, {
      subject: "TSMC", predicate: "located_in", object: "Germany", valid_from: "2024-08",
      subject_entity_id: tsmc.id, derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(r1.decision.kind).toBe("ADD");
    expect(r2.decision.kind).toBe("ADD");
    expect(r2.supersededIds).toHaveLength(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("a person's new residence still REPLACES the old one", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const marcel = createEntity(vault, { name: "Marcel", type: "person", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "lives_in", object: "Zurich", valid_from: "2019-01",
      subject_entity_id: marcel.id, derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r2 = recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "lives_in", object: "Lausanne", valid_from: "2024-06",
      subject_entity_id: marcel.id, derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(r2.decision.kind).toBe("UPDATE");
    expect(r2.supersededIds).toHaveLength(1);
    rmSync(vault, { recursive: true, force: true });
  });

  test("unlinked subject (no entity) → locations accumulate, never guessed", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, {
      subject: "SK Hynix", predicate: "located_in", object: "South Korea", valid_from: "2010-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r2 = recordFactWithSupersession(vault, {
      subject: "SK Hynix", predicate: "located_in", object: "Wuxi", valid_from: "2019-04",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(r2.decision.kind).toBe("ADD");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("reflection Rule B respects subject type and future dates", () => {
  test("company with dated location history → NO 'currently located_in' belief", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const tsmc = createEntity(vault, { name: "TSMC", type: "organization", actor: "t", owner: "o" });
    for (const [place, date] of [["Taiwan", "1987-02"], ["Germany", "2024-08"]] as const) {
      recordFactWithSupersession(vault, {
        subject: "TSMC", predicate: "located_in", object: place, valid_from: date,
        subject_entity_id: tsmc.id, derived_from: [ep.id], actor: "t", owner: "o",
      });
    }
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    expect(r.records.filter(x => x.content.includes("currently"))).toHaveLength(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("person with dated residence history → clean 'currently lives_in' belief", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const marcel = createEntity(vault, { name: "Marcel", type: "person", actor: "t", owner: "o" });
    for (const [place, date] of [["Zurich", "2019-01"], ["Lausanne", "2024-06"]] as const) {
      recordFactWithSupersession(vault, {
        subject: "Marcel", predicate: "lives_in", object: place, valid_from: date,
        subject_entity_id: marcel.id, derived_from: [ep.id], actor: "t", owner: "o",
      });
    }
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    const belief = r.records.find(x => x.content.includes("currently"));
    expect(belief).toBeDefined();
    expect(belief!.content).toContain("Lausanne");
    rmSync(vault, { recursive: true, force: true });
  });

  // v2.22.7 (l3-reflect finding): a future-dated fact is still a plan, not a
  // current state — but it must NOT erase the present employer. Before the
  // fix the future SpaceLab fact superseded Anthropic at write time (stamping
  // invalidated_at=now()), so Rule B saw only the plan and abstained, and the
  // current employer read as UNKNOWN. Now the future fact does not supersede;
  // Anthropic stays live and is correctly concluded as current, while
  // SpaceLab reads as a not-yet-current plan (no "currently ... SpaceLab").
  test("future-dated fact is a plan, not current — the present employer is retained", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Anthropic", valid_from: "2024-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "SpaceLab", valid_from: "2031-09",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    // The future plan is never concluded as the current state.
    expect(r.records.some(x => x.content.includes("SpaceLab") && x.content.includes("currently"))).toBe(false);
    // The present employer is NOT erased by the future plan.
    expect(r.records.some(x => x.content.includes("Marcel currently works_at Anthropic"))).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });
});
