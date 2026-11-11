import {
  applyMigrations,
  KNOWLEDGE_MIGRATIONS,
  registerPurgeHook,
  type SqliteDatabase,
} from "@sindri/knowledge";
import { STEWARD_MIGRATIONS } from "./migrations.js";

/** Steward tables holding project rows, children first. */
export const STEWARD_PROJECT_TABLES = [
  "steward_notes",
  "steward_decision_history",
  "steward_guidance",
  "steward_decisions",
] as const;

/**
 * Applies the knowledge schema (the `projects` table the steward tables reference), then the
 * `steward` namespace, and registers its purge hook. Rows cascade from `projects`; the hook
 * deletes them explicitly as well, so a purge never depends on the foreign-key pragma.
 */
export function ensureStewardSchema(db: SqliteDatabase): void {
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  applyMigrations(db, "steward", STEWARD_MIGRATIONS);
  registerPurgeHook(db, "steward", (projectId) => purgeStewardProject(db, projectId));
}

/** Deletes every steward row of a project (decisions, their history and notes, guidance). */
export function purgeStewardProject(db: SqliteDatabase, projectId: string): void {
  db.prepare(
    `DELETE FROM steward_notes WHERE project_id = ?
       OR decision_id IN (SELECT id FROM steward_decisions WHERE project_id = ?)`,
  ).run(projectId, projectId);
  for (const table of STEWARD_PROJECT_TABLES.slice(1))
    db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
}
