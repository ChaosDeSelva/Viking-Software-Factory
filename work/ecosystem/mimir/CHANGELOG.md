# Changelog

All notable changes are recorded here. Format follows Keep a Changelog.

## [Unreleased]

## [0.3.0] - 2026-11-10

`@mimir/protocol` and `@mimir/sdk` 0.3.0 (wire protocol stays 1; additive).

### Added

- `PATCH /v1/crews/{id}/budget` and `PATCH /v1/missions/{id}/budget` (`UpdateBudgetRequest`,
  `UpdateBudgetResponse`) merge limits onto the scope's budget or create one; tasks blocked only
  by that budget resume on the next scheduler tick. New event `budget.updated`
  (`{budget, previous}`).
- SDK `crews.updateBudget(id, body, options?)` and `missions.updateBudget(id, body, options?)` for
  `PATCH /v1/crews/{id}/budget` and `PATCH /v1/missions/{id}/budget` (idempotency key like other
  mutations, response validated with `UpdateBudgetResponse`); fake server routes and `contracts/`
  fixtures for both.
- Cached-token accounting: `UsageSample.cachedTokens` and `UsageTotals.cachedTokens` record
  prompt-cache reads apart from `tokens`; they are not counted against budgets.
- Verification that waits for a free worker queues the next attempt without a failure (task machine
  event `verification_deferred`); `task.retried` carries `deferred: "awaiting_capacity"` then.
- Schemas also carry `UpdateProjectRequest`/`UpdateProjectResponse`,
  `CreateMissionRequest.baseCommits` and `ProjectSettings.agent` (`env`, `pathPrepend`,
  `codexSandbox`).

### Fixed

- Fake server budgets match the real server: `PATCH .../budget` and a `budget` at mission or crew
  creation answer 422 `budget_on_unknown_required` for a hard budget without `onUnknown` while the
  runtime reports no usage (option `runtimeReportsUsage`, default false), and a creation budget is
  the one `PATCH` merges onto (same id, version bumped).

## [0.2.0] - 2026-10-21

### Added

- Task bound inline verification locks; uncommitted changes included in verification diff evidence.
- Per attempt command approvals, explicit argv policy checks, and blocked state recovery after denied verification.
- `@mimir/protocol` and `@mimir/sdk` 0.2.0 (wire protocol stays 1; additive, see
  `docs/protocol-compatibility.md`): `POST /v1/tasks/{id}/pr` in the contract and OpenAPI
  (`RequestPrRequest`, `RequestPrResponse`), SDK `tasks.requestPr`, fake server route, and
  `contracts/` fixtures (request/response JSON and JSON Schemas per operation) in the SDK tarball.
- Verification input carries `taskId`, `missionId`, `baseRef` and the observed `headSha`.
- Verifying step collects `<worktree>/.mimir/artifacts/` (bounded, no symlinks, redacted) as
  `review`, `screenshot`, `test.output` and `file` artifacts; new events
  `artifact.collection_skipped` and `artifact.collection_truncated`; artifact kind `file`.
- `@mimir/brokkr-verifier`: Brokkr verification through the vendored `@brokkr/sdk` 0.1.0
  (`vendor/brokkr/`), `workspace-untrusted`, contract from `ProjectSettings.verification`
  (lock required), run evidence and signing key under the data dir, nothing written in the
  worktree;
  fails closed for configured contracts when the SDK is missing.
  See `docs/verification.md`.
- `mimir start` runs the server and serves the built web app on the same origin (`MIMIR_WEB_ROOT`; SPA fallback, no directory listing, content types, confined to the web root, auth unchanged). It reads host and port from `config.json`.
- `mimir demo` creates a temp repo with a passing `testCommand`, a shell crew and a 3-task mission on the fake runtime, prints the URL, mission id and token file, and cleans up on exit. Nothing is auto approved.
- Server: missions, crews, tasks, approvals, sessions, artifacts, PR requests, usage and attention routes with the orchestrator (merged from T12), and exact allowlist command gate (ADR-014).

### Changed

- `docs/api.md` is regenerated: every contract route is served, with the five extra routes listed. Threat model, limits, getting started, troubleshooting and issue index refreshed from the code.
- `SECURITY.md` asks for reports as a file under `docs/issues/` marked `security` (no personal email).
- `docs/licenses.md` records `lightningcss` (dev only MPL-2.0).

### Fixed

- `pnpm format:check` passes again (`apps/cli/vitest.config.ts`, `packages/core/src/redaction.ts`).

## [0.1.0] - 2026-10-14

First local release. The 0.1.0 tarball predates the orchestration merge: see 0.2.0 for what the server serves now, and `docs/limits.md` for what is still missing.

### Added

- Protocol: Zod schemas, generated OpenAPI and JSON Schema (`@mimir/protocol` 0.1.0).
- SDK: typed client with SSE streaming (`@mimir/sdk` 0.1.0), packed by `pnpm release:local`.
- Durable SQLite event store (WAL, single writer lock, read only open, redaction, bounded payloads).
- Fake runtime, mission and task state machines, scheduler, leases, budgets, escalation.
- Policy engine: command classifier, deny by default evaluation, human only approvals, untrusted text detection.
- HerdR adapter (verified against HerdR 0.9.4) and git worktree manager with path and config hardening.
- Server API: health, capabilities, snapshot, projects, event replay and live SSE; bearer auth, Origin/Host checks, idempotency keys.
- Web app (React, Vite, Tailwind) with Playwright and axe accessibility tests.
- CLI: `mimir init`, `doctor`, `token show`, `export`; `start` and `demo` were placeholders in this entry (implemented under Unreleased).
- `pnpm release:local` and `scripts/install-local.sh` (macOS arm64 tarball, shim in `~/.local/bin`).
- Docs: getting started, concepts, API reference, troubleshooting, limits, licenses, ADR-001..013, threat model, SECURITY, CODE_OF_CONDUCT, CONTRIBUTING.

### Notes

- Windows and Linux are untested. Pause and multi host are unavailable.

### Added

- Monorepo scaffold: pnpm workspaces, Turborepo, Vitest, ESLint, Prettier.
- `@mimir/server` with `GET /v1/health`; `@mimir/web` Vite + React + Tailwind shell.
- Placeholder packages: protocol, sdk, core, herdr adapter, fake runtime, git, telemetry, testing.
