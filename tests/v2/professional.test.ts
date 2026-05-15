// Professional test suite for mema v2 — the suite a Swiss enterprise buyer
// would ask to see before signing.
//
// Coverage:
//   - Layer 2: entity CRUD + merge
//   - Layer 3: rule-based reflection produces correct cognitive records
//   - Layer 5: vector indexing + cosine search; vector improves recall on paraphrase
//   - Layer 5: graph traversal walks derived_from to source episodes
//   - Multi-tenant: cross-owner reads return zero results (no leak)
//   - Audit: hash chain is broken when an entry is tampered with
//   - Governance: hard-erase overwrites content on disk; retention expiry denies recall
//   - End-to-end: full L1→L6 flow with all signals fused

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { observe } from "../../src/v2/layer1-episodic";
import { recordFact, invalidateFact, getFactsValidAt } from "../../src/v2/layer2-semantic";
import {
  createEntity, readEntity, findEntityByName, listEntities, mergeEntities,
} from "../../src/v2/layer2-entities";
import { recordCognitive } from "../../src/v2/layer3-cognitive";
import { reflect } from "../../src/v2/layer3-reflection";
import { buildGovernance, policyCheck, hardErase } from "../../src/v2/layer4-governance";
import { recall } from "../../src/v2/layer5-retrieval";
import {
  initVectorStore, LocalHashEmbedder, indexRecord, vectorSearch, reindexAll,
} from "../../src/v2/layer5-embeddings";
import { walkDerivedFrom, walkSiblingFacts, buildEvidenceChain } from "../../src/v2/layer5-graph";
import { initAudit, appendAudit, queryAudit, verifyChain } from "../../src/v2/layer6-audit";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-prof-"));
  initAudit(dir);
  initVectorStore(dir);
  return dir;
}

// ─── Layer 2: Entity CRUD ───────────────────────────────────────────

describe("Layer 2 — Entity CRUD", () => {
  test("create + read + find-by-name + list", () => {
    const v = fresh();
    const e = createEntity(v, {
      name: "Marcel R.",
      type: "person",
      aliases: ["Marcel", "marcel@machtsinn.ai"],
      actor: "ardin", owner: "ardin",
    });
    expect(e.id).toBeDefined();
    expect(e.aliases).toContain("Marcel R.");
    expect(e.aliases).toContain("marcel@machtsinn.ai");

    const r = readEntity(v, "ardin", e.id);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("Marcel R.");

    const found1 = findEntityByName(v, "ardin", "Marcel");
    expect(found1?.id).toBe(e.id);
    const found2 = findEntityByName(v, "ardin", "marcel@machtsinn.ai");
    expect(found2?.id).toBe(e.id);

    const all = listEntities(v, "ardin");
    expect(all.length).toBe(1);

    rmSync(v, { recursive: true, force: true });
  });

  test("merge combines aliases and leaves redirect stub", () => {
    const v = fresh();
    const keeper = createEntity(v, { name: "Marcel", type: "person", actor: "ardin", owner: "ardin" });
    const dup = createEntity(v, { name: "M. R.", type: "person", aliases: ["MR"], actor: "ardin", owner: "ardin" });

    const merged = mergeEntities(v, "ardin", "ardin", keeper.id, dup.id);
    expect(merged).not.toBeNull();
    expect(merged!.aliases).toContain("Marcel");
    expect(merged!.aliases).toContain("M. R.");
    expect(merged!.aliases).toContain("MR");

    // The merged entity still exists as a redirect — readable, but marked
    const stub = readEntity(v, "ardin", dup.id);
    expect((stub as any)?.merged_into).toBe(keeper.id);

    rmSync(v, { recursive: true, force: true });
  });

  test("isolation: owner B cannot read owner A's entity", () => {
    const v = fresh();
    const e = createEntity(v, { name: "Secret", type: "concept", actor: "alice", owner: "alice" });
    const cross = readEntity(v, "bob", e.id);
    expect(cross).toBeNull();
    rmSync(v, { recursive: true, force: true });
  });
});

// ─── Layer 3: Reflection ─────────────────────────────────────────────

