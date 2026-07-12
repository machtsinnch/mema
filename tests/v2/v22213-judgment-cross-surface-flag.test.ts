// v2.22.13 — living-loop cross-surface flag (l3-judgment breaker). A
// judgment freezes its foundation fact's watches at CREATION. When the
// foundation fact was written BEFORE its entity existed, its
// subject_entity_id was null, so watches captured only the raw subject
// string. A later contradicting fact about the SAME entity carrying a
// DIFFERENT surface string then slipped past flagging — the judgment loop
// was strictly weaker than the L2 supersession it mirrors (which bridges
// surface strings through the entity link). The fix flags the judgment
// when the incoming fact's entity name/aliases intersect the watches.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordJudgment, readJudgment, flagJudgmentsForFact } from "../../src/v2/layer3-judgment";
import { recordFact } from "../../src/v2/layer2-semantic";
import { createEntity } from "../../src/v2/layer2-entities";
import { observe } from "../../src/v2/layer1-episodic";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v22213-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

describe("living loop flags a same-entity fact whose surface string differs from the frozen watch", () => {
  test("foundation fact predated the entity: a later fact about the same entity flags via the entity link", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "scouting notes", actor: "a", owner: "o" });

    // F1 recorded BEFORE the entity is registered: subject_entity_id null.
    // The judgment freezes watches = ["marcel schmidt"] (raw string only).
    const f1 = recordFact(vault, {
      subject: "Marcel Schmidt", predicate: "plays_for", object: "Bayern",
      derived_from: [ep1.id], actor: "a", owner: "o",
    });
    expect(f1.subject_entity_id ?? null).toBeNull();

    const j = recordJudgment(vault, {
      question: "Should we sign Marcel Schmidt?",
      decision: "Sign a 5-year deal with Marcel Schmidt",
      rationale: "Anchor at Bayern, prime years ahead",
      based_on: [f1.id, ep1.id],
      actor: "a", owner: "o",
    });
    expect(j.watches).toContain("marcel schmidt");
    expect(j.watches).not.toContain("marcel");

    // The entity is registered only now, with the surface string "Marcel
    // Schmidt" as an alias — the same person the judgment stands on.
    const ent = createEntity(vault, {
      name: "Marcel", type: "person", aliases: ["Marcel Schmidt"],
      actor: "a", owner: "o",
    });

    // F2: a directly-contradicting fact about the SAME entity, carrying a
    // DIFFERENT surface string "Marcel" plus the entity link.
    const ep2 = observe(vault, { kind: "document", content: "transfer news", actor: "a", owner: "o" });
    const f2 = recordFact(vault, {
      subject: "Marcel", predicate: "transfers_to", object: "Dortmund",
      subject_entity_id: ent.id,
      derived_from: [ep2.id], actor: "a", owner: "o",
    });
    // Guard: watches contains neither the entity id nor "marcel", so only
    // the entity-name bridge can flag this. Pre-fix this returned 0.
    expect(j.watches).not.toContain(ent.id);
    const flagged = flagJudgmentsForFact(vault, "o", f2, "a");
    expect(flagged).toBe(1);
    const jAfter = readJudgment(vault, "o", j.id)!;
    expect(jAfter.review_flags?.some(fl => fl.fact_id === f2.id)).toBe(true);
  });

  test("control: a fact with the identical surface string still flags (existing path unchanged)", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "scouting notes", actor: "a", owner: "o" });
    const f1 = recordFact(vault, {
      subject: "Marcel Schmidt", predicate: "plays_for", object: "Bayern",
      derived_from: [ep1.id], actor: "a", owner: "o",
    });
    const j = recordJudgment(vault, {
      question: "Should we sign Marcel Schmidt?",
      decision: "Sign a 5-year deal with Marcel Schmidt",
      rationale: "Anchor at Bayern",
      based_on: [f1.id, ep1.id],
      actor: "a", owner: "o",
    });
    const ep2 = observe(vault, { kind: "document", content: "transfer news", actor: "a", owner: "o" });
    const f2 = recordFact(vault, {
      subject: "Marcel Schmidt", predicate: "transfers_to", object: "Dortmund",
      derived_from: [ep2.id], actor: "a", owner: "o",
    });
    expect(flagJudgmentsForFact(vault, "o", f2, "a")).toBe(1);
    const jAfter = readJudgment(vault, "o", j.id)!;
    expect(jAfter.review_flags?.some(fl => fl.fact_id === f2.id)).toBe(true);
  });
});
