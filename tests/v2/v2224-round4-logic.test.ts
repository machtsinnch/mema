// v2.22.4 — regression tests for review-round-4 findings:
//   F1 (l2-extract):  OpenAIExtractor / OllamaExtractor no longer silently
//                     truncate input at 8000 chars; the full document reaches
//                     the model (chunked past the single-shot budget) and the
//                     result carries honest chunk_stats.
//   F2 (l3-reflect):  rejecting a previously-approved subject entity no longer
//                     duplicates its corroboration belief (entity->raw key
//                     migration is now bidirectional).
//   F3 (l3-judgment): judgment flag-relevance screening is gated independently
//                     of the web-fact-check toggle (MEMA_FACTCHECK_AUTO=false
//                     must NOT disable flag screening).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { OpenAIExtractor, OllamaExtractor } from "../../src/v2/llm-extractor";
import { recordFact } from "../../src/v2/layer2-semantic";
import { createEntity, rejectEntity } from "../../src/v2/layer2-entities";
import { observe } from "../../src/v2/layer1-episodic";
import { reflect } from "../../src/v2/layer3-reflection";
import { flagScreenAutoEnabled } from "../../src/v2/layer3-judgment";
import { factCheckAutoEnabled } from "../../src/v2/layer2-factcheck";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-v2224-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}
const SINCE = "2020-01-01T00:00:00Z";

// A ~31 KB document with a REAL fact sitting well past char 8000 (near the
// end). Pre-fix, both fallback extractors sliced to the first 8000 chars, so
// this tail fact never reached the model and was silently dropped.
function bigDocWithTailFact(): string {
  const filler = "Layer two extraction turns raw episodes into grounded triples.\n\n";
  let body = "";
  while (body.length < 30_000) body += filler;
  body += "\n\nZeta acquired Omega Robotics in 2021 for an undisclosed sum.\n";
  return body;
}

