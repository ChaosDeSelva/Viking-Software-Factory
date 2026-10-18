![Heimdall](site/assets/banner.png)

# Heimdall

An independent, Apache-2.0, local first command center for the software factory. Mimir owns execution; Sindri owns specifications, plans and delivery; Brokkr evidence comes through Mimir's artifact API. Heimdall uses their HTTP APIs and SSE streams. It does not access HerdR or edit another service's database.

## Start on this Mac

Double click **Start Heimdall.command** in this source directory. It starts the installed local factory and opens `http://127.0.0.1:4320`. Keep its Terminal window open. The terminal prints the Heimdall access token, operator code, and separate Sindri pairing code. Sign in, open **Connections**, unlock operator controls, and pair Sindri. Stop the services with Control C in that terminal.

This installed launcher expects the sibling `local-factory` directory. No GitHub account or remote repository is required. Codex and Claude Code model calls still need their configured network access and login.

## Independent installation

The `heimdall-local.tar.gz` release contains the built UI and server, with no runtime npm dependencies. Install Node.js 24 or newer, extract it, enter the extracted `heimdall` folder, and run:

```sh
node apps/server/main.mjs
```

The release's **Start Heimdall.command** does the same on macOS. Open `http://127.0.0.1:4320`, sign in using the terminal token, and unlock **Connections** to configure Mimir and optionally Sindri. Use each source's loopback origin and bearer token. **Test connection** checks authentication; **Save connection** persists it privately. Changing a connection clears its old cached events and requires fresh Sindri pairing. Configuration exports contain no credentials.

Environment configuration is also supported:

```sh
MIMIR_URL=http://127.0.0.1:7700 MIMIR_TOKEN_FILE=/absolute/path/to/mimir-token \
SINDRI_URL=http://127.0.0.1:4310 SINDRI_TOKEN_FILE=/absolute/path/to/sindri-token \
node apps/server/main.mjs
```

Token environment variables `MIMIR_TOKEN` and `SINDRI_TOKEN` are alternatives to token files. Saved connection settings take precedence. Optional variables: `HEIMDALL_PORT` (4320), `HEIMDALL_DATA_DIR` (`.heimdall`), and `HEIMDALL_TOKEN` (otherwise generated at startup). Source origins must be loopback HTTP. Never commit tokens or the state directory.

## Daily workflow

1. **New work:** register a local Git repository, bootstrap its context, save intake or draft a specification.
2. Open the specification to inspect requirements, answer questions, revise it, submit it for review and approve it. Flagged source instructions require an explicit acknowledgement for that specification.
3. Propose a plan. Open its editor to change objectives, priority, dependencies, inputs/outputs, acceptance criterion IDs, time/token/cost budgets and retry limits. Save a new revision, submit it, approve it, then **Start approved plan**.
4. Follow **Overview**, **Pipeline**, **Crews & agents**, and **Execution graph**. Click records for objectives, attempts, blockers, worktrees, plan mappings, evidence, activity and controls.
5. Use **Quality & approvals** for policy decisions, escalation recovery, gate assessments, local delivery exports and patch downloads. Human actions require a reason and show the source confirmed outcome.

## Interface and component library

React and Vite power the UI. Tailwind provides design tokens and utilities; reusable accessible components live in `apps/web/src/components`. Open `/?view=components` for the interactive catalog. Cmd/Ctrl-K searches navigation and records. A dedicated Web Worker computes dependency layouts; live source updates use SSE, and commands use authenticated HTTP.

See the [release plan](docs/factory-release-plan.md) and [Firstmate source audit](docs/firstmate-source-audit.md) for scope and provenance. Remote execution belongs to Mimir; Heimdall stays on loopback.

## Included capabilities

* Six monitoring screens plus New work, Notifications and Connections. Responsive dark/light UI, keyboard accessible inspectors, raw event drill down and searchable source/category/mission filters.
* Draggable, zoomable dependency graph with keyboard movement, automatic layout, saved per mission positions and a text dependency list. Scroll to pan; Alt + arrows move nodes; Enter opens details.
* Configurable pipeline stage order. Stage state remains source owned; moving presentation order does not move work through gates.
* Live agent output, structured tool call extraction, runtime observation freshness, session state and elapsed time. Unreported model, usage or heartbeat data stays unknown. Historical output remains available through source events/evidence.
* Mission pause/resume/cancel, crew scheduling pause/resume, graceful session stop, task retry, verification only rechecks, approval decisions and Sindri recovery/export controls.
* Deduplicated persistent notifications for failures, blockers, unavailable agents/sources, approvals, verification failures and deliveries. Read state survives restart. Desktop alerts are opt in and subject to browser/OS permission.
* Separate persisted SSE cursors, replay/deduplication, reconnect reconciliation, stale/disconnected labels, history gap notices and a bounded 20,000-event display cache.
* SHA-256-checked artifact previews for text, JSON, diffs and safe raster images up to 12 MB. Local patch download; no automatic patch application.
* Loopback binding, authenticated sessions, operator unlock, Sindri's separate human approval factor, CSRF/host checks, command allowlisting, idempotency receipts and local audit records.

## Control semantics

Crew pause prevents new scheduling for that crew; already running sessions continue. Use graceful stop on an agent when needed. Priorities apply to a newly approved plan execution, and dependencies take precedence. Existing executions are not rewritten by plan revisions.

**Re run verification only** runs the configured verifier on a settled task's existing worktree and records a fresh evidence artifact. It does not launch a coding agent or rewrite prior task acceptance/delivery. To accept changed code, revise and execute a plan. Source command policy still applies.

Mimir only monitoring works without Sindri. The new crew, live session and recheck endpoints require the updated Mimir included in this local factory. Older sources may reject those actions; Heimdall displays that rejection.

## Validation and boundaries

This is a local release candidate (`1.0.0-rc.1`). The implemented workflows have automated API/browser tests, source service regression checks and real history integration checks. See [verification](docs/verification.md) for exact evidence, fixture distinctions and remaining validation limits.

No multi day soak, manual screen reader certification or other OS installation test is claimed. Remote access, multi user roles, live terminal input injection, automatic patch application and OS level agent isolation are outside this local operator interface. A local operator code cannot protect against a hostile process running as the same OS user. Cost and token reporting retain source semantics.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:stress
pnpm release:local
node examples/demo.mjs
```

`pnpm test:integration` additionally exercises the real source APIs and browser plan editing when the built sibling sources exist under `../../work/ecosystem/` (the layout of this installation).

The demo uses explicitly synthetic data on port 4322. The runtime uses Node HTTP/SQLite; the UI uses React/TypeScript/Vite and a custom accessible graph. There is no mandatory hosted service. See [architecture and security](docs/architecture.md). This project has not been published to GitHub or a registry.

## Experimental release status

The planned public source tag is `v0.1.0`. See [release scope and setup](RELEASE-v0.1.0.md) for tested behavior and acceptance limits. Manual accessibility testing is pending. Vendor integrations without authenticated live acceptance remain experimental.
