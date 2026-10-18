# H04: Event normalization and replay

Status: **done**
Phase and gate: Phase 1 / G1
Owning task(s): T8
Last updated: 2026-10-14 (T15d)

## Done so far
Status refresh 2026-10-14 (from the ledger): T8 merged.

Implemented in `packages/herdr-adapter` (T8): normalization table, EOF as loss rule producing `runtime.gap`, re snapshot diff (ADR-004, ADR-005).

## Remaining
Implementation, `runtime.gap` and re snapshot diff.

## Acceptance tests
* [ ] Malformed events rejected; derived transitions tagged `derived`.

## Commits (local repository, no remote)
branch task/T8 only
