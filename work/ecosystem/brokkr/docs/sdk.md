# SDK: `@brokkr/sdk`

The SDK lets an application (an orchestrator such as Mimir, a planner such as Sindri, or your own tool) use Brokkr without shelling out to the CLI. It imports nothing from Mimir, Sindri or HerdR; a lint rule enforces that (`packages/sdk/eslint.config.js`).

Generated API reference: `pnpm docs:api` writes TypeDoc HTML to `docs/api/` (not committed); `pnpm release:local` generates it and ships it in the release archive under `docs/api/`.

## Install (local tarballs)

```sh
cd brokkr && pnpm pack:local     # writes dist-packages/*.tgz and dist-packages/manifest.json
```

In the consumer, depend on the SDK tarball and pin every `@brokkr/*` package to its tarball so nothing is fetched from a registry (pnpm reads `overrides` from `pnpm-workspace.yaml`):

```yaml
# pnpm-workspace.yaml of the consumer
overrides:
  "@brokkr/sdk": "file:../brokkr/dist-packages/brokkr-sdk-0.1.0.tgz"
  "@brokkr/core": "file:../brokkr/dist-packages/brokkr-core-0.1.0.tgz"
  "@brokkr/registry": "file:../brokkr/dist-packages/brokkr-registry-0.1.0.tgz"
  # ... one line per entry in dist-packages/manifest.json
```

```json
{ "dependencies": { "@brokkr/sdk": "file:../brokkr/dist-packages/brokkr-sdk-0.1.0.tgz" } }
```

`pnpm smoke:pack` does exactly this in a temp project and runs a strict TypeScript consumer against the installed packages. The SDK tarball ships the built in harness library and the JSON Schemas.

## Quick tour

```ts
import { Brokkr } from "@brokkr/sdk";

// Planning: resolve once and store the Selection (its lock is the contract).
const brokkr = new Brokkr({ cwd: "/projects/ravensight", offline: true });

const selection = await brokkr.resolve({
  task: { id: "UI-142", title: "Build analytics dashboard", description: "Create responsive analytics UI", tags: ["frontend", "react"] },
  profile: "frontend-strict",
});

const prepared = await brokkr.prepare({ selection, provider: "claude-code" });

// Verification of an agent's worktree: pin the stored lock; approvals come from your store.
// `missionRecord.lock` was stored when the work was accepted; do not take it from `selection`.
const verifier = new Brokkr({ cwd: "/projects/ravensight", lock: missionRecord.lock, exceptions: [] });
const report = await verifier.verify({ selection, workspace: "/worktrees/ui-142" });
console.log(report.verdict);   // "passed" | "failed" | "incomplete" | "blocked"
console.log(report.evidence);  // [{ path, sha256, bytes, producedBy, kind }]
```

## API

### `new Brokkr(options)`

| Option | Type | Meaning |
|---|---|---|
| `cwd` | `string` | Repository root. Repository signals are read here; `.brokkr/` files only in `developer` mode. |
| `trust` | `"workspace-untrusted"` (default) \| `"developer"` | Who defines the verification contract (below). |
| `harnesses` | `HarnessRequest[]?` | Default contract for `resolve` when it gets neither `profile` nor `harnesses`. |
| `profiles` | `Profile[]?` | Caller defined profiles. A name equal to a built in profile is an error. |
| `lock` | `HarnessLock?` | Pinned lock. It must come from a trusted record (for example the mission record written when the work was accepted), **never from the selection being verified**, otherwise the pin is a tautology. `verify` blocks with `lock_integrity` when the selection or its lock differs in any harness, version, digest or skill, or in the profile: the lock records the profile's name and the digest of the resolved profile (harness requests, overrides, policies), so stripping, swapping or editing the profile under the same name is detected. |
| `exceptions` | `ApprovedException[]?` | Approvals and waivers from the caller's approval store. In `workspace-untrusted` mode these are the only exceptions. |
| `policy` | `PolicyLayer?` | Project layer policy supplied by the caller (lower layers can only strengthen it). |
| `offline` | `boolean?` | Brokkr 0.1 never uses the network; accepted for forward compatibility. |
| `executor` | `CheckExecutor?` | Runs checks during `verify`. Default: `LocalProcessExecutor`. |
| `logger` | `BrokkrLogger?` | pino compatible `{debug, info, warn, error}`. Silent by default. |
| `builtinDir` | `string?` | Built in harness library. Default: the copy shipped with the SDK. |
| `homeDir` | `string?` | User harnesses (`~/.brokkr/harnesses`) and organization policy. Default: `os.homedir()`. |

#### Trust modes (security audit C1/C2 ruling)

