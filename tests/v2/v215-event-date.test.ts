// v2.15.0 — L1→L2 transition fixes: event_date extraction (Bug B),
// partial-chunk reporting (silent-timeout finding from the 2026-07-08
// live run), and the sanitize boundary for model-supplied dates.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeEventDate, mergeExtractionResults, type ExtractionResult,
} from "../../src/v2/llm-extractor";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFactWithSupersession, readFact } from "../../src/v2/layer2-semantic";
import { initAudit } from "../../src/v2/layer6-audit";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v215-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("sanitizeEventDate", () => {
  test("accepts YYYY, YYYY-MM, YYYY-MM-DD", () => {
    expect(sanitizeEventDate("1991")).toBe("1991");
    expect(sanitizeEventDate("2023-09")).toBe("2023-09");
    expect(sanitizeEventDate("2026-05-26")).toBe("2026-05-26");
    expect(sanitizeEventDate(" 2020-01-01 ")).toBe("2020-01-01");
  });

  test("rejects garbage, prose, timestamps, impossible dates", () => {
    expect(sanitizeEventDate(null)).toBeNull();
    expect(sanitizeEventDate(undefined)).toBeNull();
    expect(sanitizeEventDate("")).toBeNull();
    expect(sanitizeEventDate("last week")).toBeNull();
    expect(sanitizeEventDate("2026-07-08T19:00:11Z")).toBeNull();  // no invented precision
    expect(sanitizeEventDate("2026-13")).toBeNull();               // month 13
    expect(sanitizeEventDate("26-05")).toBeNull();                 // 2-digit year
    expect(sanitizeEventDate("0001")).toBeNull();                  // implausible year
    expect(sanitizeEventDate("9999")).toBeNull();
    expect(sanitizeEventDate(1991 as unknown as string)).toBeNull(); // non-string
  });
});

describe("mergeExtractionResults preserves event_date", () => {
  test("first occurrence of a duplicate triple wins, date included", () => {
    const a: ExtractionResult = {
      facts: [{ subject: "CoALA", predicate: "published_in", object: "2023", confidence: 0.95, event_date: "2023" }],
      entities: [],
    };
    const b: ExtractionResult = {
      facts: [{ subject: "CoALA", predicate: "published_in", object: "2023", confidence: 0.9, event_date: null }],
      entities: [],
    };
    const merged = mergeExtractionResults([a, b]);
    expect(merged.facts.length).toBe(1);
    expect(merged.facts[0].event_date).toBe("2023");
  });
});

describe("event_date drives bi-temporal supersession (Bug B/C fix)", () => {
  test("backfilling an OLD document no longer overwrites newer truth", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });

    // Ingest the CURRENT truth first (world date 2026).
    const current = recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Anthropic",
      valid_from: "2026-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(current.written).not.toBeNull();

    // Now ingest an OLD document stating the 2020 employer. Pre-v2.15 the
    // auto path stamped it with ingestion time (later than 2026-01-01) and
    // it SUPERSEDED the current truth. With event_date it classifies as a
    // historical backfill: ADD, supersedes nothing.
    const backfill = recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Google",
      valid_from: "2020-03-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(backfill.written).not.toBeNull();
    expect(backfill.decision.kind).toBe("ADD");
    expect(backfill.supersededIds.length).toBe(0);

    // The 2026 fact is still current (not invalidated).
    const stillCurrent = readFact(vault, "o", current.written!.id);
    expect(stillCurrent?.invalidated_at).toBeNull();
    rmSync(vault, { recursive: true, force: true });
  });

  test("a NEWER world date still supersedes the older truth", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    const old = recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Google",
      valid_from: "2020-03-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    const next = recordFactWithSupersession(vault, {
      subject: "Marcel", predicate: "works_at", object: "Anthropic",
      valid_from: "2026-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    expect(next.decision.kind).toBe("UPDATE");
    expect(next.supersededIds).toContain(old.written!.id);
    rmSync(vault, { recursive: true, force: true });
  });
});
