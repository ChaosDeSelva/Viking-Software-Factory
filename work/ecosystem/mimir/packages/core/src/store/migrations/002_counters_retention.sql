-- 002: monotonic counters (global_seq never reuses values, even after pruning),
-- retention floor, (stream_id, global_seq) index and append-only triggers.

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

-- global_seq: last assigned global sequence number.
-- pruned_through: every event with global_seq <= this value has been pruned.
-- allow_event_delete: 1 only inside EventStore.prune (escape hatch for retention).
INSERT INTO counters (name, value) SELECT 'global_seq', COALESCE(MAX(global_seq), 0) FROM events;
INSERT INTO counters (name, value) VALUES ('pruned_through', 0), ('allow_event_delete', 0);

CREATE INDEX events_stream_global ON events (stream_id, global_seq);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
WHEN (SELECT value FROM counters WHERE name = 'allow_event_delete') IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
