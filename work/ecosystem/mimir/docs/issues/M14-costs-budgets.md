# M14: Costs and budgets

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T9, T12
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): `GET /v1/usage`, budgets on missions and crews, `budget.warning` and exhaustion in `GET /v1/attention`.

Budget guard aware of usage source (`measured`, `estimated`, `unavailable`) inside the scheduler.

## Remaining
Measured usage needs agent hooks; without them figures are `estimated` or `unavailable` (docs/limits.md).

## Acceptance tests
* [ ] Budget exceeded blocks dispatch.
* [ ] Without provider data, usage shows a missing data indicator, not a number.

## Commits (local repository, no remote)
e48e7a8
