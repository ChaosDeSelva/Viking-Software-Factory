# Security model

Brokkr executes commands defined by harnesses against real repositories, and its verdict feeds automated delivery decisions. Security is release blocking (spec §16, §21.4). This page maps each threat in the spec's threat model (§16.1) to the control that addresses it, the code that implements the control, and the tests that prove it. Known gaps are listed in `docs/limits.md`.

Paths are relative to the repository root. Test names are quoted from the test files.

## Threats, controls, code, tests

### T1. Malicious or compromised community harness

| Control | Code | Tests |
|---|---|---|
| External sources are untrusted until pinned by digest and explicitly trusted; untrusted harnesses are never selected, prepared or executed | `packages/registry/src/registry.ts`, `resolve.ts`; `packages/policy/src/policy.ts` (`evaluateBefore`, `untrusted_source`); `packages/sdk/src/brokkr.ts` (`materialize`, `adapterContext`) | registry `I3: lower-trust sources never shadow higher-trust ones`; policy `blocks untrusted harnesses with reason untrusted_source`; runner `blocks untrusted harnesses without executing anything`; e2e `an untrusted harness cannot execute commands without authorization`; sdk `refuses an untrusted source` (incl. a forged selection) |
| Tree digest covers every regular file; symlinks and special files are rejected; tampered pins load as untrusted | `packages/core/src/digest.ts`, `contained.ts`; `packages/registry/src/registry.ts` | core `a .brokkrignore is just another hashed file`, `refuses FIFOs and other special files`; registry `N1: external pins cover every file` |
| Tarball members vetted before extraction (no `..`, absolute paths, links, special entries); cache re verified on every load | `packages/registry/src/tarball.ts` | registry `tarball.test.ts` hostile archive cases and cache tamper test |
| Lockfile and SDK selections pin harness and skill digests; a modified harness blocks verification | `packages/registry/src/lock.ts`; `apps/cli/src/commands/verify.ts`; `packages/sdk/src/brokkr.ts` (`materialize`) | e2e `a modified harness fails lockfile integrity validation`; runner `blocks on lockfile integrity problems`; sdk `refuses a selection whose harness digest no longer matches`, `a modified harness blocks the run and nothing executes` |

### T2. Prompt injection

| Control | Code | Tests |
|---|---|---|
| The verdict is computed only from deterministic check results and policy; no model output is an input to `computeVerdict` (D-012) | `packages/core/src/verdict.ts` | core `verdict.test.ts` (table of every state combination) |
| Skill text is selected deterministically from manifests; an AI suggestion hook may only add optional skills of resolved harnesses | `packages/resolver/src/resolve-skills.ts` | resolver tests for rejected AI suggestions |
| Agent output (logs) is evidence data, never instructions; reports escape all content | `packages/reporters/src/index.ts` | reporters `escapes report content`, `makes no external requests` |

### T3. Command injection

| Control | Code | Tests |
|---|---|---|
| Commands are argv arrays executed with `shell: false`; the only template placeholder is `{{harnessDir}}`, confined to the harness directory | `packages/runner/src/executor.ts`, `preflight.ts` | runner `never uses a shell: metacharacters are passed literally`; preflight `rejects substituted paths that leave the harness directory`, `rejects unknown placeholders` |
| Destructive and uninspectable commands denied after unwrapping wrappers (`env`, `timeout`, `npx`, `pnpm exec`, ...) | `packages/policy/src/command.ts` | policy `analyzeCommand: destructive operations` (incl. `timeout -s KILL` and `env -S` bypasses) |
| `allowedCommands` allowlist on argv[0] | `packages/policy/src/policy.ts` | policy `denies destructive commands, unsafe cwd and commands outside the allowlist` |
| All external input validated by strict schemas (manifests, tasks, config, exceptions, SDK selections) | `packages/core/src/schemas.ts`, `report.ts`; `packages/sdk/src/types.ts` (`SelectionSchema`) | core `schemas.test.ts`; sdk `rejects invalid input` |

### T4. Secret exposure

