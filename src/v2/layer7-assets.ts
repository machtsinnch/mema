// Layer 7 — Verifiable Memory Assets.
//
// Inspired by OriginTrail's Knowledge Asset model, adapted to mema's
// filesystem-truth substrate. Every memory becomes a verifiable asset with:
//   - content_hash    : SHA-256 of the body
//   - metadata_hash   : SHA-256 of the canonical frontmatter
//   - asset_version   : monotonically incremented on each update
//   - UAL             : stable resolvable identifier (mema://...)
//   - verification_status: unverified | verified | anchored
//
// Anchoring (publishing the asset's hash to an external trust system) is
// implemented as an interface only — local-anchor sink ships today,
// external sinks (OriginTrail DKG, customer-audit-bundle, etc.) are pluggable.
// NO blockchain dependency — mema works fully without external anchoring.

import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";

// ── Hashes ──────────────────────────────────────────────────────────

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Canonicalize frontmatter for hashing: sorted keys, JSON-serialized.
// Excludes the asset-hash fields themselves to avoid recursion.
function canonicalFrontmatter(fm: Record<string, unknown>): string {
  const excluded = new Set([
    "content_hash", "metadata_hash", "asset_version", "verification_status",
    "ual", "anchored_at", "anchor_targets",
  ]);
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(fm).sort()) {
    if (excluded.has(k)) continue;
    filtered[k] = fm[k];
  }
  return JSON.stringify(filtered);
}

export interface AssetHashes {
  content_hash: string;
  metadata_hash: string;
}

export function computeAssetHashes(body: string, frontmatter: Record<string, unknown>): AssetHashes {
  return {
    content_hash: sha256(body),
    metadata_hash: sha256(canonicalFrontmatter(frontmatter)),
  };
}

// ── UAL (Uniform Asset Locator) ─────────────────────────────────────
// Format: mema://owner/{owner}/{kind}/{entity_or_scope}/memory/{id}
// Examples:
//   mema://owner/ardin/episode/conversation/memory/01KR...
//   mema://owner/ardin/fact/marcel-r/memory/01KR...
//   mema://owner/ardin/cognitive/belief/memory/01KR...
//   mema://owner/ardin/v1/finance-plan/memory/01KR...

export interface UAL {
  owner: string;
  kind: string;     // episode | fact | cognitive | v1 | entity
  scope: string;    // entity name, scope name, or kind sub-class (e.g., "belief")
  id: string;
  raw: string;
}

export function mintUAL(input: { owner: string; kind: string; scope: string; id: string }): string {
  return `mema://owner/${encodeURIComponent(input.owner)}/${input.kind}/${encodeURIComponent(input.scope)}/memory/${input.id}`;
}

// SAFE_SEGMENT: after URL-decoding, owner/kind/scope/id components must match.
// Closes the path-traversal vulnerability where mintUAL encodes "../etc/passwd"
// to %2e%2e%2fetc%2fpasswd, parseUAL decodes back to "../etc/passwd", and any
// downstream filesystem `join` would escape the vault.
const SAFE_SEGMENT = /^[A-Za-z0-9_.\-]+$/;

export function parseUAL(ual: string): UAL | null {
  // Strict: scheme = mema://, segments = owner/{owner}/{kind}/{scope}/memory/{id}
  const m = ual.match(/^mema:\/\/owner\/([^\/]+)\/([^\/]+)\/([^\/]+)\/memory\/([^\/]+)$/);
  if (!m) return null;
  let owner: string, kind: string, scope: string, id: string;
  try {
    owner = decodeURIComponent(m[1]);
    kind = m[2];                              // not URL-encoded by mint
    scope = decodeURIComponent(m[3]);
    id = m[4];                                // ULIDs are A-Z0-9 only
  } catch {
    return null;                              // malformed percent-encoding
  }
  // Reject path traversal / shell metacharacters / null bytes in DECODED values.
  if (!SAFE_SEGMENT.test(owner)) return null;
  if (!SAFE_SEGMENT.test(kind)) return null;
  if (!SAFE_SEGMENT.test(scope)) return null;
  if (!SAFE_SEGMENT.test(id)) return null;
  return { owner, kind, scope, id, raw: ual };
}

