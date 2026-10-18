# Brief: {{objective}}

## Objective

{{objective}}

## Acceptance criteria

{{acceptanceCriteria}}

## Context

{{context}}

## Constraints

{{constraints}}

## Harness: database-postgres

Skills: migration-safety, schema-design, query-review, sql-testing

Checks that must pass before completion:

- `migration-dry-run`: `pnpm run db:migrate:dry-run` (when fileExists migrations; scriptExists db:migrate:dry-run)
- `sqlfluff`: `sqlfluff lint --dialect postgres migrations` (when fileExists migrations)

Do not report completion without the exit codes of these checks.
