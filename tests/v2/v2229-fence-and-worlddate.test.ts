// v2.22.9 — regression tests for review-round findings:
//   1. [l1-episodic] recordCognitive silently dropped belief content and
//      injected frontmatter when the content began with a "---" YAML fence
//      (gray-matter parsed the body's own leading frontmatter). Mirror the
//      observe() leading-fence guard.
//   2. [l1-episodic] recordJudgment shared the same unguarded-fence content
//      corruption via its prose body.
//   3. [l3-reflect] Rule B (current-state) determined world-datedness / the
//      "since" date from the single earliest-by-valid_from fact. An ISO
//      ingestion-timestamp valid_from that sorts earlier than a genuinely
//      world-dated same-value fact then masked real currency — the belief was
//      silently dropped (no record, nothing in `abstained`) or lost its date.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { recordFact } from "../../src/v2/layer2-semantic";
import {
  recordCognitive, pathForCognitive, findCognitiveByClaimKey,
} from "../../src/v2/layer3-cognitive";
import { recordJudgment, readJudgment } from "../../src/v2/layer3-judgment";
import { reflect } from "../../src/v2/layer3-reflection";
import { observe } from "../../src/v2/layer1-episodic";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2229-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

const SINCE = "2019-01-01T00:00:00Z";

// ── F1 ────────────────────────────────────────────────────────────────
describe("F1: recordCognitive preserves a body that begins with a YAML fence", () => {
  const FENCED =
    "---\nclaim_key: HIJACKED-KEY\nbelief_kind: opinion\nfabricated: yes\n---\nActually the real belief is X.";

  test("fenced content is stored intact and injects no frontmatter", () => {
    const vault = fresh();
    const rec = recordCognitive(vault, {
      kind: "belief", content: FENCED, confidence: 0.9,
      derived_from: [], actor: "t", owner: "o",
    });
    const path = pathForCognitive(vault, "o", rec.id)!;
    const parsed = matter(readFileSync(path, "utf8"));

    // The entire fenced section survives in the body (readers .trim()).
    expect(parsed.content.trim()).toBe(FENCED);
    // None of the fenced keys were merged into the record's frontmatter.
    const fm = parsed.data as Record<string, unknown>;
    expect(fm.claim_key).toBeUndefined();
    expect(fm.belief_kind).toBeUndefined();
    expect(fm.fabricated).toBeUndefined();
    // The reflection identity is not hijacked.
    expect(findCognitiveByClaimKey(vault, "o", "HIJACKED-KEY")).toBeNull();
    rmSync(vault, { recursive: true, force: true });
  });

  test("benign markdown-note content starting with '---' round-trips", () => {
    const vault = fresh();
    const note = "---\ntitle: My Note\n---\nThe belief body follows the note header.";
    const rec = recordCognitive(vault, {
      kind: "observation", content: note, confidence: 0.7,
      derived_from: [], actor: "t", owner: "o",
    });
    const parsed = matter(readFileSync(pathForCognitive(vault, "o", rec.id)!, "utf8"));
    expect(parsed.content.trim()).toBe(note);
    expect((parsed.data as Record<string, unknown>).title).toBeUndefined();
    rmSync(vault, { recursive: true, force: true });
  });
});

// ── F2 ────────────────────────────────────────────────────────────────
describe("F2: recordJudgment preserves a decision that begins with a YAML fence", () => {
  test("fenced decision keeps its body and injects no stray frontmatter", () => {
    const vault = fresh();
    const decision = "---\ninjected: yes\n---\nAdopt the framework.";
    const j = recordJudgment(vault, {
      question: "adopt the framework?", decision, rationale: "good fit",
      based_on: [], actor: "t", owner: "o",
    });
    const parsed = matter(readFileSync(pathForCognitive(vault, "o", j.id)!, "utf8"));
    const fm = parsed.data as Record<string, unknown>;
    // The prose body retains the full decision + rationale.
    expect(parsed.content.trim()).toBe(`${decision}\n\nWhy: good fit`);
    // No stray key leaked out of the fenced body.
    expect(fm.injected).toBeUndefined();
    // The explicit decision field is still the real decision text.
    expect(fm.decision).toBe(decision);
    expect(readJudgment(vault, "o", j.id)!.decision).toBe(decision);
    rmSync(vault, { recursive: true, force: true });
  });
});

// ── F3 ────────────────────────────────────────────────────────────────
describe("F3: Rule B world-datedness spans ALL same-value facts, not the earliest", () => {
  // Two same-value live facts, no supersession history. One carries an ISO
  // ingestion-timestamp valid_from that sorts EARLIER than the other's real
  // world date. The ISO fact must not become the representative and mask the
  // genuine currency.
  const seed = (vault: string) => {
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    // ISO ingestion-timestamp fallback — sorts earliest as a string.
    recordFact(vault, {
      subject: "Ardin Ibraimi", predicate: "works_at", object: "Audi",
      valid_from: "2019-05-10T12:00:00.000Z", derived_from: [ep.id],
      actor: "t", owner: "o",
    });
    // Genuine world date — establishes real "since".
    recordFact(vault, {
      subject: "Ardin Ibraimi", predicate: "works_at", object: "Audi",
      valid_from: "2020-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
  };

  test("no supersession history: current-state belief is produced with the real since date", () => {
    const vault = fresh();
    seed(vault);
    const r = reflect({
      vaultRoot: vault, owner: "o", actor: "t", since: SINCE,
      self_names: ["Ardin Ibraimi"],
    });
    const belief = r.records.find(x => x.content.includes("currently works_at Audi"));
    expect(belief).toBeTruthy();
    // The world date is used for "since", not dropped.
    expect(belief!.content).toContain("since 2020-01-01");
    // Not silently dropped, and no phantom abstention either.
    expect(r.abstained?.some(a => a.rule === "current-state" && a.predicate === "works_at")).toBe(false);
    rmSync(vault, { recursive: true, force: true });
  });

  test("fact ordering is irrelevant: reversing insertion yields the same belief", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    // Insert world-dated first, ISO second — logically identical inputs.
    recordFact(vault, {
      subject: "Ardin Ibraimi", predicate: "works_at", object: "Audi",
      valid_from: "2020-01-01", derived_from: [ep.id], actor: "t", owner: "o",
    });
    recordFact(vault, {
      subject: "Ardin Ibraimi", predicate: "works_at", object: "Audi",
      valid_from: "2019-05-10T12:00:00.000Z", derived_from: [ep.id],
      actor: "t", owner: "o",
    });
    const r = reflect({
      vaultRoot: vault, owner: "o", actor: "t", since: SINCE,
      self_names: ["Ardin Ibraimi"],
    });
    const belief = r.records.find(x => x.content.includes("currently works_at Audi"));
    expect(belief).toBeTruthy();
    expect(belief!.content).toContain("since 2020-01-01");
    rmSync(vault, { recursive: true, force: true });
  });
});