// ── Asset wrapping: add the verifiable-asset fields to a record file ──

export type VerificationStatus = "unverified" | "verified" | "anchored";

export interface AssetMetadata {
  ual: string;
  content_hash: string;
  metadata_hash: string;
  asset_version: number;
  verification_status: VerificationStatus;
  anchored_at?: string;
  anchor_targets?: string[];
}

// Wrap an existing record file in place: read, compute hashes, mint UAL,
// write back with asset metadata in frontmatter. Idempotent — running twice
// produces the same hashes (until the body or non-asset frontmatter changes).
export function wrapRecordAsAsset(
  filePath: string,
  ualInput: { owner: string; kind: string; scope: string; id: string },
): AssetMetadata {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const body = parsed.content.trim();
  const fm = { ...parsed.data };

  const hashes = computeAssetHashes(body, fm);
  const ual = mintUAL(ualInput);
  const prevVersion = typeof fm.asset_version === "number" ? fm.asset_version : 0;
  // Bump version only if content/metadata actually changed
  const hashesChanged =
    fm.content_hash !== hashes.content_hash || fm.metadata_hash !== hashes.metadata_hash;
  const newVersion = prevVersion === 0 ? 1 : (hashesChanged ? prevVersion + 1 : prevVersion);

  const assetMeta: AssetMetadata = {
    ual,
    content_hash: hashes.content_hash,
    metadata_hash: hashes.metadata_hash,
    asset_version: newVersion,
    verification_status: (fm.verification_status as VerificationStatus) ?? "unverified",
    anchored_at: fm.anchored_at as string | undefined,
    anchor_targets: fm.anchor_targets as string[] | undefined,
  };

  // Strip undefined values — js-yaml cannot serialize undefined.
  const newFm: Record<string, unknown> = { ...fm };
  for (const [k, vv] of Object.entries(assetMeta)) {
    if (vv !== undefined) newFm[k] = vv;
  }
  // Also remove any pre-existing undefined values from the original frontmatter
  for (const k of Object.keys(newFm)) {
    if (newFm[k] === undefined) delete newFm[k];
  }
  writeFileSync(filePath, matter.stringify(body, newFm), "utf8");
  return assetMeta;
}

// Recompute hashes from current file state and compare against stored hashes.
// Returns valid:true when the asset is intact, valid:false (with which hash
// failed) when the file has been mutated since last wrap.
export interface IntegrityResult {
  valid: boolean;
  content_hash_ok: boolean;
  metadata_hash_ok: boolean;
  stored_content_hash?: string;
  computed_content_hash?: string;
  stored_metadata_hash?: string;
  computed_metadata_hash?: string;
}

export function verifyAssetIntegrity(filePath: string): IntegrityResult {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const computed = computeAssetHashes(parsed.content.trim(), parsed.data);
  const stored = {
    content_hash: parsed.data.content_hash as string | undefined,
    metadata_hash: parsed.data.metadata_hash as string | undefined,
  };
  if (!stored.content_hash || !stored.metadata_hash) {
    return {
      valid: false,
      content_hash_ok: false,
      metadata_hash_ok: false,
      computed_content_hash: computed.content_hash,
      computed_metadata_hash: computed.metadata_hash,
    };
  }
  const ch_ok = stored.content_hash === computed.content_hash;
  const mh_ok = stored.metadata_hash === computed.metadata_hash;
  return {
    valid: ch_ok && mh_ok,
    content_hash_ok: ch_ok,
    metadata_hash_ok: mh_ok,
    stored_content_hash: stored.content_hash,
    computed_content_hash: computed.content_hash,
    stored_metadata_hash: stored.metadata_hash,
    computed_metadata_hash: computed.metadata_hash,
  };
}

// ── Anchor interface (pluggable, no blockchain by default) ──────────

export type AnchorTarget = "local" | "customer-audit-bundle" | "origintrail" | string;

export interface Anchor {
  ual: string;
  content_hash: string;
  metadata_hash: string;
  asset_version: number;
  target: AnchorTarget;
  anchored_at: string;
  receipt?: string;          // target-specific receipt (transaction id, doc id, etc.)
}

let _anchorDb: Database | null = null;

