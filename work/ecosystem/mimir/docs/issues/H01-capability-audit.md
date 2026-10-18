# H01: Source and capability audit

Status: **done**
Phase and gate: Phase 0 / G0
Owning task(s): T1, T2
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T1, T2.

`docs/herdr-capabilities.md`, schema dumps and diff under `docs/herdr/`, and the spike `FINDINGS.md` (one request per connection, per pane status subscriptions, silent EOF instead of `events_lost`, `terminal_id` churn, no per event sequence). Spike has 22 tests; fixtures redacted.

## Remaining
Untested in the spike: `agent.prompt` happy path, soft stop of a working agent, resume of a session bearing agent (blocked by the Claude Code trust dialog). The unredacted default session snapshot remains in spike commit eb793dc; do not share that repo without rewriting history.

## Acceptance tests
* [ ] Every capability marked verified, partial or unavailable with a reproducible command.

## Commits (local repository, no remote)
648d747, 31c4fe6, 3183b3c; spike repo f4ea139..426e3f0
