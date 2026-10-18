# security-baseline

Secrets, dependency vulnerabilities, insecure configuration and dangerous code patterns, with findings separated from heuristics.

- Version: 1.0.0
- Task types: security
- Required skills: secret-scan, dependency-audit, insecure-config, dangerous-code
- Optional skills: none

## Checks

| Id | Command | Required | Runs when |
|---|---|---|---|
| `secret-scan` | `node {{harnessDir}}/scripts/scan.mjs --kind secrets` | yes | always |
| `dependency-audit-pnpm` | `pnpm audit --json` | no | fileExists: pnpm-lock.yaml |
| `dependency-audit-npm` | `npm audit --json` | no | fileExists: package-lock.json |
| `insecure-config` | `node {{harnessDir}}/scripts/scan.mjs --kind config` | no | always |
| `dangerous-code` | `node {{harnessDir}}/scripts/scan.mjs --kind code` | no | always |

A check whose `when` conditions are not all met is skipped, not failed.

## Policies

Network: deny. Destructive commands: deny. Approval required for: install-dependencies, modify-ci, network-access.

## Layout

- `harness.yaml`: manifest
- `skills/<name>/skill.yaml` and `instructions.md`: skills (Always / Never / Verify)
- `roles/`: implementer and reviewer role definitions
- `templates/brief.md`: task brief template with `{{objective}}`, `{{acceptanceCriteria}}`, `{{context}}`, `{{constraints}}`

## Bundled scanner

`scripts/scan.mjs` is dependency-free and reads `patterns/patterns.json`.

    node scripts/scan.mjs --kind secrets|config|code|all [--root DIR]

Every result is tagged `finding` (a confirmed match of a provider-specific format or an unambiguous insecure setting) or `heuristic` (a pattern that needs human review). The scanner exits 1 only when a `finding` exists, and it never prints matched values.

Check commands use the placeholder `{{harnessDir}}` for this directory; the runner must substitute it. The dependency audit checks (`dependency-audit-pnpm`, `dependency-audit-npm`) need registry access, which this harness denies by default. They are therefore advisory (`required: false`) until a network exception or approved connector exists; a run without network must be reported as skipped or errored, never as a pass.

Validate with `brokkr harness validate harnesses/security-baseline`.
