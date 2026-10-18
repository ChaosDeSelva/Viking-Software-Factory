# M06: Project onboarding

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T6, T12, T15b (done)
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Project create/list routes are event sourced (`project.created`), repo paths are checked against `MIMIR_ALLOWED_ROOTS` with traversal and symlink tests (`apps/server/test/security/paths.test.ts`), credential shaped fields are refused with 422, and `mimir init`/`doctor` exist.

Projects are event sourced (`project.created`); `POST/GET /v1/projects`; `mimir init` and `mimir doctor`.

## Remaining
`mimir doctor` checks that the HerdR socket file exists; it does not connect or read `integration.list`. Protected branch settings are not enforced anywhere yet.

## Acceptance tests
* [ ] Registering a repo outside allowed roots is rejected.
* [ ] Doctor reports `herdr` version and socket status.

## Commits (local repository, no remote)
none
