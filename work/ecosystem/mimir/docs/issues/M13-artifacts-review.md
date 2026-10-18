# M13: Artifacts and review

Status: **partial**
Phase and gate: Phase 2 / G2
Owning task(s): T12, T13
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Artifacts (diff, changed files, test output, local delivery) are recorded with sha256 and retention, served at `GET /v1/artifacts/:id` and `/content`; `POST /v1/tasks/:id/pr` requires an approved `pr.create` and uses `gh`.

Artifact store with sha256 and retention, artifact routes, PR request route (T12); review UI (T13).

## Remaining
`gh pr create` was never run against a real remote (none exists); the PR runner is hardened (T12fix, merged: trusted cwd, pinned `GIT_DIR`, minimal env).

## Acceptance tests
* [ ] Artifact hashes verified on read.
* [ ] PR creation requires an approved `pr.create`.

## Commits (local repository, no remote)
none
