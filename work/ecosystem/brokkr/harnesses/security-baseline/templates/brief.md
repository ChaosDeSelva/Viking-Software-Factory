# Brief: {{objective}}

## Objective

{{objective}}

## Acceptance criteria

{{acceptanceCriteria}}

## Context

{{context}}

## Constraints

{{constraints}}

## Harness: security-baseline

Skills: secret-scan, dependency-audit, insecure-config, dangerous-code

Checks that must pass before completion:

- `secret-scan`: `node {{harnessDir}}/scripts/scan.mjs --kind secrets`
- `dependency-audit-pnpm`: `pnpm audit --json` (when fileExists pnpm-lock.yaml)
- `dependency-audit-npm`: `npm audit --json` (when fileExists package-lock.json)
- `insecure-config`: `node {{harnessDir}}/scripts/scan.mjs --kind config`
- `dangerous-code`: `node {{harnessDir}}/scripts/scan.mjs --kind code`

Do not report completion without the exit codes of these checks.
