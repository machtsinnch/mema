// Critical invariant test: User A must NOT be able to retrieve User B's private memories
// via recall. This test is the codified anti-leak guarantee.

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
  tmpRoot = mkdtempSync(join(tmpdir(), "machtsinn-iso-"));
  initLog(join(tmpRoot, "_meta", "log.sqlite"));
  app = buildApi({ vaultRoot: tmpRoot, apiKeys: KEYS });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function authReq(path: string, key: string, body?: any, method = "POST") {
  return new Request(`http://test${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("isolation invariant", () => {
  test("user A's private memory does not appear in user B's recall", async () => {
    // A writes a private personal memory
    const writeRes = await app.fetch(authReq("/v1/remember", "key-a", {
      content: "I'm thinking of quitting and starting a new venture next year",
      type: "semantic",
      scope: "user",
      visibility: "private",
      tags: ["personal", "career"],
    }));
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json() as any;
    expect(written.memory.frontmatter.owner).toBe("ardin");
    expect(written.memory.frontmatter.visibility).toBe("private");

    // B searches for "quitting" with all-scope
    const recallRes = await app.fetch(authReq("/v1/recall", "key-b", {
      query: "quitting venture",
      scope: "all",
    }));
    expect(recallRes.status).toBe(200);
    const recall = await recallRes.json() as any;

    // B must NOT see A's private memory even with scope=all
    const leakedIds = recall.results.map((r: any) => r.memory.frontmatter.id);
    expect(leakedIds).not.toContain(written.memory.frontmatter.id);
  });

  test("user A can recall own private memory", async () => {
    const writeRes = await app.fetch(authReq("/v1/remember", "key-a", {
      content: "marker-string-only-ardin-sees-this-private-thought",
      type: "semantic",
      scope: "user",
      visibility: "private",
    }));
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json() as any;

    const recallRes = await app.fetch(authReq("/v1/recall", "key-a", {
      query: "marker-string-only-ardin-sees-this-private-thought",
      scope: "current",
    }));
    const recall = await recallRes.json() as any;
    const ids = recall.results.map((r: any) => r.memory.frontmatter.id);
    expect(ids).toContain(written.memory.frontmatter.id);
  });

  test("entity-scoped memory is not leaked across entities by default", async () => {
    // A writes a memory under company-a
    const writeRes = await app.fetch(authReq("/v1/remember", "key-a", {
      content: "Acme Corp uses Cosmos DB for tenant isolation per their architect's preference",
      type: "semantic",
      scope: "entity",
      entity: "company-a",
      tags: ["architecture", "cosmos"],
    }));
    expect(writeRes.status).toBe(200);

    // B searches without specifying scope/entity → should NOT see company-a content
    const recallRes = await app.fetch(authReq("/v1/recall", "key-b", {
      query: "Cosmos DB tenant",
      scope: "current",
      entity: "company-b",
    }));
    const recall = await recallRes.json() as any;
    const acmeRefs = recall.results.filter((r: any) =>
      r.memory.frontmatter.entity === "company-a"
    );
    expect(acmeRefs).toHaveLength(0);
  });

  test("generalized memories are visible across entities", async () => {
    const writeRes = await app.fetch(authReq("/v1/remember", "key-a", {
      content: "Multi-tenant pattern: per-tenant Cosmos DB beats shared-with-RLS for compliance speed",
      type: "semantic",
      scope: "generalized",
      category: "architecture",
      tags: ["multi-tenant", "azure"],
      visibility: "team",
    }));
    expect(writeRes.status).toBe(200);
    const written = await writeRes.json() as any;

    const recallRes = await app.fetch(authReq("/v1/recall", "key-b", {
      query: "Multi-tenant pattern Cosmos",
      scope: "current",
      entity: "company-c",
    }));
    const recall = await recallRes.json() as any;
    const ids = recall.results.map((r: any) => r.memory.frontmatter.id);
    expect(ids).toContain(written.memory.frontmatter.id);
  });
});
