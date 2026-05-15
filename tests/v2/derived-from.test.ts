// Tests for addDerivedFrom — used by the PAI migration to wire cross-memory
// references after all records exist.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { observe } from "../../src/v2/layer1-episodic";
import { recordCognitive, addDerivedFrom, pathForCognitive } from "../../src/v2/layer3-cognitive";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-df-"));
  initAudit(dir);
  initVectorStore(dir);
  return dir;
}

describe("addDerivedFrom", () => {
  test("appends new IDs, dedupes, rebuilds links", () => {
    const v = fresh();
    const ep1 = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    const ep2 = observe(v, { kind: "observation", content: "y", actor: "a", owner: "a" });
    const c = recordCognitive(v, {
      kind: "belief", content: "test", confidence: 0.8,
      derived_from: [ep1.id], actor: "a", owner: "a",
    });
    const updated = addDerivedFrom(v, "a", c.id, [ep2.id, ep1.id], "a");
    expect(updated).not.toBeNull();
    expect(updated!.derived_from.length).toBe(2);
    expect(updated!.derived_from).toContain(ep1.id);
    expect(updated!.derived_from).toContain(ep2.id);

    const fm = matter(readFileSync(pathForCognitive(v, "a", c.id)!, "utf8")).data;
    expect(fm.links).toContain(`[[${ep1.id}]]`);
    expect(fm.links).toContain(`[[${ep2.id}]]`);
    rmSync(v, { recursive: true, force: true });
  });

  test("idempotent — no-op when all IDs already present", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "a", owner: "a" });
    const c = recordCognitive(v, {
      kind: "belief", content: "test", confidence: 0.8,
      derived_from: [ep.id], actor: "a", owner: "a",
    });
    const r = addDerivedFrom(v, "a", c.id, [ep.id], "a");
    expect(r).not.toBeNull();
    expect(r!.derived_from).toEqual([ep.id]);
    rmSync(v, { recursive: true, force: true });
  });

  test("owner-scoped: cross-tenant attempt returns null", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "x", actor: "alice", owner: "alice" });
    const c = recordCognitive(v, {
      kind: "belief", content: "alice's", confidence: 0.8,
      derived_from: [ep.id], actor: "alice", owner: "alice",
    });
    const r = addDerivedFrom(v, "bob", c.id, ["someid"], "bob");
    expect(r).toBeNull();
    rmSync(v, { recursive: true, force: true });
  });
});
