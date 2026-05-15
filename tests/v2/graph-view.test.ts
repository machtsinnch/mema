// Tests for the Obsidian link writers + the graph view layer.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, invalidateFact } from "../../src/v2/layer2-semantic";
import { createEntity, mergeEntities, touchEntity, readEntity } from "../../src/v2/layer2-entities";
import { recordCognitive, supersedeBelief } from "../../src/v2/layer3-cognitive";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";
import {
  buildGraphView, GRAPH_VIEW_DEFAULT_LIMIT, GRAPH_VIEW_MAX_LIMIT,
} from "../../src/v2/layer5-graph-view";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-gv-"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("Obsidian wikilink writers", () => {
  test("recordFact writes links from derived_from", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    const f = recordFact(v, {
      subject: "s", predicate: "p", object: "o",
      derived_from: [ep.id], confidence: 0.8, actor: "a", owner: "a",
    });
    const fm = matter(readFileSync(join(v, "facts", "a", `${f.id}.md`), "utf8")).data;
    expect(fm.links).toEqual([`[[${ep.id}]]`]);
    rmSync(v, { recursive: true, force: true });
  });

  test("invalidateFact rebuilds links to include superseded_by", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    const f1 = recordFact(v, {
      subject: "s", predicate: "p", object: "o",
      derived_from: [ep.id], confidence: 0.8, actor: "a", owner: "a",
    });
    const f2 = recordFact(v, {
      subject: "s", predicate: "p", object: "o2",
      derived_from: [ep.id], confidence: 0.9, actor: "a", owner: "a",
    });
    invalidateFact(v, f1.id, "a", "a", f2.id);
    const fm = matter(readFileSync(join(v, "facts", "a", `${f1.id}.md`), "utf8")).data;
    expect(fm.links).toContain(`[[${ep.id}]]`);
    expect(fm.links).toContain(`[[${f2.id}]]`);
    rmSync(v, { recursive: true, force: true });
  });

  test("recordCognitive writes links from derived_from", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    const c = recordCognitive(v, {
      kind: "belief", content: "b", confidence: 0.8,
      derived_from: [ep.id], actor: "a", owner: "a",
    });
    const fm = matter(readFileSync(join(v, "cognitive", "a", "belief", `${c.id}.md`), "utf8")).data;
    expect(fm.links).toEqual([`[[${ep.id}]]`]);
    rmSync(v, { recursive: true, force: true });
  });

  test("supersedeBelief updates links on the old record", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    const oldB = recordCognitive(v, {
      kind: "belief", content: "old", confidence: 0.5,
      derived_from: [ep.id], actor: "a", owner: "a",
    });
    const newB = recordCognitive(v, {
      kind: "belief", content: "new", confidence: 0.9,
      derived_from: [ep.id], actor: "a", owner: "a",
    });
    supersedeBelief(v, oldB.id, newB.id, "a", "a");
    const fm = matter(readFileSync(join(v, "cognitive", "a", "belief", `${oldB.id}.md`), "utf8")).data;
    expect(fm.superseded_by).toBe(newB.id);
    expect(fm.links).toContain(`[[${newB.id}]]`);
    rmSync(v, { recursive: true, force: true });
  });

  test("createEntity writes empty links; merge writes redirect link", () => {
    const v = fresh();
    const e1 = createEntity(v, { name: "Marcel", type: "person", actor: "a", owner: "a" });
    const e2 = createEntity(v, { name: "M.", type: "person", actor: "a", owner: "a" });
    const m1 = matter(readFileSync(join(v, "v2-entities", "a", `${e1.id}.md`), "utf8")).data;
    expect(m1.links).toEqual([]);
    mergeEntities(v, "a", "a", e1.id, e2.id);
    const stub = matter(readFileSync(join(v, "v2-entities", "a", `${e2.id}.md`), "utf8")).data;
    expect(stub.links).toEqual([`[[${e1.id}]]`]);
    rmSync(v, { recursive: true, force: true });
  });
});

describe("touchEntity preserves frontmatter (regression: drop-links bug)", () => {
  test("touchEntity updates last_seen but keeps existing links + custom fields", () => {
    const v = fresh();
    const e = createEntity(v, { name: "Marcel", type: "person", actor: "a", owner: "a" });
    // Simulate a custom frontmatter field being added externally (e.g. by wrap-as-asset)
    const path = join(v, "v2-entities", "a", `${e.id}.md`);
    const parsed = matter(readFileSync(path, "utf8"));
    parsed.data.content_hash = "sha256:abc";
    parsed.data.asset_version = 1;
    parsed.data.links = [`[[01XYZ]]`];
    writeFileSync(path, matter.stringify(parsed.content.trim(), parsed.data), "utf8");

    touchEntity(v, "a", e.id);

    const after = matter(readFileSync(path, "utf8")).data;
    expect(after.content_hash).toBe("sha256:abc");      // custom field preserved
    expect(after.asset_version).toBe(1);                 // custom field preserved
    expect(after.links).toEqual([`[[01XYZ]]`]);          // links preserved
    expect(after.last_seen).toBeDefined();
    rmSync(v, { recursive: true, force: true });
  });

  test("touchEntity refuses cross-owner update", () => {
    const v = fresh();
    const e = createEntity(v, { name: "Secret", type: "concept", actor: "alice", owner: "alice" });
    const before = readEntity(v, "alice", e.id)!.last_seen;
    touchEntity(v, "bob", e.id);   // bob attempts to bump alice's entity
    const after = readEntity(v, "alice", e.id)!.last_seen;
    expect(after).toBe(before);    // no change
    rmSync(v, { recursive: true, force: true });
  });
});

