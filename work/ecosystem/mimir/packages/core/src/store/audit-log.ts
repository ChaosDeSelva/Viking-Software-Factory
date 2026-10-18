import { newId } from "@mimir/protocol";
import { redact } from "../redaction.js";
import type { Db, Stmt } from "./db.js";

export interface AuditInput {
  actor: string;
  action: string;
  target?: string;
  decision?: string;
  reason?: string;
}

export interface AuditRecord extends AuditInput {
  id: string;
  createdAt: string;
}

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  decision: string | null;
  reason: string | null;
  created_at: string;
}

function rowToRecord(row: AuditRow): AuditRecord {
  const rec: AuditRecord = {
    id: row.id,
    actor: row.actor,
    action: row.action,
    createdAt: row.created_at,
  };
  if (row.target !== null) rec.target = row.target;
  if (row.decision !== null) rec.decision = row.decision;
  if (row.reason !== null) rec.reason = row.reason;
  return rec;
}

/** Append-only audit trail of who did what. `reason` is passed through `redact`. */
export class AuditLog {
  private readonly insert: Stmt;
  private readonly all: Stmt;

  constructor(db: Db) {
    this.insert = db.prepare(
      `INSERT INTO audit_entries (id, actor, action, target, decision, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.all = db.prepare("SELECT * FROM audit_entries ORDER BY rowid");
  }

  record(input: AuditInput): AuditRecord {
    const row: AuditRow = {
      id: newId("aud"),
      actor: input.actor,
      action: input.action,
      target: input.target ?? null,
      decision: input.decision ?? null,
      reason: input.reason === undefined ? null : redact(input.reason).text,
      created_at: new Date().toISOString(),
    };
    this.insert.run(
      row.id,
      row.actor,
      row.action,
      row.target,
      row.decision,
      row.reason,
      row.created_at,
    );
    return rowToRecord(row);
  }

  list(): AuditRecord[] {
    return (this.all.all() as AuditRow[]).map(rowToRecord);
  }
}
