// Layer 6: Audit — append-only log with cryptographic hash chain.
// Records EVERY operation (OBSERVE/EXTRACT/INVALIDATE/REFLECT/RECALL/POLICY_DENY/ERASE).
// `prev_hash` chains entries so tampering with any entry breaks verification.
//
// Storage: SQLite (data/_meta/audit.sqlite), separate from v1's memory_log.
// We keep v1's log intact and add v2 audit alongside.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditEntry, AuditOp } from "./types";

let _db: Database | null = null;
let _vaultRoot: string | null = null;
// External sealed witness: every appended hash is also written here as an
// append-only line. An attacker who controls the SQLite DB cannot retroactively
// erase or rewrite witness lines that have already been flushed to disk
// (especially when the witness file is on a different device, watched by an
// fsnotify hook, or replicated to immutable storage).
let _witnessPath: string | null = null;

export function initAudit(vaultRoot: string): void {
  _vaultRoot = vaultRoot;
  const dbPath = `${vaultRoot}/_meta/audit.sqlite`;
  _witnessPath = `${vaultRoot}/_meta/audit-witness.log`;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      op TEXT NOT NULL,
      actor TEXT NOT NULL,
      owner TEXT NOT NULL,
      purpose TEXT,
      record_ids TEXT NOT NULL,        -- JSON array
      evidence_chain TEXT,             -- JSON array
      reason TEXT,
      prev_hash TEXT,
      curr_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit(owner, ts);
    CREATE INDEX IF NOT EXISTS idx_audit_op ON audit(op, ts);
  `);
  // v2.7.2+ metadata column for ERASE provenance, APPROVE/REJECT context,
  // and other op-specific structured payloads. Added via ALTER TABLE so
  // existing v2.0-v2.7.1 databases upgrade cleanly without losing the chain.
  const cols = db.prepare(`PRAGMA table_info(audit)`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === "metadata")) {
    db.exec(`ALTER TABLE audit ADD COLUMN metadata TEXT`);  // JSON object, nullable
  }
  _db = db;
}

function db(): Database {
  if (!_db) {
    if (!_vaultRoot) throw new Error("Audit not initialized — call initAudit() first");
    initAudit(_vaultRoot);
  }
  return _db!;
}

function computeHash(prevHash: string | null, payload: Record<string, unknown>): string {
  const canonical = JSON.stringify({ prev: prevHash, ...payload });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface AppendAuditInput {
  op: AuditOp;
  actor: string;
  owner: string;
  purpose?: string;
  record_ids: string[];
  evidence_chain?: string[];
  reason?: string;
  // v2.7.2+ op-specific structured metadata. For ERASE this carries the
  // pre-erasure provenance ({erased_record_id, erased_record_path,
  // content_hash_before, metadata_hash_before, legal_basis}). Included in
  // the hash chain, so tampering with metadata invalidates the chain.
  metadata?: Record<string, unknown>;
}

export function appendAudit(input: AppendAuditInput): AuditEntry {
  // CRITICAL: read-modify-write must be a single SQLite transaction so that
  // two concurrent appendAudit calls cannot read the same `prev_hash` and
  // commit a forked chain. bun:sqlite's `transaction()` uses BEGIN IMMEDIATE
  // internally — perfect for this RMW pattern.
  const ts = new Date().toISOString();
  const payloadBase = {
    ts,
    op: input.op,
    actor: input.actor,
    owner: input.owner,
    purpose: input.purpose,
    record_ids: input.record_ids,
    evidence_chain: input.evidence_chain,
    reason: input.reason,
  };

  // Metadata is part of the hashed payload so tampering with it invalidates
  // the chain — critical for the ERASE op's auditable provenance.
  const payloadWithMeta = input.metadata
    ? { ...payloadBase, metadata: input.metadata }
    : payloadBase;
  const txn = db().transaction(() => {
    const last = db().prepare(`SELECT curr_hash FROM audit ORDER BY seq DESC LIMIT 1`).get() as { curr_hash: string } | undefined;
    const prev = last?.curr_hash ?? null;
    const curr = computeHash(prev, payloadWithMeta);
    const r = db().prepare(`
      INSERT INTO audit (ts, op, actor, owner, purpose, record_ids, evidence_chain, reason, metadata, prev_hash, curr_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts, input.op, input.actor, input.owner,
      input.purpose ?? null,
      JSON.stringify(input.record_ids),
      input.evidence_chain ? JSON.stringify(input.evidence_chain) : null,
      input.reason ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      prev, curr,
    );
    return { seq: Number(r.lastInsertRowid), prev, curr };
  });
  const { seq, prev, curr } = txn();

  // External sealed witness: append the (seq, curr_hash) line to a separate
  // file. An attacker who later truncates the SQLite DB and resets
  // sqlite_sequence cannot retroactively rewrite witness lines already on disk.
  // verifyChain() cross-checks the DB against the witness file.
  if (_witnessPath) {
    try {
      appendFileSync(_witnessPath, `${seq}\t${curr}\n`, "utf8");
    } catch {
      // If the witness file is unwritable we still proceed — the in-DB chain
      // remains intact. Operators should monitor witness file availability.
    }
  }

  return {
    seq,
    ts, op: input.op, actor: input.actor, owner: input.owner,
    purpose: input.purpose,
    record_ids: input.record_ids,
    evidence_chain: input.evidence_chain,
    reason: input.reason,
    metadata: input.metadata,
    prev_hash: prev,
    curr_hash: curr,
  };
}

