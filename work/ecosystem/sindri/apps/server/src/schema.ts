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
  `
  -- A reviewer's request to change a delivered execution. The spec drafted for it (and every
  -- later version in that lineage) is planned against, and executed on top of, base_commits:
  -- the delivered execution's verified results.
  CREATE TABLE rework_requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_execution_id TEXT NOT NULL,
    spec_lineage_id TEXT NOT NULL UNIQUE,
    base_commits_json TEXT NOT NULL,
    feedback TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX rework_requests_source ON rework_requests(source_execution_id);
  `,
];
