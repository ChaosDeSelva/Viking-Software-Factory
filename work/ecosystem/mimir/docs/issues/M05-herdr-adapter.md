# M05: HerdR adapter integration

Status: **done**
Phase and gate: Phase 1 / G1
Owning task(s): T8
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T8 merged, re review all addressed, live 5/5 against HerdR 0.9.4.

Adapter merged on main (T8): socket client with per request connections, session create/input/stop, event normalization, reconcile, `MimirError` mapping, fake HerdR server tests and a live test against a dedicated session. The server uses it when `MIMIR_RUNTIME=herdr`.

## Remaining
Adapter (create, input, normalization, stop, reconcile), fake HerdR server tests, live test against a dedicated session. Covers H03 to H06.

## Acceptance tests
* [ ] Two interleaved sessions, restart Mimir, restart HerdR, replay after UI disconnect, duplicate start, malformed event, cancel/completion race, missing capability, slow consumer with large output, credential in logs (G2 adapter acceptance list).
* [ ] HerdR down at boot: capabilities report unavailable and commands return 503.

## Commits (local repository, no remote)
branch task/T8: 67ae6fa (socket client port); not on main
