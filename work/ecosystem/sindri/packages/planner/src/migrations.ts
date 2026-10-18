/** Append-only migrations for the `planner` namespace (requires knowledge + specs tables). */
export const PLANNER_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    spec_id TEXT NOT NULL REFERENCES specifications(id) ON DELETE CASCADE,
    spec_version INTEGER NOT NULL,
    lineage_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'approved', 'superseded')),
    body_json TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (lineage_id, version)
  );
  CREATE INDEX plans_spec ON plans(spec_id);
  CREATE TRIGGER plans_immutable BEFORE UPDATE ON plans
  WHEN OLD.status IN ('approved', 'superseded') AND (
    NEW.body_json IS NOT OLD.body_json OR NEW.project_id IS NOT OLD.project_id OR
    NEW.spec_id IS NOT OLD.spec_id OR NEW.spec_version IS NOT OLD.spec_version OR
    NEW.lineage_id IS NOT OLD.lineage_id OR NEW.version IS NOT OLD.version OR
    NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at OR
    NEW.created_at IS NOT OLD.created_at OR
    (OLD.status = 'superseded' AND NEW.status <> 'superseded') OR
    (OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'superseded'))
  )
  BEGIN
    SELECT RAISE(ABORT, 'approved plans are immutable');
  END;
  `,
];
