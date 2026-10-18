# H07: Contract and failure tests

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T8, T14a
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Contract tests run against the fake runtime and a fake HerdR server; chaos suites inject runtime gaps, slow consumers and corrupt rows.

Shared contract tests against the fake runtime and a fake HerdR server (T5, T8); chaos suites for runtime gap, slow consumer, corrupt rows and restart (T14a, `docs/gates/phase-2-gate.md`).

## Remaining
Orchestration failure injection is on `task/T14b`.

## Acceptance tests
* [ ] The G2 adapter acceptance list passes.

## Commits (local repository, no remote)
none
