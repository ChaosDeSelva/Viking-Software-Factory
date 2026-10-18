# H05: Stop, restart and reconcile

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T8, T12
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Adapter stop and reconcile are implemented; the server runs reconcile at boot and records `recovery.reconciled` (`runtime-gap.test.ts`).

Implemented in `packages/herdr-adapter` (T8): liveness from `pane.process_info`, force stop via `pane.close`, binding by `pane_id`+`cwd`+session id. The server calls reconcile at boot.

## Remaining
Restarting a real HerdR and re binding sessions despite new `terminal_id`s is unproven; the cancel/completion race has no dedicated test.

## Acceptance tests
* [ ] Restart HerdR and re bind sessions despite new `terminal_id`s.
* [ ] Cancel and completion race resolves deterministically.

## Commits (local repository, no remote)
branch task/T8 only
