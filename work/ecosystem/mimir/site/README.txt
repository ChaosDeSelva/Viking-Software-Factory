![Mimir](site/assets/banner.png)

# Mimir

Mission control for crews of coding agents: you set the work, Mimir runs it in isolated worktrees, and nothing privileged happens without a person saying yes.

License: Apache-2.0 · Status: pre release (0.1.0) · Node >= 25 · Local first, no telemetry

Mimir is the orchestration layer of the Viking software factory.

## What it is

Running several coding agents at once is easy. Keeping them from stepping on each other, knowing what each one did, stopping them safely, and recovering when your machine restarts is not. A terminal full of panes tells you very little about which task is blocked, which one is waiting for you, and which one quietly failed an hour ago.

Mimir has one job in the ecosystem: it commands crews. You create a project (a git repository on your machine), a mission (a goal made of tasks with dependencies), and one or more crews (groups of agents with roles). Mimir schedules tasks onto crews, gives every task its own git worktree, starts the agent session, watches it, asks a verifier to check the exact worktree when the agent finishes, and records everything it observes in a durable, replayable event log. People approve merges, secrets, and destructive commands. Agents cannot approve anything.

Mimir deliberately does not do several things. It does not plan: a planner (Sindri in this ecosystem) submits missions to it, and Mimir has no concept of tickets, specs, or quality harnesses. Execution uses an explicit runtime adapter: local headless CLI, managed or interactive terminals, Herdr, SSH workers, or a capacity aware fleet. Herdr integration remains isolated in `packages/herdr-adapter`. It does not judge quality: verification is delegated, and Mimir never overrides the verdict. It is not a hosted service, has no paid tier, and does not require a hosted control service. Agent model calls and explicitly configured SSH workers use their configured network connections.

## Runtime choices

Codex and Claude Code are the primary local harnesses. OpenCode, Gemini CLI and Pi have experimental headless profiles; their fixture tests do not establish authenticated vendor compatibility. Set `MIMIR_RUNTIME=cli`, `tmux`, `tmux-interactive`, `herdr`, `ssh`, or `fleet`. Zellij, cmux and Orca terminal bridges and additional interactive harness profiles are experimental. Durable supervisor inboxes and fleet drain controls are available through Heimdall. See [runtime setup and support](docs/runtime-support.md) for configuration, remote source limits, credential handling, and test coverage.

## Features

Each item below exists in the code on this branch.

* **Missions, crews, tasks.** Create and list them over HTTP; tasks form a dependency graph (`packages/core/src/domain/dag.ts`).
* **Task and mission state machines.** Explicit transitions with guards; illegal moves are rejected (`taskMachine.ts`, `missionMachine.ts`).
* **Scheduler with leases.** Ready tasks are leased to one session at a time; expired leases return to the pool.
* **Per task git worktrees.** Mimir creates and removes them (`packages/git`); agents never share a working directory.
* **Durable event log.** SQLite in WAL mode with SQL migrations, one writer per data directory, ordered per stream only.
* **Replay and live timeline.** `GET /v1/events` pages with a cursor; `GET /v1/events/stream` is Server Sent Events that resume from `Last-Event-ID`.
* **Idempotent mutations.** Every mutation needs an `Idempotency-Key`; replays return the original result.
* **Deny by default policy.** A command classifier uses an exact allowlist and fails closed; unfamiliar commands create an approval request.
* **Approvals.** List pending approvals and approve or reject them; approvals expire.
* **Verification step.** After the session exits, the task enters `verifying` and a test command (or an injected verifier) runs against the exact worktree.
* **Budgets and usage.** Token and cost samples are tagged `measured`, `estimated`, or `unavailable`; budgets can park tasks.
* **Restart recovery.** On boot Mimir reconciles with the runtime; a task whose session vanished becomes `blocked` with `unknown_after_restart` instead of being marked done.
* **Artifacts.** Diffs, changed file manifests, and test output are stored, size bounded, and redacted.
* **Redaction.** Secrets are redacted before storage and in `mimir export`.
* **Fake runtime.** `packages/fake-runtime` simulates sessions on a scripted clock, so you can run missions without HerdR or any model.
* **TypeScript SDK and web app.** `@mimir/sdk` (client with SSE reconnect) and a React web app with Missions, Crews, Activity, Reviews, and Agent Inspector screens.