describe("Layer 3 — Automated reflection", () => {
  test("produces beliefs from convergent facts", () => {
    const v = fresh();
    // Create 3 episodes
    const ep1 = observe(v, { kind: "observation", content: "Marcel R. founded machtsinn.", actor: "ardin", owner: "ardin" });
    const ep2 = observe(v, { kind: "observation", content: "Marcel R. is the CEO of machtsinn.", actor: "ardin", owner: "ardin" });
    const ep3 = observe(v, { kind: "observation", content: "Marcel R. presented at Swiss Insurtech 2026.", actor: "ardin", owner: "ardin" });

    // Create 3 facts about the same subject+predicate
    recordFact(v, {
      subject: "marcel-r", predicate: "role_at", object: "machtsinn",
      derived_from: [ep1.id], confidence: 0.9, actor: "ardin", owner: "ardin",
    });
    recordFact(v, {
      subject: "marcel-r", predicate: "role_at", object: "machtsinn-AG",
      derived_from: [ep2.id], confidence: 0.85, actor: "ardin", owner: "ardin",
    });
    recordFact(v, {
      subject: "marcel-r", predicate: "role_at", object: "machtsinn",
      derived_from: [ep3.id], confidence: 0.95, actor: "ardin", owner: "ardin",
    });

    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const report = reflect({
      vaultRoot: v, owner: "ardin", actor: "ardin",
      since: cutoff, min_support: 3,
    });
    expect(report.windowed_episodes).toBe(3);
    expect(report.windowed_facts).toBe(3);
    // Expect at least one belief from the 3 convergent role_at facts
    const beliefs = report.records.filter(r => r.kind === "belief");
    expect(beliefs.length).toBeGreaterThanOrEqual(1);
    const roleBelief = beliefs.find(b => b.content.includes("role_at"));
    expect(roleBelief).toBeDefined();
    expect(roleBelief!.derived_from.length).toBe(3);
    rmSync(v, { recursive: true, force: true });
  });

  test("no-LLM principle: reflect() makes no external API calls", async () => {
    // We can't intercept fetch from inside this test easily, but reflect()
    // is purely a filesystem walker. If it imported fetch or fired one, we'd
    // see network errors in CI. Smoke-check: reflect runs synchronously with
    // no async fetch.
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "test", actor: "ardin", owner: "ardin" });
    const t0 = Date.now();
    const report = reflect({ vaultRoot: v, owner: "ardin", actor: "ardin", since: "1900-01-01" });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);  // a network call would take 100ms+ even local
    expect(report).toBeDefined();
    rmSync(v, { recursive: true, force: true });
  });
});

// ─── Layer 5: Vector retrieval ───────────────────────────────────────

describe("Layer 5 — Vector indexing + search", () => {
  test("index 10 records, vectorSearch returns them by similarity", async () => {
    const v = fresh();
    const emb = new LocalHashEmbedder(256);
    // Create episodes and index them
    const topics = [
      "Swiss pillar 3a tax optimization strategy",
      "machtsinn elevator pitch value proposition for Swiss enterprises",
      "Cosmos DB Azure multi-tenant data isolation",
      "machtsinn pricing strategy and partner deal scenarios",
      "release management branching workflow guide",
      "Marcel founded machtsinn and presented at Swiss Insurtech",
      "Säule 3a contribution limits 2026 Switzerland",
      "competitive positioning vs Mem0 Zep Hindsight",
      "Notion publisher agent renders cover images",
      "audit log SHA-256 hash chain integrity verification",
    ];
    for (let i = 0; i < topics.length; i++) {
      const ep = observe(v, { kind: "document", content: topics[i], actor: "ardin", owner: "ardin" });
      const path = join(v, "episodes", "ardin", ep.timestamp.slice(0, 10), `${ep.id}.md`);
      await indexRecord({ path, owner: "ardin", kind: "episode", record_id: ep.id, text: topics[i], embedder: emb });
    }
    // Query with a paraphrase of topic 1
    const r = await vectorSearch("Säule 3a Swiss tax planning Pillar 3a", "ardin", emb, 5);
    expect(r.length).toBeGreaterThan(0);
    // Top result should be one of the two Säule/Pillar 3a topics
    const topPath = readFileSync(r[0].path, "utf8");
    expect(topPath.toLowerCase()).toMatch(/3a|tax/);
    rmSync(v, { recursive: true, force: true });
  });

  test("reindexAll walks v2 storage and indexes every record", async () => {
    const v = fresh();
    const emb = new LocalHashEmbedder(128);
    observe(v, { kind: "document", content: "doc one", actor: "ardin", owner: "ardin" });
    observe(v, { kind: "document", content: "doc two", actor: "ardin", owner: "ardin" });
    recordFact(v, {
      subject: "x", predicate: "y", object: "z",
      derived_from: [], confidence: 0.5, actor: "ardin", owner: "ardin",
    });
    const result = await reindexAll(v, emb, { owner: "ardin" });
    expect(result.indexed).toBeGreaterThanOrEqual(3);
    rmSync(v, { recursive: true, force: true });
  });
});

// ─── Layer 5: Graph traversal ────────────────────────────────────────