export function initAnchorStore(vaultRoot: string): void {
  const dbPath = `${vaultRoot}/_meta/anchors.sqlite`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS anchors (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ual TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_hash TEXT NOT NULL,
      asset_version INTEGER NOT NULL,
      target TEXT NOT NULL,
      anchored_at TEXT NOT NULL,
      receipt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_anchor_ual ON anchors(ual);
    CREATE INDEX IF NOT EXISTS idx_anchor_target ON anchors(target);
  `);
  _anchorDb = db;
}

function adb(): Database {
  if (!_anchorDb) throw new Error("Anchor store not initialized");
  return _anchorDb;
}

export interface AnchorAssetInput {
  vaultRoot: string;
  filePath: string;          // path to the record file
  target: AnchorTarget;
}

// Anchor an asset to a target. v2.0 ships "local" target which simply writes
// the anchor record. External sinks (OriginTrail DKG, customer audit bundle,
// IPFS, etc.) are pluggable through this interface — they implement an
// `anchorPublish(asset)` function and return a receipt.
export function anchorAsset(input: AnchorAssetInput): Anchor {
  const raw = readFileSync(input.filePath, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data;
  if (!fm.ual || !fm.content_hash || !fm.metadata_hash) {
    throw new Error(`asset not wrapped — call wrapRecordAsAsset first: ${input.filePath}`);
  }
  const now = new Date().toISOString();
  const anchor: Anchor = {
    ual: fm.ual,
    content_hash: fm.content_hash,
    metadata_hash: fm.metadata_hash,
    asset_version: fm.asset_version ?? 1,
    target: input.target,
    anchored_at: now,
    receipt: input.target === "local" ? `local-${Date.now()}` : undefined,
  };
  adb().prepare(`
    INSERT INTO anchors (ual, content_hash, metadata_hash, asset_version, target, anchored_at, receipt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(anchor.ual, anchor.content_hash, anchor.metadata_hash, anchor.asset_version,
         anchor.target, anchor.anchored_at, anchor.receipt ?? null);

  // Update the record's verification_status + anchored_at
  const newFm: Record<string, unknown> = {
    ...fm,
    verification_status: "anchored" as VerificationStatus,
    anchored_at: now,
    anchor_targets: [...new Set([...((fm.anchor_targets as string[]) ?? []), input.target])],
  };
  for (const k of Object.keys(newFm)) {
    if (newFm[k] === undefined) delete newFm[k];
  }
  writeFileSync(input.filePath, matter.stringify(parsed.content.trim(), newFm), "utf8");

  return anchor;
}

// CRITICAL: listAnchors MUST be owner-scoped. We extract the owner from the UAL
// embedded in each anchor row and filter against the caller's owner. Anchors
// don't have a separate owner column today — that's the contract via UAL.
export function listAnchors(owner: string, ual?: string): Anchor[] {
  if (!owner) return [];   // deny-by-default
  const sql = ual
    ? `SELECT * FROM anchors WHERE ual = ? ORDER BY seq DESC`
    : `SELECT * FROM anchors ORDER BY seq DESC LIMIT 500`;
  const rows = (ual ? adb().prepare(sql).all(ual) : adb().prepare(sql).all()) as any[];
  const ownerPrefix = `mema://owner/${encodeURIComponent(owner)}/`;
  return rows
    .filter(r => typeof r.ual === "string" && r.ual.startsWith(ownerPrefix))
    .slice(0, 200)
    .map(r => ({
      ual: r.ual,
      content_hash: r.content_hash,
      metadata_hash: r.metadata_hash,
      asset_version: r.asset_version,
      target: r.target,
      anchored_at: r.anchored_at,
      receipt: r.receipt ?? undefined,
    }));
}

// Mark a memory as "verified" — typically after a human reviews it.
// State transitions: unverified -> verified -> anchored
export function setVerificationStatus(filePath: string, status: VerificationStatus): void {
  const raw = readFileSync(filePath, "utf8");
  const parsed = matter(raw);
  const newFm: Record<string, unknown> = { ...parsed.data, verification_status: status };
  for (const k of Object.keys(newFm)) {
    if (newFm[k] === undefined) delete newFm[k];
  }
  writeFileSync(filePath, matter.stringify(parsed.content.trim(), newFm), "utf8");
}
