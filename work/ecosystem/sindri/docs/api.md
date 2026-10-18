# HTTP API

Source: the routes registered by `buildServer` (`apps/server/src/app.ts` and `apps/server/src/routes/`). The list below was taken from Fastify's `printRoutes()` on the built server, so every route the server serves is here.

## Conventions

* Base `http://127.0.0.1:7800`. Loopback only unless `SINDRI_ALLOW_REMOTE=1` with TLS.
* Every `/v1/*` route except `GET /v1/health` needs `Authorization: Bearer <token>` (`sindri token show`).
* `POST`, `PUT` and `DELETE` need an `Idempotency-Key` header (422 `idempotency_key_required` otherwise), except `POST /v1/approval-session`, whose response holds a secret and is never stored. The same key with the same request replays the stored response with `Idempotency-Replayed: true`; the same key with a different request is 409 `idempotency_mismatch`; a request still running is 409 `idempotency_in_progress`; 5xx outcomes release the key.
* Approvals (spec approve, plan approve, PR request) also need `X-Sindri-Approval: <approval secret>` from `POST /v1/approval-session`, which trades the pairing code printed by `sindri start` for a secret. Without it: 403 `approval_required`.
* A request with an `Origin` outside the allowlist gets 403 `origin_forbidden`; a non loopback `Host` gets 403 `host_forbidden`.
* Errors use `{ "error": { "code", "message", "details?" } }`. JSON responses (except settings) are display sanitized server side.

| Status | Codes                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| 401    | `unauthorized`                                                                                                |
| 403    | `origin_forbidden`, `host_forbidden`, `approval_required`, `approval_pairing_failed`                          |
| 404    | `not_found`                                                                                                   |
| 409    | `invalid_state`, `idempotency_*`, `invalid_plan`, `submission_mismatch`                                       |
| 422    | `validation_failed`, `invalid_json`, `idempotency_key_required`, `confirmation_required`, `no_connector`, `local_only` (settings) |
| 429    | `approval_locked` (too many wrong pairing codes; restart the server)                                          |
| 501    | `not_supported` (harness install, pin, verify: Brokkr operations)                                             |
| 503    | `local_only`, `mimir_unavailable`, `provider_unavailable`, `provider_error`, `not_connected`                  |
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

## Projects, intake, director, specs, knowledge

| Method | Path                          | Body or query                                      | Response                                                                                 |
| ------ | ----------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| POST   | `/v1/projects`                | `{name, repoPath}` (absolute existing directory)   | 201 `{project}`                                                                          |
| GET    | `/v1/projects`                |                                                    | `{projects}`                                                                             |
| GET    | `/v1/projects/:id`            |                                                    | `{project}`                                                                              |
| POST   | `/v1/projects/:id/bootstrap`  | `{}`                                               | `{result}` (indexed, unchanged, removed, skipped, secretsDropped, unsafeGitConfig?)      |
| GET    | `/v1/projects/:id/search`     | `?q=&limit=`                                       | `{hits}`                                                                                 |
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
| POST   | `/v1/specs/:id/submit`        | `{}`                                               | `{spec}`                                                                                 |
| POST   | `/v1/specs/:id/approve`       | `{}` + `X-Sindri-Approval`                         | `{spec}` (approver is the approval session's principal); 409 while blocking questions remain |
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
| POST   | `/v1/executions`                                 | `{planId}` (an approved plan)                                     | 201 execution view: `{execution, tasks, approvals, artifacts, plan, links, gates, running}` |
| GET    | `/v1/executions`                                 | `?projectId=`                                                     | `{executions}`                                                           |
| GET    | `/v1/executions/:id`                             |                                                                   | execution view (as above)                                                |
| GET    | `/v1/executions/:id/events`                      | `?follow=1&after=`; `Last-Event-ID`                               | `text/event-stream` of stored notices (read only)                        |
| POST   | `/v1/executions/:id/approvals/:approvalId`       | `{decision:"approved"\|"rejected", reason?}`                      | `{approval, execution}` (relayed to Mimir; a human decision)             |
| POST   | `/v1/executions/:id/escalations/:planTaskId`     | `{decision:"retry"\|"skip"\|"replan"\|"abort", reason}`           | execution view                                                           |
| POST   | `/v1/executions/:id/assess`                      | `{}`                                                              | `{gates}`                                                                |
| POST   | `/v1/executions/:id/pr`                          | `{}` + `X-Sindri-Approval`                                        | `{pr}`; 409 `invalid_state` until every task's quality gate passed       |
| GET    | `/v1/reviews`                                    | `?projectId=`                                                     | `{deliveryService, approvals, escalations, budgetAlerts, gateFailures, findings}` |
| GET    | `/v1/deliveries`                                 | `?projectId=`                                                     | `{deliveries}`                                                           |
| GET    | `/v1/deliveries/:id`                             | `:id` is the execution id                                         | `{report, prDescription, deliveryService}`; 409 while running            |
| GET    | `/v1/deliveries/:id/trace`                       |                                                                   | `{trace}`: ticket, spec version, plan version, mission, tasks with events and artifacts |

Intake responses omit the raw snapshot and add a sanitized `display` view. Settings hold secret names only, never values.

## Delivery knowledge proposals

* `GET /v1/deliveries/:id/proposals`: list evidence backed proposals.
* `POST /v1/deliveries/:id/proposals`: generate proposals after completed delivery; approval factor required.
* `POST /v1/deliveries/:id/proposals/:proposalId/decision`: accept/reject with the approval factor.

Web app routes `GET /` and `GET /*` are public when started with `sindri start`; static responses
set nosniff, and unmatched `/v1/*` requests remain API errors.
