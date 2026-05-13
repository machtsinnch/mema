// v0.7 fix tests: closes the remaining v0.6 audit findings.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLog } from "../src/db";
import { buildApi } from "../src/api";

let tmpRoot: string;
let app: ReturnType<typeof buildApi>;
const KEYS = { "key-a": "ardin", "key-b": "marcel" };

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "machtsinn-v07-"));
  initLog(join(tmpRoot, "_meta", "log.sqlite"));
  process.env.MACHTSINN_RATE_LIMIT_BURST = "10000";
  process.env.MACHTSINN_RATE_LIMIT_RPS = "1000";
  app = buildApi({ vaultRoot: tmpRoot, apiKeys: KEYS });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.MACHTSINN_RATE_LIMIT_BURST;
  delete process.env.MACHTSINN_RATE_LIMIT_RPS;
});

function req(path: string, key: string, body?: any, method: "GET" | "POST" | "PUT" = "POST") {
  return new Request(`http://test${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function write(key: string, payload: any): Promise<string> {
  const r = await app.fetch(req("/v1/remember", key, payload));
  const d = await r.json() as any;
  return d.memory.frontmatter.id;
}

describe("v0.7: NEW-D (HIGH) — cross-owner mutation via promote backlinks", () => {
  test("user B promoting user A's team-visibility memories does NOT mutate A's links", async () => {
    // A writes three team-visibility entity memories
    const a1 = await write("key-a", { content: "a1 team", type: "semantic", scope: "entity", entity: "delta", visibility: "team" });
    const a2 = await write("key-a", { content: "a2 team", type: "semantic", scope: "entity", entity: "epsilon", visibility: "team" });
    const a3 = await write("key-a", { content: "a3 team", type: "semantic", scope: "entity", entity: "zeta", visibility: "team" });

    // Read A's links BEFORE promote
    const before = await Promise.all([a1, a2, a3].map(async id => {
      const r = await app.fetch(req(`/v1/memory/${id}`, "key-a", undefined, "GET"));
      const d = await r.json() as any;
      return d.memory.frontmatter.links;
    }));

    // B promotes A's memories
    const res = await app.fetch(req("/v1/promote", "key-b", {
      source_ids: [a1, a2, a3],
      content: "B's promotion of A's memories",
      category: "cross-domain",
    }));
    expect(res.status).toBe(200);
    const promoted = await res.json() as any;
    expect(promoted.skipped_foreign_backlinks).toHaveLength(3);

    // A's links should be UNCHANGED — no cross-owner mutation
    const after = await Promise.all([a1, a2, a3].map(async id => {
      const r = await app.fetch(req(`/v1/memory/${id}`, "key-a", undefined, "GET"));
      const d = await r.json() as any;
      return d.memory.frontmatter.links;
    }));
    expect(after).toEqual(before);
  });

  test("user A promoting OWN memories DOES backlink them", async () => {
    const a1 = await write("key-a", { content: "own1", type: "semantic", scope: "entity", entity: "eta", visibility: "team" });
    const a2 = await write("key-a", { content: "own2", type: "semantic", scope: "entity", entity: "theta", visibility: "team" });
    const a3 = await write("key-a", { content: "own3", type: "semantic", scope: "entity", entity: "iota", visibility: "team" });
    const res = await app.fetch(req("/v1/promote", "key-a", {
      source_ids: [a1, a2, a3], content: "own promotion", category: "self",
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.skipped_foreign_backlinks).toHaveLength(0);
    expect(data.backlinked || data.skipped_foreign_backlinks).toBeDefined();

    // Verify A's source memories now have a link back to the hub
    const hubId = data.hub.frontmatter.id;
    for (const id of [a1, a2, a3]) {
      const r = await app.fetch(req(`/v1/memory/${id}`, "key-a", undefined, "GET"));
      const d = await r.json() as any;
      expect(d.memory.frontmatter.links.some((l: string) => l.includes(hubId))).toBe(true);
    }
  });
});

describe("v0.7: malformed JSON returns 400 not 500", () => {
  test("POST /v1/remember with malformed JSON → 400", async () => {
    const res = await fetch("http://test/v1/remember", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "key-a" },
      body: "{not valid json",
    }).catch(() => null);
    // The Bun test environment may not run the global fetch — use app.fetch via Request directly
    const r2 = await app.fetch(new Request("http://test/v1/remember", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "key-a" },
      body: "{not valid json",
    }));
    expect(r2.status).toBe(400);
    const data = await r2.json() as any;
    expect(data.error).toMatch(/invalid JSON/i);
  });

  test("POST /v1/forget with empty body → 400", async () => {
    const r = await app.fetch(new Request("http://test/v1/forget", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "key-a" },
      body: "",
    }));
    expect(r.status).toBe(400);
  });
});

describe("v0.7: timing oracle mitigation — isReadable uses index only", () => {
  test("GET on nonexistent and on-private both return 404 (functionally indistinguishable)", async () => {
    const privId = await write("key-a", { content: "private to ardin", type: "semantic", scope: "user", visibility: "private" });
    const r1 = await app.fetch(req(`/v1/memory/${privId}`, "key-b", undefined, "GET"));
    const r2 = await app.fetch(req("/v1/memory/01ZZZZZZZZZZZZZZZZZZZZZZZZ", "key-b", undefined, "GET"));
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    const b1 = await r1.json() as any;
    const b2 = await r2.json() as any;
    expect(b1.error).toBe(b2.error); // identical body
  });
});