| Control | Code | Tests |
|---|---|---|
| Environment allowlist; secret named variables are never passed | `packages/runner/src/env.ts` | preflight `passes only the explicit allowlist plus requested keys`; runner `passes exactly the given environment` |
| Streaming redaction of logs (patterns and the caller's secret values); artifacts redacted at rest; generated bundles scanned; any finding blocks | `packages/policy/src/secrets.ts`; `packages/runner/src/pipeline.ts` | secrets `line redactor never emits a secret split across chunks`; runner `secret findings in output block the run`; e2e `a secret in output blocks the run and is redacted in evidence` |
| Events carry check results, never raw check output | `packages/sdk/src/brokkr.ts` (`verify`), `events.ts` | `tests/contracts/src/schemas.test.ts` (event schema) |

### T5. Unsafe filesystem operations

| Control | Code | Tests |
|---|---|---|
| Check `cwd` must resolve (realpath) inside the workspace | `packages/runner/src/executor.ts` (`resolveWorkingDirectory`) | runner `rejects a cwd that escapes the workspace with ..`, `... through a symlink`; e2e `a malicious manifest cannot escape its working directory` |
| Generated bundles: writes confined to the bundle directory, no writes through symlinks, ledger verified cleanup that deletes only Brokkr's own unchanged files | `packages/core/src/bundle.ts`; adapters | core `bundle.test.ts`; adapters `cleanup only touches the adapter's own project files` |
| `.brokkr` must not be a symlink | `packages/registry/src/config.ts` (`ensureBrokkrDir`) | registry and CLI `M4` tests |
| The SDK defaults to `trust: 'workspace-untrusted'`: harnesses, profiles, lock, policy and exceptions come only from the caller, the built in library and `~/.brokkr`; nothing under the repository's or the workspace's `.brokkr/` defines the contract. `developer` mode is opt in and still never takes the contract from the verified workspace. The only workspace files read are regular files under `.brokkr/generated/` (secret scan), read after the checks with `O_NOFOLLOW` opens and `fstat` checks on the handle; symlinks, hard links (`nlink > 1`, which could share an inode with a file outside the workspace), FIFOs, devices and swapped files are refused. The CLI and the SDK use the same reader, `readGeneratedBundles` in `@brokkr/runner` (review I2, fix round 2 N2, fix round 3 I-a/I-b) | `packages/sdk/src/brokkr.ts` (`open`, `findProfile`, `verify`); `packages/registry/src/registry.ts` (`projectSources: false`) | sdk `trust.test.ts` (hostile repo with a no op harness, a profile shadowing `frontend-strict` and self approved waivers); sdk `developer mode reads policy and exceptions from cwd, never from the workspace`; registry `projectSources: false loads neither ...`; sdk `review I2: generated bundles are read only inside the workspace`, `fix round 2 N2: ...` (check swaps a bundle for a symlink or a hard link; FIFO and /dev/zero do not hang); `packages/runner/src/bundles.test.ts`; `apps/cli/test/bundles.test.ts` |

### T6. Compromised dependencies

| Control | Code | Tests |
|---|---|---|
| Dependency installation needs an approval exception | `packages/policy/src/command.ts`, `policy.ts` | policy `requires approval for dependency installation` |
| Network denied by default for checks (best effort); audits need a recorded network exception | `packages/policy/src/policy.ts` (`applyNetworkPolicy`) | runner `network-dependent checks under network deny are skipped network_denied, never passed`; `an approved network-access exception lets the audit run` |
| Brokkr's own dependencies: Apache-2.0-compatible licences only; lockfile verified against pnpm supply chain policy on install | `pnpm-lock.yaml` | `pnpm install` output |

### T7. Attempts to bypass verification

| Control | Code | Tests |
|---|---|---|
| A required check that is skipped, errored, timed out or cancelled never counts as passed; a run with nothing required is `incomplete` | `packages/core/src/verdict.ts` | core `verdict.test.ts`; e2e `a required check that cannot execute is incomplete, never a pass` |
| Exceptions are scoped, expiring, attributed and visible; security policies are never waivable; waived checks are `skipped (exception <id>)` | `packages/policy/src/policy.ts`; `packages/reporters/src/index.ts` | policy `an exception can never waive a security policy or untrusted source`; reporters `shows waived checks as skipped with the exception id, never passed` |
| Lower policy layers can only strengthen | `packages/policy/src/policy.ts` (`mergePolicies`) | policy `lower layers cannot weaken a deny set higher up` |
| Evidence integrity: SHA-256 manifest re verified on read | `packages/evidence/src/index.ts` (`readReport`) | evidence `detects an edited report.json and missing artifacts`; sdk verify tests check `readReport` integrity |
| Timeouts and cancellation kill the owned process group; partial evidence kept | `packages/runner/src/executor.ts` | runner `escalates to SIGKILL when SIGTERM is ignored`; e2e `a timed-out check terminates its owned process tree`, `Ctrl-C on the built bin` |
| The SDK cannot be talked out of the verdict: there is no option to override it | `packages/sdk/src/brokkr.ts` | `tests/contracts/src/sdk-surface.test.ts` (`no verdict override exists`) |

## Audit trail

Every run records policy decisions (policy, stage, outcome, layer, check), applied exceptions with approver and scope, harness versions and digests, the lock digest, the repository commit and dirty tree digest, and the environment. See `docs/verification-and-reports.md`.

## What Brokkr does not protect against

No OS level sandbox; network denial via proxy variables only; `setsid` can escape the process group; interpreter payloads are opaque. An orchestrator should inject a sandboxing `CheckExecutor` for untrusted work. Details: `docs/limits.md`.

## Run store integrity (B3b fix round 3)

Runs are stored outside the workspace under `<home>/.brokkr/runs/<sha256(workspace)>/` and the manifest is HMAC signed with `<home>/.brokkr/key` (B2fix). A check runs as the same user and can compute that path, so before every check and before writing the report Brokkr re checks that the run directory is the directory it created (`lstat`: not a symlink, same device and inode; same `realpath`, so no ancestor such as `.brokkr` was swapped). Otherwise verification stops with `infra` and nothing is written. Tests: `packages/evidence/src/run-intact.test.ts`; `packages/sdk/src/runroot.test.ts` (a check swaps its run directory, or the home `.brokkr`, for a symlink; a workspace `.brokkr/runs` symlink is ignored and the workspace is never written).
