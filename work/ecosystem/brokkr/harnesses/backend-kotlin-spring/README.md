# backend-kotlin-spring

Kotlin + Spring Boot backend engineering harness with JVM test gates.

- Version: 1.0.0
- Task types: kotlin, spring, jvm
- Required skills: spring-architecture, kotlin-idioms, jvm-testing, spring-security
- Optional skills: none

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `gradle-test` | `./gradlew test` | yes | fileExists: gradlew |

A check whose `when` conditions are not all met is skipped, not failed.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: implementer and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

Validate with `brokkr harness validate harnesses/backend-kotlin-spring`.
