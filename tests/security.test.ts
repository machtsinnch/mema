// Security regression tests for fixes from the v0.3 audit.
// Each test maps to a specific finding closed in v0.4.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLog } from "../src/db";
import { buildApi } from "../src/api";

let tmpRoot: string;
let app: ReturnType<typeof buildApi>;

const KEYS = { "key-a": "ardin", "key-b": "marcel" };

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "machtsinn-sec-"));
  initLog(join(tmpRoot, "_meta", "log.sqlite"));
  app = buildApi({ vaultRoot: tmpRoot, apiKeys: KEYS });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function req(path: string, key: string, body?: any, method: "GET" | "POST" | "PUT" = "POST") {
  return new Request(`http://test${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("CRITICAL fix: canRead scope=all bypass (was leaking non-private user memory)", () => {
  test("user A's project-visibility user memory not visible to B with scope=all", async () => {
    const writeRes = await app.fetch(req("/v1/remember", "key-a", {
      content: "secret-marker-project-visibility-user-memory",
      type: "semantic", scope: "user", visibility: "project",
    }));
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json() as any;

    const recallRes = await app.fetch(req("/v1/recall", "key-b", {
      query: "secret-marker-project-visibility-user-memory", scope: "all",
    }));
    const recall = await recallRes.json() as any;
    const ids = recall.results.map((r: any) => r.memory.frontmatter.id);
    expect(ids).not.toContain(written.memory.frontmatter.id);
  });

  test("user A's team-visibility user memory still NOT visible to B (user scope is per-owner)", async () => {
    const writeRes = await app.fetch(req("/v1/remember", "key-a", {
      content: "team-vis-marker-still-user-scoped",
      type: "semantic", scope: "user", visibility: "team",
    }));
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json() as any;

    const recallRes = await app.fetch(req("/v1/recall", "key-b", {
      query: "team-vis-marker-still-user-scoped", scope: "all",
    }));
    const recall = await recallRes.json() as any;
    const ids = recall.results.map((r: any) => r.memory.frontmatter.id);
    expect(ids).not.toContain(written.memory.frontmatter.id);
  });
});

describe("CRITICAL fix: path traversal rejected", () => {
  test("rejects entity with ..", async () => {
    const res = await app.fetch(req("/v1/remember", "key-a", {
      content: "should not write", type: "semantic", scope: "entity",
      entity: "../../etc",
    }));
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(JSON.stringify(data)).toMatch(/invalid entity/i);
  });

  test("rejects path with ..", async () => {
    const res = await app.fetch(req("/v1/remember", "key-a", {
      content: "should not write", type: "semantic", scope: "entity",
      entity: "test-co", path: "../../../tmp/evil",
    }));
    expect(res.status).toBe(400);
  });

  test("rejects entity with slash", async () => {
    const res = await app.fetch(req("/v1/remember", "key-a", {
      content: "x", type: "semantic", scope: "entity", entity: "foo/bar",
    }));
    expect(res.status).toBe(400);
  });

  test("accepts clean entity names", async () => {
    const res = await app.fetch(req("/v1/remember", "key-a", {
      content: "clean entity test", type: "semantic", scope: "entity",
      entity: "clean-entity-123",
    }));
    expect(res.status).toBe(200);
  });
});

describe("CRITICAL fix: /v1/log isolation", () => {
  test("user B's log query does not return user A's entries", async () => {
    await app.fetch(req("/v1/remember", "key-a", {
      content: "audit-trail-test-memory", type: "semantic", scope: "user",
    }));

    const logRes = await app.fetch(req("/v1/log?scope=all&limit=100", "key-b", undefined, "GET"));
    expect(logRes.status).toBe(200);
    const data = await logRes.json() as any;
    const ardinEntries = data.entries.filter((e: any) => e.owner === "ardin");
    expect(ardinEntries).toHaveLength(0);
  });
});

describe("HIGH fix: /v1/consolidate isolation", () => {
  test("user B's consolidate proposals exclude user A's private content", async () => {
    // user A writes a private memory with a uniquely identifiable token
    await app.fetch(req("/v1/remember", "key-a", {
      content: "ZZZ-unique-token-only-ardin-zzz appears here multiple times. ZZZ-unique-token-only-ardin-zzz again. ZZZ-unique-token-only-ardin-zzz again.",
      type: "semantic", scope: "user", visibility: "private",
      tags: ["zzz-unique"],
    }));

    const conRes = await app.fetch(req("/v1/consolidate", "key-b", {
      min_entities: 1, min_occurrences: 1, max_saturation: 1, limit: 100,
    }));
    expect(conRes.status).toBe(200);
    const data = await conRes.json() as any;
    const tokens = data.proposals.map((p: any) => p.token);
    // Token should not appear; B cannot see A's private content
    expect(tokens.some((t: string) => t.includes("zzz") || t.includes("ardin"))).toBe(false);
  });
});

describe("HIGH fix: aliases populated for Obsidian readability", () => {
  test("writing memory with aliases preserves them in frontmatter", async () => {
    const res = await app.fetch(req("/v1/remember", "key-a", {
      content: "test with alias", type: "semantic", scope: "user",
      aliases: ["My Readable Title"],
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.memory.frontmatter.aliases).toEqual(["My Readable Title"]);
  });
});