The agent being verified can write the worktree and often the repository, so by default neither is allowed to decide what "verified" means.

| Input | `workspace-untrusted` (default) | `developer` (opt in) |
|---|---|---|
| Harness sources | built in, `~/.brokkr/harnesses` | also `<cwd>/.brokkr/harnesses` and pinned `sources` from `<cwd>/.brokkr/config.yaml` |
| Default harnesses | `options.harnesses`, else chosen by task types / repository signals | also `<cwd>/.brokkr/config.yaml` |
| Profiles | `options.profiles`, built ins | also `<cwd>/.brokkr/config.yaml` (never shadowing a built in name) |
| Lock | the selection's lock, checked against `options.lock` when given | same |
| Policy | organization (`~/.brokkr/org-policy.yaml`), `options.policy`, harness, task | also `<cwd>/.brokkr/config.yaml` `policies` |
| Exceptions | `options.exceptions` only | also `<cwd>/.brokkr/exceptions.yaml` |

In both modes the verified `workspace`'s `.brokkr/` never defines the contract: its config, harnesses, profiles, lock, policy and exceptions are not read. The only thing read from it is `.brokkr/generated/`, scanned for leaked secrets **after the checks have run**. Containment is enforced at read time: each file is opened with `O_NOFOLLOW | O_NONBLOCK` and `fstat`-checked on the handle (regular file, same inode as listed, not a hard link, parent inside the workspace, at most 8 MiB, bounded read); entry count and depth are capped; symlinks, hard links, FIFOs, devices and files swapped after listing are refused and reported as warnings. The CLI's equivalent (`brokkr verify` trust option, runs stored outside the workspace and HMAC signed) is being added by the B2 fix round; the SDK will use that run storage once it lands.

### `resolve({ task, profile? | harnesses?, budgetTokens? }) → Selection`

Chooses harnesses and skills; runs nothing and writes nothing.

* `profile`: `options.profiles` (and, in `developer` mode, `.brokkr/config.yaml` profiles), else the built in `frontend-strict`, `backend-strict`, `fullstack`.
* `harnesses`: explicit `[{ name, version: "<semver range>" }]`.
* neither: `options.harnesses`; in `developer` mode the harnesses in `.brokkr/config.yaml`; if there are none, harnesses whose task types match the task's `taskTypes`/`tags`; failing that, harnesses recommended from repository signals. No match is a `not-found` error.

`Selection` is plain JSON (validate with `SelectionSchema` or `schemas/selection.v1.json`):

```ts
interface Selection {
  schemaVersion: 1;
  task: TaskDescriptor;
  profile?: string;
  harnesses: Array<{ name; version; digest; description; taskTypes; source; sourceRef; trust; executionAllowed; checks: { id; required }[] }>;
  skills: Array<{ name; version; digest; reason; requiredBy?; score }>;
  lock: HarnessLock;            // lockVersion 2; pins every harness and skill digest
  rationale: Array<{ kind: "harness" | "skill"; name; selected; reason; score? }>;
  warnings: string[];
}
```

Untrusted sources are refused (`trust_required`). Conflicting harnesses are refused (`harness-conflict`).

### `prepare({ selection, provider, workspace?, modifyProjectInstructions? }) → PreparedContext`

Writes the provider's instruction bundle (`claude-code`, `codex` or `generic`) under `<workspace ?? cwd>/.brokkr/generated/`. The selection is re resolved and every pinned digest compared first: a modified harness or skill, a skill the harnesses do not ship, or an untrusted source is refused (`integrity` / `trust_required`) before anything is written. `cleanup(sameInput)` removes exactly what was written.

### `verify({ selection, workspace, task?, signal?, onEvent?, correlationId?, workspaceId?, projectId?, env? }) → VerificationReport`

Runs the selection's checks against the exact `workspace` (a worktree, for example) and returns Brokkr's report. The pipeline is the CLI's (`brokkr verify`): policy before, preflight, execution through the executor, policy after, verdict, then HMAC signed evidence under `<homeDir>/.brokkr/runs/<sha256(workspace)>/<id>/` (or `runRoot`). Nothing is written inside the workspace, and a run directory or `.brokkr` swapped for a symlink during the run is an `infra` error before any evidence is written (`RunHandle.assertIntact`, checked before each check and before finalizing).

* The **verdict is Brokkr's**. Nothing in the input can override it (D-012); the contract tests pin that no such option exists.
* A selection whose pinned digests no longer match the installed harnesses gives `blocked` (`lock_integrity`) and nothing executes.
* `correlationId` is carried by every event and recorded as the report's `executionId`.
* `signal`: aborting cancels the running check (process group killed), keeps partial evidence and resolves with `interrupted: true`.
* `env`: the caller environment the check environment is filtered from (allowlist only; secret looking names are never passed). Default `process.env`.
* Resolves normally for every verdict. Rejects only when no report can be produced (invalid input, missing workspace, infrastructure error), after emitting `verification.failed`.

