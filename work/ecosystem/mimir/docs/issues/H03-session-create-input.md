# H03: Session create, discover, input

Status: **done**
Phase and gate: Phase 1 / G1
Owning task(s): T8
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T8 merged.

Implemented in `packages/herdr-adapter` (T8): `workspace.create`, bounded retry of `agent.start` on `agent_pane_busy`, `agent.wait` before `agent.prompt`; fake HerdR server tests plus a live test against a dedicated session.

## Remaining
Implementation and live test (T8).

## Acceptance tests
* [ ] Duplicate start with the same idempotency key creates one session.
* [ ] Input only into an empty composer, verified before Enter.

## Commits (local repository, no remote)
branch task/T8 only
