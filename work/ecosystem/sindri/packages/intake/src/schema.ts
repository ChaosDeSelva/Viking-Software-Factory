import type { SqliteDatabase } from "@sindri/knowledge";

/** Append-only migrations for the `intake` namespace (requires the knowledge `projects` table). */
export const INTAKE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE intakes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('manual', 'jira', 'linear')),
    external_id TEXT,
    external_url TEXT,
    title TEXT NOT NULL,
    raw_snapshot_json TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    sync_state TEXT NOT NULL CHECK (sync_state IN ('imported', 'stale', 'conflict')),
    permissions_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    pending_snapshot_json TEXT,
    UNIQUE (project_id, source, external_id)
  );

  CREATE TABLE intake_attachments (
    id TEXT PRIMARY KEY,
    intake_id TEXT NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    path TEXT NOT NULL
  );

  CREATE TABLE intake_comments (
    id TEXT PRIMARY KEY,
    intake_id TEXT NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    external_id TEXT,
    origin TEXT NOT NULL DEFAULT 'remote' CHECK (origin IN ('remote', 'local'))
  );
  CREATE INDEX intake_comments_intake ON intake_comments(intake_id, created_at);
  `,
  // v2: remember the remote `updated` value acknowledged by resolveSync({ take: "local" }).
  `ALTER TABLE intakes ADD COLUMN acknowledged_remote_updated TEXT`,
  // v3 (audit M5): display text is sanitized once, when the row is written. Rows from before are
  // backfilled by openIntake.
  `
  ALTER TABLE intakes ADD COLUMN display_title TEXT;
  ALTER TABLE intakes ADD COLUMN display_body TEXT;
  ALTER TABLE intake_comments ADD COLUMN display_author TEXT;
  ALTER TABLE intake_comments ADD COLUMN display_body TEXT;
  `,
  // v4: the kind of work an intake asks for, operator guidance for it, and research options.
  // Existing rows are code changes. A follow-up question links the execution it follows.
  `
  ALTER TABLE intakes ADD COLUMN work_kind TEXT NOT NULL DEFAULT 'change'
    CHECK (work_kind IN ('change', 'research', 'pr_review'));
  ALTER TABLE intakes ADD COLUMN notes TEXT NOT NULL DEFAULT '';
  ALTER TABLE intakes ADD COLUMN skill_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE intakes ADD COLUMN research_json TEXT;
  ALTER TABLE intakes ADD COLUMN linked_execution_id TEXT;
  `,
];

const SOURCES_BEFORE_GITHUB = "'manual', 'jira', 'linear')";
const SOURCES_WITH_GITHUB = "'manual', 'jira', 'linear', 'github')";

/**
 * Widens the `intakes.source` CHECK to allow `github` (pull requests). SQLite cannot alter a
 * CHECK, so the table is rebuilt from its own stored definition, which keeps every column added by
 * later migrations. Comments, attachments and specifications reference `intakes`, and dropping a
 * parent with foreign keys on would cascade into them, so foreign keys are off for the rebuild
 * (the documented SQLite procedure; the pragma only works outside a transaction). Idempotent: a
 * table that already allows `github` is left alone.
 */
export function widenIntakeSources(db: SqliteDatabase): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intakes'")
    .get() as { sql: string } | undefined;
  if (!row || !row.sql.includes(SOURCES_BEFORE_GITHUB)) return;
  if (db.inTransaction) throw new Error("widenIntakeSources must run outside a transaction");
  const fk = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const current = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'intakes'")
        .get() as { sql: string };
      // Another connection may have rebuilt it meanwhile.
      if (!current.sql.includes(SOURCES_BEFORE_GITHUB)) return;
      const create = current.sql
        .replace(/^CREATE TABLE\s+"?intakes"?/, "CREATE TABLE intakes_rebuild")
        .replace(SOURCES_BEFORE_GITHUB, SOURCES_WITH_GITHUB);
      db.exec(create);
      db.exec("INSERT INTO intakes_rebuild SELECT * FROM intakes");
      db.exec("DROP TABLE intakes");
      db.exec("ALTER TABLE intakes_rebuild RENAME TO intakes");
      const children = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('intake_comments', 'intake_attachments', 'specifications')`,
        )
        .all() as { name: string }[];
      for (const { name } of children)
        if ((db.pragma(`foreign_key_check(${name})`) as unknown[]).length > 0)
          throw new Error(`intake rebuild broke a foreign key of ${name}`);
    }).immediate();
  } finally {
    if (fk) db.pragma("foreign_keys = ON");
  }
}