## Quick start

### Requirements

* Node 25 or newer and pnpm 12.
* git 2.38 or newer.
* `jq` for the walkthrough below (optional otherwise).
* HerdR 0.9.0 or newer on `PATH` only if you want real agents. The fake runtime needs nothing else.
* macOS arm64 is the only platform exercised so far.

### Install

```sh
pnpm install
pnpm build
node apps/cli/dist/main.js --help
```

To produce the local release bundle and the two tarballs other repos consume (`@mimir/protocol`, `@mimir/sdk`):

```sh
pnpm release:local
bash scripts/install-local.sh dist/mimir-0.1.0-macos-arm64.tar.gz
```

This writes `dist/mimir-0.1.0-macos-arm64.tar.gz` and `dist-packages/*.tgz`, installs under `~/.mimir/app`, and puts a `mimir` shim in `~/.local/bin` (override with `MIMIR_APP_DIR` and `MIMIR_BIN_DIR`).

### Run

```sh
node apps/cli/dist/main.js init     # creates ~/.mimir, a 0600 auth token, config.json
node apps/cli/dist/main.js doctor   # checks node, pnpm, git, herdr, data dir
node apps/server/dist/main.js       # API on http://127.0.0.1:7700, fake runtime
```

For the web app during development, run `pnpm dev`: the server on `127.0.0.1:7700` and Vite on `127.0.0.1:5173`. The server does not serve the built web app yet.

Useful environment variables: `MIMIR_DATA_DIR` (default `~/.mimir`), `MIMIR_HOST` and `MIMIR_PORT` (default `127.0.0.1:7700`), `MIMIR_RUNTIME` (`fake` default, `herdr`, or `none`), `MIMIR_AUTH_TOKEN` (at least 16 characters, overrides the token file), `MIMIR_TICK_MS` (scheduler interval, default 1000), `MIMIR_ALLOWED_ROOTS` (restrict project paths), `MIMIR_ALLOWED_ORIGINS`.

### First task

With the server running on the fake runtime, this creates a sample repository, runs one shell task through the whole lifecycle, and approves the one privileged step.

```sh
export MIMIR_DATA_DIR=/tmp/mimir-demo
mkdir -p /tmp/mimir-sample && cd /tmp/mimir-sample && git init -q \
  && git -c user.name=demo -c user.email=demo@example.com commit -q --allow-empty -m init && cd -
TOKEN=$(node apps/cli/dist/main.js token show)
API=http://127.0.0.1:7700
call() { curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }

PROJECT=$(call -H "Idempotency-Key: p1" -d '{"name":"sample","repoPath":"/tmp/mimir-sample","settings":{"testCommand":["true"]}}' $API/v1/projects | jq -r .project.id)
MISSION=$(call -H "Idempotency-Key: m1" -d "{\"projectId\":\"$PROJECT\",\"objective\":\"say hello\",\"tasks\":[{\"title\":\"hello\",\"brief\":\"echo hello\"}]}" $API/v1/missions | jq -r .mission.id)
call -H "Idempotency-Key: c1" -d "{\"missionId\":\"$MISSION\",\"template\":\"solo\",\"members\":[{\"role\":\"implementer\",\"agentKind\":\"shell\"}]}" $API/v1/crews
call -H "Idempotency-Key: s1" -d '{}' $API/v1/missions/$MISSION/start
```

Within a few seconds the task parks, because `echo hello` runs through `sh -c` and the classifier does not know it:

```text
{"title":"hello","status":"blocked","blockedReason":"approval_required"}
{"id":"apr_...","action":"shell.unclassified","reason":"dispatch task \"hello\" running [\"sh\",\"-c\",\"echo hello\"] (shell.unclassified)"}
```

Approve it and watch the mission finish:

```sh
APPROVAL=$(call "$API/v1/approvals?status=pending" | jq -r '.approvals[0].id')
call -H "Idempotency-Key: d1" -d '{"decision":"approved"}' $API/v1/approvals/$APPROVAL/decision
call "$API/v1/tasks?missionId=$MISSION" | jq -c '.tasks[] | {title,status}'
call "$API/v1/events" | jq -r '.events[].type' | uniq -c
```

