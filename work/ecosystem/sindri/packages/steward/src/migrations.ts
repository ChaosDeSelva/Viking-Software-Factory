/**
 * Append-only migrations for the `steward` namespace. Requires the knowledge `projects` table
 * (`ensureStewardSchema` applies it first).
 */
export const STEWARD_MIGRATIONS: readonly string[] = [
  `
  -- One row per recommendation. Every change to a row is also written to
  -- steward_decision_history in the same transaction (the store never updates without it).
  CREATE TABLE steward_decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    -- What makes a subject "the same" for this type (e.g. an escalation at a given attempt).
    -- A subject and type never produce a second decision, whatever became of the first.
    dedupe_key TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_label TEXT NOT NULL,
    -- Snapshot of the subject the recommendation was made for (applying and similarity read it).
    context_json TEXT NOT NULL,
    inputs_json TEXT NOT NULL DEFAULT '[]',
    recommendation_value TEXT NOT NULL DEFAULT '',
    recommendation_detail TEXT,
    reasoning TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    mode TEXT NOT NULL CHECK (mode IN ('recommend', 'auto')),
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'accepted', 'changed', 'rejected', 'applied', 'rolled_back', 'expired'
    )),
    -- The value that was applied (the recommendation, or the operator's edit).
    final_value TEXT,
    -- What applying did (ids a rollback needs).
    applied_json TEXT,
    outcome_json TEXT,
    reversible INTEGER NOT NULL DEFAULT 0 CHECK (reversible IN (0, 1)),
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT,
    UNIQUE (type, dedupe_key)
  );
  CREATE UNIQUE INDEX steward_decisions_one_pending
    ON steward_decisions(type, subject_id) WHERE status = 'pending';
  CREATE INDEX steward_decisions_project ON steward_decisions(project_id, type, created_at);
  CREATE INDEX steward_decisions_status ON steward_decisions(status);

  CREATE TABLE steward_decision_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL REFERENCES steward_decisions(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX steward_decision_history_decision ON steward_decision_history(decision_id, seq);
  CREATE INDEX steward_decision_history_project ON steward_decision_history(project_id);
  CREATE TRIGGER steward_decision_history_append_only BEFORE UPDATE ON steward_decision_history
  BEGIN
    SELECT RAISE(ABORT, 'steward decision history is append-only');
  END;

  -- Operator notes: global (project_id NULL), per project, or on one decision.
  CREATE TABLE steward_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    decision_id TEXT REFERENCES steward_decisions(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX steward_notes_project ON steward_notes(project_id, created_at);
  CREATE INDEX steward_notes_decision ON steward_notes(decision_id);

  -- Mode per decision type, global. Missing rows mean the default ('recommend').
  CREATE TABLE steward_modes (
    type TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('off', 'recommend', 'auto')),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE steward_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Guidance proposed from repeated operator corrections. Nothing is guidance until the
  -- operator accepts it; accepting records task evidence and a valid knowledge entry citing it.
  CREATE TABLE steward_guidance (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    signature TEXT NOT NULL,
    rule TEXT NOT NULL,
    decision_ids_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
    entry_id TEXT,
    evidence_id TEXT,
    decided_by TEXT,
    decided_at TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, type, signature)
  );
  `,
];
