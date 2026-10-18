# M15: Restart recovery

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T12, T14a
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Boot recovery runs before the server accepts requests. `orchestrator/e2e.test.ts` shows a session lost while Mimir was down parks the task `unknown_after_restart`; `apps/server/test/chaos/restart.test.ts` SIGKILLs the server and restarts on the same data dir; `runtime-gap.test.ts` covers the runtime gap.

Single writer lock, durable store, lease expiry, boot reconcile in the orchestrator, chaos tests for restart and runtime gap.

## Remaining
Restart against a real HerdR server (new `terminal_id`s) has not been run; orchestration chaos scenarios are on `task/T14b`.

## Acceptance tests
* [ ] SIGKILL the server mid mission and restart on the same data directory: no lost or duplicated events, running tasks `blocked unknown_after_restart`, nothing auto completed.

## Commits (local repository, no remote)
none
