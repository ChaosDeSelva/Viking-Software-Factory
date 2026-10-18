# qa-regression

Independent regression test plan, re-run of the project's tests and evidence capture. It backs the `qa` role in Sindri plans: QA works after implementation and review, plans tests from the acceptance criteria, re-runs them itself and records evidence instead of trusting the implementer's report.

- Version: 1.0.0
- Task types: qa, test, regression
- Required skills: regression-test-plan, independent-verification, test-evidence, flaky-test-triage
- Optional skills: playwright-e2e

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `test` | `pnpm test` | yes | scriptExists: test |
| `integration` | `pnpm run test:integration` | no | scriptExists: test:integration |
| `e2e` | `pnpm run test:e2e` | no | scriptExists: test:e2e |
| `coverage` | `pnpm run coverage` | no | scriptExists: coverage |

The `test` check is identical to `backend-node`'s, so the two harnesses compose without a conflict. A required check whose `when` conditions are not met is skipped and makes the verdict `incomplete`, never `passed`. Optional checks run when their script exists and never decide the verdict.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci, update-snapshots.

## Roles

- `roles/qa.yaml`: the QA agent. It may add tests but must not change product code.
- `roles/reviewer.yaml`: reviews QA coverage and evidence.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: qa and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

Validate with `brokkr harness validate harnesses/qa-regression`.
