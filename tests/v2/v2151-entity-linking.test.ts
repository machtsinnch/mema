// v2.15.1 — fact↔entity linking (closes review finding F3): facts persist
// subject_entity_id / object_entity_id, and supersession matches candidates
// through the subject entity so alias-differing facts supersede correctly.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe } from "../../src/v2/layer1-episodic";
import {
  recordFact, recordFactWithSupersession, readFact, pathForFact,
} from "../../src/v2/layer2-semantic";
import { createEntity } from "../../src/v2/layer2-entities";
import { initAudit } from "../../src/v2/layer6-audit";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2151-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("fact persists entity links", () => {
  test("subject/object entity IDs land in frontmatter and links", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const subj = createEntity(vault, { name: "Princeton", type: "organization", actor: "t", owner: "o" });
    const obj = createEntity(vault, { name: "CoALA", type: "concept", actor: "t", owner: "o" });

    const fact = recordFact(vault, {
      subject: "Princeton", predicate: "developed", object: "CoALA",
      subject_entity_id: subj.id, object_entity_id: obj.id,
      derived_from: [ep.id], actor: "t", owner: "o",
    });

    const onDisk = readFact(vault, "o", fact.id);
    expect(onDisk?.subject_entity_id).toBe(subj.id);
    expect(onDisk?.object_entity_id).toBe(obj.id);

    // Obsidian graph edges: the fact file wikilinks both entity records.
    const raw = readFileSync(pathForFact(vault, "o", fact.id)!, "utf8");
    expect(raw).toContain(`[[${subj.id}]]`);
    expect(raw).toContain(`[[${obj.id}]]`);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("supersession sees through aliases via subject_entity_id", () => {
  test("'Marcel' and 'Marcel Schmidt' facts supersede when linked to one entity", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const marcel = createEntity(vault, {
      name: "Marcel Schmidt", type: "person", aliases: ["Marcel"], actor: "t", owner: "o",
    });

    const old = recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Google",
      subject_entity_id: marcel.id, valid_from: "2020-03-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const next = recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "works_at", object: "Anthropic",
      subject_entity_id: marcel.id, valid_from: "2026-01-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });

    // Pre-v2.15.1 this was ADD (string mismatch); now the entity link makes
    // the Google fact a candidate and the newer world date supersedes it.
    expect(next.decision.kind).toBe("UPDATE");
    expect(next.supersededIds).toContain(old.written!.id);
    const superseded = readFact(vault, "o", old.written!.id);
    expect(superseded?.superseded_by).toBe(next.written!.id);
    rmSync(vault, { recursive: true, force: true });
  });

  test("without entity links, alias facts still accumulate (unchanged behavior)", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Google",
      valid_from: "2020-03-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    const next = recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "works_at", object: "Anthropic",
      valid_from: "2026-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(next.decision.kind).toBe("ADD");
    expect(next.supersededIds.length).toBe(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("entity-linked duplicate is skipped across alias spellings", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const marcel = createEntity(vault, {
      name: "Marcel Schmidt", type: "person", aliases: ["Marcel"], actor: "t", owner: "o",
    });
    recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Anthropic",
      subject_entity_id: marcel.id, valid_from: "2026-01-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    const dup = recordFactWithSupersession(vault, {
      subject: "Marcel Schmidt", predicate: "works_at", object: "Anthropic",
      subject_entity_id: marcel.id, valid_from: "2026-01-01",
      derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(dup.written).toBeNull();
    expect(dup.decision.kind).toBe("NONE");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("v2.16.6 — entity dedup across types", () => {
  test("same name with different type merges into one record", () => {
    const vault = fresh();
    const a = createEntity(vault, { name: "Ginger liqueur", type: "product", actor: "t", owner: "o" });
    const b = createEntity(vault, { name: "Ginger liqueur", type: "concept", actor: "t", owner: "o" });
    expect(b.id).toBe(a.id);
    const c = createEntity(vault, { name: "ginger liqueur", type: "product", actor: "t", owner: "o" });
    expect(c.id).toBe(a.id);
    rmSync(vault, { recursive: true, force: true });
  });
});
