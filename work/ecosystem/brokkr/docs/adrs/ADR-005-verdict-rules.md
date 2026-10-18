# ADR-005: Verdict rules and verification exit codes

* Status: accepted
* Date: 2026-10-14

## Context

Spec §8.2 defines six check states and four verdicts and says a required skipped check cannot count as passed. Phase 3 acceptance: Brokkr must never report incomplete verification as successful. Brokkr's verdict is not overridable by a model or by Sindri (D-012).

## Decision

`computeVerdict` (`@brokkr/core`) is a pure function with this precedence: **blocked > failed > incomplete > passed**.

| Condition | Verdict |
|---|---|
| any policy denial: untrusted source, destructive or non allowlisted command (including aliased binaries), unsafe cwd, missing approval, lock integrity failure, secret exposure, a policy conflict (a lower layer making a higher layer's required check waivable), a tampered Brokkr home | `blocked` |
| any required check `failed` | `failed` |
| any required check `skipped` (other than harness required `not_applicable`), `errored`, `timed_out` or `cancelled` without an approved exception | `incomplete` |
| an unmet policy requirement (a `requiredCheckIds` entry no harness defines, a required review that was not recorded) | `incomplete` |
| no required check at all | `incomplete` (a vacuous pass proves nothing) |
| required checks exist but none actually ran and passed (e.g. all waived by exceptions) | `incomplete` (audit C2: waivers alone never pass a run) |
| otherwise | `passed` |

* Optional checks never change the verdict; they are reported.
* An exception can waive a required check only before it runs. The check is then `skipped` with reason `exception` and its `exceptionId`, reported as `skipped (exception <id>)`, and counted as satisfied, provided at least one other required check actually ran and passed. An exception never turns `failed` into a pass. In `workspace-untrusted` mode an exception counts only if its approver is caller trusted and organization/project policy (from outside the workspace) made the check waivable (ADR-003, ADR-006).
* **Not applicable (controller ruling, fix round 1).** A `when` guard that is not met (`fileExists`, `anyFileExists`, `scriptExists`) skips the check with reason `not_applicable`. A required check skipped this way is excluded from the required set: it neither passes nor fails anything, and the vacuous run rule counts only applicable required checks.
  * Exception: a check that a `requiredCheckIds` policy (organization or project) demands carries `requiredBy: "policy"` and stays `incomplete` when not applicable, because the policy demands that it runs.
  * Failures of the command template itself (executable not on PATH, the package script the command runs, a missing `pnpm exec` binary) are not "not applicable": they stay `missing_tool`/`missing_script` and make a required check incomplete.
  * Because a crew agent can make a check not applicable by deleting its guard file (for example `playwright.config.ts`), not applicable required checks are listed prominently: a "Required checks not applicable" section at the top of `report.md` and `report.html`, a block in the terminal output, a verdict reason per check, and the gate count shows `n/m required gates passed (k not applicable)`.
* When any check is blocked by policy before execution, no check runs at all. A denial discovered while preparing a check (a script run that would install dependencies) blocks the run and skips the remaining checks.
* `trustMode` is recorded in every report; in `workspace-untrusted` mode a missing or mismatching caller lock is a `lock_integrity` denial (`blocked`).
* Report `summary` keeps exactly the four §10.2 counters; `timed_out` and `cancelled` count as `errored`. Each check's real state is in `checks[]`.

**Exit codes** (`exitCodeForVerdict`, spec §11.3): `passed` 0, `failed` 1, `incomplete` 1, `blocked` 4. An interrupted run exits 130 whatever the verdict. Configuration errors (bad config, unknown profile, conflicting harnesses, a manifest with `cwd: ../..`) exit 2 before a run starts. Unexpected infrastructure failures (for example run storage that cannot be created) exit 3.

## Consequences

Every combination of required/optional check states is covered by table driven tests in `packages/core/src/verdict.test.ts`. Built in harnesses whose required checks are gated on optional tooling (frontend react's browser checks, backend node's migration dry run) pass on repositories without that tooling, with the skipped checks called out as not applicable rather than hidden.
