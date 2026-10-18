/**
 * Append-only migrations for the `delivery_quality` namespace (S6: gates, reviews, delivery
 * reports, knowledge proposals). Execution ids refer to S5's `executions` rows but carry no
 * foreign key, so these tables also work over any `ExecutionReader`. Since v3 they need the
 * knowledge `projects` table (deliveries cascade from it); apply through `ensureQualitySchema`.
 */
export const QUALITY_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE gate_evaluations (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    plan_task_id TEXT NOT NULL,
    mimir_task_id TEXT NOT NULL,
    passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
    engineering_verdict TEXT,
    report_artifact_id TEXT,
    failures_json TEXT NOT NULL,
    advisories_json TEXT NOT NULL,
    evaluated_at TEXT NOT NULL
  );
  CREATE INDEX gate_evaluations_task ON gate_evaluations(execution_id, plan_task_id);

  CREATE TABLE gate_repairs (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    plan_task_id TEXT NOT NULL,
    mimir_task_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    evaluation_id TEXT NOT NULL REFERENCES gate_evaluations(id),
    instruction TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (execution_id, plan_task_id, attempt)
  );

  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    plan_task_id TEXT NOT NULL,
    implementer_task_id TEXT NOT NULL,
    implementer_crew_id TEXT NOT NULL,
    reviewer_crew_id TEXT NOT NULL,
    reviewer_task_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('reviewer', 'qa')),
    origin TEXT NOT NULL CHECK (origin IN ('plan', 'created')),
    status TEXT NOT NULL CHECK (status IN ('requested', 'completed')),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('approve', 'request_changes')),
    reason TEXT,
    findings_json TEXT NOT NULL DEFAULT '[]',
    acceptance_json TEXT NOT NULL DEFAULT '[]',
    decisions_json TEXT NOT NULL DEFAULT '[]',
    review_artifact_id TEXT,
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    -- Independence is a schema invariant, not only a code path.
    CHECK (reviewer_crew_id <> implementer_crew_id)
  );
  CREATE INDEX reviews_task ON reviews(execution_id, plan_task_id);

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('built', 'delivered_pending_merge')),
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  CREATE INDEX deliveries_execution ON deliveries(execution_id);

  CREATE TABLE pr_requests (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    plan_task_id TEXT NOT NULL,
    mimir_task_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('requested', 'awaiting_approval')),
    approval_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (delivery_id, plan_task_id)
  );

  CREATE TABLE delivery_evidence (
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    ref_id TEXT NOT NULL,
    task_evidence_id TEXT NOT NULL,
    PRIMARY KEY (delivery_id, ref_id)
  );

  CREATE TABLE knowledge_proposals (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('entry', 'decision')),
    claim TEXT NOT NULL,
    body TEXT,
    -- Task evidence ids; nothing is proposed without a source.
    source_refs_json TEXT NOT NULL CHECK (json_array_length(source_refs_json) > 0),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
    entry_id TEXT,
    decision_id TEXT,
    decided_by TEXT,
    decided_at TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (delivery_id, kind, claim)
  );
  `,
  // Fix round 1: project_id on every table (project purge deletes by it; see S7b), shared-budget
  // repairs (retry or repair task), review freshness, and PR requests keyed by head commit.
  `
  ALTER TABLE gate_evaluations ADD COLUMN project_id TEXT;
  ALTER TABLE gate_repairs ADD COLUMN project_id TEXT;
  ALTER TABLE gate_repairs ADD COLUMN kind TEXT NOT NULL DEFAULT 'retry'
    CHECK (kind IN ('retry', 'repair_task'));
  ALTER TABLE gate_repairs ADD COLUMN repair_task_id TEXT;
  ALTER TABLE reviews ADD COLUMN project_id TEXT;
  ALTER TABLE reviews ADD COLUMN implementer_attempt INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE pr_requests ADD COLUMN project_id TEXT;
  ALTER TABLE pr_requests ADD COLUMN execution_id TEXT;
  ALTER TABLE pr_requests ADD COLUMN head_sha TEXT;
  CREATE UNIQUE INDEX pr_requests_head ON pr_requests(execution_id, plan_task_id, head_sha);
  ALTER TABLE delivery_evidence ADD COLUMN project_id TEXT;
  CREATE INDEX gate_evaluations_project ON gate_evaluations(project_id);
  CREATE INDEX gate_repairs_project ON gate_repairs(project_id);
  CREATE INDEX reviews_project ON reviews(project_id);
  CREATE INDEX deliveries_project ON deliveries(project_id);
  CREATE INDEX pr_requests_project ON pr_requests(project_id);
  CREATE INDEX delivery_evidence_project ON delivery_evidence(project_id);
  CREATE INDEX knowledge_proposals_project ON knowledge_proposals(project_id);
  `,
  // v3 (audit M4): deliveries get a project_id foreign key with ON DELETE CASCADE, and its
  // children (PR requests, delivery evidence, knowledge proposals) cascade from deliveries. SQLite
  // cannot add a constraint to a column, so the four tables are rebuilt; children are parked in
  // temp tables meanwhile so no foreign key is ever violated. Rows of projects that no longer
  // exist were left behind by purges before M4: they are deleted. Gate evaluations, repairs and
  // reviews are purged by the hook `ensureQualitySchema` registers with the knowledge purge.
  `
  DELETE FROM pr_requests WHERE delivery_id IN
    (SELECT id FROM deliveries WHERE project_id NOT IN (SELECT id FROM projects));
  DELETE FROM delivery_evidence WHERE delivery_id IN
    (SELECT id FROM deliveries WHERE project_id NOT IN (SELECT id FROM projects));
  DELETE FROM knowledge_proposals WHERE delivery_id IN
    (SELECT id FROM deliveries WHERE project_id NOT IN (SELECT id FROM projects));
  DELETE FROM deliveries WHERE project_id NOT IN (SELECT id FROM projects);

  CREATE TEMP TABLE parked_pr_requests AS SELECT * FROM pr_requests;
  CREATE TEMP TABLE parked_delivery_evidence AS SELECT * FROM delivery_evidence;
  CREATE TEMP TABLE parked_knowledge_proposals AS SELECT * FROM knowledge_proposals;
  DROP TABLE pr_requests;
  DROP TABLE delivery_evidence;
  DROP TABLE knowledge_proposals;

  CREATE TABLE deliveries_v3 (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('built', 'delivered_pending_merge')),
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );
  INSERT INTO deliveries_v3 (id, execution_id, project_id, status, report_json, created_at, delivered_at)
    SELECT id, execution_id, project_id, status, report_json, created_at, delivered_at FROM deliveries;
  DROP TABLE deliveries;
  ALTER TABLE deliveries_v3 RENAME TO deliveries;
  CREATE INDEX deliveries_execution ON deliveries(execution_id);
  CREATE INDEX deliveries_project ON deliveries(project_id);

  CREATE TABLE pr_requests (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    plan_task_id TEXT NOT NULL,
    mimir_task_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('requested', 'awaiting_approval')),
    approval_id TEXT,
    created_at TEXT NOT NULL,
    project_id TEXT,
    execution_id TEXT,
    head_sha TEXT,
    UNIQUE (delivery_id, plan_task_id)
  );
  CREATE UNIQUE INDEX pr_requests_head ON pr_requests(execution_id, plan_task_id, head_sha);
  CREATE INDEX pr_requests_project ON pr_requests(project_id);
  INSERT INTO pr_requests (id, delivery_id, plan_task_id, mimir_task_id, status, approval_id,
      created_at, project_id, execution_id, head_sha)
    SELECT id, delivery_id, plan_task_id, mimir_task_id, status, approval_id, created_at,
      project_id, execution_id, head_sha FROM parked_pr_requests;

  CREATE TABLE delivery_evidence (
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    ref_id TEXT NOT NULL,
    task_evidence_id TEXT NOT NULL,
    project_id TEXT,
    PRIMARY KEY (delivery_id, ref_id)
  );
  CREATE INDEX delivery_evidence_project ON delivery_evidence(project_id);
  INSERT INTO delivery_evidence (delivery_id, ref_id, task_evidence_id, project_id)
    SELECT delivery_id, ref_id, task_evidence_id, project_id FROM parked_delivery_evidence;

  CREATE TABLE knowledge_proposals (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('entry', 'decision')),
    claim TEXT NOT NULL,
    body TEXT,
    source_refs_json TEXT NOT NULL CHECK (json_array_length(source_refs_json) > 0),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
    entry_id TEXT,
    decision_id TEXT,
    decided_by TEXT,
    decided_at TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (delivery_id, kind, claim)
  );
  CREATE INDEX knowledge_proposals_project ON knowledge_proposals(project_id);
  INSERT INTO knowledge_proposals (id, delivery_id, project_id, kind, claim, body, source_refs_json,
      confidence, status, entry_id, decision_id, decided_by, decided_at, reason, created_at)
    SELECT id, delivery_id, project_id, kind, claim, body, source_refs_json, confidence, status,
      entry_id, decision_id, decided_by, decided_at, reason, created_at
    FROM parked_knowledge_proposals;

  DROP TABLE parked_pr_requests;
  DROP TABLE parked_delivery_evidence;
  DROP TABLE parked_knowledge_proposals;
  `,
];