export function queryAudit(filter?: {
  owner?: string;
  op?: AuditOp;
  since?: string;
  limit?: number;
}): AuditEntry[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter?.owner) { where.push("owner = ?"); params.push(filter.owner); }
  if (filter?.op) { where.push("op = ?"); params.push(filter.op); }
  if (filter?.since) { where.push("ts >= ?"); params.push(filter.since); }
  const sql = `
    SELECT * FROM audit
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY seq DESC LIMIT ${filter?.limit ?? 100}
  `;
  const rows = db().prepare(sql).all(...params) as any[];
  return rows.map(r => ({
    ...r,
    record_ids: JSON.parse(r.record_ids),
    evidence_chain: r.evidence_chain ? JSON.parse(r.evidence_chain) : undefined,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));
}

// Walk the chain from seq=1; recompute each entry's hash and verify it matches.
// Returns the first break point (if any) so operators can investigate.
//
// CRITICAL: also detects row deletion by requiring contiguous `seq` values
// starting from 1, AND verifies entries_checked equals max(seq). An insider
// who deletes rows N..M out-of-band will break either the seq contiguity check
// (gap in the middle) or the count==max check (suffix-drop).
export function verifyChain(): {
  valid: boolean;
  broken_at_seq?: number;
  entries_checked: number;
  reason?: string;
} {
  const rows = db().prepare(`SELECT * FROM audit ORDER BY seq ASC`).all() as any[];
  let prev: string | null = null;
  let expectedSeq = 1;
  for (const r of rows) {
    // Seq contiguity check — catches mid-stream row deletion.
    if (r.seq !== expectedSeq) {
      return {
        valid: false,
        broken_at_seq: r.seq,
        entries_checked: rows.length,
        reason: `seq_gap: expected ${expectedSeq}, got ${r.seq}`,
      };
    }
    expectedSeq++;

    const payload: Record<string, unknown> = {
      ts: r.ts, op: r.op, actor: r.actor, owner: r.owner,
      purpose: r.purpose ?? undefined,
      record_ids: JSON.parse(r.record_ids),
      evidence_chain: r.evidence_chain ? JSON.parse(r.evidence_chain) : undefined,
      reason: r.reason ?? undefined,
    };
    // v2.7.2+ metadata is included in the hash payload only when present —
    // pre-v2.7.2 entries did not have this column, so their hash payload
    // omitted it. Adding metadata for older entries would invalidate the
    // chain; only include it when the row actually carries non-null metadata.
    if (r.metadata !== null && r.metadata !== undefined) {
      payload.metadata = JSON.parse(r.metadata);
    }
    const expected = computeHash(prev, payload);
    if (expected !== r.curr_hash || (r.prev_hash ?? null) !== prev) {
      return {
        valid: false,
        broken_at_seq: r.seq,
        entries_checked: rows.length,
        reason: "hash_mismatch",
      };
    }
    prev = r.curr_hash;
  }
  // Suffix-drop check: max(seq) from SQLite's autoincrement must equal rows.length.
  const seqState = db().prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'audit'`).get() as { seq: number } | undefined;
  if (seqState && seqState.seq > rows.length) {
    return {
      valid: false,
      broken_at_seq: rows.length + 1,
      entries_checked: rows.length,
      reason: `suffix_dropped: sqlite_sequence reports max seq ${seqState.seq} but only ${rows.length} rows present`,
    };
  }

  // EXTERNAL WITNESS CHECK — catches the sqlite_sequence tampering bypass.
  // Even an attacker who deletes rows AND resets sqlite_sequence cannot have
  // rewritten earlier witness lines already flushed to disk. Each line in the
  // witness file is `{seq}\t{curr_hash}`. We verify:
  //   (a) every DB row's curr_hash matches the witness line at that seq, AND
  //   (b) the witness file has no extra trailing lines that the DB lost.
  if (_witnessPath && existsSync(_witnessPath)) {
    let witness = "";
    try { witness = readFileSync(_witnessPath, "utf8"); } catch { /* ignore */ }
    const witnessLines = witness.split("\n").filter(l => l.length > 0);
    // Map seq -> expected hash from witness
    const witnessMap = new Map<number, string>();
    for (const line of witnessLines) {
      const [seqStr, h] = line.split("\t");
      const s = Number(seqStr);
      if (Number.isFinite(s) && h) witnessMap.set(s, h);
    }
    // Every DB row's hash must match the witness
    for (const r of rows) {
      const expected = witnessMap.get(r.seq);
      if (expected && expected !== r.curr_hash) {
        return {
          valid: false,
          broken_at_seq: r.seq,
          entries_checked: rows.length,
          reason: `witness_mismatch: seq ${r.seq} DB hash does not match external witness`,
        };
      }
    }
    // Witness must not contain rows the DB has lost
    const maxWitnessSeq = witnessLines.length > 0
      ? Math.max(...[...witnessMap.keys()])
      : 0;
    if (maxWitnessSeq > rows.length) {
      return {
        valid: false,
        broken_at_seq: rows.length + 1,
        entries_checked: rows.length,
        reason: `witness_suffix_drop: witness has seq up to ${maxWitnessSeq} but DB only has ${rows.length} rows`,
      };
    }
  }

  return { valid: true, entries_checked: rows.length };
}
