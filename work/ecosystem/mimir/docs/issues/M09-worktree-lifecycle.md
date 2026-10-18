# M09: Worktree lifecycle

Status: **done**
Phase and gate: Phase 2 / G2
Owning task(s): T10, T12
Last updated: 2026-10-14 (T15d, main at 06f0722)

## Done so far
Status refresh 2026-10-14 (T15d, from the code): Worktrees are created and removed by the orchestrator through `GitWorktreePort` (`apps/server/src/orchestrator/git-port.ts`), on top of the hardened `@mimir/git` package.

`GitManager`, path safety, protected branch guard, diff, conflict detection and `runTests` in `@mimir/git` (T10, ADR-013), driven by the orchestrator (T12).

## Remaining
None known.

## Acceptance tests
* [ ] Two worktrees for two tasks on one repo have disjoint paths and branches.
* [ ] Dirty removal refused; clean removal deletes the merged branch.
* [ ] Traversal and symlink rejection.
* [ ] A worktree inside the project checkout is rejected.

## Commits (local repository, no remote)
branch task/T10: 9d7f626, f822b5b, 1c0c52d, e3bd65d; not on main
