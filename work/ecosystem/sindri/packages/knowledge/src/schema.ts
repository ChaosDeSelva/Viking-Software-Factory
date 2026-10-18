/** Append-only migrations for the `knowledge` namespace. Never edit a shipped entry. */
export const KNOWLEDGE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    indexed_at TEXT NOT NULL,
    UNIQUE (project_id, path)
  );

  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    UNIQUE (document_id, ordinal)
  );

  CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');

  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE TABLE knowledge_entries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    claim TEXT NOT NULL,
    source_refs_json TEXT NOT NULL CHECK (json_array_length(source_refs_json) >= 1),
    validity TEXT NOT NULL CHECK (validity IN ('valid', 'superseded', 'retracted')),
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    supersedes_id TEXT REFERENCES knowledge_entries(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    retracted_reason TEXT
  );
  CREATE INDEX knowledge_entries_project ON knowledge_entries(project_id, validity);
  CREATE INDEX knowledge_entries_supersedes ON knowledge_entries(supersedes_id);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    adr_markdown TEXT NOT NULL,
    status TEXT NOT NULL,
    approver TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE task_evidence (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    external_ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER task_evidence_no_update BEFORE UPDATE ON task_evidence BEGIN
    SELECT RAISE(ABORT, 'task_evidence is immutable');
  END;
  CREATE TRIGGER task_evidence_no_delete BEFORE DELETE ON task_evidence BEGIN
    SELECT RAISE(ABORT, 'task_evidence is immutable');
  END;
  `,
  // v2 (audit M4): task evidence can be erased with its project. An erased row is a tombstone:
  // id, kind, created_at and the content hash stay; project, reference and payload are dropped.
  // Rows stay immutable otherwise, and are never deleted.
  `
  DROP TRIGGER task_evidence_no_update;
  DROP TRIGGER task_evidence_no_delete;
  CREATE TABLE task_evidence_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    external_ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    content_sha256 TEXT,
    erased_at TEXT,
    CHECK (erased_at IS NOT NULL OR project_id IS NOT NULL),
    CHECK (erased_at IS NULL OR (project_id IS NULL AND external_ref = '' AND payload_json = 'null'
      AND content_sha256 IS NOT NULL))
  );
  INSERT INTO task_evidence_v2 (id, project_id, external_ref, kind, payload_json, created_at)
    SELECT id, project_id, external_ref, kind, payload_json, created_at FROM task_evidence;
  DROP TABLE task_evidence;
  ALTER TABLE task_evidence_v2 RENAME TO task_evidence;
  CREATE INDEX task_evidence_project ON task_evidence(project_id);
  CREATE TRIGGER task_evidence_no_update BEFORE UPDATE ON task_evidence
  WHEN NOT (
    OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
    AND NEW.id = OLD.id AND NEW.kind = OLD.kind AND NEW.created_at = OLD.created_at
    AND (OLD.content_sha256 IS NULL OR NEW.content_sha256 = OLD.content_sha256)
  )
  BEGIN
    SELECT RAISE(ABORT, 'task_evidence is immutable');
  END;
  CREATE TRIGGER task_evidence_no_delete BEFORE DELETE ON task_evidence BEGIN
    SELECT RAISE(ABORT, 'task_evidence is immutable');
  END;
  `,
];
