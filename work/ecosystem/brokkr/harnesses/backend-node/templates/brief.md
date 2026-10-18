# Brief: {{objective}}

## Objective

{{objective}}

## Acceptance criteria

{{acceptanceCriteria}}

## Context

{{context}}

## Constraints

{{constraints}}

## Harness: backend-node

Skills: api-contracts, typescript, input-validation, error-handling, authn-authz-review

Checks that must pass before completion:

- `typecheck`: `pnpm exec tsc --noEmit` (when fileExists tsconfig.json)
- `lint`: `pnpm run lint` (when scriptExists lint)
- `test`: `pnpm test` (when scriptExists test)
- `migration-dry-run`: `pnpm run db:migrate:dry-run` (when fileExists migrations; scriptExists db:migrate:dry-run)

Do not report completion without the exit codes of these checks.
