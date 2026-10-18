# Verification and reports

## Pipeline

`brokkr verify` and `Brokkr.verify` run the same pipeline (`packages/runner/src/pipeline.ts`):

1. **Resolve and check integrity.** Harnesses come from the config, a profile, or an SDK selection. A lockfile (or a selection lock) that no longer matches the installed harnesses blocks the run.
2. **Merge policy** from the system, organization, project, harness and task layers (`docs/policies-and-exceptions.md`).
3. **Evaluate before execution.** Untrusted sources, destructive or non allowlisted commands, unsafe working directories and missing approvals are decided for the whole plan. Any denial blocks the run and nothing executes.
4. **Per check:** waiver, network policy, then preflight: `{{harnessDir}}` expansion, working directory, `when` conditions, executable on `PATH`, package script present, `pnpm exec` binary installed. A failed preflight skips the check with a reason and a diagnostic.
5. **Execute** through the `CheckExecutor`: argv only, filtered environment, own process group, timeout (SIGTERM, then SIGKILL), bounded logs, streaming secret redaction. Consecutive `parallel: true` checks run concurrently; the rest run in order.
6. **Evaluate after execution.** Secrets in output, artifacts or generated bundles block the run; `requiredCheckIds` and review requirements are checked.
7. **Verdict and evidence.** The report and an evidence manifest are written to `.brokkr/runs/run_<ulid>/`.

## Check states (spec §8.2)

| State | Meaning |
|---|---|
| `passed` | completed successfully |
| `failed` | ran and detected a failure |
| `errored` | infrastructure or tool error prevented a valid result |
| `skipped` | not executed; `reason` is always set |
| `cancelled` | interrupted |
| `timed_out` | exceeded `timeoutSeconds`; its process tree was killed |

Skip and error reasons include `missing_tool`, `missing_script`, `not_applicable` (a `when` guard does not hold; per the controller ruling, implemented by the B2 fix round, earlier builds report `condition_not_met`), `policy_denied`, `untrusted_source`, `exception`, `network_denied`, `cwd_rejected`, `invalid_command`, `spawn_error`, `timeout`, `cancelled`. New reasons are a recorded schema change (`docs/compatibility.md`).

## Verdicts

Precedence: `blocked` > `failed` > `incomplete` > `passed` (ADR-005).

* `passed` only when every applicable required check ran and passed.
* A required check that is skipped (other than not applicable, see above), errored, timed out or cancelled makes the run `incomplete` unless an approved exception waived it. Waived checks are shown as `skipped (exception <id>)`, never as passed.
* A run with nothing required that actually ran is `incomplete`.
* Optional checks are reported but never change the verdict.
* AI review is advisory and not part of the verdict.

CLI exit codes: `passed` 0, `failed` 1, `incomplete` 1, `blocked` 4, interrupted 130, invalid configuration 2, infrastructure error 3.

## Report (`report.json`, schema version `1.0`)

The canonical report follows spec §10.2 with additions. JSON Schema: `packages/sdk/schemas/verification-report.v1.json` (also exported as `verificationReportJsonSchema()`).

| Field | Content |
|---|---|
| `id`, `executionId?`, `projectId?`, `taskId?` | run id (`run_<ulid>`), caller correlation id, project, task |
| `harness`, `harnesses[]` | composed `name`/`version` summary plus `lockDigest`; every harness with its digest |
| `repository` | `commitSha`, `workspaceId?`, `dirtyTreeDigest` (status, diff against HEAD and untracked file contents), so uncommitted work is identified exactly |
| `startedAt`, `completedAt` | ISO timestamps |
| `verdict`, `reasons[]`, `interrupted?` | the verdict and why |
| `checks[]` | id, required, state, command, cwd, declaring harnesses, exit code, signal, timing, reason, message, exception id, log path, output bytes, truncation, max RSS, secret findings |
| `policyDecisions[]` | policy, stage (`before`/`runtime`/`after`), outcome, layer, check, message |
| `exceptions[]` | every applied exception with approver, scope, expiry and what it applied to |
| `evidence[]` | relative path, SHA-256, bytes, producer, kind |
| `summary` | `passed`, `failed`, `skipped`, `errored` (timed out and cancelled count as errored) |
| `environment`, `warnings[]` | Brokkr, Node, platform, arch; non fatal warnings |

## Evidence

```
.brokkr/runs/run_<ulid>/
  report.json  report.md  evidence-manifest.json
  logs/<checkId>.log
  test-results/<checkId>/   screenshots/<checkId>/
```

Checks receive `BROKKR_TEST_RESULTS_DIR` and `BROKKR_SCREENSHOTS_DIR` to write artifacts. Every artifact is listed with its SHA-256 in `evidence-manifest.json`. `brokkr report` and `Brokkr.readReport` re hash everything and flag `integrity_failed` on any change; checksums prove evidence has not changed since it was recorded, not who produced it.

## Formats

* JSON: canonical, machine readable.
* Markdown: PR ready summary, checks, policy decisions, exceptions, evidence and environment.
* HTML: self contained (inline CSS, no scripts, no external requests), readable offline.

```sh
brokkr report --latest --format html > report.html
brokkr runs list
brokkr runs prune --keep 10        # or --older-than 7d
```

From the SDK: `renderReport(report, "md" | "html" | "json")`.
