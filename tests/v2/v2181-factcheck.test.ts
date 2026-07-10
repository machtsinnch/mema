// v2.18.1 — internet fact-check as Layer 2 enrichment. Tests cover the
// deterministic parts only (no CLI/network in tests): verdict parsing,
// the stamp on fact records, and retrieval demotion of contradicted facts.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFactCheck, claimSentence, listUnverifiedClaims, factCheckUnverified, factCheckAutoEnabled,
} from "../../src/v2/layer2-factcheck";
import { annotateFactCorroboration } from "../../src/v2/layer2-semantic";
import { recordFact, readFact, annotateFactVerification } from "../../src/v2/layer2-semantic";
import { observe } from "../../src/v2/layer1-episodic";
import { recall } from "../../src/v2/layer5-retrieval";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2181-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("parseFactCheck", () => {
  test("parses bare JSON", () => {
    const r = parseFactCheck('{"verdict":"confirmed","note":"Yes.","sources":["https://a"]}');
    expect(r.verdict).toBe("confirmed");
    expect(r.sources).toEqual(["https://a"]);
  });

  test("survives fences and surrounding prose", () => {
    const r = parseFactCheck('Here you go:\n```json\n{"verdict":"contradicted","note":"No — X is true instead.","sources":[]}\n```\n');
    expect(r.verdict).toBe("contradicted");
  });

  test("rejects unknown verdicts and non-JSON", () => {
    expect(() => parseFactCheck('{"verdict":"maybe","note":"","sources":[]}')).toThrow();
    expect(() => parseFactCheck("no json here")).toThrow();
  });

  test("claimSentence reads naturally with the world date", () => {
    expect(claimSentence({ subject: "TSMC", predicate: "located_in", object: "Taiwan", as_of: "1987-02" }))
      .toBe("TSMC located in Taiwan (as of 1987-02)");
  });
});

describe("verification stamp on fact records", () => {
  test("writes verdict + note + sources + timestamp; idempotent on same stamp", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const f = recordFact(vault, { subject: "TSMC", predicate: "located_in", object: "Taiwan", derived_from: [ep.id], actor: "t", owner: "o" });

    const stamp = { verdict: "confirmed", note: "HQ is in Hsinchu, Taiwan.", sources: ["https://example.org"] };
    expect(annotateFactVerification(vault, "o", f.id, stamp, "t")).toBe(true);
    const read = readFact(vault, "o", f.id);
    expect(read?.verification).toBe("confirmed");
    expect(read?.verification_note).toContain("Hsinchu");
    expect(read?.verification_sources).toEqual(["https://example.org"]);
    expect(read?.verification_checked_at).toBeDefined();
    // Same stamp again → no rewrite.
    expect(annotateFactVerification(vault, "o", f.id, stamp, "t")).toBe(false);
    // Changed verdict → rewrite.
    expect(annotateFactVerification(vault, "o", f.id, { ...stamp, verdict: "contradicted" }, "t")).toBe(true);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("retrieval demotes contradicted facts", () => {
  test("a web-contradicted fact ranks below an equal clean one", async () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "chip fabs report", actor: "t", owner: "o" });
    const clean = recordFact(vault, { subject: "Quorix", predicate: "headquartered_in", object: "Zug", derived_from: [ep.id], actor: "t", owner: "o" });
    const wrong = recordFact(vault, { subject: "Quorix", predicate: "headquartered_in", object: "Berlin", derived_from: [ep.id], actor: "t", owner: "o" });
    annotateFactVerification(vault, "o", wrong.id, { verdict: "contradicted", note: "HQ is Zug.", sources: ["https://example.org"] }, "t");

    const r = await recall(vault, { query: "Quorix headquartered", owner: "o", actor: "t", purpose: "test" });
    const cleanHit = r.hits.find(h => h.kind === "fact" && h.id === clean.id);
    const wrongHit = r.hits.find(h => h.kind === "fact" && h.id === wrong.id);
    expect(cleanHit).toBeDefined();
    expect(wrongHit).toBeDefined();
    expect(cleanHit!.score).toBeGreaterThan(wrongHit!.score);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("automatic fact-check pass (v2.18.2)", () => {
  test("checks only unverified corroborated claims, respects the limit, stamps all facts", async () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    // Two corroborated claims (2 facts each) + one uncorroborated fact.
    const ids: string[] = [];
    for (const [s, p, ob] of [["TSMC", "supplies", "Nvidia"], ["ASML", "supplies", "TSMC"]] as const) {
      for (const ep of [ep1, ep2]) {
        const f = recordFact(vault, { subject: s, predicate: p, object: ob, derived_from: [ep.id], actor: "t", owner: "o" });
        annotateFactCorroboration(vault, "o", f.id, 2, "t");
        ids.push(f.id);
      }
    }
    recordFact(vault, { subject: "Zug", predicate: "hosts", object: "Quorix", derived_from: [ep1.id], actor: "t", owner: "o" });

    expect(listUnverifiedClaims(vault, "o")).toHaveLength(2);

    // Stubbed checker — no web, deterministic.
    const seen: string[] = [];
    const checker = async (c: { subject: string }) => {
      seen.push(c.subject);
      return { verdict: "confirmed" as const, note: "stub", sources: ["https://example.org"] };
    };

    const r1 = await factCheckUnverified(vault, "o", "t", { limit: 1, checker });
    expect(r1.checked).toHaveLength(1);
    expect(r1.pending).toBe(1);
    expect(r1.checked[0].factsStamped).toBe(2);

    // Second pass picks up the remaining claim and skips the stamped one.
    const r2 = await factCheckUnverified(vault, "o", "t", { limit: 5, checker });
    expect(r2.checked).toHaveLength(1);
    expect(r2.pending).toBe(0);
    expect(new Set(seen).size).toBe(2);

    // Nothing left.
    expect(listUnverifiedClaims(vault, "o")).toHaveLength(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("a failing check is reported and does not block the rest", async () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    for (const [s, ob] of [["A", "B"], ["C", "D"]] as const) {
      for (const ep of [ep1, ep2]) {
        const f = recordFact(vault, { subject: s, predicate: "supplies", object: ob, derived_from: [ep.id], actor: "t", owner: "o" });
        annotateFactCorroboration(vault, "o", f.id, 2, "t");
      }
    }
    let n = 0;
    const checker = async () => {
      if (++n === 1) throw new Error("boom");
      return { verdict: "unverifiable" as const, note: "stub", sources: [] };
    };
    const r = await factCheckUnverified(vault, "o", "t", { limit: 5, checker });
    expect(r.errors).toHaveLength(1);
    expect(r.checked).toHaveLength(1);
    rmSync(vault, { recursive: true, force: true });
  });

  test("auto mode is off under bun test unless forced on", () => {
    expect(factCheckAutoEnabled()).toBe(false);   // NODE_ENV=test here
    process.env.MEMA_FACTCHECK_AUTO = "true";
    expect(factCheckAutoEnabled()).toBe(true);
    process.env.MEMA_FACTCHECK_AUTO = "false";
    expect(factCheckAutoEnabled()).toBe(false);
    delete process.env.MEMA_FACTCHECK_AUTO;
  });
});
