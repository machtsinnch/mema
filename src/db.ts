// machtsinn.ai — SQLite append-only provenance log.
// Every memory mutation is logged. Forgetting is a log entry, not a delete.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Operation } from "./types";

let _db: Database | null = null;

export function initLog(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      op TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      actor TEXT NOT NULL,
      source TEXT,
      diff TEXT,
      trust_before REAL,
      trust_after REAL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_log_memory ON memory_log(memory_id);
    CREATE INDEX IF NOT EXISTS idx_log_owner ON memory_log(owner, ts);
    CREATE INDEX IF NOT EXISTS idx_log_op ON memory_log(op, ts);
  `);
  _db = db;
  return db;
}

export function db(): Database {
  if (!_db) throw new Error("DB not initialized — call initLog() first");
  return _db;
}

export interface LogEntry {
  seq: number;
  ts: string;
  op: Operation;
  memory_id: string;
  owner: string;
  actor: string;
  source?: string | null;
  diff?: string | null;
  trust_before?: number | null;
  trust_after?: number | null;
  reason?: string | null;
}

export function logOp(entry: Omit<LogEntry, "seq" | "ts"> & { ts?: string }): void {
  const ts = entry.ts ?? new Date().toISOString();
  db().prepare(`
    INSERT INTO memory_log
    (ts, op, memory_id, owner, actor, source, diff, trust_before, trust_after, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ts,
    entry.op,
    entry.memory_id,
    entry.owner,
    entry.actor,
    entry.source ?? null,
    entry.diff ?? null,
    entry.trust_before ?? null,
    entry.trust_after ?? null,
    entry.reason ?? null,
  );
}

export function queryLog(filter?: {
  memory_id?: string;
  owner?: string;
  op?: Operation;
  since?: string;
  limit?: number;
}): LogEntry[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter?.memory_id) { where.push("memory_id = ?"); params.push(filter.memory_id); }
  if (filter?.owner)     { where.push("owner = ?");     params.push(filter.owner); }
  if (filter?.op)        { where.push("op = ?");        params.push(filter.op); }
  if (filter?.since)     { where.push("ts >= ?");       params.push(filter.since); }
  const sql = `
    SELECT * FROM memory_log
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY seq DESC
    LIMIT ${filter?.limit ?? 1000}
  `;
  return db().prepare(sql).all(...params) as LogEntry[];
}