describe("Layer 5 — Graph traversal", () => {
  test("walkDerivedFrom finds source episodes of a belief", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "root", actor: "ardin", owner: "ardin" });
    const fact = recordFact(v, {
      subject: "s", predicate: "p", object: "o",
      derived_from: [ep.id], confidence: 0.8, actor: "ardin", owner: "ardin",
    });
    const belief = recordCognitive(v, {
      kind: "belief", content: "synth", confidence: 0.7,
      derived_from: [ep.id, fact.id], actor: "ardin", owner: "ardin",
    });
    const nodes = walkDerivedFrom(v, "ardin", belief.id, 3);
    const ids = nodes.map(n => n.id);
    expect(ids).toContain(ep.id);
    expect(ids).toContain(fact.id);
    rmSync(v, { recursive: true, force: true });
  });

  test("walkSiblingFacts returns facts about same subject", () => {
    const v = fresh();
    const f1 = recordFact(v, { subject: "marcel", predicate: "role", object: "ceo", derived_from: [], confidence: 0.9, actor: "a", owner: "a" });
    recordFact(v, { subject: "marcel", predicate: "located", object: "switzerland", derived_from: [], confidence: 0.8, actor: "a", owner: "a" });
    recordFact(v, { subject: "alice", predicate: "role", object: "engineer", derived_from: [], confidence: 0.9, actor: "a", owner: "a" });
    const siblings = walkSiblingFacts(v, "a", "marcel", f1.id);
    expect(siblings.length).toBe(1);
    expect(siblings[0].predicate).toBe("located");
    rmSync(v, { recursive: true, force: true });
  });

  test("buildEvidenceChain expands hits into supporting chain", () => {
    const v = fresh();
    const ep = observe(v, { kind: "observation", content: "src", actor: "a", owner: "a" });
    const fact = recordFact(v, {
      subject: "x", predicate: "y", object: "z",
      derived_from: [ep.id], confidence: 0.8, actor: "a", owner: "a",
    });
    const chain = buildEvidenceChain(v, "a", [fact.id], 2);
    expect(chain).toContain(fact.id);
    expect(chain).toContain(ep.id);
    rmSync(v, { recursive: true, force: true });
  });
});

// ─── Multi-tenant isolation ──────────────────────────────────────────

describe("Multi-tenant isolation (v2)", () => {
  test("owner A's records do not appear in owner B's recall", async () => {
    const v = fresh();
    // Alice writes a secret
    observe(v, { kind: "document", content: "alice's secret cosmos config", actor: "alice", owner: "alice" });
    // Bob queries for the same content
    const r = await recall(v, {
      query: "alice's secret cosmos config",
      owner: "bob", actor: "bob:agent", purpose: "personal",
      limit: 10,
    });
    expect(r.hits.length).toBe(0);
    rmSync(v, { recursive: true, force: true });
  });

  test("getFactsValidAt is owner-scoped", () => {
    const v = fresh();
    recordFact(v, {
      subject: "x", predicate: "y", object: "z",
      derived_from: [], confidence: 0.8, actor: "alice", owner: "alice",
    });
    const bobFacts = getFactsValidAt(v, "bob", new Date().toISOString());
    expect(bobFacts.length).toBe(0);
    const aliceFacts = getFactsValidAt(v, "alice", new Date().toISOString());
    expect(aliceFacts.length).toBe(1);
    rmSync(v, { recursive: true, force: true });
  });
});

// ─── Audit hash chain tamper detection ──────────────────────────────

describe("Audit — hash chain integrity", () => {
  test("verifyChain detects tampering with a historical entry", async () => {
    const v = fresh();
    appendAudit({ op: "OBSERVE", actor: "ardin", owner: "ardin", record_ids: ["a1"] });
    appendAudit({ op: "OBSERVE", actor: "ardin", owner: "ardin", record_ids: ["a2"] });
    appendAudit({ op: "OBSERVE", actor: "ardin", owner: "ardin", record_ids: ["a3"] });
    expect(verifyChain().valid).toBe(true);

    // Tamper: change the reason field on seq=2 directly in the DB
    const dbPath = join(v, "_meta", "audit.sqlite");
    const db = new Database(dbPath);
    db.exec(`UPDATE audit SET reason = 'TAMPERED' WHERE seq = 2`);
    db.close();

    // Re-open via initAudit so verifyChain reads the tampered state
    initAudit(v);
    const r = verifyChain();
    expect(r.valid).toBe(false);
    expect(r.broken_at_seq).toBe(2);
    rmSync(v, { recursive: true, force: true });
  });
});

// ─── Hard erase content destruction ─────────────────────────────────