```text
{"id":"apr_...","status":"approved"}
{"title":"hello","status":"completed"}
{"id":"msn_...","status":"completed"}
```

The event list runs from `project.created` through `approval.requested`, `approval.decided`, `git.worktree_created`, `session.started`, `task.verifying`, `test.run_completed`, and `task.completed` to `mission.completed`. Export the mission with secrets redacted:

```sh
node apps/cli/dist/main.js export --mission "$MISSION" --out mission.json
```

If the project has no `testCommand`, Mimir runs its default test command in the empty worktree, which fails, and the mission ends `failed`. The verification verdict is not overridden.

`mimir start` and `mimir demo` are still placeholders and exit 3.

## How it works

```text
 web app / SDK / curl
         |  HTTP + SSE (loopback, bearer token)
         v
 +----------------+      +------------------+
 |  Mimir server  |----->| event store      |  SQLite WAL, per-stream order
 |  (Fastify)     |<-----| read model       |  rebuilt from the log
 +-------+--------+      +------------------+
         |
         v
 +----------------+   policy: classify, approve, deny
 |  orchestrator  |   leases, budgets, worktrees (packages/git)
 |  + scheduler   |   verifier: test command on the exact worktree
 +-------+--------+
         |  RuntimeAdapter interface
         v
 +------------------+     +------------------+
 | herdr-adapter    | or  | fake-runtime     |
 +--------+---------+     +------------------+
          |  NDJSON over a Unix socket
          v
       HerdR  ->  terminal sessions running agents
```

Every request is authenticated, then validated against Zod schemas in `packages/protocol`. Mutations are written to the event log inside a transaction, and the read model is updated from the same events. The orchestrator ticks on an interval: it promotes tasks whose dependencies are done, checks policy and budget, leases a task, creates a worktree, and asks the runtime to start a session. Runtime state comes only from HerdR's `agent_status` events, tagged `observed`; terminal text is shown to humans but is never a state source, and unknown stays `unknown`. When the session exits, the task moves to `verifying`, the verifier runs, and its verdict decides `completed` or another attempt.

Events are ordered within a stream (a mission, a task, an approval), never globally. Clients that reconnect resume from a cursor, and a snapshot comes with the cursor to start from.

## Reference

### Task states

| State       | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `pending`   | Waiting for dependencies                                                   |
| `ready`     | Dependencies done, waiting for a lease                                     |
| `leased`    | Reserved for one crew member, session not started                          |
| `running`   | Session started                                                            |
| `verifying` | Session finished, verifier running                                         |
| `completed` | Verification passed (terminal)                                             |
| `blocked`   | Waiting on approval, budget, input, or a restart; `blockedReason` says why |
| `failed`    | Out of attempts or runtime failure; can be retried or cancelled            |
| `cancelled` | Stopped by an operator (terminal)                                          |

Missions move through `draft`, `active`, `paused`, `completed`, `cancelled`, and `failed`.

### API surface

All routes are under `/v1`. Everything except `GET /v1/health` needs `Authorization: Bearer <token>`; mutations need `Idempotency-Key`.

| Area             | Routes                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Health and state | `GET /health`, `GET /capabilities`, `GET /snapshot`, `GET /attention`, `GET /usage`                                  |
| Projects         | `GET /projects`, `POST /projects`                                                                                    |
| Missions         | `GET /missions`, `GET /missions/{id}`, `POST /missions`, `POST /missions/{id}/start`, `/pause`, `/resume`, `/cancel` |
| Crews            | `GET /crews`, `POST /crews`                                                                                          |
| Tasks            | `GET /tasks`, `POST /tasks`, `POST /tasks/{id}/retry`, `POST /tasks/{id}/pr`                                         |
| Approvals        | `GET /approvals`, `POST /approvals/{id}/decision`                                                                    |
| Sessions         | `POST /sessions/{id}/input`, `POST /sessions/{id}/stop`, `GET /sessions/{id}/terminal`                               |
| Events           | `GET /events`, `GET /events/stream` (SSE)                                                                            |
| Artifacts        | `GET /artifacts/{id}`, `GET /artifacts/{id}/content`                                                                 |

