import {
  applyMigrations,
  KNOWLEDGE_MIGRATIONS,
  openDatabase,
  type SqliteDatabase,
} from "@sindri/knowledge";

/** Sindri project ids the test plans use (`approvedPlan` fixtures and the fake world). */
export const TEST_PROJECT_IDS: readonly string[] = ["sindri-project-1", "prj_1"];

/**
 * An in-memory database with the knowledge schema and the test projects: since audit M4,
 * executions and deliveries reference `projects(id)`.
 */
export function openDeliveryTestDb(
  projectIds: readonly string[] = TEST_PROJECT_IDS,
): SqliteDatabase {
  const db = openDatabase(":memory:");
  applyMigrations(db, "knowledge", KNOWLEDGE_MIGRATIONS);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, repo_path, created_at, updated_at)
     VALUES (?, ?, '/repos/test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  for (const id of projectIds) insert.run(id, id);
  return db;
}
