# Verification

When a task's agent finishes, the task enters `verifying`. In that step Mimir, in order:

1. Records the worktree's `diff` and `changed-files` manifest (base and head commit, including uncommitted edits).
2. Collects files the agent left under `<worktree>/.mimir/artifacts/` (top level only):
   `review.json` as `review`, `screenshot-*.png` as `screenshot`, `*.log` as `test.output`,
   `*.md` as `report` (served as `text/markdown`), anything else as `file`. A `review` or `file`
   whose name ends in `.json` (e.g. `review.json`, `sources.json`) is served as
   `application/json`. Each entry is `lstat`ed; symlinks (also a symlinked `.mimir` or
   `artifacts` directory), directories, FIFOs and devices are skipped. Limits: 8 MB per file,
   64 MB in total, the first 200 entries by name. Text is redacted before it is stored. Each file
   is an `artifact.recorded` event (provenance `observed`, source `mimir.server`, SHA-256 of the
   stored bytes, `name`). Skipped entries emit `artifact.collection_skipped` with a reason
   (`symlink`, `not_a_file`, `file_too_large`, `total_too_large`, `unreadable`,
   `outside_worktree`); more than 200 entries emit one `artifact.collection_truncated`.
3. Runs the verifier with the task id, mission id, worktree, base commit and observed head.

## Task modes

A task created with `mode` (see `TaskMode` in [api.md](api.md)) changes this step:

- `deliverable: "document"`: no verifier runs. The brief ends with a contract asking for the
  deliverable as Markdown in `.mimir/artifacts/<name>.md` (or `review.json` for a review) and no
  source changes. Mimir records `diff` and `changed-files` for transparency and collects the
  artifacts as above. With at least one `report` (`*.md`) or `review` (`review.json`) collected
  in this attempt the task completes with
  `task.completed.verificationSkipped: "document_deliverable"` and the worktree's base commit as
  `resultCommit`; worktree edits are never committed. Without one the attempt fails with
  `task.failed.reason: "document_missing"`; it is retried while attempts are left, and the next
  attempt's brief says that no report artifact was produced. A document task cannot be delivered
  (`POST /v1/tasks/{id}/pr`) or rechecked.
- `access: "read"` (only with `deliverable: "document"`; `{ access: "read", deliverable: "diff" }`
  is refused with a validation error): Claude runs with the `default` permission mode and only
  `Read`, `Grep`, `Glob`, `git diff/log/show/status` and `Write`/`Edit` under
  `.mimir/artifacts/`. Codex keeps `workspace-write` (so it can write artifacts); its edits are
  discarded as for any document task.
- `network: "web"`: Claude also gets `WebSearch` and `WebFetch`; Codex gets
  `sandbox_workspace_write.network_access=true` whatever the project setting.

### Before every attempt

Before each session starts (any mode), Mimir prepares the worktree's `.mimir`:

- `.mimir` must be a directory (or absent). A symlink or a file there fails the task with
  `task.failed.reason: "workspace_invalid: ..."` and `retryable: false`: no attempt is used up
  retrying it.
- The top-level files of `.mimir/artifacts/` are removed: earlier attempts' files were collected
  already, or belong to a failed attempt. Only what this attempt leaves is collected.
- `.mimir/inputs/` is replaced. Because a document task's result commit is its base, its output
  reaches dependent tasks as files: per completed dependency, the `report` artifacts (`*.md`),
  `sources.json` and `review.json` recorded by its completing attempt, copied from the stored
  (redacted) artifacts, never from the dependency's worktree. Each dependency gets
  `.mimir/inputs/<slug>/`, the slug of its title (lowercase, non-alphanumerics as `-`, at most 60
  characters; `-<last 8 characters of its id>` on a collision). The agent's brief lists the
  files, and `session.requested.inputs` lists them as `{ dependencyTaskId, dir, files }`.
  `.mimir/inputs/` is in the repository's `info/exclude`, is left out of `diff`,
  `changed-files` and result commits, and is not collected (only the top level of
  `.mimir/artifacts/` is).

## Verifiers

| Project settings | Verifier |
|---|---|
| `verification` set | Brokkr (`@mimir/brokkr-verifier`, `@brokkr/sdk` from `vendor/brokkr/`) |
| no `verification` | the project's `testCommand` (default `npm test`) |

`settings.verification`:

```json
{
  "verification": {
    "harnesses": ["documentation@^1"],
    "lockPath": "/abs/path/outside/the/worktree/harness.lock.json",
    "policyPath": "/abs/path/outside/the/worktree/policy.yaml"
  }
}
```

An optional task level `verification` contract overrides the project default and is persisted in the task event. Sindri uses this to bind each crew to its approved harness selection. Supply exactly one of inline `lock` (the full Brokkr resolve lock object) or `lockPath`.

`harnesses` are `name@semver-range` (`name` alone means any version). A lock is required
(`workspace-untrusted` verification needs pinned harness versions and digests; produce it with
`brokkr harness lock` or from a `resolve` selection's `lock`); `policyPath` is optional. Both are
absolute, JSON or YAML, and refused when they resolve inside the task worktree. Brokkr runs
`workspace-untrusted`: nothing under the worktree's `.brokkr/` (config, exceptions, harnesses,
policy) is read. Mimir supplies no exceptions and an empty approver list, so no waiver applies.

