// LocalHashEmbedder discrimination tests.
//
// The embedder is not "semantic" in the transformer sense — but it MUST do
// better than coin-flip on the kinds of queries that matter for an enterprise
// knowledge corpus:
//   - acronyms (NCPCS-3041, VAVGS, AKS)
//   - identifier suffixes
//   - paraphrase-light queries (synonyms with shared lexical surface)
//   - rare-word discrimination (rare tokens should weight higher)
//
// These are not transformer-quality results. They are sanity floors: if any
// of these fails, the embedder upgrade regressed.

import { describe, expect, test } from "bun:test";
import { LocalHashEmbedder } from "../../src/v2/layer5-embeddings";

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("LocalHashEmbedder v2 — discrimination", () => {
  const emb = new LocalHashEmbedder(512);

  test("acronym substring matches lift cosine above unrelated", async () => {
    const q = await emb.embed("NCPCS-3041 syslog");
    const related = await emb.embed("Customer ticket NCPCS-3041 reports failure in syslog forwarder");
    const unrelated = await emb.embed("Quarterly revenue review for the marketing department");
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
    // The related cosine should be meaningfully above noise (≥ 0.10)
    expect(cosine(q, related)).toBeGreaterThan(0.10);
  });

  test("partial token / n-gram match (paraphrase-light)", async () => {
    const q = await emb.embed("Azure Kubernetes Service monitoring");
    const related = await emb.embed("AKS cluster monitoring dashboards in Azure");
    const unrelated = await emb.embed("Italian pasta recipes for weeknight dinners");
    // The query and related share "monitoring", "Azure" stem, and partial n-grams
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });

  test("identical text → cosine 1.0 (determinism)", async () => {
    const text = "Marcel founded machtsinn and presented at Swiss Insurtech 2026.";
    const v1 = await emb.embed(text);
    const v2 = await emb.embed(text);
    expect(cosine(v1, v2)).toBeCloseTo(1.0, 6);
  });

  test("disjoint vocabularies → near-zero cosine", async () => {
    const a = await emb.embed("alpha beta gamma delta epsilon zeta eta theta");
    const b = await emb.embed("xyz pqr mno klm jkl uvw rst opq");
    // Char n-grams of disjoint vocab will still trigger some bucket overlap
    // via collisions, but the score should be well below "related" floor.
    expect(cosine(a, b)).toBeLessThan(0.30);
  });

  test("embedder name carries the version (cache invalidation)", () => {
    expect(emb.name).toContain("v2");
  });

  test("dim is 512 by default (was 256 in v1)", () => {
    expect(emb.dim).toBe(512);
    expect((emb as any).dim).toBe(512);
  });
});
