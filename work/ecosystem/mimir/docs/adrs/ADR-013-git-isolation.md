# ADR-013: Git isolation

Status: Accepted as a design (2026-10-14). Implementation: `packages/git` (task T10). The code exists on branch `task/T10` (4 commits, e3bd65d at head) and is not merged to main yet; on main `packages/git/src/index.ts` is a placeholder.

## Context
Parallel agents must not overwrite each other or the user's checkout, and an agent must not be able to push, merge into a protected branch or delete work without a human (ADR-002).

## Decision
* One worktree per task at `<worktreeRoot>/<projectId>/<taskId>` (default root `~/.mimir/worktrees`), outside the project checkout; `worktreeRoot` must not be inside any registered project and the repo path must not be under `worktreeRoot`.
* Branch `mimir/<crewSlug>/<taskId>-<taskSlug>`, slugs `[a-z0-9-]` up to 40 characters; creation refuses if the branch exists; the base SHA is recorded.
* Paths are resolved with `realpath`; `..` segments and symlinked targets are rejected.
* Ownership claim file `.mimir-owner.json` in the worktree.
* Removal is fail closed: a dirty tree or unpushed or unmerged commits refuse removal unless forced, and forcing requires an approval (`git.force_remove_worktree`, policy action in `packages/core/src/policy/actions.ts`).
* Protected branches (`main, master, trunk, develop, production, release/*` by default; `DEFAULT_PROTECTED_BRANCHES` in `packages/core/src/policy/classify.ts`) are never checked out, pushed or merged into. `packages/git` intentionally has no push or merge function; PR creation is a separate approval gated server flow.
* Git is invoked with argument arrays only, never shell strings. Conflict detection is a dry run via `git merge-tree` (git 2.38 or later).
* Test commands run with an allowlisted environment (`PATH`, `HOME`, `LANG`, `TERM` plus explicit extras) and capped output.

## Consequences
* Requires git 2.38 or later (checked by `mimir doctor` in the later CLI task).
* An integration conflict queues a review rather than auto merging.
* Mimir never auto merges or deploys by default.
