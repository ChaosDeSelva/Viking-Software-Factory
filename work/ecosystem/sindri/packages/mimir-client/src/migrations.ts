/** Append-only migrations for the `mimir_client` namespace. */
export const MIMIR_CLIENT_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE execution_cursors (
    mission_id TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- One row per Mimir mutation Sindri has completed, keyed by its idempotency key, so a
  -- re-run after a crash replays the stored response instead of calling Mimir again.
  CREATE TABLE mimir_submissions (
    idempotency_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    mimir_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
];
