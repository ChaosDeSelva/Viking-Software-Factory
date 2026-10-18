import {
  applyMigrations,
  KNOWLEDGE_MIGRATIONS,
  registerPurgeHook,
  type SqliteDatabase,
} from "@sindri/knowledge";
import { QUALITY_MIGRATIONS } from "./gates/migrations.js";
import { DELIVERY_MIGRATIONS } from "./migrations.js";

const hasTable = (db: SqliteDatabase, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
  undefined;

/** Executions of a project, including rows written before `executions.project_id` existed. */
const PROJECT_EXECUTIONS = `SELECT id FROM executions WHERE project_id = @p
  OR (project_id IS NULL AND json_valid(plan_json) AND json_extract(plan_json, '$.projectId') = @p)`;

/**
 * Applies the knowledge schema (the `projects` table the delivery tables reference), then the
 * `delivery` namespace, and registers its purge hook. Executions cascade from `projects`; the
 * hook catches rows written before `executions.project_id` existed.
 */
export function ensureDeliverySchema(db: SqliteDatabase): void {
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  applyMigrations(db, "delivery", DELIVERY_MIGRATIONS);
  registerPurgeHook(db, "delivery", (projectId) => {
    db.prepare(`DELETE FROM executions WHERE id IN (${PROJECT_EXECUTIONS})`).run({ p: projectId });
  });
}

/**
 * Applies the knowledge schema, then the `delivery_quality` namespace, and registers its purge
 * hook: gate evaluations and repairs, reviews and everything hanging off the project's
 * deliveries go with the project (audit M4). Deliveries cascade from `projects`.
 */
export function ensureQualitySchema(db: SqliteDatabase): void {
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  applyMigrations(db, "delivery_quality", QUALITY_MIGRATIONS);
  registerPurgeHook(db, "delivery_quality", (projectId) => {
    const executions = hasTable(db, "executions")
      ? ` OR execution_id IN (${PROJECT_EXECUTIONS})`
      : "";
    const deliveries = " OR delivery_id IN (SELECT id FROM deliveries WHERE project_id = @p)";
    for (const [table, extra] of [
      ["pr_requests", deliveries],
      ["delivery_evidence", deliveries],
      ["knowledge_proposals", deliveries],
      ["gate_repairs", executions],
      ["gate_evaluations", executions],
      ["reviews", executions],
      ["deliveries", executions],
    ] as const)
      db.prepare(`DELETE FROM ${table} WHERE project_id = @p${extra}`).run({ p: projectId });
  });
}
