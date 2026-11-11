# Concepts

This page describes the model Mimir implements. The authoritative definitions are the Zod
schemas in `packages/protocol/src`; [api](api.md) is generated from them.

## What Mimir is

Mimir commands crews of coding agents and records everything observable in a durable event log.
It does not plan work (a planner submits missions to it) and it does not run terminals (HerdR does).
Humans stay in control of merges, secrets and destructive operations.

## Entities

* **Project**: a git repository on this machine, registered with `POST /v1/projects`. Paths can be
  restricted with `MIMIR_ALLOWED_ROOTS`.
* **Mission**: a goal made of tasks. Status: `draft`, `active`, `paused`, `completed`, `cancelled`,
  `failed`.
* **Crew**: a named group of agents that works on a mission. Roles: `lead`, `implementer`,
  `reviewer`, `qa`, `investigator`. Status: `configured`, `running`, `stopped`, `archived`.
* **Task**: one unit of work with dependencies (a DAG). Status: `pending`, `ready`, `leased`,
  `running`, `verifying`, `completed`, `blocked`, `failed`, `cancelled`. A task is leased to one
  session at a time (`packages/core/src/domain/lease.ts`).
* **Session**: one agent or shell running in a HerdR pane. State: `requested`, `starting`,
  `idle`, `running`, `waiting`, `blocked`, `stopping`, `stopped`, `completed`, `failed`,
  `unknown`.
* **Worktree**: each task works in its own git worktree that Mimir creates and removes
  (`packages/git`). Agents never share a working directory.
* **Approval**: a human decision (`approved` or `rejected`) on a privileged action. Agents and
  system actors cannot approve, and nobody approves their own request.
* **Artifact**, **usage**: recorded outputs and token or cost samples.

## Events

Every state change is an event in an append only SQLite log (WAL mode). Event types are listed in
`EVENT_TYPES` (`packages/protocol/src/events.ts`): `mission.*`, `task.*`, `session.*`, `git.*`,
`approval.*`, `budget.*`, `policy.denied`, `recovery.*` and others.

* Ordering is **per stream** only. Mimir does not promise a global order.
* Clients read history with `GET /v1/events?cursor=...`, follow live with `GET /v1/events/stream`
  (Server Sent Events), and bootstrap with `GET /v1/snapshot`, which returns the full read model
  plus a cursor to resume from. Subscribe, then snapshot, then replay from the snapshot cursor, so
  nothing is missed.
* Payloads are bounded and redacted before storage.

## Provenance and unknown

Runtime state comes only from HerdR's `agent_status` and is marked `observed`. Mimir never reads
terminal text to decide state. Values it computes are `derived`; model written text is
`summarized`. When Mimir cannot tell, the state is `unknown`, not a guess.

Usage has a source: `measured`, `estimated` or `unavailable`. Without agent hooks, measured usage
is unavailable.

## Budgets

A sample's `tokens` is what counts against a token budget: fresh input (prompt-cache writes
included) plus output. Input served from the provider's prompt cache is recorded as `cachedTokens`
and never counted. For the local CLIs (`apps/server/src/cli-runtime/adapter.ts`, `usageOfEvent`):

* Codex `exec --json`: the last `turn.completed` is the session total;
  `tokens = input_tokens - cached_input_tokens + output_tokens`, `cachedTokens = cached_input_tokens`.
* Claude `stream-json`: the `result` event is the session total;
  `tokens = input_tokens + cache_creation_input_tokens + output_tokens`,
  `cachedTokens = cache_read_input_tokens`. `estimatedCost` is Claude's `total_cost_usd`.

A hard budget that is exhausted blocks its ready tasks (`blockedReason: budget_exceeded`), appends
`budget.exceeded` once per budget version and shows a `budget_exceeded` item in `GET /v1/attention`.
The event payload says which budget and by how much:
`{ budgetId, scope: crew|mission|project, unit: tokens|cost, used, limit, overBy, budgetVersion }`
(the envelope carries `missionId` and `crewId`). The operator resolves it with
`PATCH /v1/crews/{id}/budget` or `PATCH /v1/missions/{id}/budget` (SDK `crews.updateBudget`,
`missions.updateBudget`;
`{ limitTokens?, limitCost?, warnAtFraction?, enforce?, onUnknown?, expectedVersion? }`, a limit is
positive and bounded, `null` removes it). That appends `budget.updated` `{ budget, previous }`, and
the scheduler returns the blocked tasks to `ready` on its next tick.

## Policy

Shell commands and other actions are classified, then evaluated deny by default:
`allow`, `deny` or `require_approval` (`packages/core/src/policy`). Free text from agents,
repositories or tools never changes a decision.

## Auth

Loopback bind by default. Every request except `GET /v1/health` needs `Authorization: Bearer <token>`,
including unknown paths (401 before 404). The check runs on the route the router dispatched to, so
percent encoded or dot segment spellings of a path cannot skip it.
The token lives in `~/.mimir/auth-token` (mode 0600, at least 32 characters, never a symlink) or
`MIMIR_AUTH_TOKEN`; the data dir is forced to 0700. Agent worktrees live outside the data dir
(`~/.mimir-work/worktrees` by default) and the server refuses a worktree root inside it. Agents that
run as the operator's OS user can still read the token by absolute path; the policy classifier's
sensitive path list (`packages/core/src/sensitive-paths.ts`) is the gate for that, and running
agents as a separate OS user is the only hard boundary. See ADR-012.

## Server configuration

| Variable | Meaning | Default |
|---|---|---|
| `MIMIR_HOST` / `MIMIR_PORT` | listen address | `127.0.0.1` / `7700` |
| `MIMIR_DATA_DIR` | data directory (0700) | `~/.mimir` |
| `MIMIR_WORKTREE_ROOT` | agent worktrees; must be outside the data dir | `~/.mimir-work/worktrees` |
| `MIMIR_RUNTIME` | `fake` or `none` | `fake` |
| `MIMIR_AUTH_TOKEN` | override the token file | unset |
| `MIMIR_ALLOWED_ORIGINS` | extra origins allowed to call the API | Vite dev origins |
| `MIMIR_PUBLIC_ORIGINS` | origins clients reach the server at | derived from host and port |
| `MIMIR_ALLOWED_ROOTS` | restrict project `repoPath`s (`:` or `,` separated) | no restriction |
| `MIMIR_ALLOW_REMOTE`, `MIMIR_TLS_CERT`, `MIMIR_TLS_KEY` | non loopback bind requires all three | refused |
| `MIMIR_LOG_LEVEL` | pino level | `info` |

See also the [ADRs](adrs/README.md) and the [threat model](security/threat-model.md).
