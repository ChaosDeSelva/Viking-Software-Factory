# M03: Database and event store

Status: **done**
Phase and gate: Phase 1 / G1
Owning task(s): T4
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T4 merged, three fix rounds.

SQLite WAL, numbered migrations, append only event store with per stream gap free sequence, global cursor, dedupe on `(source, sourceEventId)`, redaction before insert, bounded payloads, idempotent `CommandLedger`, `AuditLog`, single writer O_EXCL lock. 56 tests, no mocks. See ADR-010.

## Remaining
Review in flight at time of writing. Lock is host local; concurrency test is in process (T4 concerns 2 and 3). Retention and backups not implemented.

## Acceptance tests
* [ ] Append, read by cursor, dedupe and subscribe behave as in `event-store.test.ts` (22 tests).
* [ ] A second server on the same data directory refuses to start (`lock.test.ts`).
* [ ] Credential like strings never reach the stored payload (`redaction.test.ts`, `event-store.test.ts`).
* [ ] Restart the server and reconnect the UI without losing history (G1, needs T6).

## Commits (local repository, no remote)
5a28f6f..65a97e2 (merged f70e4da)
