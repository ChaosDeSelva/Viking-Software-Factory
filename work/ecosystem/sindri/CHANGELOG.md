# Changelog

## Unreleased

Added:

- Work kinds: intakes carry `workKind` (`change`, `research`, `pr_review`), plus `notes` and `skillIds`; the planner, gates and delivery report branch on it. The director's investigation kind only suggests `research` (`meta.suggestedWorkKind`).
- Research: a read only investigator document task (web only when allowed) and an optional fact-check reviewer; gates `research-document`, `research-sources`, `research-citations`, `research-file-sources`, `research-source-policy`; `POST /v1/executions/:id/accept`, `/reject` (approval secret) and `/follow-up`.
- PR review: GitHub pull request import through the operator's `gh` (`GET /v1/github/status`), a factory-owned review mirror under `<dataDir>/review-mirrors/`, reviewer and security reviewer tasks, gates `pr-review-schema` and `pr-review-markdown`, findings mapped to hunks against the merge base, an editable draft (`GET`/`PUT /v1/executions/:id/review`), `GET .../review/preview` with a leak check, and `POST .../review/post` (approval secret) with a marker-based duplicate guard.
- Skills library (`/v1/skills`: import, re-import, delete, changed and missing on disk) and project guidance (`/v1/projects/:id/guidance`: standing notes, default skills). Plans record guidance digests; briefs get an operator guidance block capped at 48 KB.
- Web UI: kind switch in the Inbox (Change, Research, Review a PR), research document and PR review views on deliveries, Settings → Skills, Project settings → Guidance.
- Error codes: `not_exportable`, `already_decided`, `already_posted`, `post_in_progress`, `pr_head_moved`, `pr_changed_since_plan`, `gates_not_passed`, `project_required`, `post_blocked`, `mirror_failed`, `github_error`.
- `@mimir/sdk` and `@mimir/protocol` 0.4.0 (task modes), `@factory/ui` 0.1.9.

## 0.1.0 (unreleased)

Local recovery build integrates the demo, acceptance workflow and installable packaging. No remote release has been published.

Added:

- Real Brokkr SDK harness selection with preserved task verification locks.
- Delivery approval reconciliation and sourced knowledge proposal routes/UI.
- Full factory acceptance, packaged smoke checks and a separate real Codex repair verification.

- Project bootstrap and context index with secret, size, binary and symlink protections, plus search.
- Manual intake and read only Jira and Linear connectors using SecretStore handles.
- Versioned specifications with approval and diff.
- Provider neutral director (Anthropic, fake and null providers) with injection detection and nonce delimited untrusted text.
- Project knowledge with sources, retraction, supersession and history.
- Task planner with dependency graph and harness selection through a `HarnessService` interface.
- Mimir client facade over `@mimir/sdk` 0.2.0 (protocol 1) and a delivery loop library.
- Fastify server with bearer auth, origin and host checks, idempotency and export.
- Web UI for projects, inbox, director, specs, knowledge and settings, with axe accessibility checks.
- CLI: `init`, `doctor`, `start`, `export`, `token show`; working fixture based `demo`.
- ADRs 001-009 and the documentation set in `docs/`.

Known gaps: see `docs/limits.md`.
