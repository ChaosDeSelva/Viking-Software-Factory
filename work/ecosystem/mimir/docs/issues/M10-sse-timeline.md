# M10: SSE timeline

Status: **done**
Phase and gate: Phase 1 / G1
Owning task(s): T6, T13
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): `GET /v1/events` (cursor), `GET /v1/events/stream` (SSE with `Last-Event-ID`), `GET /v1/snapshot`, and the timeline UI with provenance badges. A slow SSE consumer receives a `gap` and replays (`apps/server/test/chaos/slow-sse.test.ts`).

Event read side in the store, HTTP replay and SSE in the server (T6), timeline UI (T13).

## Remaining
None known.

## Acceptance tests
* [ ] SSE replays from `Last-Event-ID` then receives a live event with no gap or duplicate.
* [ ] UI shows `observed` versus `summarized` labels.

## Commits (local repository, no remote)
none