Verdict semantics (ADR-005, plus the B2 fix round rulings):

| Verdict | When |
|---|---|
| `passed` | every applicable required check ran and passed |
| `failed` | a required check ran and failed |
| `incomplete` | a required check could not produce a result (missing tool or script, error, timeout, cancellation), a policy requirement is unmet, or nothing required ran |
| `blocked` | policy denial: untrusted source, lock integrity, destructive or non allowlisted command, missing approval, secret exposure |

A required check whose `when` guard does not hold (for example no Playwright config) is reported as `skipped` with reason `not_applicable` and does not by itself make the run `incomplete` (controller ruling, implemented by the B2 fix round; builds before it report `condition_not_met` and `incomplete`). Dependency audits need the network and run only with a project level `allowNetworkFor` exception that is recorded in the report (see `docs/policies-and-exceptions.md`). The published schemas are strict; new `reason` values arrive with a regenerated schema (`docs/compatibility.md`).

### Events (spec §13.3)

`onEvent` receives, synchronously and in order:

| Type | Extra fields |
|---|---|
| `verification.started` | `runId, runDir, workspace, taskId?, harnesses[], checks` |
| `verification.check.started` | `runId, checkId, command[]` |
| `verification.check.completed` | `runId, checkId, result: CheckResult` |
| `verification.completed` | `runId, runDir, verdict, summary, reasons[]` |
| `verification.cancelled` | same as completed; the run was aborted |
| `verification.failed` | `runId?, error { code, message }`: no report could be produced |

Every event has `{ schemaVersion: 1, eventId, correlationId, timestamp, sequence, type }`. `sequence` starts at 1 and is gapless **within one verify call**; there is no global ordering across runs. Exactly one terminal event (`completed`, `cancelled` or `failed`) ends each call. `completed` means a report exists, not that it passed: read `verdict`. Checks skipped before execution (policy, missing tool, not applicable, waived) emit only `check.completed`. Events carry results, never raw check output. A listener that throws is logged and ignored. Schema: `VerificationEventSchema`, `schemas/verification-event.v1.json`.

### `readReport(runDir) → { report, dir, integrity }`

Reads a stored run and re hashes every artifact in its evidence manifest. `integrity.status` is `ok` or `integrity_failed` with `problems`.

### `listHarnesses() → HarnessSummary[]`, `inspectRepo() → RepoSignals`

Every visible harness (all sources, with trust and digest), and read only repository signals (package manager, frameworks, scripts, tsconfig, test runners).

### Errors

All failures are `BrokkrError` with `code` (`invalid-config`, `not-found`, `harness-conflict`, `skill-conflict`, `integrity`, `trust_required`, `policy-denied`, `infra`, ...) and the matching CLI `exitCode`.

## Executors

```ts
interface CheckExecutor {
  execute(request: CheckExecutionRequest, signal?: AbortSignal): Promise<CheckExecutionResult>;
}
```

`request` carries `checkId`, `command` (argv, never a shell string), `workspace`, `cwd`, the already filtered `env`, `timeoutMs`, `logFile`, output limits and a redactor factory. The result reports `state` (`passed | failed | errored | timed_out | cancelled`), `exitCode`, `signal`, timing, `outputTail`, byte counts, `maxRssBytes` and `secretFindings`. An injected executor owns *where* commands run (container, VM, remote worktree); Brokkr still owns *what* runs (policy before execution) and *what it means* (verdict). See ADR-004 and `examples/mimir-integration`.

## Testing your integration

```ts
import { MockExecutor } from "@brokkr/sdk/testing";

const executor = new MockExecutor({
  typecheck: "passed",
  unit: { state: "failed", exitCode: 1, output: "1 failed\n" },
  e2e: { state: "passed", delayMs: 50 },
  lint: (req) => ({ state: req.command.includes("--fix") ? "failed" : "passed" }),
});
const brokkr = new Brokkr({ cwd, executor });
```

Unscripted checks are `errored` (never a silent pass) unless you pass `{ fallback: "passed" }`. `executor.calls` records every request. Preflight, policy and verdict logic still run for real.

## Examples

* `examples/sindri-integration`: resolve harnesses for planned tasks without running anything.
* `examples/mimir-integration`: verify a git worktree through an injected executor, keep an ordered event log, and turn the verdict into the orchestrator's own decision.

## Compatibility

See `docs/compatibility.md`. Contract tests in `tests/contracts/` pin the runtime exports, the types and the schemas.
