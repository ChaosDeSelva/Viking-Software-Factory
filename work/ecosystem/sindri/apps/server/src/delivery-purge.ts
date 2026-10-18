import type { SqliteDatabase } from "@sindri/knowledge";

/**
 * Delivery-side tables in delete order (children before parents: pr_requests,
 * delivery_evidence and knowledge_proposals before deliveries; gate_repairs before
 * gate_evaluations). They belong to `@sindri/delivery` and `@sindri/mimir-client` and have no
 * foreign key to `projects`. Since the S6 fix round the delivery_quality tables carry
 * `project_id` (deleted by it); rows written before that, and S5's execution tables, are found
 * through the project's plans and executions.
 */
const TABLES = [
  // The server's own settle-assessment markers.
  "quality_assessments",
  "pr_requests",
  "delivery_evidence",
  "knowledge_proposals",
  "gate_repairs",
  "gate_evaluations",
  "reviews",
  "deliveries",
  "execution_inbox",
  "execution_approvals",
  "artifacts_refs",
  "execution_events_v2",
  "execution_events",
  "execution_tasks",
  "executions",
  "execution_cursors",
] as const;

const list = (ids: readonly string[]) => JSON.stringify([...new Set(ids)]);
const IN = "IN (SELECT value FROM json_each(?))";

export interface DeliveryPurgeTargets {
  planIds: string[];
  executionIds: string[];
  missionIds: string[];
  deliveryIds: string[];
  /** Mimir task and approval ids: they appear in stored idempotency keys and responses. */
  refIds: string[];
}

function columns(db: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name),
  );
}

const ids = (db: SqliteDatabase, sql: string, ...params: unknown[]): string[] =>
  (db.prepare(sql).all(...params) as { id: string | null }[])
    .map((r) => r.id)
    .filter((v): v is string => typeof v === "string");

/** Everything delivery-side that belongs to the project (read before plans are deleted). */
export function deliveryPurgeTargets(db: SqliteDatabase, projectId: string): DeliveryPurgeTargets {
  const has = (t: string) => columns(db, t).size > 0;
  const planIds = has("plans")
    ? ids(db, "SELECT id FROM plans WHERE project_id = ?", projectId)
    : [];
  if (!has("executions"))
    return { planIds, executionIds: [], missionIds: [], deliveryIds: [], refIds: [] };
  const execCols = columns(db, "executions");
  const executionIds = ids(
    db,
    `SELECT id FROM executions WHERE plan_id ${IN}${
      execCols.has("project_id") ? " OR project_id = ?" : ""
    }`,
    list(planIds),
    ...(execCols.has("project_id") ? [projectId] : []),
  );
  const missionIds = ids(
    db,
    `SELECT mimir_mission_id AS id FROM executions WHERE id ${IN}`,
    list(executionIds),
  );
  const deliveryIds = has("deliveries")
    ? ids(
        db,
        `SELECT id FROM deliveries WHERE execution_id ${IN} OR project_id = ?`,
        list(executionIds),
        projectId,
      )
    : [];
  const refIds = [
    ...(has("execution_tasks")
      ? ids(
          db,
          `SELECT mimir_task_id AS id FROM execution_tasks WHERE execution_id ${IN}`,
          list(executionIds),
        )
      : []),
    ...(has("execution_approvals")
      ? ids(
          db,
          `SELECT mimir_approval_id AS id FROM execution_approvals WHERE execution_id ${IN}`,
          list(executionIds),
        )
      : []),
  ];
  return { planIds, executionIds, missionIds, deliveryIds, refIds };
}

/**
 * Deletes the project's executions, events, approvals, artifacts, gate evaluations, reviews,
 * deliveries, PR requests and knowledge proposals, Mimir follow cursors and stored Mimir
 * submissions, plus server idempotency rows that mention them. Run inside the purge
 * transaction, before the project row (and its plans) are deleted.
 */
export function purgeDeliveryData(
  db: SqliteDatabase,
  projectId: string,
  t: DeliveryPurgeTargets,
  keepCommandKey: string | null = null,
): void {
  for (const table of TABLES) {
    const cols = columns(db, table);
    if (cols.size === 0) continue;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, p: unknown) => {
      where.push(sql);
      params.push(p);
    };
    if (table === "executions") add(`id ${IN}`, list(t.executionIds));
    if (table === "deliveries") add(`id ${IN}`, list(t.deliveryIds));
    if (cols.has("execution_id")) add(`execution_id ${IN}`, list(t.executionIds));
    if (cols.has("delivery_id")) add(`delivery_id ${IN}`, list(t.deliveryIds));
    if (cols.has("mission_id")) add(`mission_id ${IN}`, list(t.missionIds));
    if (cols.has("project_id")) add("project_id = ?", projectId);
    if (where.length)
      db.prepare(`DELETE FROM "${table}" WHERE ${where.join(" OR ")}`).run(...params);
  }
  // Stored Mimir responses and server idempotency rows carry plan text and these ids.
  const refs = [...t.planIds, ...t.executionIds, ...t.missionIds, ...t.deliveryIds, ...t.refIds];
  if (refs.length === 0) return;
  const mentions = (cols: string[]) =>
    `EXISTS (SELECT 1 FROM json_each(?) j WHERE ${cols
      .map((c) => `instr(coalesce(${c}, ''), j.value) > 0`)
      .join(" OR ")})`;
  if (columns(db, "mimir_submissions").size > 0)
    db.prepare(
      `DELETE FROM mimir_submissions WHERE ${mentions(["idempotency_key", "mimir_id", "response_json"])}`,
    ).run(list(refs));
  if (columns(db, "commands").size > 0)
    db.prepare(
      `DELETE FROM commands WHERE idempotency_key IS NOT ? AND ${mentions(["url", "response"])}`,
    ).run(keepCommandKey, list(refs));
}
