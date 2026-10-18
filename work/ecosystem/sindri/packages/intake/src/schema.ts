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
];
