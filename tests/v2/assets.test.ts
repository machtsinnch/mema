// Layer 7 — Verifiable Memory Asset tests.
// Covers: hash computation determinism, UAL round-trip, integrity detection of
// tampering, anchor lifecycle, verification status transitions.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { observe, pathForEpisode } from "../../src/v2/layer1-episodic";
import { initAudit } from "../../src/v2/layer6-audit";
import {
  computeAssetHashes, mintUAL, parseUAL,
  wrapRecordAsAsset, verifyAssetIntegrity,
  anchorAsset, listAnchors, setVerificationStatus,
  initAnchorStore, sha256,
} from "../../src/v2/layer7-assets";

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "mema-assets-"));
  initAudit(dir);
  initAnchorStore(dir);
  return dir;
}

describe("Layer 7 — Hashes", () => {
  test("sha256 is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello").length).toBe(64);
    expect(sha256("hello")).not.toBe(sha256("Hello"));
  });

  test("computeAssetHashes ignores asset-meta fields (recursion-safe)", () => {
    const body = "test body";
    const fm1 = { id: "x", owner: "ardin", kind: "doc" };
    const fm2 = { id: "x", owner: "ardin", kind: "doc", content_hash: "fake", asset_version: 1 };
    const h1 = computeAssetHashes(body, fm1);
    const h2 = computeAssetHashes(body, fm2);
    expect(h1.metadata_hash).toBe(h2.metadata_hash);  // asset fields excluded from hash
    expect(h1.content_hash).toBe(h2.content_hash);
  });
});

describe("Layer 7 — UAL", () => {
  test("mint + parse round trip", () => {
    const ual = mintUAL({ owner: "ardin", kind: "fact", scope: "marcel-r", id: "01ABC" });
    expect(ual).toBe("mema://owner/ardin/fact/marcel-r/memory/01ABC");
    const parsed = parseUAL(ual);
    expect(parsed).not.toBeNull();
    expect(parsed!.owner).toBe("ardin");
    expect(parsed!.kind).toBe("fact");
    expect(parsed!.scope).toBe("marcel-r");
    expect(parsed!.id).toBe("01ABC");
  });

  test("parse rejects malformed", () => {
    expect(parseUAL("https://wrong.scheme/x/y/z")).toBeNull();
    expect(parseUAL("mema://onlytwosegments")).toBeNull();
    expect(parseUAL("")).toBeNull();
  });

  test("parseUAL accepts safe-character owner/scope (no traversal vectors)", () => {
    // Spaces and slashes are intentionally rejected at parse time — that's a
    // SECURITY property (closes path-traversal). Only owners/scopes matching
    // [A-Za-z0-9_.\-] are accepted post-decode.
    const ual = mintUAL({ owner: "user-one", kind: "fact", scope: "swiss-ai", id: "01" });
    const parsed = parseUAL(ual);
    expect(parsed).not.toBeNull();
    expect(parsed!.owner).toBe("user-one");
    expect(parsed!.scope).toBe("swiss-ai");
  });
});

describe("Layer 7 — Wrap & Verify Integrity", () => {
  test("wrapping a record stamps it with hashes + UAL + version 1", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "verifiable body", actor: "ardin", owner: "ardin" });
    const path = pathForEpisode(v, "ardin", ep.id)!;
    const meta = wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });
    expect(meta.ual).toContain("mema://owner/ardin/episode/document/memory/");
    expect(meta.content_hash).toHaveLength(64);
    expect(meta.metadata_hash).toHaveLength(64);
    expect(meta.asset_version).toBe(1);
    expect(meta.verification_status).toBe("unverified");
    rmSync(v, { recursive: true, force: true });
  });

  test("integrity check passes on unmodified asset", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "stable body", actor: "ardin", owner: "ardin" });
    const path = pathForEpisode(v, "ardin", ep.id)!;
    wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });
    const r = verifyAssetIntegrity(path);
    expect(r.valid).toBe(true);
    expect(r.content_hash_ok).toBe(true);
    expect(r.metadata_hash_ok).toBe(true);
    rmSync(v, { recursive: true, force: true });
  });

  test("integrity check FAILS when body is silently modified", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "original content", actor: "ardin", owner: "ardin" });
    const path = pathForEpisode(v, "ardin", ep.id)!;
    wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });

    // Adversary modifies the body directly on disk
    const raw = readFileSync(path, "utf8");
    const parsed = matter(raw);
    const tampered = matter.stringify("TAMPERED — different content", parsed.data);
    writeFileSync(path, tampered, "utf8");

    const r = verifyAssetIntegrity(path);
    expect(r.valid).toBe(false);
    expect(r.content_hash_ok).toBe(false);
    rmSync(v, { recursive: true, force: true });
  });

  test("re-wrapping after a real change bumps asset_version", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "v1 body", actor: "ardin", owner: "ardin" });
    const path = pathForEpisode(v, "ardin", ep.id)!;
    const m1 = wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });
    expect(m1.asset_version).toBe(1);

    // Re-wrap without change — version stays
    const m2 = wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });
    expect(m2.asset_version).toBe(1);

    // Modify body and rewrap — version bumps
    const raw = readFileSync(path, "utf8");
    const parsed = matter(raw);
    const updated = matter.stringify("v2 body", parsed.data);
    writeFileSync(path, updated, "utf8");
    const m3 = wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });
    expect(m3.asset_version).toBe(2);

    rmSync(v, { recursive: true, force: true });
  });
});

describe("Layer 7 — Anchor lifecycle", () => {
  test("anchorAsset writes a receipt and updates verification_status", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "anchor me", actor: "ardin", owner: "ardin" });
    const path = pathForEpisode(v, "ardin", ep.id)!;
    wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });

    const a = anchorAsset({ vaultRoot: v, filePath: path, target: "local" });
    expect(a.target).toBe("local");
    expect(a.receipt).toContain("local-");
    expect(a.content_hash).toHaveLength(64);

    // listAnchors is owner-scoped — first arg is owner, optional second arg is UAL.
    const anchors = listAnchors("ardin", a.ual);
    expect(anchors.length).toBe(1);

    // Cross-tenant check: a different owner cannot see this anchor.
    const crossTenant = listAnchors("alice", a.ual);
    expect(crossTenant.length).toBe(0);

    // Record's verification_status should now be "anchored"
    const after = matter(readFileSync(path, "utf8"));
    expect(after.data.verification_status).toBe("anchored");
    expect(after.data.anchor_targets).toContain("local");

    rmSync(v, { recursive: true, force: true });
  });

  test("anchoring fails if record was not wrapped", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "not wrapped", actor: "ardin", owner: "ardin" });
    const path = pathForEpisode(v, "ardin", ep.id)!;
    let threw = false;
    try { anchorAsset({ vaultRoot: v, filePath: path, target: "local" }); } catch { threw = true; }
    expect(threw).toBe(true);
    rmSync(v, { recursive: true, force: true });
  });

  test("setVerificationStatus transitions the state", () => {
    const v = fresh();
    const ep = observe(v, { kind: "document", content: "review me", actor: "ardin", owner: "ardin" });
    const path = pathForEpisode(v, "ardin", ep.id)!;
    wrapRecordAsAsset(path, { owner: "ardin", kind: "episode", scope: "document", id: ep.id });
    setVerificationStatus(path, "verified");
    const after = matter(readFileSync(path, "utf8"));
    expect(after.data.verification_status).toBe("verified");
    rmSync(v, { recursive: true, force: true });
  });
});
