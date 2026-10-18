# ADR-002: Mimir owns worktrees

Status: Accepted (2026-10-14). Source: D-002. Implementation: `packages/git` (task T10, in progress, see `docs/issues/M09-worktree-lifecycle.md`).

## Context
HerdR 0.9.x has `worktree.create`, `worktree.list`, `worktree.open` and `worktree.remove`, and groups worktree workspaces under a primary. The specs require one owner per lifecycle. Firstmate, the reference product, independently keeps worktrees outside HerdR.

## Decision
Mimir creates and removes worktrees with `packages/git`. HerdR `worktree.*` is never called. Mimir passes the worktree path to HerdR as the working directory of the pane that runs the agent. See ADR-013 for the isolation rules.

## Consequences
* Mimir can enforce branch naming, ownership claims, dirty tree refusal and protected branches without depending on HerdR semantics.
* HerdR's worktree grouping UI is not used.
* `docs/herdr-capabilities.md` marks the `worktree.*` methods "present but NOT USED".
