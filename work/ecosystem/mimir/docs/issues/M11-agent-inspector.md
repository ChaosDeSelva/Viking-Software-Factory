# M11: Agent inspector

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T12, T13
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Session input, stop (force stop needs an approved `runtime.force_stop`, proven in `orchestrator/e2e.test.ts`) and on demand terminal read routes are served; the inspector UI is merged.

Session routes in the server (T12) and the inspector page (T13).

## Remaining
Terminal read depends on the runtime capability; the 2 s client polling floor and the real HerdR terminal path are not proven by a test here.

## Acceptance tests
* [ ] Terminal read is on demand and never polled faster than 2 s.
* [ ] Force stop shows the approval requirement.

## Commits (local repository, no remote)
none
