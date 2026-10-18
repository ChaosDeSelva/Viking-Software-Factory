/** Append-only migrations for the server's own `server` namespace in the shared SQLite file. */
export const SERVER_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE commands (
    idempotency_key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
    status_code INTEGER,
    content_type TEXT,
    response TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE server_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE commands ADD COLUMN project_id TEXT;
  CREATE INDEX commands_project ON commands(project_id);
  `,
  `
  -- One settle assessment per execution and settle point (last event row at settle time), so
  -- re-runs of a finished execution never re-assess on their own (S7b fix I1).
  CREATE TABLE quality_assessments (
    execution_id TEXT NOT NULL,
    settle_seq INTEGER NOT NULL,
    assessed_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, settle_seq)
  );
  `,
];
