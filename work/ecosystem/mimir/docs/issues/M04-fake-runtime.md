# M04: Fake runtime integration

Status: **done**
Phase and gate: Phase 1 / G1
Owning task(s): T5
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T5 merged.

`packages/fake-runtime`: deterministic `FakeRuntime` implementing `RuntimeAdapter`, `ManualClock`, scripted states, `chaos()` and `loseSession()`, `FixtureReplayRuntime` using the spike recordings; `packages/testing` helpers `withFakeRuntime`, `collectEvents`. 16 + 3 tests.

## Remaining
Red step was not run separately (T5 concern). Orchestrator integration with the fake runtime lands in T12.

## Acceptance tests
* [ ] Default script produces starting, running, idle, completed and `session.exited`.
* [ ] `chaos({emitGap:true})` emits `runtime.gap`; `loseSession` emits `session.lost`.
* [ ] Fixture replay paces events by recorded `t_ms`.

## Commits (local repository, no remote)
86f8d22, fb05c6f (merged bd4a6fc)
