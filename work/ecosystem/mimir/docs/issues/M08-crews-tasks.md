# M08: Crews and tasks

Status: **done**
Phase and gate: Phase 2 / G2
Owning task(s): T9, T12
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Crew and task routes (`POST /v1/crews`, `GET /v1/crews`, `GET/POST /v1/tasks`, `POST /v1/tasks/:id/retry`) and the mission transitions (start, pause, resume, cancel) are served; `apps/server/src/routes/orchestration.test.ts` and `orchestrator/e2e.test.ts` cover them.

Task and mission state machines with exhaustive edge tests, crew choice and per crew limits inside the scheduler.

## Remaining
Role templates beyond `solo` are not exercised end to end.

## Acceptance tests
* [ ] Exhaustive edge test for the task machine.
* [ ] Role templates lead, implementer, reviewer, qa, investigator produce correct argv.

## Commits (local repository, no remote)
b41ecd8, bff4b79, ac53792
