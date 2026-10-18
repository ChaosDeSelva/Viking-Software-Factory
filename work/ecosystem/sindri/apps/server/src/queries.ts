import type { SqliteDatabase } from "@sindri/knowledge";

/**
 * Read-only queries over the delivery package's tables that `DeliveryLoop` does not expose:
 * executions by project (executions only know their plan), and event rows by insertion order
 * (for SSE ids and Last-Event-ID resume). Nothing here writes.
 */
export interface ExecutionSummaryRow {
  id: string;
  planId: string;
  planVersion: number;
  projectId: string;
  status: string;
  mimirMissionId: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface EventRow {
  seq: number;
  id: string;
  mimirEventId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
}

export function executionsByProject(db: SqliteDatabase, projectId: string): ExecutionSummaryRow[] {
  return db
    .prepare(
      `SELECT e.id, e.plan_id AS planId, e.plan_version AS planVersion, p.project_id AS projectId,
              e.status, e.mimir_mission_id AS mimirMissionId, e.created_at AS createdAt,
              e.finished_at AS finishedAt
       FROM executions e JOIN plans p ON p.id = e.plan_id
       WHERE p.project_id = ? ORDER BY e.created_at DESC, e.rowid DESC`,
    )
    .all(projectId) as ExecutionSummaryRow[];
}

/** The project of an execution, through its plan (null when the plan is gone). */
export function projectOfExecution(db: SqliteDatabase, executionId: string): string | null {
  const r = db
    .prepare(
      "SELECT p.project_id AS projectId FROM executions e JOIN plans p ON p.id = e.plan_id WHERE e.id = ?",
    )
    .get(executionId) as { projectId: string } | undefined;
  return r?.projectId ?? null;
}

/** Sequence number of an event row (for Last-Event-ID); 0 when unknown. */
export function eventSeq(db: SqliteDatabase, executionId: string, eventId: string): number {
  const r = db
    .prepare("SELECT rowid AS seq FROM execution_events WHERE execution_id = ? AND id = ?")
    .get(executionId, eventId) as { seq: number } | undefined;
  return r?.seq ?? 0;
}

export function eventsAfter(
  db: SqliteDatabase,
  executionId: string,
  afterSeq: number,
  limit = 500,
): EventRow[] {
  return (
    db
      .prepare(
        `SELECT rowid AS seq, id, mimir_event_id, type, payload_json, occurred_at
         FROM execution_events WHERE execution_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
      )
      .all(executionId, afterSeq, limit) as {
      seq: number;
      id: string;
      mimir_event_id: string;
      type: string;
      payload_json: string;
      occurred_at: string;
    }[]
  ).map((r) => ({
    seq: r.seq,
    id: r.id,
    mimirEventId: r.mimir_event_id,
    type: r.type,
    payload: JSON.parse(r.payload_json) as unknown,
    occurredAt: r.occurred_at,
  }));
}

/** Every execution with its status (startup resume). */
export function executionStatuses(db: SqliteDatabase): { id: string; status: string }[] {
  return db.prepare("SELECT id, status FROM executions ORDER BY created_at").all() as {
    id: string;
    status: string;
  }[];
}
