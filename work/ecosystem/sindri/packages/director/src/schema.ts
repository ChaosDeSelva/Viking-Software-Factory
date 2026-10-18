/** Append-only migrations for the `director` namespace (requires knowledge, intake, specs). */
export const DIRECTOR_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE director_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_estimate REAL,
    source TEXT NOT NULL CHECK (source IN ('measured', 'unavailable')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX director_runs_project ON director_runs(project_id, created_at);

  CREATE TABLE director_spec_meta (
    spec_id TEXT PRIMARY KEY REFERENCES specifications(id) ON DELETE CASCADE,
    untrusted_instruction_detected INTEGER NOT NULL CHECK (untrusted_instruction_detected IN (0, 1)),
    meta_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE director_answers (
    id TEXT PRIMARY KEY,
    spec_id TEXT NOT NULL REFERENCES specifications(id) ON DELETE CASCADE,
    revised_spec_id TEXT NOT NULL REFERENCES specifications(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    answer TEXT NOT NULL,
    author TEXT NOT NULL,
    intake_comment_id TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // v2: every provider call is recorded, including failed ones.
  `ALTER TABLE director_runs ADD COLUMN outcome TEXT NOT NULL DEFAULT 'ok';`,
];
