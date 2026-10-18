# backend-node

Node.js + TypeScript backend/API engineering harness with contract, validation, security and test gates.

- Version: 1.0.0
- Task types: backend, api, node
- Required skills: api-contracts, typescript, input-validation, error-handling, authn-authz-review
- Optional skills: structured-logging, testing, backend-performance

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `typecheck` | `pnpm exec tsc --noEmit` | yes | fileExists: tsconfig.json |
| `lint` | `pnpm run lint` | yes | scriptExists: lint |
| `test` | `pnpm test` | yes | scriptExists: test |
| `migration-dry-run` | `pnpm run db:migrate:dry-run` | yes | fileExists: migrations; scriptExists: db:migrate:dry-run |

A check whose `when` conditions are not all met is skipped, not failed.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci, database-migration.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: implementer and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

Validate with `brokkr harness validate harnesses/backend-node`.
