# Verification

When a task's agent finishes, the task enters `verifying`. In that step Mimir, in order:

1. Records the worktree's `diff` and `changed-files` manifest (base and head commit, including uncommitted edits).
2. Collects files the agent left under `<worktree>/.mimir/artifacts/` (top level only):
   `review.json` as `review`, `screenshot-*.png` as `screenshot`, `*.log` as `test.output`,
   anything else as `file`. Each entry is `lstat`ed; symlinks (also a symlinked `.mimir` or
   `artifacts` directory), directories, FIFOs and devices are skipped. Limits: 8 MB per file,
   64 MB in total, the first 200 entries by name. Text is redacted before it is stored. Each file
   is an `artifact.recorded` event (provenance `observed`, source `mimir.server`, SHA-256 of the
   stored bytes, `name`). Skipped entries emit `artifact.collection_skipped` with a reason
   (`symlink`, `not_a_file`, `file_too_large`, `total_too_large`, `unreadable`,
   `outside_worktree`); more than 200 entries emit one `artifact.collection_truncated`.
3. Runs the verifier with the task id, mission id, worktree, base commit and observed head.

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

The task passes only when Brokkr's verdict is `passed` and the report is bound to the task
(`report.taskId` is the Mimir task id) and to the head Mimir observed
(`report.repository.commitSha` equals the manifest's `headSha`). The report is stored as the
`brokkr.verification-report` artifact. There is no override (D-012): a failed, incomplete or
blocked verdict fails the attempt.

If `@brokkr/sdk` cannot be loaded, the server logs `verifier: brokkr unavailable` at startup and
tasks with `verification` set fail closed. Only tasks without a Brokkr contract use their project test command.

## Vendored Brokkr

`vendor/brokkr/` holds the 12 `@brokkr/*` 0.1.0 tarballs and `manifest.json` built from Brokkr
main `99e00ad` (step 2 integration) with `pnpm build && pnpm pack:local`; `pnpm-workspace.yaml` overrides each package to its tarball. To update,
copy a new `dist-packages/` over `vendor/brokkr/`, update the overrides, and run `pnpm install`.
