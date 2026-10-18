# H08: OS compatibility matrix and install docs

Status: **partial**
Phase and gate: Phase 3 / G3
Owning task(s): T15c, T15d
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Only macOS arm64 (Node 25, HerdR 0.9.4, git 2.x) has real runs; see `docs/limits.md` and `docs/gates/phase-3-gate.md`.

Only macOS arm64 has been used so far. Linux is covered by the CI workflow definition but has not been run locally; Windows is untested.

## Remaining
Linux and Windows are untested; the matrix cannot be filled from real runs yet.

## Acceptance tests
* [ ] Matrix filled from real runs.

## Commits (local repository, no remote)
none