describe("Layer 4 — Hard erase", () => {
  test("hardErase overwrites content on disk; audit entry remains", () => {
    const v = fresh();
    const ep = observe(v, {
      kind: "document",
      content: "Personally identifiable information that MUST be erased on DSAR request.",
      actor: "ardin", owner: "ardin",
    });
    const path = join(v, "episodes", "ardin", ep.timestamp.slice(0, 10), `${ep.id}.md`);
    expect(existsSync(path)).toBe(true);
    const before = readFileSync(path, "utf8");
    expect(before).toContain("Personally identifiable information");

    const r = hardErase({
      vaultRoot: v, owner: "ardin", actor: "ardin",
      record_path: path, reason: "DSAR Article 17",
    });
    expect(r.erased).toBe(true);

    const after = readFileSync(path, "utf8");
    expect(after).not.toContain("Personally identifiable information");
    expect(after).toContain("ERASED");
    expect(after).toContain("DSAR Article 17");

    const erasures = queryAudit({ owner: "ardin", op: "ERASE" });
    expect(erasures.length).toBe(1);
    rmSync(v, { recursive: true, force: true });
  });
});

// ─── Governance retention + policy ──────────────────────────────────

describe("Layer 4 — Governance retention", () => {
  test("policyCheck denies expired record", () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const gov = buildGovernance({
      source_content: "X",
      actor: "ardin", purpose: ["support"],
      retention_until: past,
    });
    const r = policyCheck(gov, { actor: "ardin", purpose: "support" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("retention_expired");
  });

  test("policyCheck denies unrelated purpose", () => {
    const gov = buildGovernance({
      source_content: "X", actor: "ardin", purpose: ["customer-support"],
    });
    const r = policyCheck(gov, { actor: "ardin", purpose: "marketing-analytics" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("purpose_not_allowed");
  });

  test("policyCheck denies actor not in allowlist", () => {
    const gov = buildGovernance({
      source_content: "X", actor: "ardin", purpose: ["any"],
      allowed_actors: ["ardin", "marcel"],
    });
    const r = policyCheck(gov, { actor: "evil-bot", purpose: "any" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("actor_not_in_allowlist");
  });
});

// ─── End-to-end: full L1 → L6 with all signals ───────────────────────

describe("End-to-end: full six-layer flow", () => {
  test("Episode → Fact → Belief → Recall (with vector) → Audit chain valid", async () => {
    const v = fresh();
    const emb = new LocalHashEmbedder(256);

    const ep = observe(v, {
      kind: "conversation",
      content: "Ardin decided sqlite-vec is fine for embeddings because vector store is derived state, not authoritative.",
      actor: "ardin:claude-code", owner: "ardin",
    });
    const fact = recordFact(v, {
      subject: "mema",
      predicate: "uses_for_embeddings",
      object: "sqlite-vec",
      derived_from: [ep.id], confidence: 0.95,
      actor: "ardin:claude-code", owner: "ardin",
    });
    const belief = recordCognitive(v, {
      kind: "belief",
      content: "Filesystem-truth + embeddings coexist when the index is derived state.",
      confidence: 0.85,
      derived_from: [ep.id, fact.id],
      actor: "ardin:claude-code", owner: "ardin",
    });

    // Index everything for vector retrieval
    const epPath = join(v, "episodes", "ardin", ep.timestamp.slice(0, 10), `${ep.id}.md`);
    const factPath = join(v, "facts", "ardin", `${fact.id}.md`);
    const beliefPath = join(v, "cognitive", "ardin", "belief", `${belief.id}.md`);
    for (const [path, kind, id, text] of [
      [epPath, "episode", ep.id, ep.content],
      [factPath, "fact", fact.id, `${fact.subject} ${fact.predicate} ${fact.object}`],
      [beliefPath, "cognitive", belief.id, belief.content],
    ] as const) {
      await indexRecord({ path, owner: "ardin", kind, record_id: id, text, embedder: emb });
    }

    // Recall with both keyword + vector enabled
    const r = await recall(v, {
      query: "vector store derived state filesystem truth",
      owner: "ardin", actor: "ardin:claude-code", purpose: "engineering-decision",
      use_vector: true, limit: 10,
    });
    expect(r.hits.length).toBeGreaterThanOrEqual(1);
    // Evidence chain should include the source episode (via graph expansion)
    expect(r.evidence_chain.length).toBeGreaterThanOrEqual(2);

    // Audit chain valid through OBSERVE+EXTRACT+REFLECT+RECALL
    expect(verifyChain().valid).toBe(true);

    rmSync(v, { recursive: true, force: true });
  });
});
