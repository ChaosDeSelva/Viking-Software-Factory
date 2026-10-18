# ADR-010: Durable event storage design

Status: Accepted and implemented (2026-10-14). Code: `packages/core/src/store/` (task T4, merged at f70e4da, review in flight). Report: `.sdd/reports/T4-report.md`.

## Context
HerdR gives no replay (ADR-004). The UI, SDK and Sindri need a replayable history that survives server restarts. Events can contain credentials printed by agents.

## Decision
* SQLite via better sqlite3 in WAL mode with `foreign_keys=ON` and `busy_timeout=5000` (`db.ts`). Numbered SQL migrations in `migrations/NNN_name.sql`, each applied in its own transaction and recorded in `schema_migrations` (`migrate.ts`).
* Append only `events` table: `id`, `stream_id` (FK to `streams`), `sequence` (gap free, 1-based per stream), `global_seq` (unique, assigned inside a `BEGIN IMMEDIATE` transaction), `type`, `provenance`, `source`, `source_event_id`, `correlation_id`, mission/crew/task/session ids, `occurred_at`, `observed_at`, `payload`. Unique `(stream_id, sequence)` and unique `(source, source_event_id)` give dedupe (`event-store.ts`).
* The cursor is `base64(String(global_seq))`; reads return events strictly after it. Order is guaranteed per stream, not globally across streams, as the spec requires.
* Redaction runs before insert (`packages/core/src/redaction.ts`), then payloads are bounded (default 262144 bytes, env `MIMIR_MAX_PAYLOAD_BYTES`); truncated payloads become `{truncated, originalBytes, preview}`.
* `commands` table with `idempotency_key UNIQUE` for the idempotent command ledger (`command-ledger.ts`); an `AuditLog` for decisions (`audit-log.ts`).
* Single writer: an `O_EXCL` lock file next to the database (`lock.ts`) so a second server on the same data directory refuses to start.

## Consequences
* Restarting the server loses no history; the SDK resumes via `Last-Event-ID` (server work in T6, in progress).
* Known limits recorded by T4: the lock is host local (not safe on network filesystems) and has a small race window between file creation and writing the pid; the concurrency test is in process, so true multi connection contention is excluded by the lock rather than tested.
* Retention and backups are not implemented yet (M17).