describe("buildGraphView", () => {
  test("returns nodes for all kinds + edges in canonical fields", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "src", actor: "a", owner: "a" });
    const f = recordFact(v, {
      subject: "s", predicate: "p", object: "o",
      derived_from: [ep.id], confidence: 0.9, actor: "a", owner: "a",
    });
    const c = recordCognitive(v, {
      kind: "belief", content: "b", confidence: 0.7,
      derived_from: [ep.id, f.id], actor: "a", owner: "a",
    });
    const ent = createEntity(v, { name: "X", type: "concept", actor: "a", owner: "a" });

    const view = buildGraphView(v, "a");
    expect(view.nodes.length).toBe(4);   // episode, fact, cognitive, entity
    expect(view.stats.by_kind.episode).toBe(1);
    expect(view.stats.by_kind.fact).toBe(1);
    expect(view.stats.by_kind.cognitive).toBe(1);
    expect(view.stats.by_kind.entity).toBe(1);

    // Edges: fact→episode (derived_from), cognitive→episode + cognitive→fact (derived_from)
    expect(view.edges.length).toBe(3);
    expect(view.edges.some(e => e.source === f.id && e.target === ep.id && e.kind === "derived_from")).toBe(true);
    expect(view.edges.some(e => e.source === c.id && e.target === f.id && e.kind === "derived_from")).toBe(true);
    expect(view.stats.truncated).toBe(false);
    rmSync(v, { recursive: true, force: true });
  });

  test("filters by owner — owner B sees nothing of owner A", () => {
    const v = fresh();
    observe(v, { kind: "observation", content: "alice's", actor: "alice", owner: "alice" });
    const view = buildGraphView(v, "bob");
    expect(view.nodes.length).toBe(0);
    expect(view.edges.length).toBe(0);
    rmSync(v, { recursive: true, force: true });
  });

  test("dedupes edges (caller error with duplicate derived_from doesn't inflate)", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    // Caller bug: duplicate IDs in derived_from
    const f = recordFact(v, {
      subject: "s", predicate: "p", object: "o",
      derived_from: [ep.id, ep.id, ep.id], confidence: 0.8, actor: "a", owner: "a",
    });
    const view = buildGraphView(v, "a");
    const dfEdges = view.edges.filter(e => e.source === f.id && e.target === ep.id && e.kind === "derived_from");
    expect(dfEdges.length).toBe(1);
    rmSync(v, { recursive: true, force: true });
  });

  test("respects limit option and sets truncated flag", () => {
    const v = fresh();
    for (let i = 0; i < 10; i++) {
      observe(v, { kind: "observation", content: `ep${i}`, actor: "a", owner: "a" });
    }
    const view = buildGraphView(v, "a", { limit: 5 });
    expect(view.nodes.length).toBe(5);
    expect(view.stats.truncated).toBe(true);
    rmSync(v, { recursive: true, force: true });
  });

  test("drops edges whose target was never added to the node set", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    recordFact(v, {
      subject: "s", predicate: "p", object: "o",
      // derived_from points to a nonexistent ID
      derived_from: [ep.id, "01-DOES-NOT-EXIST"], confidence: 0.8, actor: "a", owner: "a",
    });
    const view = buildGraphView(v, "a");
    expect(view.edges.some(e => e.target === "01-DOES-NOT-EXIST")).toBe(false);
    rmSync(v, { recursive: true, force: true });
  });

  test("skips tombstoned and forgotten records", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "doomed", actor: "a", owner: "a" });
    // Hard-erase by mutating the tombstone flag directly (simulate hardErase result)
    const epPath = join(v, "episodes", "a", ep.timestamp.slice(0, 10), `${ep.id}.md`);
    const parsed = matter(readFileSync(epPath, "utf8"));
    parsed.data.tombstone = true;
    writeFileSync(epPath, matter.stringify("erased", parsed.data), "utf8");

    const view = buildGraphView(v, "a");
    expect(view.nodes.some(n => n.id === ep.id)).toBe(false);
    rmSync(v, { recursive: true, force: true });
  });

  test("constants are exported and sane", () => {
    expect(GRAPH_VIEW_DEFAULT_LIMIT).toBe(2000);
    expect(GRAPH_VIEW_MAX_LIMIT).toBe(10000);
  });
});
