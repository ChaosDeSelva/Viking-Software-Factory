import Database from "better-sqlite3";

/**
 * The shared better-sqlite3 handle type. Declared as an interface so dependants can name it
 * in emitted declarations without depending on `@types/better-sqlite3` themselves.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SqliteDatabase extends Database.Database {}

/**
 * Open (or create) a Sindri SQLite database with the shared pragmas:
 * WAL journaling, foreign keys enforced, and a busy timeout.
 */
export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    namespace TEXT NOT NULL,
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (namespace, version)
  )`);
  return db;
}

/**
 * Apply each not-yet-applied migration of `namespace`, in order; each step runs in its
 * own transaction. Migrations are append-only: index i is version i + 1.
 * Returns the number of migrations applied.
 */
export function applyMigrations(
  db: SqliteDatabase,
  namespace: string,
  migrations: readonly string[],
): number {
  const current = db.prepare(
    "SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations WHERE namespace = ?",
  );
  const record = db.prepare(
    "INSERT INTO schema_migrations (namespace, version, applied_at) VALUES (?, ?, ?)",
  );
  let applied = 0;
  for (let i = 0; i < migrations.length; i++) {
    const sql = migrations[i] as string;
    // Re-check inside a write-locked (IMMEDIATE) transaction so two processes opening the
    // same fresh database cannot both apply the same step.
    const ran = db
      .transaction(() => {
        if ((current.get(namespace) as { v: number }).v >= i + 1) return false;
        db.exec(sql);
        record.run(namespace, i + 1, new Date().toISOString());
        return true;
      })
      .immediate();
    if (ran) applied++;
  }
  return applied;
}
