// v2.22.5 — regression test for review-round-5 finding:
//   (l3-reflect): Rule B (current-state) minted a DUPLICATE live belief when a
//   name-resolved subject's entity is REJECTED between reflect runs. Rule A got
//   the entity->raw key-migration fallback in v2.22.4; Rule B lacked it, so the
//   surviving entity-id-keyed belief was missed and a second identical live
//   belief was created. This proves the fallback now heals Rule B too.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
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
  const dir = mkdtempSync(join(tmpdir(), "mema-v2225-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2019-01-01T00:00:00Z";

// Count non-superseded belief records on disk for an owner.
function liveBeliefs(vault: string, owner: string): Array<{ claim_key?: string; content: string }> {
  const dir = join(vault, "cognitive", owner, "belief");
  if (!existsSync(dir)) return [];
  const out: Array<{ claim_key?: string; content: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const p = matter(readFileSync(join(dir, f), "utf8"));
    const fm = p.data as Record<string, unknown>;
    if (fm.superseded_by) continue;
    out.push({ claim_key: fm.claim_key as string | undefined, content: p.content.trim() });
  }
  return out;
}

describe("F1: Rule B (current-state) does not duplicate its belief when the subject entity is rejected", () => {
  test("belief count stays 1 across approve -> reflect -> reject -> reflect", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "employment note", actor: "t", owner: "o" });
    // One UNLINKED current-state fact carrying a WORLD date (so Rule B concludes
    // "currently works_at" from the dated fact even with no supersession history).
    recordFact(vault, {
      subject: "John Smith", predicate: "works_at", object: "Google",
      valid_from: "2020", derived_from: [ep.id], actor: "t", owner: "o",
    });
    // (1) Register+approve the subject entity so subjKeyOf resolves the raw name
    // to its id and Rule B keys the belief `current|<ENTID>|works_at`.
    const john = createEntity(vault, { name: "John Smith", type: "person", actor: "t", owner: "o" });
    reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["John Smith"] });
    const afterApprove = liveBeliefs(vault, "o");
    expect(afterApprove.length).toBe(1);
    expect(afterApprove[0].claim_key).toContain(john.id);   // keyed by the entity id

    // (2) Reviewer rejects the entity (e.g. flagged as hallucinated).
    rejectEntity(vault, john.id, "o", "t", "not a real person");
    // (3) reflect re-runs: subjKeyOf falls back to the raw name and the group
    // key reverts to `current|john smith|works_at`. Pre-fix, Rule B minted a
    // SECOND live belief keyed by the raw name while the entity-id-keyed
    // survivor lingered — two live beliefs for the identical claim.
    reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["John Smith"] });
    const afterReject = liveBeliefs(vault, "o");
    expect(afterReject.length).toBe(1);                     // still exactly ONE — no duplicate
    expect(afterReject[0].content).toContain("John Smith currently works_at Google");
    // The key healed onto the raw-name form so it stops drifting on later runs.
    expect(afterReject[0].claim_key).toBe("current|john smith|works_at");

    // (4) a third run is a pure no-op now that the key is stable.
    reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["John Smith"] });
    expect(liveBeliefs(vault, "o").length).toBe(1);
    rmSync(vault, { recursive: true, force: true });
  });
});
