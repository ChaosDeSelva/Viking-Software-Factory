# ADR-001: Separate repository

Status: Accepted (2026-10-14).

## Context

Sindri plans (intake, specs, knowledge, task DAG, delivery). Mimir commands crews. Brokkr defines and verifies quality. Each has a different release cadence and a different reason to change.

## Decision

Sindri lives in its own git repository with its own history, lockfile, CI and releases. No source or path import crosses a repository boundary. Cross repo use is by packed tarball only, vendored under `vendor/`.

## Consequences

* Mimir has no notion of tickets, specs or harnesses, and Sindri has no notion of HerdR sessions.
* An ESLint `no-restricted-imports` rule enforces the boundary (see the root `eslint.config.js`).
* Refreshing a dependency is an explicit act: re pack, copy the tarball into `vendor/`, `pnpm install`.
