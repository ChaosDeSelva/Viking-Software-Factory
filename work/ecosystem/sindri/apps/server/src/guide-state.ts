import type { GuideCountedItem, GuideProjectState, GuideState } from "@sindri/director";
import type { SqliteDatabase } from "@sindri/knowledge";
import { FINAL_STATUSES } from "./statuses.js";

/**
 * The Guide's state snapshot: counts by status and titles only, read with SELECTs alone (the
 * Guide never writes). A section whose table does not exist yet reads as empty.
 */

const MAX_PROJECTS = 20;
const MAX_ITEMS = 5;

const FINAL = [...FINAL_STATUSES];
const NOT_FINAL = `e.status NOT IN (${FINAL.map(() => "?").join(", ")})`;

function rows<T>(db: SqliteDatabase, sql: string, ...args: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch {
    return [];
  }
}

const countBy = (db: SqliteDatabase, sql: string, projectId: string) =>
  Object.fromEntries(
    rows<{ status: string; n: number }>(db, sql, projectId).map((r) => [r.status, r.n]),
  );

function group(
  db: SqliteDatabase,
  countSql: string,
  itemsSql: string,
  args: unknown[],
  item: (r: Record<string, string>) => GuideCountedItem,
) {
  const count = rows<{ n: number }>(db, countSql, ...args)[0]?.n ?? 0;
  const items = rows<Record<string, string>>(db, `${itemsSql} LIMIT ${MAX_ITEMS}`, ...args).map(
    item,
  );
  return { count, items };
}

const EXEC_TASKS = `FROM execution_tasks t JOIN executions e ON e.id = t.execution_id
  JOIN plans p ON p.id = e.plan_id WHERE p.project_id = ? AND ${NOT_FINAL}`;
const BUDGET = `(t.blocked_reason LIKE 'budget_exceeded%' OR t.blocked_reason LIKE 'budget_uncertain%')`;

function projectState(db: SqliteDatabase, p: { id: string; name: string }): GuideProjectState {
  const exec = [p.id, ...FINAL];
  return {
    id: p.id,
    name: p.name,
    specs: countBy(
      db,
      "SELECT status, COUNT(*) AS n FROM specifications WHERE project_id = ? GROUP BY status",
      p.id,
    ),
    plans: countBy(
      db,
      "SELECT status, COUNT(*) AS n FROM plans WHERE project_id = ? GROUP BY status",
      p.id,
    ),
    executions: countBy(
      db,
      `SELECT e.status, COUNT(*) AS n FROM executions e JOIN plans p ON p.id = e.plan_id
       WHERE p.project_id = ? GROUP BY e.status`,
      p.id,
    ),
    deliveries: countBy(
      db,
      "SELECT status, COUNT(*) AS n FROM deliveries WHERE project_id = ? GROUP BY status",
      p.id,
    ),
    pendingApprovals:
      rows<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM execution_approvals a JOIN executions e ON e.id = a.execution_id
         JOIN plans p ON p.id = e.plan_id
         WHERE p.project_id = ? AND a.status = 'pending' AND a.disposition = 'inbox'`,
        p.id,
      )[0]?.n ?? 0,
    pendingDecisions: group(
      db,
      "SELECT COUNT(*) AS n FROM steward_decisions WHERE project_id = ? AND status = 'pending'",
      `SELECT id, type, subject_label FROM steward_decisions
       WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC`,
      [p.id],
      (r) => ({ id: r["id"]!, label: `${r["type"]}: ${r["subject_label"]}` }),
    ),
    openEscalations: group(
      db,
      `SELECT COUNT(*) AS n ${EXEC_TASKS} AND t.escalation IS NOT NULL`,
      `SELECT e.id, t.plan_task_id, t.escalation ${EXEC_TASKS} AND t.escalation IS NOT NULL
       ORDER BY e.created_at DESC, t.rowid`,
      exec,
      (r) => ({ id: r["id"]!, label: `task ${r["plan_task_id"]} (${r["escalation"]})` }),
    ),
    budgetBlocks: group(
      db,
      `SELECT COUNT(*) AS n ${EXEC_TASKS} AND ${BUDGET}`,
      `SELECT e.id, t.plan_task_id ${EXEC_TASKS} AND ${BUDGET} ORDER BY e.created_at DESC, t.rowid`,
      exec,
      (r) => ({ id: r["id"]!, label: `task ${r["plan_task_id"]}` }),
    ),
    recentSpecs: rows<{ id: string; title: string; status: string }>(
      db,
      `SELECT id, title, status FROM specifications WHERE project_id = ? AND status <> 'superseded'
       ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_ITEMS}`,
      p.id,
    ).map((s) => ({ id: s.id, label: s.title, status: s.status })),
  };
}

/** The snapshot for one project, or for every project when none (or an unknown one) is named. */
export function guideState(db: SqliteDatabase, projectId?: string): GuideState {
  if (projectId) {
    const one = rows<{ id: string; name: string }>(
      db,
      "SELECT id, name FROM projects WHERE id = ?",
      projectId,
    );
    if (one[0]) return { projects: [projectState(db, one[0])] };
  }
  const all = rows<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM projects ORDER BY updated_at DESC, rowid DESC LIMIT ${MAX_PROJECTS + 1}`,
  );
  return {
    projects: all.slice(0, MAX_PROJECTS).map((p) => projectState(db, p)),
    ...(projectId ? { unknownProject: true } : {}),
    ...(all.length > MAX_PROJECTS ? { truncated: true } : {}),
  };
}
