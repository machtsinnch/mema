// v2.18.0 — Ardin's knowledge labels + world-claim boundary (2026-07-10):
//   - every rule-made belief carries belief_kind "personal"
//   - world claims (subject not in the owner's own world) NEVER become
//     Layer 3 beliefs — the Layer 2 facts get corroboration_sources
//     instead, and the report lists them under world_claims.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reflect } from "../../src/v2/layer3-reflection";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, recordFactWithSupersession, readFact } from "../../src/v2/layer2-semantic";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2180-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

describe("world claims stay in Layer 2", () => {
  test("corroborated world claim → no belief, facts annotated, report lists it", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "ardin", owner: "ardin-pai" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "ardin", owner: "ardin-pai" });
    const f1 = recordFact(vault, { subject: "Hock Tan", predicate: "sold", object: "Broadcom", derived_from: [ep1.id], actor: "ardin", owner: "ardin-pai" });
    const f2 = recordFact(vault, { subject: "Hock Tan", predicate: "sold", object: "Broadcom", derived_from: [ep2.id], actor: "ardin", owner: "ardin-pai" });

    const r = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r.cognitive_records_created).toBe(0);
    expect(r.world_claims).toHaveLength(1);
    expect(r.world_claims![0]).toMatchObject({ subject: "Hock Tan", object: "Broadcom", sources: 2 });
    // The agreement lives ON the facts now:
    expect(readFact(vault, "ardin-pai", f1.id)?.corroboration_sources).toBe(2);
    expect(readFact(vault, "ardin-pai", f2.id)?.corroboration_sources).toBe(2);
    rmSync(vault, { recursive: true, force: true });
  });

  test("self subject still becomes a belief, labeled personal", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "ardin", owner: "ardin-pai" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "ardin", owner: "ardin-pai" });
    // "ardin.me" shares the owner token "ardin" → owner's own world.
    recordFact(vault, { subject: "ardin.me", predicate: "deploys_to", object: "Cloudflare Pages", derived_from: [ep1.id], actor: "ardin", owner: "ardin-pai" });
    recordFact(vault, { subject: "ardin.me", predicate: "deploys_to", object: "cloudflare pages", derived_from: [ep2.id], actor: "ardin", owner: "ardin-pai" });

    const r = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r.cognitive_records_created).toBe(1);
    expect(r.records[0].belief_kind).toBe("personal");
    expect(r.world_claims).toHaveLength(0);
    rmSync(vault, { recursive: true, force: true });
  });

  test("re-run over unchanged world claims writes nothing new (idempotent)", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "ardin", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "ardin", owner: "o" });
    const f1 = recordFact(vault, { subject: "TSMC", predicate: "supplies", object: "Nvidia", derived_from: [ep1.id], actor: "ardin", owner: "o" });
    recordFact(vault, { subject: "TSMC", predicate: "supplies", object: "Nvidia", derived_from: [ep2.id], actor: "ardin", owner: "o" });

    reflect({ vaultRoot: vault, owner: "o", actor: "ardin", since: SINCE });
    const stamp1 = readFact(vault, "o", f1.id)?.corroboration_updated_at;
    const r2 = reflect({ vaultRoot: vault, owner: "o", actor: "ardin", since: SINCE });
    const stamp2 = readFact(vault, "o", f1.id)?.corroboration_updated_at;
    expect(r2.cognitive_records_created).toBe(0);
    expect(stamp2).toBe(stamp1);          // same count → no rewrite
    expect(r2.world_claims).toHaveLength(1); // still visible in the report
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("belief labels", () => {
  test("Rule B current-state belief carries belief_kind personal", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "x", actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Marcel", predicate: "works_at", object: "Google", valid_from: "2020-03", derived_from: [ep.id], actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Marcel", predicate: "works_at", object: "Anthropic", valid_from: "2024-01", derived_from: [ep.id], actor: "t", owner: "o" });
    const r = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE });
    const belief = r.records.find(x => x.content.includes("currently"));
    expect(belief?.belief_kind).toBe("personal");
    rmSync(vault, { recursive: true, force: true });
  });

  test("pre-label records get the label backfilled on the next run", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "ardin", owner: "ardin-pai" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "ardin", owner: "ardin-pai" });
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [ep1.id], actor: "ardin", owner: "ardin-pai" });
    recordFact(vault, { subject: "ardin.me", predicate: "uses", object: "Astro", derived_from: [ep2.id], actor: "ardin", owner: "ardin-pai" });

    const r1 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r1.records[0].belief_kind).toBe("personal");
    // Simulate a pre-v2.18 record: strip the label from the file.
    const { readFileSync, writeFileSync, readdirSync } = require("node:fs");
    const dir = join(vault, "cognitive", "ardin-pai", "belief");
    for (const f of readdirSync(dir)) {
      writeFileSync(join(dir, f), readFileSync(join(dir, f), "utf8").replace(/^belief_kind:.*\n/m, ""));
    }
    const r2 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r2.updated).toBe(1);           // backfilled in place, not duplicated
    expect(r2.cognitive_records_created).toBe(0);
    const r3 = reflect({ vaultRoot: vault, owner: "ardin-pai", actor: "ardin", since: SINCE });
    expect(r3.unchanged).toBe(1);         // and stable afterwards
    rmSync(vault, { recursive: true, force: true });
  });
});
