// v0.6 fix tests: closes 4th-round audit findings.

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
  tmpRoot = mkdtempSync(join(tmpdir(), "machtsinn-v06-"));
  initLog(join(tmpRoot, "_meta", "log.sqlite"));
  // Very high rate-limit burst so the OTHER tests in this file don't trip on it.
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

describe("v0.6: generalized+project leak closed", () => {
  test("user B cannot read user A's generalized+project memory", async () => {
    const wr = await app.fetch(req("/v1/remember", "key-a", {
      content: "secret-generalized-project-content",
      type: "semantic", scope: "generalized", visibility: "project",
      category: "secret-cat",
    }));
    expect(wr.status).toBe(200);
    const w = await wr.json() as any;
    const rec = await app.fetch(req("/v1/recall", "key-b", {
      query: "secret-generalized-project-content", scope: "all",
    }));
    const rec_data = await rec.json() as any;
    const ids = rec_data.results.map((r: any) => r.memory.frontmatter.id);
    expect(ids).not.toContain(w.memory.frontmatter.id);
  });
});

describe("v0.6: /v1/stats isolation", () => {
  test("user B's stats does not list user A's private entities", async () => {
    await app.fetch(req("/v1/remember", "key-a", {
      content: "alpha private content", type: "semantic", scope: "entity",
      entity: "ardin-private-entity-zzz", visibility: "private",
    }));
    const sr = await app.fetch(req("/v1/stats", "key-b", undefined, "GET"));
    const s = await sr.json() as any;
    expect(s.entities).not.toContain("ardin-private-entity-zzz");
  });

  test("user B's stats does not list user A's private generalized categories", async () => {
    await app.fetch(req("/v1/remember", "key-a", {
      content: "marker-secret-cat-only", type: "semantic", scope: "generalized",
      category: "secret-cat-x", visibility: "private",
    }));
    const sr = await app.fetch(req("/v1/stats", "key-b", undefined, "GET"));
    const s = await sr.json() as any;
    expect(s.generalized_categories).not.toContain("secret-cat-x");
  });
});

describe("v0.6: /v1/topology/health isolation", () => {
  test("user B does not see hub counts from user A's private generalized memories", async () => {
    const beforeRes = await app.fetch(req("/v1/topology/health", "key-b", undefined, "GET"));
    const before = await beforeRes.json() as any;
    await app.fetch(req("/v1/remember", "key-a", {
      content: "private hub content", type: "semantic", scope: "generalized",
      category: "private-cat-y", visibility: "private",
    }));
    const afterRes = await app.fetch(req("/v1/topology/health", "key-b", undefined, "GET"));
    const after = await afterRes.json() as any;
    expect(after.hub_count).toBe(before.hub_count);
  });
});

describe("v0.6: 404 oracle collapsed", () => {
  test("GET /v1/memory/<not-mine-id> returns 404 not 403", async () => {
    const wr = await app.fetch(req("/v1/remember", "key-a", {
      content: "private user note", type: "semantic", scope: "user", visibility: "private",
    }));
    const w = await wr.json() as any;
    const res = await app.fetch(req(`/v1/memory/${w.memory.frontmatter.id}`, "key-b", undefined, "GET"));
    expect(res.status).toBe(404);
  });

  test("GET /v1/memory/<nonexistent-id> also returns 404 (indistinguishable)", async () => {
    const res = await app.fetch(req("/v1/memory/01ZZZZZZZZZZZZZZZZZZZZZZZZ", "key-b", undefined, "GET"));
    expect(res.status).toBe(404);
  });

  test("POST /v1/forget on another user's memory returns 404", async () => {
    const wr = await app.fetch(req("/v1/remember", "key-a", {
      content: "ardin private content for forget test", type: "semantic", scope: "user",
    }));
    const w = await wr.json() as any;
    const res = await app.fetch(req("/v1/forget", "key-b", {
      id: w.memory.frontmatter.id, reason: "trying to forget someone else's memory",
    }));
    expect(res.status).toBe(404);
  });
});
