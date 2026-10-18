# M02: Schema and SDK

Status: **partial**
Phase and gate: Phase 1 / G1
Owning task(s): T3, T6, T7 (done)
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Protocol, server routes and SDK are merged. Every operation in `packages/protocol/openapi.json` is served (`docs/api.md`); `tasks.create` and `artifacts.content` are in the SDK. Five served routes (mission pause/resume, `POST /v1/tasks/:id/pr`, `GET /v1/sessions/:id/terminal`, `GET /v1/attention`) are not in the OpenAPI contract yet.

`@mimir/protocol`: enums, prefixed ULID ids, error codes and `MimirError`, entity schemas, event envelope and payload schemas, `RuntimeAdapter` contract, command schemas, generated `openapi.json` (20 paths, 24 operations) and `schemas/event-envelope.json`. 153 tests. Review: approved, fix round applied.

## Remaining
Add the five extra routes to the protocol contract and SDK (`task/T12b` covers `tasks.requestPr`).

## Acceptance tests
* [ ] Every entity and request has a valid and an invalid sample test with the exact issue path.
* [ ] OpenAPI document validates; round trip typed `{[K in EventType]: EventPayloadMap[K]}`.
* [ ] Contract tests run by both server and SDK (T6/T7).
* [ ] Duplicate `POST /v1/missions` with the same `Idempotency-Key` creates one mission (G1).

## Commits (local repository, no remote)
7f90675..2832ab8, 026a978, 1ea5c00
