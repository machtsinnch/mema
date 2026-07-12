// v2.22.12 (l3-reflect finding) — reflection upsert must collapse ALL stale
// predecessors, not just one. When a subject is written under 2+ spellings that
// each formed a belief BEFORE the entity existed, registering the entity (name
// + alias) merges them into ONE reflection group. The single-match probes
// (alt_claim_key + entity_fallback) heal only ONE predecessor, so the other
// aliased-spelling belief stayed live forever — a permanent duplicate that
// double-surfaces in retrieval and inflates apparent corroboration.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { reflect } from "../../src/v2/layer3-reflection";
import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, recordFactWithSupersession } from "../../src/v2/layer2-semantic";
import { createEntity } from "../../src/v2/layer2-entities";
import { initAudit } from "../../src/v2/layer6-audit";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v22212-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

// Count NON-superseded belief files whose body asserts the given needle.
function liveBeliefs(vault: string, owner: string, needle: string): string[] {
  const dir = join(vault, "cognitive", owner, "belief");
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const parsed = matter(readFileSync(join(dir, f), "utf8"));
    if (parsed.data.superseded_by) continue;
    if (parsed.content.toLowerCase().includes(needle.toLowerCase())) out.push(f);
  }
  return out;
}

describe("Rule A — late entity merging two aliased-spelling beliefs", () => {
  test("registering the entity between runs leaves exactly ONE live belief", () => {
    const vault = fresh();
    // Run 1 — no entity yet: two spellings, each corroborated by 2 documents.
    const d1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const d2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    const d3 = observe(vault, { kind: "document", content: "c", actor: "t", owner: "o" });
    const d4 = observe(vault, { kind: "document", content: "d", actor: "t", owner: "o" });
    recordFact(vault, { subject: "Ardin", predicate: "created", object: "MemA", derived_from: [d1.id, d2.id], actor: "t", owner: "o" });
    recordFact(vault, { subject: "Ardin Ibraimi", predicate: "created", object: "MemA", derived_from: [d3.id, d4.id], actor: "t", owner: "o" });

    const self = ["Ardin Ibraimi"];
    const r1 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: self });
    // Two separate subject-spelling groups -> two beliefs before the entity.
    expect(r1.cognitive_records_created).toBe(2);
    expect(liveBeliefs(vault, "o", "created MemA").length).toBe(2);

    // The normal late-entity path: an approved person entity with the alias.
    createEntity(vault, { name: "Ardin Ibraimi", type: "person", aliases: ["Ardin"], actor: "t", owner: "o" });

    // Run 2 — both spellings now resolve to one entity => ONE group. The other
    // aliased predecessor must be superseded, not left live.
    const r2 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: self });
    expect(r2.cognitive_records_created).toBe(0);
    const live = liveBeliefs(vault, "o", "created MemA");
    expect(live.length).toBe(1);
    // The survivor now cites all four documents (merged corroboration).
    const survivor = matter(readFileSync(join(vault, "cognitive", "o", "belief", live[0]!), "utf8"));
    expect(survivor.content).toContain("independently stated in 4 documents");

    // A third run must remain idempotent — no new duplicate re-minted.
    const r3 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: self });
    expect(r3.cognitive_records_created).toBe(0);
    expect(liveBeliefs(vault, "o", "created MemA").length).toBe(1);

    rmSync(vault, { recursive: true, force: true });
  });
});

describe("Rule B — late entity merging two aliased-spelling current-state beliefs", () => {
  test("registering the entity between runs leaves exactly ONE live current-state belief", () => {
    const vault = fresh();
    const ep = observe(vault, { kind: "document", content: "cv", actor: "t", owner: "o" });
    // Each spelling gets a dated supersession history so Rule B concludes a
    // current value for BOTH before the entity exists.
    recordFactWithSupersession(vault, { subject: "Ardin", predicate: "works_at", object: "OldCorp", valid_from: "2018-01", derived_from: [ep.id], actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Ardin", predicate: "works_at", object: "Netcloud", valid_from: "2022-01", derived_from: [ep.id], actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Ardin Ibraimi", predicate: "works_at", object: "PriorAG", valid_from: "2019-01", derived_from: [ep.id], actor: "t", owner: "o" });
    recordFactWithSupersession(vault, { subject: "Ardin Ibraimi", predicate: "works_at", object: "Netcloud", valid_from: "2022-01", derived_from: [ep.id], actor: "t", owner: "o" });

    const self = ["Ardin Ibraimi"];
    const r1 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: self });
    expect(liveBeliefs(vault, "o", "currently works_at").length).toBe(2);
    expect(r1.abstained?.length).toBe(0);

    createEntity(vault, { name: "Ardin Ibraimi", type: "person", aliases: ["Ardin"], actor: "t", owner: "o" });

    const r2 = reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: self });
    // One merged group, one current value (Netcloud) — one live belief only.
    const live = liveBeliefs(vault, "o", "currently works_at");
    expect(live.length).toBe(1);
    expect(r2.abstained?.length).toBe(0);
    const survivor = matter(readFileSync(join(vault, "cognitive", "o", "belief", live[0]!), "utf8"));
    expect(survivor.content).toContain("Netcloud");

    rmSync(vault, { recursive: true, force: true });
  });
});
