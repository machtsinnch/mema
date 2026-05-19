// v2.9.0+ benchmark x-owner override (P0-A from second external review).
//
// API auth derives owner from the x-api-key header by default. When
// MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true at server start, the x-owner
// header overrides — required for the LongMemEval / LoCoMo / Swiss
// Trust benchmark harnesses to isolate per-question vaults without
// provisioning hundreds of API keys.
//
// Security invariants verified here:
//   1. Without the env var, x-owner is ignored (default-safe).
//   2. With the env var, x-owner overrides — and writes land in the
//      correct owner namespace.
//   3. With the env var, x-owner is rejected if it violates the
//      whitelist (would otherwise enable path traversal or header
//      injection into frontmatter).

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "../../src/api";
import { ensureVault } from "../../src/storage";
import { initLog } from "../../src/db";
import { initAudit } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { initAnchorStore } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-xown-"));
  ensureVault({ root: dir });
  initLog(join(dir, "_meta", "log.sqlite"));
  initAudit(dir);
  initVectorStore(dir);
  initAnchorStore(dir);
  return dir;
}

const KEYS = { "bench-key": "bench_default_owner" };

describe("x-owner override (P0-A)", () => {
  test("without MEMA_BENCH_ALLOW_OWNER_OVERRIDE, x-owner is ignored", async () => {
    delete process.env.MEMA_BENCH_ALLOW_OWNER_OVERRIDE;
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const r = await app.request("/v2/observe", {
      method: "POST",
      headers: {
        "x-api-key": "bench-key",
        "x-owner": "should_be_ignored",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "observation", content: "test", source: "t", skip_extraction: true }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { episode: { owner: string } };
    expect(j.episode.owner).toBe("bench_default_owner");
    rmSync(vault, { recursive: true, force: true });
  });

  test("with MEMA_BENCH_ALLOW_OWNER_OVERRIDE=true, x-owner overrides", async () => {
    process.env.MEMA_BENCH_ALLOW_OWNER_OVERRIDE = "true";
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    const r = await app.request("/v2/observe", {
      method: "POST",
      headers: {
        "x-api-key": "bench-key",
        "x-owner": "lmebench_q42",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "observation", content: "test", source: "t", skip_extraction: true }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { episode: { owner: string } };
    expect(j.episode.owner).toBe("lmebench_q42");
    delete process.env.MEMA_BENCH_ALLOW_OWNER_OVERRIDE;
    rmSync(vault, { recursive: true, force: true });
  });

  test("x-owner with whitespace / invalid chars is rejected (400)", async () => {
    process.env.MEMA_BENCH_ALLOW_OWNER_OVERRIDE = "true";
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    // Header strings with \n or non-printable chars are rejected by the
    // fetch layer itself before our middleware sees them; we only test
    // values that fetch will pass through but our validator rejects.
    const cases = [
      "../../etc/passwd",
      "owner with spaces",
      "owner@with$symbols",
      "x".repeat(65),
    ];
    for (const bad of cases) {
      const r = await app.request("/v2/observe", {
        method: "POST",
        headers: {
          "x-api-key": "bench-key",
          "x-owner": bad,
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "observation", content: "test", source: "t", skip_extraction: true }),
      });
      expect(r.status).toBe(400);
    }
    delete process.env.MEMA_BENCH_ALLOW_OWNER_OVERRIDE;
    rmSync(vault, { recursive: true, force: true });
  });

  test("x-actor must still match the EFFECTIVE owner after x-owner override", async () => {
    process.env.MEMA_BENCH_ALLOW_OWNER_OVERRIDE = "true";
    const vault = fresh();
    const app = buildApi({ vaultRoot: vault, apiKeys: KEYS });
    // x-actor claims a DIFFERENT owner than the effective one → 403
    const r = await app.request("/v2/observe", {
      method: "POST",
      headers: {
        "x-api-key": "bench-key",
        "x-owner": "effective_owner",
        "x-actor": "different_owner:label",
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "observation", content: "test", source: "t", skip_extraction: true }),
    });
    expect(r.status).toBe(403);
    delete process.env.MEMA_BENCH_ALLOW_OWNER_OVERRIDE;
    rmSync(vault, { recursive: true, force: true });
  });
});
