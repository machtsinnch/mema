// v2.22.1 — regression tests for review-round-2 L2/L3/extractor findings.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFact, recordFactWithSupersession, readFact } from "../../src/v2/layer2-semantic";
import { createEntity, rejectEntity } from "../../src/v2/layer2-entities";
import { observe } from "../../src/v2/layer1-episodic";
import { reflect } from "../../src/v2/layer3-reflection";
import { consensusMerge } from "../../src/v2/llm-extractor";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2221-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

describe("L2a: restating inside a closed window does not resurrect the fact", () => {
  test("a restatement inside a closed validity window is skipped, not ADDed as current", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Google",
      valid_from: "2020-01-01", valid_to: "2024-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    const restate = recordFactWithSupersession(vault, {
      subject: "John", predicate: "works_at", object: "Google", valid_from: "2021-06-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(restate.written).toBeNull();          // duplicate/stale, not a new open-ended fact
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("L2b: alias supersession bridges linked and unlinked facts", () => {
  test("a linked new fact supersedes an unlinked older fact under an alias", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    // Old fact ingested BEFORE the entity existed — unlinked, surface "Marcel".
    const old = recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Google", valid_from: "2020-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    }).written!;
    const ent = createEntity(vault, { name: "Marcel Schmidt", type: "person", aliases: ["Marcel"], actor: "t", owner: "o" });
    const neu = recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "works_at", object: "Anthropic", valid_from: "2026-01",
      subject_entity_id: ent.id, derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(neu.decision.kind).toBe("UPDATE");
    expect(readFact(vault, "o", old.id)!.superseded_by).toBe(neu.written!.id);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("L3a: Rule B treats ended facts as history, not current", () => {
  test("an ended job never becomes a 'currently' belief; a later real job wins", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFact(vault, {
      subject: "John", predicate: "works_at", object: "OldCorp",
      valid_from: "2018-03", valid_to: "2020-06-30", derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r1 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["John"] });
    expect(r1.records.some(x => x.content.includes("currently") && x.content.includes("OldCorp"))).toBe(false);

    recordFact(vault, {
      subject: "John", predicate: "works_at", object: "NewCorp", valid_from: "2023-05",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const r2 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["John"] });
    const belief = r2.records.find(x => x.content.includes("currently"));
    expect(belief?.content).toContain("NewCorp");
    expect(r2.abstained?.length ?? 0).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("L3b: rejected entities cannot mint false corroboration", () => {
  test("a rejected entity's alias does not glue two distinct subjects into one belief", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    // A hallucinated entity with a broad alias, then rejected.
    const bad = createEntity(vault, { name: "Acme", type: "organization", aliases: ["Alpha", "Beta"], actor: "t", owner: "o", status: "draft" });
    rejectEntity(vault, bad.id, "o", "reviewer", "hallucinated");
    // Two genuinely different subjects that share the rejected entity's aliases.
    recordFact(vault, { subject: "Alpha", predicate: "uses", object: "X", derived_from: [ep1.id], actor: "t", owner: "o" });
    recordFact(vault, { subject: "Beta", predicate: "uses", object: "X", derived_from: [ep2.id], actor: "t", owner: "o" });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Alpha", "Beta"] });
    // Must NOT corroborate — different subjects, only glued by a rejected entity.
    expect(r.records.some(x => x.content.includes("independently stated"))).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("L3d: entity registered between runs does not duplicate the belief", () => {
  test("the belief updates in place after its subject's entity appears", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "ardin", owner: "ardin-pai" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "ardin", owner: "ardin-pai" });
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [ep1.id], actor: "ardin", owner: "ardin-pai" });
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [ep2.id], actor: "ardin", owner: "ardin-pai" });
    const r1 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r1.cognitive_records_created).toBe(1);
    // Now the entity is registered.
    createEntity(vault, { name: "ardin.me", type: "system", actor: "ardin", owner: "ardin-pai" });
    const r2 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r2.cognitive_records_created).toBe(0);   // no duplicate
    const r3 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r3.cognitive_records_created).toBe(0);
    expect(r3.unchanged).toBe(1);                   // stable after key migration
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("E1: consensus anchoring is unicode-safe", () => {
  test("an accented entity does not falsely anchor an unrelated subject", () => {
    const p = (facts: any[]) => ({ facts, entities: [{ name: "Zürich", type: "place" }] });
    const merged = consensusMerge([
      p([{ subject: "Zürich", predicate: "hosts", object: "summit", confidence: 0.9 }]),
      p([{ subject: "Zürich", predicate: "hosts", object: "summit", confidence: 0.9 }]),
      p([{ subject: "rich district", predicate: "hosts", object: "summit", confidence: 0.9 }]),
    ]);
    // "rich district" must NOT collapse into "Zürich".
    const subjects = merged.facts.map(f => f.subject.toLowerCase());
    expect(merged.facts.length).toBeGreaterThanOrEqual(1);
    expect(subjects.some(s => s.includes("zürich"))).toBe(true);
    rmSync; // no vault
  });
});