CLI commands: `init`, `token show`, `doctor`, `export`, plus the placeholders `start` and `demo`. Every command takes `--json`. Exit codes: 0 ok, 2 bad configuration, 3 infrastructure problem.

## Ecosystem

Mimir is one of four products, each its own repository. The paths below are siblings of this repository.

| Product | Responsibility                             | Where                                                   |
| ------- | ------------------------------------------ | ------------------------------------------------------- |
| Sindri  | Plans: intake, specs, task graph, delivery | `../sindri`                                             |
| Brokkr  | Defines and verifies quality               | `../brokkr`                                             |
| Mimir   | Commands crews, supervised                 | this repository                                         |
| HerdR   | Runs agents in terminal sessions           | `../upstream/herdr` (upstream Rust software, read only) |

Hard rules: Sindri reaches Mimir only through `@mimir/sdk` and `@mimir/protocol`. Mimir reaches HerdR only through `packages/herdr-adapter`. Mimir and Sindri consume Brokkr only as packed tarballs. Brokkr depends on nothing else. There are no cross repo source imports. Brokkr's verdict is never overridable by a model or by Sindri.

## Security and privacy

The server binds `127.0.0.1` and refuses a non loopback bind without `MIMIR_ALLOW_REMOTE=1` and TLS. Every route but health needs a bearer token stored with mode 0600, and `Origin` and `Host` are checked against CSRF and DNS rebinding. Privileged actions are denied by default; people approve, agents and system actors cannot. Secrets are redacted before storage and in exports. There is no telemetry, no hosted service, and no outbound HTTP client in the server or core. Agents run as your user, so read the threat model before pointing Mimir at repositories you do not trust. See [SECURITY.md](SECURITY.md) and [docs/security/](docs/security/).

## Documentation

* [docs/getting-started.md](docs/getting-started.md): installation and first run.
* [docs/concepts.md](docs/concepts.md): entities and the model Mimir implements.
* [docs/api.md](docs/api.md): the HTTP API generated from the protocol schemas.
* [docs/limits.md](docs/limits.md): what does not work yet.
* [docs/troubleshooting.md](docs/troubleshooting.md): common failures and fixes.
* [docs/licenses.md](docs/licenses.md): license policy and rulings.
* [docs/herdr-capabilities.md](docs/herdr-capabilities.md): HerdR capability map and adapter mapping.
* [docs/herdr/](docs/herdr/): HerdR 0.7.4 and 0.9.4 socket schemas, their diff, and verified wire facts.
* [docs/adrs/](docs/adrs/): fourteen architecture decision records and their index.
* [docs/security/threat-model.md](docs/security/threat-model.md): threats and mitigations, implemented versus planned.
* [docs/security/dependency-audit.md](docs/security/dependency-audit.md): dependency audit.
* [docs/gates/phase-2-gate.md](docs/gates/phase-2-gate.md): chaos, security, and recovery scenarios.
* [docs/gates/performance.md](docs/gates/performance.md): load targets and measured results.
* [docs/issues/](docs/issues/): the local issue tracker, one file per epic.

Note that `getting-started.md`, `api.md`, and `limits.md` still say missions do not run and several routes are contract only. That predates the orchestrator wiring; the walkthrough above is current.

## Roadmap

Gates are defined in `05_ROADMAP_PLAN.md` at the ecosystem root. Not yet done:

* G1 and G2 against real HerdR: a real single agent mission, three crews over two repositories, and recovery after killing the server mid task. The walkthrough here uses the fake runtime only.
* `mimir start` and `mimir demo` are placeholders.
* The server does not serve the web app.
* Agent pause and resume: HerdR has no such operation, so only stop is supported.
* G3: Linux installers, an onboarding wizard, and an independent developer installing from the docs without help. Linux and Windows are untested.
* The public rename (D-003) and publishing `@mimir/protocol` and `@mimir/sdk` 0.x.
* Measured token and cost data requires agent hooks; without them usage is `estimated` or `unavailable`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md); everything runs locally and `pnpm check` is the gate.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Experimental release status

The planned public source tag is `v0.1.0`. See [release scope and setup](RELEASE-v0.1.0.md) for tested behavior and acceptance limits. Manual accessibility testing is pending. Vendor integrations without authenticated live acceptance remain experimental.
