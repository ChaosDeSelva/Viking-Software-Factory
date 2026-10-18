-- 001: event log, stream sequence counters, command ledger, audit log.

CREATE TABLE streams (
  stream_id     TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL
);

CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  stream_id       TEXT NOT NULL REFERENCES streams(stream_id),
  sequence        INTEGER NOT NULL,
  global_seq      INTEGER NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  provenance      TEXT NOT NULL,
  source          TEXT NOT NULL,
  source_event_id TEXT,
  correlation_id  TEXT,
  mission_id      TEXT,
  crew_id         TEXT,
  task_id         TEXT,
  session_id      TEXT,
  occurred_at     TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  payload         TEXT NOT NULL,
  UNIQUE (stream_id, sequence),
  UNIQUE (source, source_event_id)
);

CREATE INDEX events_mission_global ON events (mission_id, global_seq);
CREATE INDEX events_type_global    ON events (type, global_seq);
CREATE INDEX events_session_global ON events (session_id, global_seq);

CREATE TABLE commands (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  request         TEXT NOT NULL,
  response        TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE audit_entries (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  decision   TEXT,
  reason     TEXT,
  created_at TEXT NOT NULL
);
