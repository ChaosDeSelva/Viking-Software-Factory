# database-postgres

PostgreSQL schema changes, migrations and query review.

- Version: 1.0.0
- Task types: database, postgres, sql
- Required skills: migration-safety, schema-design, query-review, sql-testing
- Optional skills: none

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `migration-dry-run` | `pnpm run db:migrate:dry-run` | yes | fileExists: migrations; scriptExists: db:migrate:dry-run |
| `sqlfluff` | `sqlfluff lint --dialect postgres migrations` | no | fileExists: migrations |

A check whose `when` conditions are not all met is skipped, not failed.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci, database-migration.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: implementer and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

Validate with `brokkr harness validate harnesses/database-postgres`.
