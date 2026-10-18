/** Append-only migrations for the `specs` namespace (requires knowledge + intake tables). */
export const SPECS_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE specifications (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intake_id TEXT REFERENCES intakes(id) ON DELETE SET NULL,
    lineage_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    status TEXT NOT NULL CHECK (status IN ('draft', 'review', 'approved', 'superseded')),
    title TEXT NOT NULL,
    body_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, lineage_id, version)
  );
  CREATE INDEX specifications_lineage ON specifications(lineage_id, version);
  `,
  // v2: approved/superseded rows are immutable; only approved -> superseded is allowed.
  `
  CREATE TRIGGER specifications_immutable BEFORE UPDATE ON specifications
  WHEN OLD.status IN ('approved', 'superseded') AND (
    NEW.title IS NOT OLD.title OR NEW.body_json IS NOT OLD.body_json OR
    NEW.provenance_json IS NOT OLD.provenance_json OR NEW.project_id IS NOT OLD.project_id OR
    NEW.lineage_id IS NOT OLD.lineage_id OR NEW.version IS NOT OLD.version OR
    NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at OR
    NEW.created_at IS NOT OLD.created_at OR
    (OLD.status = 'superseded' AND NEW.status <> 'superseded') OR
    (OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'superseded'))
  )
  BEGIN
    SELECT RAISE(ABORT, 'approved specifications are immutable');
  END;
  `,
];