Mimir writes nothing inside the worktree during verification. Brokkr's run evidence goes to
`<MIMIR_DATA_DIR>/brokkr/runs/`, signed with Mimir's own key `<MIMIR_DATA_DIR>/brokkr/signing.key`
(created once, mode 0600; never `~/.brokkr/key`). Brokkr reads the operator's `~/.brokkr` only for
user harnesses and organization policy, which can only strengthen the contract. Package script
checks need the worktree's dependencies installed (`node_modules`); installing them stays a
Mimir privileged action (`package.install`).

Mimir passes Brokkr the task's base commit as `baseCommit`: the `baseSha` of the task's
`git.worktree_created` event (Mimir's own record of where the worktree started), never a ref
resolved inside the worktree, whose refs the agent can move. Only a full 40- or 64-hex commit id
is passed. In `workspace-untrusted` mode a required check skipped because its `when` guard does
not hold counts as not applicable only when the guard did not hold at the base commit either;
without a base commit Brokkr makes such a verdict `incomplete`. A Brokkr build that predates
`baseCommit` ignores the field.

The task passes only when Brokkr's verdict is `passed` and the report is bound to the task
(`report.taskId` is the Mimir task id) and to the head Mimir observed
(`report.repository.commitSha` equals the manifest's `headSha`). The report is stored as the
`brokkr.verification-report` artifact. There is no override (D-012): a failed, incomplete or
blocked verdict fails the attempt.

If `@brokkr/sdk` cannot be loaded, the server logs `verifier: brokkr unavailable` at startup and
tasks with `verification` set fail closed. Only tasks without a Brokkr contract use their project test command.

## Vendored Brokkr

`vendor/brokkr/` holds the 12 `@brokkr/*` 0.1.0 tarballs and `manifest.json` built from Brokkr
the factory branch `local/factory-poc` (commit `e4a915f`, which adds `baseCommit`) with `pnpm build && pnpm pack:local`; `pnpm-workspace.yaml` overrides each package to its tarball. To update,
copy a new `dist-packages/` over `vendor/brokkr/`, update the overrides, and run `pnpm install`.

## Project environment (`settings.agent`, `settings.verificationTimeoutMs`)

Agent sessions and verification runs start from a small allowlisted environment. A project that
needs more (tool shims on PATH, a build cache outside the worktree, network for Codex) says so in
its settings. These are operator configuration: only `POST /v1/projects` and
`PATCH /v1/projects/{id}` write them, and nothing an agent can reach does.

```json
{
  "agent": {
    "env": { "GOCACHE": "/Users/me/Library/Caches/go-build" },
    "pathPrepend": ["/Users/me/.local/share/mise/shims"],
    "codexSandbox": { "writableRoots": ["/Users/me/Library/Caches/go-build"], "networkAccess": true }
  },
  "verificationTimeoutMs": 1800000
}
```

| Field | Applies to |
|---|---|
| `agent.env` | Agent sessions on the `cli` and `tmux` runtimes (also as `fleet` workers), the test command, and the environment Brokkr filters for its checks. Other runtimes ignore it. |
| `agent.pathPrepend` | The same places: these directories go in front of the server's PATH, in order. |
| `agent.codexSandbox` | Codex sessions only: `-c sandbox_workspace_write.writable_roots=[...]` and `-c sandbox_workspace_write.network_access=true` are added to the `codex exec` arguments. |
| `verificationTimeoutMs` | The test command (default 10 minutes). A Brokkr check keeps the `timeoutSeconds` of its harness. |

Limits: at most 64 variables, names matching `^[A-Za-z_][A-Za-z0-9_]*$` (128 characters), values
up to 4096 characters; at most 32 PATH entries and 32 writable roots, each an absolute path of up
to 1024 characters without `..` segments or control characters (PATH entries also without `:`).
`PATH`, `HOME`, `NODE_OPTIONS`, `BASH_ENV`, `ENV` and every `GIT_*`, `LD_*`, `DYLD_*` and `MIMIR_*`
name are refused; PATH changes only through `pathPrepend`. Values that look like credentials are
refused as in any project field.

Brokkr passes a check its own allowlist (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `CI` and a few
more) plus the variable names the harness lists under `env`. A variable from `agent.env` reaches a
check only when the harness names it, and never when its name looks like a secret or an
interpreter option. `pathPrepend` always reaches checks, because PATH is on that allowlist.

Changed settings apply to sessions and verifications started afterwards. With `agent.codexSandbox`
set, a task that carries explicit `argv` no longer equals the Codex template unless it includes
the same `-c` arguments, so it needs an approval like any other non-template argv.

When a verification fails and attempts are left, the next attempt's brief ends with a one-line
summary of the failed checks (command, exit code, the end of the redacted output; at most three
checks of 1200 characters each). Shell members and tasks with explicit `argv` get no summary.
