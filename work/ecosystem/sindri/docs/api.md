# HTTP API

Source: the routes registered by `buildServer` (`apps/server/src/app.ts` and `apps/server/src/routes/`). The list below was taken from Fastify's `printRoutes()` on the built server, so every route the server serves is here.

## Conventions

* Base `http://127.0.0.1:7800`. Loopback only unless `SINDRI_ALLOW_REMOTE=1` with TLS.
* Every `/v1/*` route except `GET /v1/health` needs `Authorization: Bearer <token>` (`sindri token show`).
* `POST`, `PUT` and `DELETE` need an `Idempotency-Key` header (422 `idempotency_key_required` otherwise), except `POST /v1/approval-session`, whose response holds a secret and is never stored, and the read-only `POST /v1/guide/ask`. The same key with the same request replays the stored response with `Idempotency-Replayed: true`; the same key with a different request is 409 `idempotency_mismatch`; a request still running is 409 `idempotency_in_progress`; 5xx outcomes release the key.
* Approvals (spec approve, plan approve, PR request) also need `X-Sindri-Approval: <approval secret>` from `POST /v1/approval-session`, which trades the pairing code printed by `sindri start` for a secret. Without it: 403 `approval_required`.
* A request with an `Origin` outside the allowlist gets 403 `origin_forbidden`; a non loopback `Host` gets 403 `host_forbidden`.
* Errors use `{ "error": { "code", "message", "details?" } }`. JSON responses (except settings) are display sanitized server side: markup is stripped and strings are cut at 64 KB. The one exception inside a response is the `patch` field of `GET /v1/deliveries/:id/local`, which is served byte for byte so it applies; render it as text.
* A failed LLM provider call is 503 `provider_unavailable` (`provider_unavailable`, `auth`, `rate_limited`) or 503 `provider_error` (`timeout`, `invalid_output`, `refused`, `api_error`). The message names the cause in brackets, and `details.reason`, when present, is the end of what the provider's CLI reported, with secrets redacted.

| Status | Codes                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`                                                                                                |
| 403    | `origin_forbidden`, `host_forbidden`, `approval_required`, `approval_pairing_failed`                          |
| 404    | `not_found`                                                                                                   |
| 409    | `invalid_state`, `idempotency_*`, `invalid_plan`, `submission_mismatch`                                       |
| 422    | `validation_failed`, `invalid_json`, `idempotency_key_required`, `confirmation_required`, `no_connector`, `local_only` (settings) |
| 429    | `approval_locked` (too many wrong pairing codes; restart the server), `rate_limited` (Guide)                  |
| 501    | `not_supported` (harness install, pin, verify: Brokkr operations)                                             |
| 502    | `mimir_error` (Mimir answered with a local delivery result Sindri cannot read)                                |
| 503    | `local_only`, `mimir_unavailable` (not configured or not reachable), `mimir_error`, `provider_unavailable`, `provider_error`, `not_connected` |
| 500    | `internal`                                                                                                    |

## Server, approvals, settings

| Method | Path                    | Body or query                          | Response                                                                                   |
| ------ | ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/v1/health`            | none (no auth)                         | `{status:"ok"}`                                                                            |
| GET    | `/v1/capabilities`      |                                        | `{serverVersion, features:{mimir, brokkr}}` (configured, not probed)                       |
| POST   | `/v1/approval-session`  | `{pairingCode, channel:"web"\|"cli"}`  | 201 `{approvalSecret, principal, expiresAt}`; 403 wrong code; 429 locked                   |
| GET    | `/v1/settings`          |                                        | `{settings, tokenLocation}`                                                                |
| PUT    | `/v1/settings`          | full settings object, strict           | `{settings}`; 422 `local_only` for a remote provider or non loopback Mimir with local only on. A changed Mimir target stops runs on the old connection and resumes them on the new one |
| GET    | `/v1/export`            |                                        | `application/zip` with `sindri.db`, `settings.json`, `manifest.json`                       |
| GET    | `/v1/mimir/status`      |                                        | `{configured, url, tokenSecret, blocked, reachable, serverVersion, error}`                 |
| GET    | `/v1/feedback-graph/status` |                                    | `{configured, enabled, url, reachable, error}`; `reachable` is null when not configured, disabled or blocked ([feedback-graph.md](feedback-graph.md)) |

