# @mimir/git

Safe per-task git worktrees for Mimir: create, claim, diff, check for conflicts, and remove. The package has no `push`, `merge` or checkout of existing branches. Integration is an approval-gated server flow.

## Layout

```
<worktreeRoot>/                      default ~/.mimir/worktrees
  <projectId>/<taskId>/              one worktree per task, branch mimir/<crewSlug>/<taskId>-<taskSlug>
    .mimir-owner.json                advisory ownership claim {taskId, sessionId?, createdAt}
  .mimir-scratch/<projectId>.git     Mimir-owned bare repo used for read-only analysis
```

## Semantics

- **Claim file.** The manager writes `.mimir-owner.json` into each worktree and adds the line `/.mimir-owner.json` to the project's `.git/info/exclude`, in the common dir. That is the only write to the primary clone's metadata, and it keeps the claim file out of status and commits. The file sits in space the agent can write, so it is advisory:
  - It is validated with `OwnerClaimSchema` on every read, and an invalid file is a `conflict`.
  - The server's persisted `Worktree` record is authoritative.
- **Base ref and "merged".** A worktree records `baseSha`, plus the `baseRef` it was created from. The default `baseRef` is `origin/HEAD`'s target, or the clone's current branch if there is none.
  - Removal checks that work is merged against the _live_ `baseRef`. With `origin/HEAD`, that is `origin/<default>`, so local-only merges do not count. This check fails closed.
  - If `baseRef` no longer resolves, `baseSha` is used instead.
  - Persist `baseRefOf(id)` with the record and pass it back to `restore()`. Without it, `restore` falls back to the default branch.
- **Diffs.** `diff(id)` and `changedFilesManifest(id)` are committed-only by default (`baseSha..HEAD`). With `{ includeWorkingTree: true }` they diff a snapshot of the working tree, and `dirty` reports whether that snapshot differs from HEAD. The snapshot works like this:
  - It covers tracked paths plus untracked, non-ignored files.
  - Content is the **raw bytes on disk**, with no clean filters, so LFS pointers and CRLF appear as stored.
  - Files are opened with `O_NOFOLLOW` and checked with `fstat`. Symlinks are recorded as links, and their targets are never read.
  - A path reached through a symlinked directory is `policy_denied`.
  - FIFOs, sockets and devices are ignored.
  - Removal uses the same snapshot to decide whether the tree is dirty.
- **Dirtiness.** Removal treats a worktree as dirty when either of these differs from HEAD:
  - the filter-free working-tree snapshot (content, mode, presence, untracked files);
  - the index (`ls-files -s`: staged-only changes, index-only or index-missing paths, unmerged stages).
- **Nested repositories.** Working-tree reads and non-forced removal fail with `policy_denied` when the worktree contains any of these:
  - gitlinks (mode 160000), in the index or in HEAD;
  - a nested `.git` directory or file, matched case-insensitively (`.GIT` and `.Git` count);
  - any directory entry (`dir/`) that `ls-files --others` reports.

  Mimir never runs `git status`, which recurses into nested repos and runs their unaudited config. The walk also enters ignored trees such as `node_modules`, so a vendored git checkout there denies non-forced removal (fail-closed by design; use an approved force).

- **Conflicts.** `detectConflicts(id, ref)` runs `merge-tree --write-tree` on committed work in the scratch repo and mutates nothing.

## Security model

Agents can write their worktree and, without OS sandboxing, the project's shared `.git`.

- **Every git call:**
  - gets an allowlisted environment: PATH, HOME, LANG, LC_ALL and TERM from the parent, plus fixed `GIT_*` hardening values;
  - runs with hardening `-c` flags: no hooks, fsmonitor, signature checks, ssh or credential helpers.
- **Before `worktree add` and removal:** the repo's local and worktree config is audited, and any command-running key is `policy_denied`. The keys are filter, merge or diff drivers, aliases, includes, gpg, ssh, credential helpers, hooksPath, fsmonitor and similar.
- **Read-only analysis** (`diff`, `log`, `merge-tree`) runs in `.mimir-scratch/<projectId>.git`. That repo borrows objects through `objects/info/alternates`. Mimir rewrites its config and attributes on every open, and global and system config are disabled, so no driver an agent defines can exist there.

## Remaining risks

- The operator's global git config is trusted and is not audited.
- An agent that can write the common `.git` could change config between the audit and `worktree add` (TOCTOU), or tamper with objects and refs. Closing this needs OS-level sandboxing of agent writes.
- Swapping a symlink between the ancestor check and `open` is narrowed but not eliminated. The ancestors are re-checked after reading, and the inode must match the pre-open `lstat`.
- Any local `filter.*` key fails closed, including `filter.lfs`, as does `extensions.worktreeConfig`. LFS projects need an allowlist.
- Scratch repos accumulate snapshot blobs and have no automatic gc.
