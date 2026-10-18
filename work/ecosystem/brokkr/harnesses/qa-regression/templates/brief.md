# Brief: {{objective}}

## Objective

{{objective}}

## Acceptance criteria

{{acceptanceCriteria}}

## Context

{{context}}

## Constraints

{{constraints}}

## Harness: qa-regression

Role: independent QA. Do not change product code; report defects with a failing test.

Skills: regression-test-plan, independent-verification, test-evidence, flaky-test-triage

Checks that must pass before completion:

- `test`: `pnpm test` (when scriptExists test)
- `integration`: `pnpm run test:integration` (when scriptExists test:integration)
- `e2e`: `pnpm run test:e2e` (when scriptExists test:e2e)
- `coverage`: `pnpm run coverage` (when scriptExists coverage)

Do not report completion without the exit codes of these checks and the evidence for each acceptance criterion.
