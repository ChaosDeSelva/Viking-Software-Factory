# documentation

Documentation accuracy, runnable examples, link integrity and release notes.

- Version: 1.0.0
- Task types: docs, documentation
- Required skills: docs-accuracy, runnable-examples, release-notes, link-integrity
- Optional skills: none

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `docs-links` | `pnpm run docs:links` | yes | scriptExists: docs:links |
| `docs-examples` | `pnpm run docs:examples` | yes | scriptExists: docs:examples |
| `docs-lint` | `pnpm run docs:lint` | no | scriptExists: docs:lint |
| `docs-build` | `pnpm run docs:build` | no | scriptExists: docs:build |

A check whose `when` conditions are not all met is skipped, not failed.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: implementer and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

Validate with `brokkr harness validate harnesses/documentation`.
