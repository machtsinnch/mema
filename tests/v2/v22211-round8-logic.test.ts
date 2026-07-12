// v2.22.11 — regression tests for review-round-8 findings:
//   F1 (l2-extract): a single non-string subject/predicate/object slot (the
//                    model renders an object as a bare JSON number) no longer
//                    crashes parseStrictJson and discards EVERY fact from the
//                    chunk/document — only the malformed triple is dropped, its
//                    valid siblings still extract.
//   F2 (l3-reflect): subjKeyOf skips a fact's DRAFT/REJECTED subject_entity_id
//                    so raw-name facts and draft/rejected-linked facts about the
//                    same subject unify under one corroboration group (Rule A no
//                    longer fragments and loses the belief).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OllamaExtractor } from "../../src/v2/llm-extractor";
import { recordFact } from "../../src/v2/layer2-semantic";
import { createEntity, rejectEntity } from "../../src/v2/layer2-entities";
import { observe } from "../../src/v2/layer1-episodic";
import { reflect } from "../../src/v2/layer3-reflection";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v22211-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

describe("F1: a numeric subject/predicate/object slot drops only that fact, not the whole batch", () => {
  const realFetch = globalThis.fetch;

  test("model emits three facts, one with object:2024 — the two valid siblings still extract", async () => {
    // The exact scenario: a weak model, despite the prompt rejecting numeric
    // objects, renders one object as a bare JSON number. Pre-fix, the
    // (2024).toLowerCase() inside filterFewShotLeak threw TypeError, the
    // exception propagated out of parseStrictJson, and extract() rejected —
    // losing the two perfectly valid sibling facts too.
    const modelJson = JSON.stringify({
      facts: [
        { subject: "Ardin", predicate: "founded", object: "Machtsinn AG", confidence: 0.95 },
        { subject: "Machtsinn AG", predicate: "uses", object: "TypeScript", confidence: 0.9 },
        { subject: "Machtsinn AG", predicate: "founded_in", object: 2024, confidence: 0.9 },
      ],
      entities: [],
    });
    // @ts-expect-error — test stub
    globalThis.fetch = async () => new Response(
      JSON.stringify({ message: { content: modelJson } }),
      { status: 200 },
    );
    try {
      const ex = new OllamaExtractor();
      const res = await ex.extract("Ardin founded Machtsinn AG. Machtsinn AG uses TypeScript.");
      // The malformed numeric-object triple is dropped...
      expect(res.facts.some(f => f.predicate === "founded_in")).toBe(false);
      // ...but BOTH valid siblings survive (pre-fix: zero facts, a thrown pass).
      expect(res.facts.some(f => f.subject === "Ardin" && f.object === "Machtsinn AG")).toBe(true);
      expect(res.facts.some(f => f.subject === "Machtsinn AG" && f.object === "TypeScript")).toBe(true);
      expect(res.facts.length).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("F2: subjKeyOf skips a draft/rejected subject_entity_id so corroboration does not fragment", () => {
  // Two documents state the identical self-claim; one fact is unlinked (raw
  // name) and the other is linked to a NON-approved entity id. They must group
  // together and produce ONE corroboration belief.
  function twoCorroboratingFacts(vault: string, linkId: string): void {
    const ep1 = observe(vault, { kind: "document", content: "doc-one", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "doc-two", actor: "t", owner: "o" });
    // fact1: ingested before the entity existed — no subject_entity_id (raw).
    recordFact(vault, {
      subject: "Ardin", predicate: "created", object: "MemA",
      derived_from: [ep1.id], actor: "t", owner: "o",
    });
    // fact2: ingested while the (non-approved) entity existed — carries its id,
    // because the ingest resolver findEntityByName does NOT filter by status.
    recordFact(vault, {
      subject: "Ardin", predicate: "created", object: "MemA",
      derived_from: [ep2.id], actor: "t", owner: "o", subject_entity_id: linkId,
    });
  }

  test("DRAFT-linked sibling unifies with the raw-name sibling → one belief", () => {
    const vault = fresh();
    // A pending-review DRAFT entity for the same subject.
    const draft = createEntity(vault, { name: "Ardin", type: "person", status: "draft", actor: "t", owner: "o" });
    twoCorroboratingFacts(vault, draft.id);

    const rep = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    // Pre-fix: subjKeyOf(fact2)=draft_id, subjKeyOf(fact1)="ardin" → two groups
    // of one, both below minSources=2 → zero beliefs. Post-fix: one group of
    // two distinct documents → one corroboration belief.
    expect(rep.cognitive_records_created).toBe(1);
    expect(rep.records[0].content).toContain("Ardin created MemA");
    expect(rep.records[0].content).toContain("2 documents");
    rmSync(vault, { recursive: true, force: true });
  });

  test("REJECTED-linked sibling unifies with the raw-name sibling → one belief", () => {
    const vault = fresh();
    // An entity that was created, approved, then reviewer-rejected. Its stale
    // id still rides on facts ingested while it was live.
    const ent = createEntity(vault, { name: "Ardin", type: "person", actor: "t", owner: "o" });
    rejectEntity(vault, ent.id, "o", "t", "not a real person");
    twoCorroboratingFacts(vault, ent.id);

    const rep = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    expect(rep.cognitive_records_created).toBe(1);
    expect(rep.records[0].content).toContain("Ardin created MemA");
    rmSync(vault, { recursive: true, force: true });
  });
});
