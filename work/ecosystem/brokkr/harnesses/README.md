# Built-in harnesses

Priority P0: `frontend-react`, `backend-node`, `security-baseline`, `documentation`, `qa-regression`. Priority P1: `database-postgres`, `backend-kotlin-spring`, `godot-game`.

| Name | Version | Task types | Required skills | Checks |
|---|---|---|---|---|
| `frontend-react` | 1.0.0 | frontend, ui, react | react-architecture, typescript, accessibility, responsive-design | typecheck, lint, unit, build, screenshot-desktop, screenshot-mobile, axe |
| `backend-node` | 1.0.0 | backend, api, node | api-contracts, typescript, input-validation, error-handling, authn-authz-review | typecheck, lint, test, migration-dry-run |
| `security-baseline` | 1.0.0 | security | secret-scan, dependency-audit, insecure-config, dangerous-code | secret-scan, dependency-audit-pnpm, dependency-audit-npm, insecure-config, dangerous-code |
| `documentation` | 1.0.0 | docs, documentation | docs-accuracy, runnable-examples, release-notes, link-integrity | docs-links, docs-examples, docs-lint, docs-build |
| `qa-regression` | 1.0.0 | qa, test, regression | regression-test-plan, independent-verification, test-evidence, flaky-test-triage | test, integration, e2e, coverage |
| `database-postgres` | 1.0.0 | database, postgres, sql | migration-safety, schema-design, query-review, sql-testing | migration-dry-run, sqlfluff |
| `backend-kotlin-spring` | 1.0.0 | kotlin, spring, jvm | spring-architecture, kotlin-idioms, jvm-testing, spring-security | gradle-test |
| `godot-game` | 1.0.0 | game, godot | gdscript-quality, scene-structure, game-testing, asset-hygiene | godot-check |

Checks are argv arrays run without a shell and are skipped when their `when` conditions (`scriptExists`, `fileExists`) are not met. Validate any harness with `brokkr harness validate <dir>`.

## Profiles

Profiles in `profiles/` request a set of harnesses together.

| Profile | Harnesses |
|---|---|
| `frontend-strict` | frontend-react, security-baseline, documentation |
| `backend-strict` | backend-node, security-baseline (add `database-postgres` explicitly when the project uses PostgreSQL) |
| `fullstack` | frontend-react, backend-node, security-baseline |

## Skill format

Each skill is at most 300 words with `Always`, `Never` and `Verify` sections.
