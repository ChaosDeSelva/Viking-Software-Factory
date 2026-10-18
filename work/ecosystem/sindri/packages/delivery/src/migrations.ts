/** Append-only migrations for the `delivery` namespace (execution side). */
export const DELIVERY_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE executions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    mimir_mission_id TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'running', 'awaiting_human', 'blocked', 'replan_requested',
      'verified_pending_review', 'cancelled', 'failed'
    )),
    started_at TEXT,
    finished_at TEXT,
    -- The approved plan as executed (retries and escalation per task come from here).
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX executions_plan ON executions(plan_id, plan_version);

  CREATE TABLE execution_tasks (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    plan_task_id TEXT NOT NULL,
    mimir_task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_event_cursor TEXT,
    -- Set once retries are exhausted: the plan task's escalation policy.
    escalation TEXT CHECK (escalation IS NULL OR escalation IN ('block', 'ask', 'replan')),
    escalation_reason TEXT,
    UNIQUE (execution_id, plan_task_id),
    UNIQUE (execution_id, mimir_task_id)
  );

  CREATE TABLE execution_events (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    mimir_event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX execution_events_execution ON execution_events(execution_id);

  CREATE TABLE artifacts_refs (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    mimir_artifact_id TEXT NOT NULL,
    plan_task_id TEXT,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    uri TEXT NOT NULL,
    UNIQUE (execution_id, mimir_artifact_id)
  );

  -- Sindri's inbox of Mimir approval requests. Sindri never approves on its own.
  CREATE TABLE execution_approvals (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    mimir_approval_id TEXT NOT NULL UNIQUE,
    plan_task_id TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    disposition TEXT NOT NULL CHECK (disposition IN ('inbox', 'auto_rejected')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    requested_at TEXT NOT NULL,
    decided_at TEXT
  );
  `,
  // Fix round 1: per-execution event dedupe (Sindri-authored rows have no Mimir id), one
  // execution per Mimir mission, run numbers, task resolutions, and a general inbox.
  `
  CREATE TABLE execution_events_v2 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    mimir_event_id TEXT,
    source TEXT NOT NULL DEFAULT 'mimir' CHECK (source IN ('mimir', 'sindri')),
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    UNIQUE (execution_id, mimir_event_id),
    CHECK ((source = 'mimir') = (mimir_event_id IS NOT NULL))
  );
  INSERT INTO execution_events_v2 (id, execution_id, mimir_event_id, source, type, payload_json, occurred_at)
    SELECT id, execution_id, mimir_event_id, 'mimir', type, payload_json, occurred_at FROM execution_events;
  DROP TABLE execution_events;
  ALTER TABLE execution_events_v2 RENAME TO execution_events;
  CREATE INDEX execution_events_execution ON execution_events(execution_id);

  CREATE UNIQUE INDEX executions_mission ON executions(mimir_mission_id);
  ALTER TABLE executions ADD COLUMN run_number INTEGER NOT NULL DEFAULT 1;

  ALTER TABLE execution_tasks ADD COLUMN resolution TEXT
    CHECK (resolution IS NULL OR resolution IN ('skipped', 'skipped_dependency'));
  ALTER TABLE execution_tasks ADD COLUMN blocked_reason TEXT;

  -- Items needing a human that are not Mimir approvals: ask escalations, budget overruns.
  CREATE TABLE execution_inbox (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('escalation', 'budget_exceeded')),
    plan_task_id TEXT,
    detail_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX execution_inbox_execution ON execution_inbox(execution_id);
  `,
  // S7b fix round: the task's latest Mimir session id (from event envelopes), so the UI can
  // deep-link to MIMIR_URL/agents/:sessionId.
  `
  ALTER TABLE execution_tasks ADD COLUMN session_id TEXT;
  `,
  // v4 (audit M4): executions belong to a Sindri project; deleting the project deletes them and,
  // through the existing execution_id cascades, their tasks, events, approvals, artifacts and
  // inbox. Requires the knowledge `projects` table (ensureDeliverySchema applies it first).
  `
  ALTER TABLE executions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
  UPDATE executions SET project_id = (
    SELECT p.id FROM projects p
    WHERE p.id = CASE WHEN json_valid(executions.plan_json)
      THEN json_extract(executions.plan_json, '$.projectId') END
  );
  CREATE INDEX executions_project ON executions(project_id);
  `,
];
