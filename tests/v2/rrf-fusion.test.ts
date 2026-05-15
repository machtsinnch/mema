// v2.9.0+ RRF fusion tests.

import { describe, expect, test } from "bun:test";
import { reciprocalRankFusion } from "../../src/v2/layer5-rrf";

describe("Reciprocal Rank Fusion", () => {
  test("empty input returns empty", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  test("single list returns same ordering", () => {
    const r = reciprocalRankFusion([{
      name: "kw",
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    }]);
    expect(r.map(x => x.id)).toEqual(["a", "b", "c"]);
    // 1/(60+1) > 1/(60+2) > 1/(60+3)
    expect(r[0].rrf_score).toBeGreaterThan(r[1].rrf_score);
  });

  test("documents appearing in multiple lists rank higher", () => {
    // 'a' appears top in both lists; 'b' appears 2nd in both; 'c' only in one.
    const r = reciprocalRankFusion([
      { name: "kw", items: [{ id: "a" }, { id: "b" }, { id: "c" }] },
      { name: "vec", items: [{ id: "a" }, { id: "b" }, { id: "d" }] },
    ]);
    const top = r[0];
    expect(top.id).toBe("a");
    expect(top.contributions.kw).toBeGreaterThan(0);
    expect(top.contributions.vec).toBeGreaterThan(0);

    const b = r.find(x => x.id === "b")!;
    const c = r.find(x => x.id === "c")!;
    // b has 2 contributions, c has 1 → b > c
    expect(b.rrf_score).toBeGreaterThan(c.rrf_score);
  });

  test("a top-1 in only one list can still be beaten by a top-3 in three lists", () => {
    // d: 1st in keyword only.
    // e: 3rd in keyword, vector, AND graph.
    const r = reciprocalRankFusion([
      { name: "kw", items: [{ id: "d" }, { id: "x" }, { id: "e" }] },
      { name: "vec", items: [{ id: "y" }, { id: "z" }, { id: "e" }] },
      { name: "graph", items: [{ id: "w" }, { id: "v" }, { id: "e" }] },
    ]);
    const d = r.find(x => x.id === "d")!;
    const e = r.find(x => x.id === "e")!;
    // d: 1/61 ≈ 0.01639
    // e: 3/63 ≈ 0.04762
    expect(e.rrf_score).toBeGreaterThan(d.rrf_score);
  });

  test("k parameter affects relative weighting", () => {
    const lists = [{ name: "kw", items: [{ id: "a" }, { id: "b" }] }];
    const r60 = reciprocalRankFusion(lists, 60);
    const r1 = reciprocalRankFusion(lists, 1);
    // Both rank a > b, but the gap is larger when k=1 (1/2 - 1/3 > 1/61 - 1/62).
    const gap60 = r60[0].rrf_score - r60[1].rrf_score;
    const gap1 = r1[0].rrf_score - r1[1].rrf_score;
    expect(gap1).toBeGreaterThan(gap60);
  });

  test("preserves the payload of the first list a doc appeared in", () => {
    const r = reciprocalRankFusion([
      { name: "kw", items: [{ id: "a", payload: "kw-version" } as any] },
      { name: "vec", items: [{ id: "a", payload: "vec-version" } as any] },
    ]);
    expect((r[0].hit as any).payload).toBe("kw-version");
  });
});
