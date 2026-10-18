# Brief: {{objective}}

## Objective

{{objective}}

## Acceptance criteria

{{acceptanceCriteria}}

## Context

{{context}}

## Constraints

{{constraints}}

## Harness: documentation

Skills: docs-accuracy, runnable-examples, release-notes, link-integrity

Checks that must pass before completion:

- `docs-links`: `pnpm run docs:links` (when scriptExists docs:links)
- `docs-examples`: `pnpm run docs:examples` (when scriptExists docs:examples)
- `docs-lint`: `pnpm run docs:lint` (when scriptExists docs:lint)
- `docs-build`: `pnpm run docs:build` (when scriptExists docs:build)

Do not report completion without the exit codes of these checks.