describe("F1: OpenAI/Ollama extractors do not silently truncate at 8000 chars", () => {
  const realFetch = globalThis.fetch;

  test("OpenAIExtractor sends the FULL document (tail fact included) and reports chunk_stats", async () => {
    const doc = bigDocWithTailFact();
    expect(doc.length).toBeGreaterThan(24_000);           // exceeds the single-shot budget
    expect(doc.indexOf("Zeta acquired Omega")).toBeGreaterThan(8000);  // the dropped-tail scenario

    const sentBodies: string[] = [];
    // @ts-expect-error — test stub
    globalThis.fetch = async (_url: string, init: { body: string }) => {
      sentBodies.push(init.body);
      const sawTail = init.body.includes("Zeta acquired Omega");
      const facts = sawTail
        ? [{ subject: "Zeta", predicate: "acquired", object: "Omega Robotics", confidence: 0.9 }]
        : [];
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts, entities: [] }) } }] }),
        { status: 200 },
      );
    };
    try {
      const ex = new OpenAIExtractor({ apiKey: "test-key" });
      const res = await ex.extract(doc);
      // The tail fact reached the model and survived the merge — no silent drop.
      const allSent = sentBodies.join("\n");
      expect(allSent).toContain("Zeta acquired Omega Robotics");
      expect(res.facts.some(f => f.subject === "Zeta" && f.object === "Omega Robotics")).toBe(true);
      // chunk_stats is now populated so /v2/observe can report coverage honestly.
      expect(res.chunk_stats).toBeDefined();
      expect(res.chunk_stats!.total).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("OllamaExtractor sends the FULL document (tail fact included) and reports chunk_stats", async () => {
    const doc = bigDocWithTailFact();
    const sentBodies: string[] = [];
    // @ts-expect-error — test stub
    globalThis.fetch = async (_url: string, init: { body: string }) => {
      sentBodies.push(init.body);
      const sawTail = init.body.includes("Zeta acquired Omega");
      const facts = sawTail
        ? [{ subject: "Zeta", predicate: "acquired", object: "Omega Robotics", confidence: 0.9 }]
        : [];
      return new Response(
        JSON.stringify({ message: { content: JSON.stringify({ facts, entities: [] }) } }),
        { status: 200 },
      );
    };
    try {
      const ex = new OllamaExtractor();
      const res = await ex.extract(doc);
      const allSent = sentBodies.join("\n");
      expect(allSent).toContain("Zeta acquired Omega Robotics");
      expect(res.facts.some(f => f.subject === "Zeta" && f.object === "Omega Robotics")).toBe(true);
      expect(res.chunk_stats).toBeDefined();
      expect(res.chunk_stats!.total).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a small document still takes the single-shot path (no chunk_stats overhead)", async () => {
    // @ts-expect-error — test stub
    globalThis.fetch = async () => new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [], entities: [] }) } }] }),
      { status: 200 },
    );
    try {
      const res = await new OpenAIExtractor({ apiKey: "k" }).extract("Ada uses Rust.");
      expect(res.chunk_stats).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

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

describe("F2: rejecting a previously-approved subject entity does not duplicate its belief", () => {
  test("belief count stays 1 across approve -> reflect -> reject -> reflect", () => {
    const vault = fresh();
    const ep1 = observe(vault, { kind: "document", content: "a", actor: "t", owner: "o" });
    const ep2 = observe(vault, { kind: "document", content: "b", actor: "t", owner: "o" });
    // Two UNLINKED corroborating facts, same raw subject spelling, distinct docs.
    recordFact(vault, {
      subject: "Ardin", predicate: "likes", object: "Coffee",
      derived_from: [ep1.id], actor: "t", owner: "o",
    });
    recordFact(vault, {
      subject: "Ardin", predicate: "likes", object: "Coffee",
      derived_from: [ep2.id], actor: "t", owner: "o",
    });
    // (1) Register+approve entity 'Ardin'.
    const ardin = createEntity(vault, { name: "Ardin", type: "person", actor: "t", owner: "o" });
    // (2) reflect groups both facts under the entity id -> ONE belief.
    reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    const afterApprove = liveBeliefs(vault, "o");
    expect(afterApprove.length).toBe(1);
    expect(afterApprove[0].claim_key).toContain(ardin.id);  // keyed by the entity id

    // (3) Reviewer rejects the entity (a legitimate review action).
    rejectEntity(vault, ardin.id, "o", "t", "not a real person");
    // (4) reflect re-runs: the group reverts to the raw-name key. Pre-fix this
    // minted a SECOND live belief keyed `corro|ardin|likes|coffee`.
    reflect({ vaultRoot: vault, owner: "o", actor: "t", since: SINCE, self_names: ["Ardin"] });
    const afterReject = liveBeliefs(vault, "o");
    expect(afterReject.length).toBe(1);                     // still exactly ONE — no duplicate
    expect(afterReject[0].content).toContain("Ardin likes Coffee");
    rmSync(vault, { recursive: true, force: true });
  });
});

describe("F3: judgment flag screening is gated independently of web fact-checking", () => {
  test("MEMA_FACTCHECK_AUTO=false does NOT disable flag screening", () => {
    const savedFC = process.env.MEMA_FACTCHECK_AUTO;
    const savedFS = process.env.MEMA_FLAG_SCREEN_AUTO;
    try {
      // The documented, quota-saving switch turns web fact-checking off...
      process.env.MEMA_FACTCHECK_AUTO = "false";
      expect(factCheckAutoEnabled()).toBe(false);
      // ...but flag screening is a SEPARATE job type — it must stay available.
      process.env.MEMA_FLAG_SCREEN_AUTO = "true";
      expect(flagScreenAutoEnabled()).toBe(true);
      // And its own switch turns it off without touching fact-checking.
      process.env.MEMA_FLAG_SCREEN_AUTO = "false";
      expect(flagScreenAutoEnabled()).toBe(false);
      process.env.MEMA_FACTCHECK_AUTO = "true";
      expect(flagScreenAutoEnabled()).toBe(false);         // still independent
    } finally {
      if (savedFC === undefined) delete process.env.MEMA_FACTCHECK_AUTO; else process.env.MEMA_FACTCHECK_AUTO = savedFC;
      if (savedFS === undefined) delete process.env.MEMA_FLAG_SCREEN_AUTO; else process.env.MEMA_FLAG_SCREEN_AUTO = savedFS;
    }
  });

  test("flag screening defaults on outside tests, off under bun test unless forced", () => {
    const savedFS = process.env.MEMA_FLAG_SCREEN_AUTO;
    const savedNE = process.env.NODE_ENV;
    try {
      delete process.env.MEMA_FLAG_SCREEN_AUTO;
      expect(flagScreenAutoEnabled()).toBe(false);         // NODE_ENV=test here
      process.env.NODE_ENV = "production";
      expect(flagScreenAutoEnabled()).toBe(true);          // on by default in prod
    } finally {
      if (savedFS === undefined) delete process.env.MEMA_FLAG_SCREEN_AUTO; else process.env.MEMA_FLAG_SCREEN_AUTO = savedFS;
      process.env.NODE_ENV = savedNE;
    }
  });
});
