# M07: Mission scheduler

Status: **done**
Phase and gate: Phase 2 / G2
Owning task(s): T9, T12
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): The pure scheduler is driven by the server `Orchestrator` (tick loop, leases, recovery). `apps/server/src/orchestrator/e2e.test.ts` runs a DAG with a dependency and a concurrency cap to a completed mission.

Pure deterministic scheduler, leases with heartbeat and expiry, DAG validation, escalation detectors; 349 core tests including fast check properties and mutation checks. See ADR-011.

## Remaining
T12fix (merged) added recovery and budget fixes.

## Acceptance tests
* [ ] Never dispatches over a crew's concurrency cap (property test).
* [ ] Session `done` moves the task to `verifying`, not `completed`.
* [ ] Expired lease emits an expire decision for every mission.

## Commits (local repository, no remote)
f18161c..e3cf326 (merged 56c13c0)