## Projects, intake, director, specs, knowledge

| Method | Path                          | Body or query                                      | Response                                                                                 |
| ------ | ----------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| POST   | `/v1/projects`                | `{name, repoPath}` (absolute existing directory)   | 201 `{project}`                                                                          |
| GET    | `/v1/projects`                |                                                    | `{projects}`                                                                             |
| GET    | `/v1/projects/:id`            |                                                    | `{project}`                                                                              |
| POST   | `/v1/projects/:id/bootstrap`  | `{}`                                               | `{result}` (indexed, unchanged, removed, skipped, secretsDropped, unsafeGitConfig?)      |
| GET    | `/v1/projects/:id/search`     | `?q=&limit=`                                       | `{hits}`                                                                                 |
| GET    | `/v1/projects/:id/feedback-graph` |                                                | `{link:{projectKey, source:"auto"\|"override"\|"none"}, lessons:[{id, title, rule, appliesWhen, paths, status, injectionDetected}], error}`; 404 unknown project ([feedback-graph.md](feedback-graph.md)) |
| PUT    | `/v1/projects/:id/feedback-graph` | `{projectKey: string\|null}` (`null` clears the override) | same as GET; 422 unless the key starts with a letter, digit or `_`, then only letters, digits, `_`, `.` or `-` (at most 200) |
| DELETE | `/v1/projects/:id/data`       | `{confirm:"<project name>", eraseEvidence?:true}`  | `{deleted:{projectId, evidenceErased?}}`; 422 wrong confirm; 409 task evidence without `eraseEvidence` |
| POST   | `/v1/intakes`                 | `{projectId, title, body}`                         | 201 `{intake}`                                                                           |
| POST   | `/v1/intakes/import`          | `{projectId, url}`                                 | 201 `{intake}`; 503 `local_only`; 422 `no_connector`                                     |
| GET    | `/v1/intakes`                 | `?projectId=`                                      | `{intakes}`                                                                              |
| GET    | `/v1/intakes/:id`             |                                                    | `{intake, comments}`                                                                     |
| POST   | `/v1/director/draft`          | `{projectId, intakeId?, request}`                  | 201 `{spec, meta, context[], analysis}`                                                  |
| GET    | `/v1/specs`                   | `?projectId=`                                      | `{specs}` (all versions)                                                                 |
| GET    | `/v1/specs/diff`              | `?from=&to=`                                       | `{diff}`                                                                                 |
| GET    | `/v1/specs/:id`               |                                                    | `{spec, meta, lineage[]}`                                                                |
| GET    | `/v1/specs/:id/questions`     |                                                    | `{questions}` (blocking only)                                                            |
| POST   | `/v1/specs/:id/answer`        | `{questionId, answer, author?}`                    | 201 `{spec, meta}` (a revised version)                                                   |
| GET    | `/v1/specs/:id/render`        |                                                    | `{markdown}`                                                                             |
| POST   | `/v1/specs/:id/submit`        | `{}`                                               | `{spec}`; 409 `invalid_state` when the spec has no acceptance criteria                   |
| POST   | `/v1/specs/:id/approve`       | `{}` + `X-Sindri-Approval`                         | `{spec}` (approver is the approval session's principal); 409 while blocking questions remain or the spec has no acceptance criteria |
| POST   | `/v1/specs/:id/revise`        | `{title?, body?}`                                  | 201 `{spec}`                                                                             |
| GET    | `/v1/knowledge`               | `?projectId=&q=`                                   | `{entries}` (each with `sources`)                                                        |
| POST   | `/v1/knowledge`               | `{projectId, claim, sourceRefs (>=1), confidence}` | 201 `{entry}`                                                                            |
| POST   | `/v1/knowledge/:id/retract`   | `{reason}`                                         | `{entry}`; 409 if already retracted                                                      |
| POST   | `/v1/knowledge/:id/supersede` | `{claim, sourceRefs, confidence}`                  | 201 `{entry}`; 409 if the entry is not valid                                             |
| GET    | `/v1/knowledge/:id/history`   |                                                    | `{history}`                                                                              |

## Plans and harnesses

| Method | Path                           | Body or query                                                   | Response                                                    |
| ------ | ------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/v1/plans/propose`            | `{specId}` (an approved spec)                                   | 201 `{plan, versions, harnessSource}`                       |
| GET    | `/v1/plans`                    | `?projectId=` or `?specId=`                                     | `{plans}`                                                   |
| GET    | `/v1/plans/:id`                |                                                                 | `{plan, versions}`                                          |
| GET    | `/v1/plans/:id/versions`       |                                                                 | `{versions}`                                                |
| GET    | `/v1/plans/:id/dry-run`        |                                                                 | `{dryRun}`                                                  |
| POST   | `/v1/plans/:id/submit`         | `{}`                                                            | `{plan}`                                                    |
| POST   | `/v1/plans/:id/approve`        | `{}` + `X-Sindri-Approval`                                      | `{plan}`                                                    |
| POST   | `/v1/plans/:id/revise`         | `{tasks:[PlanTask]}`                                            | 201 `{plan, versions}`                                      |
| GET    | `/v1/harnesses`                |                                                                 | `{source, harnesses}` (`fake` fixtures unless Brokkr is enabled) |
| GET    | `/v1/harnesses/repo-signals`   | `?projectId=`                                                   | `{source, signals}`                                         |
| GET    | `/v1/harnesses/:name`          |                                                                 | `{source, name, versions}`                                  |
| POST   | `/v1/harnesses/explain`        | `{projectId?, task, profile? \| harnesses?}`                    | `{source, selection, explanation}`                          |
| POST   | `/v1/harnesses/install`        |                                                                 | 501 `not_supported` (Brokkr)                                |
| POST   | `/v1/harnesses/:name/pin`      |                                                                 | 501 `not_supported` (Brokkr)                                |
| POST   | `/v1/harnesses/:name/verify`   |                                                                 | 501 `not_supported` (Brokkr)                                |

## Executions, reviews, deliveries

Executions need a configured Mimir (503 `mimir_unavailable` or `local_only` otherwise).

| Method | Path                                             | Body or query                                                     | Response                                                                 |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/v1/executions`                                 | `{planId}` (an approved plan)                                     | 201 execution view: `{execution, tasks, approvals, artifacts, plan, links, gates, running}`. A plan version that already has an open execution returns that one, also for concurrent requests. An execution of the same plan lineage that is `replan_requested` is cancelled first (see below) |
| GET    | `/v1/executions`                                 | `?projectId=`                                                     | `{executions}`                                                           |
| GET    | `/v1/executions/:id`                             |                                                                   | execution view (as above)                                                |
| GET    | `/v1/executions/:id/events`                      | `?follow=1&after=`; `Last-Event-ID`                               | `text/event-stream` of stored notices (read only)                        |
| GET    | `/v1/changes`                                    |                                                                   | `text/event-stream`: `changed {version}` on connect and after any write, so open pages refresh (no record data; read only) |
| POST   | `/v1/executions/:id/approvals/:approvalId`       | `{decision:"approved"\|"rejected", reason?}`                      | `{approval, execution}` (relayed to Mimir; a human decision)             |
| POST   | `/v1/executions/:id/escalations/:planTaskId`     | `{decision:"retry"\|"skip"\|"replan"\|"abort", reason}`           | execution view; 409 `invalid_state` once the execution has finished      |
| POST   | `/v1/executions/:id/cancel`                      | `{reason?}`                                                       | execution view with `execution.status: "cancelled"`; 409 `invalid_state` when the execution has already finished; 404 unknown id |
| POST   | `/v1/executions/:id/assess`                      | `{}`                                                              | `{gates}`                                                                |
| POST   | `/v1/executions/:id/pr`                          | `{}` + `X-Sindri-Approval`                                        | `{pr}`; 409 `invalid_state` until every task's quality gate passed       |
| GET    | `/v1/reviews`                                    | `?projectId=`                                                     | `{deliveryService, approvals, escalations, budgetAlerts, gateFailures, findings}`; `escalations` lists open executions only |
| GET    | `/v1/deliveries`                                 | `?projectId=`                                                     | `{deliveries}`                                                           |
| GET    | `/v1/deliveries/:id`                             | `:id` is the execution id                                         | `{report, prDescription, deliveryService}`; 409 while running            |
| GET    | `/v1/deliveries/:id/trace`                       |                                                                   | `{trace}`: ticket, spec version, plan version, mission, tasks with events and artifacts |
| GET    | `/v1/deliveries/:id/local`                       |                                                                   | `{result}`: `null`, or `{baseSha, resultCommit, patch, repoPath, apply, undo}` from Mimir's local delivery. `patch` is not display sanitized; 502 `mimir_error` when the stored result is unreadable |
| POST   | `/v1/deliveries/:id/rework`                      | `{feedback}` (1 to 20000 characters)                              | 201 `{rework, spec, meta}`: a draft spec tied to the delivery's verified result commits. 409 `invalid_state` when the delivery has no result commit, or while an earlier rework spec is unapproved (`details: {reworkId, specId, specLineageId}`). 500 with `details: {specId, specLineageId}` when the spec was drafted but its link could not be saved: do not approve that spec |
| GET    | `/v1/deliveries/:id/reworks`                     |                                                                   | `{reworks}`: each `{id, projectId, sourceExecutionId, specLineageId, baseCommits, feedback, createdAt, specs:[{id, version, status, title}]}` |

Intake responses omit the raw snapshot and add a sanitized `display` view. Settings hold secret names only, never values.

### How a run ends

An execution is final in `verified_pending_review`, `cancelled` or `failed`.

* `failed`: Mimir ended the mission as failed (`mission.failed`). Nothing more can be decided on it.
* `cancelled`: an escalation was answered with `abort`, the mission was cancelled in Mimir, or the run was cancelled through `POST /v1/executions/:id/cancel`. That route works in every open status (running, awaiting a human, blocked, replan requested). It cancels the Mimir mission (a mission that has already ended counts as stopped), closes open inbox items, marks pending approvals `expired`, and stores an `execution_cancelled` event with the actor and reason. The bearer token is enough, as for `abort`.
* `replan_requested` is not final. The run continues when a revised plan of the same plan lineage (`POST /v1/plans/:id/revise`, then approve) is executed: `POST /v1/executions` for that plan cancels the old mission and closes the old execution as `cancelled`, with the reason `superseded by revised plan <id> (version <n>)` in its `execution_cancelled` event. A plan proposed anew for the spec is a different lineage and leaves the old run open; cancel that one explicitly.

## Delivery knowledge proposals

* `GET /v1/deliveries/:id/proposals`: list evidence backed proposals.
* `POST /v1/deliveries/:id/proposals`: generate proposals after completed delivery; approval factor required.
* `POST /v1/deliveries/:id/proposals/:proposalId/decision`: accept/reject with the approval factor.

## Steward

The steward's decision log, modes, notes and guidance ([steward.md](steward.md)). A `Decision` is
`{id, projectId, type, subject:{kind, id, label}, inputs:[{kind, ref, summary}], recommendation:{value, detail?}, reasoning, confidence, mode, status, outcome, reversible, notes, createdAt, decidedAt, appliedValue, error}`.

| Method | Path                                     | Body or query                                                       | Response                                                                                   |
| ------ | ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/v1/steward/status`                     |                                                                     | `{running, types:[{type, mode, autoAllowed, stats}], feedbackGraph}`                        |
| PUT    | `/v1/steward/modes`                      | `{type, mode:"off"\|"recommend"\|"auto"}` + `X-Sindri-Approval`     | `{types}`; 422 `validation_failed` for `auto` on `spec.approve` or `plan.approve`          |
| POST   | `/v1/steward/pause`                      | `{}`                                                                | status (as `GET /v1/steward/status`)                                                       |
| POST   | `/v1/steward/resume`                     | `{}`                                                                | status                                                                                     |
| GET    | `/v1/steward/decisions`                  | `?projectId=&type=&status=&limit=&before=` (`before`: a decision id or ISO time) | `{decisions}`, newest first (limit default 50, at most 500)                     |
| GET    | `/v1/steward/decisions/:id`              |                                                                     | `{decision}` with `history:[{action, actor, detail, createdAt}]`                            |
| POST   | `/v1/steward/decisions/:id/accept`       | `{value?}` (an edited value makes it `changed`)                     | `{decision}`; performs the value. `spec.approve`/`plan.approve` need `X-Sindri-Approval`. 409 when not pending or no recommendation yet; 422 for a value outside the type's values |
| POST   | `/v1/steward/decisions/:id/reject`       | `{reason?}`                                                         | `{decision}`; 409 when not pending                                                          |
| POST   | `/v1/steward/decisions/:id/rollback`     | `{reason}`                                                          | `{decision}` (`rolled_back`); 409 `invalid_state` when not applied, not reversible, or the subject moved on (for example a later spec version was approved or planned) |
| POST   | `/v1/steward/decisions/:id/notes`        | `{text}`                                                            | `{decision}`                                                                                |
| GET    | `/v1/steward/notes`                      | `?projectId=` (that project's notes and the global ones; without it, all) | `{notes}`, newest first                                                              |
| POST   | `/v1/steward/notes`                      | `{projectId: string\|null, text}` (`null` is a global note)         | 201 `{note}`; 404 unknown project                                                          |
| GET    | `/v1/steward/guidance`                   | `?projectId=`                                                       | `{guidance:[{id, projectId, type, rule, decisionIds, status, entryId, decidedBy, decidedAt, reason, createdAt}]}` |
| POST   | `/v1/steward/guidance/:id/decision`      | `{decision:"accepted"\|"rejected", reason?}` + `X-Sindri-Approval`  | `{guidance}`; accepting records task evidence and a knowledge entry; 409 when already decided |

## Guide

The read-only Guide answers an operator's question from the factory docs (`BuildServerOptions.docs`, a `DocsSource`; without it the answer says the docs are not installed) and a redacted snapshot of the factory state: per project, counts by status of specs, plans, runs and deliveries, waiting approval requests, pending steward decisions, open escalations and budget blocks, with titles only. Ticket titles and labels go to the provider in data blocks, with injected instructions removed. It has no tools and calls no mutating service; links point at the screen where the operator acts.

| Method | Path            | Body or query                                                                                                   | Response                                                                                                                                                       |
| ------ | --------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/guide/ask` | `{question (1-2000 chars), context?:{app:"sindri"\|"heimdall"\|"mimir"\|"skidbladnir", screen?, projectId?}}`; no `Idempotency-Key`; optional `X-Guide-Client` (1-128 chars of `A-Za-z0-9_-`) gives each client behind a shared token its own rate-limit bucket | `{answer (markdown), links:[{label, href}], sources}`. `href` is a Sindri web hash route (`#/reviews?project=…&execution=…`), only to real views and ids in the snapshot; `sources` are `docs:<slug>`, `glossary:<term>`, `state`. 422 `validation_failed` (bad body or `X-Guide-Client`; neither counts against the limit); 429 `rate_limited` (30 per minute per token and `X-Guide-Client`, with `Retry-After`); 503 `provider_unavailable` / `provider_error` |

Web app routes `GET /` and `GET /*` are public when started with `sindri start`; static responses
set nosniff, and unmatched `/v1/*` requests remain API errors.
