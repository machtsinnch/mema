// Security hardening tests — these cover the four CRITICAL issues an
// independent adversarial critic flagged at v2.0:
//
//   1. Audit chain detects suffix-drop (deleting tail rows from the SQLite DB)
//   2. Audit chain detects mid-stream row deletion (seq gaps)
//   3. recall() denies records with no `owner` frontmatter (v1 leak fix)
//   4. parseUAL rejects path traversal / unsafe characters in components
//
// If any of these tests fail, the system is unsafe to ship.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import matter from "gray-matter";

import { initAudit, appendAudit, verifyChain } from "../../src/v2/layer6-audit";
import { initVectorStore } from "../../src/v2/layer5-embeddings";
import { recall } from "../../src/v2/layer5-retrieval";
import { observe } from "../../src/v2/layer1-episodic";
import { parseUAL, mintUAL } from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-sec-"));
  initAudit(dir);
  initVectorStore(dir);
  return dir;
}

describe("Security hardening — audit chain row deletion detection", () => {
  test("verifyChain detects mid-stream row deletion (seq gap)", async () => {
    const v = fresh();
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r1"] });
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r2"] });
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r3"] });
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r4"] });
    expect(verifyChain().valid).toBe(true);

    // Insider deletes seq=2 from the SQLite DB out-of-band.
    const dbPath = join(v, "_meta", "audit.sqlite");
    const db = new Database(dbPath);
    db.exec(`DELETE FROM audit WHERE seq = 2`);
    db.close();
    initAudit(v);

    const r = verifyChain();
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("seq_gap");

    rmSync(v, { recursive: true, force: true });
  });

  test("verifyChain detects suffix-drop (deleting tail rows)", async () => {
    const v = fresh();
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r1"] });
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r2"] });
    appendAudit({ op: "OBSERVE", actor: "a", owner: "a", record_ids: ["r3"] });
    expect(verifyChain().valid).toBe(true);

    // Insider exfiltrates data, then deletes the trailing RECALL entries.
    // (Note: sqlite_sequence retains the max issued seq even after delete.)
    const dbPath = join(v, "_meta", "audit.sqlite");
    const db = new Database(dbPath);
    db.exec(`DELETE FROM audit WHERE seq = 3`);
    db.close();
    initAudit(v);

    const r = verifyChain();
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("suffix_dropped");

    rmSync(v, { recursive: true, force: true });
  });
});

describe("Security hardening — recall denies records without owner frontmatter", () => {
  test("v1 legacy record with no owner frontmatter is NOT returned to any tenant", async () => {
    const v = fresh();
    // Simulate a v1 legacy record dropped into the vault with no owner field.
    const legacyDir = join(v, "entities", "legacy-entity");
    mkdirSync(legacyDir, { recursive: true });
    const legacyContent = matter.stringify(
      "Body of legacy record containing the magic word watermelon.",
      { id: "legacy-1", scope: "entity", visibility: "team", tags: ["legacy"] },
    );
    writeFileSync(join(legacyDir, "legacy-1.md"), legacyContent, "utf8");

    // Tenant alice queries for the magic word.
    const r = await recall(v, {
      query: "watermelon",
      owner: "alice",
      actor: "alice:agent",
      purpose: "personal",
      limit: 10,
    });
    // The legacy record has no owner. It MUST NOT appear in alice's results.
    expect(r.hits.length).toBe(0);

    rmSync(v, { recursive: true, force: true });
  });

  test("recall denies a different-owner record (positive isolation)", async () => {
    const v = fresh();
    observe(v, {
      kind: "document",
      content: "bob's verbatim secret pineapple data",
      actor: "bob", owner: "bob",
    });
    const r = await recall(v, {
      query: "pineapple",
      owner: "alice",
      actor: "alice:agent",
      purpose: "personal",
      limit: 10,
    });
    expect(r.hits.length).toBe(0);
    rmSync(v, { recursive: true, force: true });
  });

  test("recall correctly returns same-owner records (negative test for over-blocking)", async () => {
    const v = fresh();
    observe(v, {
      kind: "document",
      content: "alice's verbatim data containing pineapple",
      actor: "alice", owner: "alice",
    });
    const r = await recall(v, {
      query: "pineapple",
      owner: "alice",
      actor: "alice:agent",
      purpose: "personal",
      limit: 10,
    });
    expect(r.hits.length).toBeGreaterThanOrEqual(1);
    rmSync(v, { recursive: true, force: true });
  });
});

describe("Security hardening — UAL path traversal rejection", () => {
  test("parseUAL rejects encoded path traversal in owner", () => {
    // mema://owner/%2e%2e%2fetc%2fpasswd/fact/scope/memory/01ABC
    const malicious = "mema://owner/%2e%2e%2fetc%2fpasswd/fact/scope/memory/01ABC";
    const p = parseUAL(malicious);
    expect(p).toBeNull();
  });

  test("parseUAL rejects encoded path traversal in scope", () => {
    const malicious = "mema://owner/ardin/fact/%2e%2e%2f%2e%2e%2fetc/memory/01ABC";
    expect(parseUAL(malicious)).toBeNull();
  });

  test("parseUAL rejects raw .. dot-dot segments in owner", () => {
    // Even without URL encoding, if someone constructs a UAL with /../ they
    // would have to bypass the regex match anyway. Test post-decode safety.
    const malicious = "mema://owner/..%2F..%2Fetc/fact/scope/memory/01ABC";
    expect(parseUAL(malicious)).toBeNull();
  });

  test("parseUAL rejects null-byte injection", () => {
    const malicious = "mema://owner/alice%00admin/fact/scope/memory/01ABC";
    expect(parseUAL(malicious)).toBeNull();
  });

  test("parseUAL rejects shell metacharacters", () => {
    expect(parseUAL("mema://owner/alice%3B%20rm%20-rf/fact/scope/memory/01")).toBeNull();
    expect(parseUAL("mema://owner/alice/fact/scope%24%28curl%20evil%29/memory/01")).toBeNull();
  });

  test("parseUAL accepts legitimate components", () => {
    const legit = mintUAL({ owner: "ardin", kind: "fact", scope: "marcel-r", id: "01KRABC" });
    const p = parseUAL(legit);
    expect(p).not.toBeNull();
    expect(p!.owner).toBe("ardin");
    expect(p!.scope).toBe("marcel-r");
  });

  test("parseUAL accepts owner with dots, underscores, hyphens", () => {
    // mintUAL URL-encodes; legit values like "user-1.profile" pass through.
    const u = "mema://owner/user-1.profile/fact/scope_name/memory/01KRABC";
    const p = parseUAL(u);
    expect(p).not.toBeNull();
    expect(p!.owner).toBe("user-1.profile");
  });
});
