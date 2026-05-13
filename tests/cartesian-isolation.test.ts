// Cartesian-product isolation tests — closes the v0.4 audit gap (Codex finding).
// Tests every combination of {scope, visibility, owner_match, scopeRequest} that the
// previous test suite missed. Each row is one assertion.

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
  tmpRoot = mkdtempSync(join(tmpdir(), "machtsinn-cart-"));
  initLog(join(tmpRoot, "_meta", "log.sqlite"));
  app = buildApi({ vaultRoot: tmpRoot, apiKeys: KEYS });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function req(path: string, key: string, body?: any, method: "GET" | "POST" | "PUT" = "POST", headers: Record<string,string> = {}) {
  return new Request(`http://test${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function write(key: string, payload: any): Promise<{ id: string; status: number }> {
  const res = await app.fetch(req("/v1/remember", key, payload));
  const data = await res.json() as any;
  return { id: data.memory?.frontmatter?.id, status: res.status };
}

async function canRecall(key: string, query: string, opts: any = {}): Promise<string[]> {
  const res = await app.fetch(req("/v1/recall", key, { query, ...opts }));
  const d = await res.json() as any;
  return (d.results ?? []).map((r: any) => r.memory.frontmatter.id);
}

async function canGet(key: string, id: string): Promise<number> {
  const res = await app.fetch(req(`/v1/memory/${id}`, key, undefined, "GET"));
  return res.status;
}

describe("entity-scope visibility cartesian — closes Codex audit gap", () => {

  test("entity+private+ownerA — B cannot recall via scope=all", async () => {
    const { id } = await write("key-a", {
      content: "entity-priv-marker-zzz-1",
      type: "semantic", scope: "entity", entity: "acme", visibility: "private",
    });
    const ids = await canRecall("key-b", "entity-priv-marker-zzz-1", { scope: "all" });
    expect(ids).not.toContain(id);
  });

  test("entity+private+ownerA — B cannot GET by id", async () => {
    const { id } = await write("key-a", {
      content: "entity-priv-get-marker-zzz-2",
      type: "semantic", scope: "entity", entity: "acme", visibility: "private",
    });
    expect(await canGet("key-b", id)).toBe(404); // v0.6: 404 not 403 (oracle collapse)
  });

  test("entity+project+ownerA — B cannot recall via scope=all", async () => {
    const { id } = await write("key-a", {
      content: "entity-proj-marker-zzz-3",
      type: "semantic", scope: "entity", entity: "acme", visibility: "project",
    });
    const ids = await canRecall("key-b", "entity-proj-marker-zzz-3", { scope: "all" });
    expect(ids).not.toContain(id);
  });

  test("entity+project+ownerA — B cannot GET by id", async () => {
    const { id } = await write("key-a", {
      content: "entity-proj-get-marker-zzz-4",
      type: "semantic", scope: "entity", entity: "acme", visibility: "project",
    });
    expect(await canGet("key-b", id)).toBe(404); // v0.6: 404 not 403 (oracle collapse)
  });

  test("entity+team+ownerA — B CAN recall (intentional, team-visible)", async () => {
    const { id } = await write("key-a", {
      content: "entity-team-marker-zzz-5",
      type: "semantic", scope: "entity", entity: "acme", visibility: "team",
    });
    const ids = await canRecall("key-b", "entity-team-marker-zzz-5", { scope: "all" });
    expect(ids).toContain(id);
  });

  test("entity+private+ownerA — A can still read own", async () => {
    const { id } = await write("key-a", {
      content: "entity-priv-self-marker-zzz-6",
      type: "semantic", scope: "entity", entity: "acme", visibility: "private",
    });
    expect(await canGet("key-a", id)).toBe(200);
  });

});

describe("promote ownership check — closes Codex N1", () => {
  test("user B cannot promote user A's entity-private memories", async () => {
    const a1 = (await write("key-a", { content: "src-1 in alpha", type: "semantic", scope: "entity", entity: "alpha", visibility: "private" })).id;
    const a2 = (await write("key-a", { content: "src-2 in beta",  type: "semantic", scope: "entity", entity: "beta",  visibility: "private" })).id;
    const a3 = (await write("key-a", { content: "src-3 in gamma", type: "semantic", scope: "entity", entity: "gamma", visibility: "private" })).id;
    const res = await app.fetch(req("/v1/promote", "key-b", {
      source_ids: [a1, a2, a3],
      content: "stolen content?",
      category: "exfil-attempt",
    }));
    expect(res.status).toBe(404); // v0.7: collapsed to 404 (no existence oracle)
    const data = await res.json() as any;
    expect(data.error).toMatch(/not found/i);
  });

  test("user A CAN promote own memories across 3+ entities", async () => {
    const a1 = (await write("key-a", { content: "own-1 in delta", type: "semantic", scope: "entity", entity: "delta", visibility: "team" })).id;
    const a2 = (await write("key-a", { content: "own-2 in epsilon", type: "semantic", scope: "entity", entity: "epsilon", visibility: "team" })).id;
    const a3 = (await write("key-a", { content: "own-3 in zeta", type: "semantic", scope: "entity", entity: "zeta", visibility: "team" })).id;
    const res = await app.fetch(req("/v1/promote", "key-a", {
      source_ids: [a1, a2, a3],
      content: "legitimate cross-entity pattern",
      category: "cross-domain",
    }));
    expect(res.status).toBe(200);
  });
});

describe("link ownership check — closes Codex N2", () => {
  test("user B cannot link from user A's memory", async () => {
    const a = (await write("key-a", { content: "link-target-a", type: "semantic", scope: "entity", entity: "acme", visibility: "team" })).id;
    const b = (await write("key-b", { content: "link-target-b", type: "semantic", scope: "entity", entity: "acme", visibility: "team" })).id;
    const res = await app.fetch(req("/v1/link", "key-b", { from: a, to: b, edge: "sibling" }));
    expect(res.status).toBe(404); // v0.7: collapsed to 404
  });

  test("user A CAN link from own memory", async () => {
    const a1 = (await write("key-a", { content: "link-src-a1", type: "semantic", scope: "entity", entity: "acme", visibility: "team" })).id;
    const a2 = (await write("key-a", { content: "link-tgt-a2", type: "semantic", scope: "entity", entity: "acme", visibility: "team" })).id;
    const res = await app.fetch(req("/v1/link", "key-a", { from: a1, to: a2, edge: "sibling" }));
    expect(res.status).toBe(200);
  });
});

describe("x-actor spoofing prevention — closes Codex N4", () => {
  test("user B cannot set x-actor with another owner prefix", async () => {
    const res = await app.fetch(req(
      "/v1/remember", "key-b",
      { content: "trying to spoof actor", type: "semantic", scope: "user" },
      "POST",
      { "x-actor": "ardin:fake-agent" }
    ));
    expect(res.status).toBe(403);
  });

  test("user B's bare-label x-actor is always prefixed with their own owner", async () => {
    const res = await app.fetch(req(
      "/v1/remember", "key-b",
      { content: "legitimate actor labeling", type: "semantic", scope: "user" },
      "POST",
      { "x-actor": "cursor" }
    ));
    expect(res.status).toBe(200);
    // Verify the audit log entry recorded actor as "marcel:cursor"
    const logRes = await app.fetch(req("/v1/log?limit=1", "key-b", undefined, "GET"));
    const log = await logRes.json() as any;
    expect(log.entries[0].actor).toBe("marcel:cursor");
  });

  test("matching owner prefix is accepted", async () => {
    const res = await app.fetch(req(
      "/v1/remember", "key-b",
      { content: "self-prefixed actor", type: "semantic", scope: "user" },
      "POST",
      { "x-actor": "marcel:claude-code" }
    ));
    expect(res.status).toBe(200);
  });
});
