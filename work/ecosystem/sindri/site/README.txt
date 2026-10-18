![Sindri](site/assets/banner.png)

# Sindri

Turns an idea into a reviewed specification, executable plan, and evidence backed local delivery. GitHub is optional.

License: Apache-2.0
Status: pre release (0.1.0 is not cut)
Node >= 25. Local first, no telemetry.

## What it is

Software teams lose time between "someone asked for something" and "a change a reviewer can trust". Requests arrive as tickets or one line ideas, the intent drifts as it moves through chat and agents, and what finally lands in review comes with the agent's own account of why it is fine.

Sindri is the planning and delivery layer that closes that gap. Its single responsibility is to decide what to build and why, and to judge whether the result is acceptable. It takes a request (manual text, or a read only snapshot of a Jira or Linear issue), drafts a versioned specification with a provider neutral LLM director, turns an approved spec into an approved task plan with dependencies and harness selections, submits that plan to Mimir as missions, and then gates the outcome on evidence: Brokkr's deterministic verification verdict plus an independent review that is separate from the implementer. The result is a delivery report and PR text that trace every claim back to a recorded artifact.

Sindri deliberately does not do several things. It does not run agents or open terminals: crews run in Mimir, and only `packages/mimir-client` talks to Mimir, through `@mimir/sdk`. It never touches HerdR. It does not define engineering quality: harnesses and the verification verdict belong to Brokkr, and no model or Sindri code can override that verdict. It does not merge or deploy; a PR is a proposal for a human. It does not write back to your tracker. Ticket text, repo files and agent output are treated as untrusted data.

## Features

* **Project bootstrap.** Indexes a git repo's README, docs, ADRs, manifests, build scripts and a depth-3 structure listing into searchable chunks. Skips secret looking files, binaries, files over 1 MiB and symlink escapes, and reports each skip.
* **Manual intake.** Plain text requests stored against a project.
* **Read only Jira and Linear import.** Jira by `GET` only, Linear by GraphQL queries only, with snapshots kept and changed re imports held as pending.
* **Credential handles.** Settings store secret names, never values; the server rejects token shaped strings.
* **Intake sanitizing.** Ticket text is shown through a sanitized view and handed to the director inside per request random delimiters.
* **Provider neutral director.** Anthropic, fake and null providers behind one interface, with injection detection and a recorded run for every call.
* **Versioned specs.** Draft, review, approved; revisions create new versions, approved versions are immutable, diffs are available, and approval is refused while blocking questions remain.
* **Project knowledge.** Sourced claims with confidence; retract or supersede, never edit, with history kept.
* **Task planner.** Spec to dependency aware task DAG with objective, acceptance, harness version, budget and retries, with dry run and an approval step.
* **Harness selection.** Real Brokkr SDK selection with the full pinned lock carried from approved plan to task verification.
* **Mimir orchestration.** Executions submitted as missions through the SDK facade, with event reconciliation and bounded gate repair retries.
* **Quality gates.** Command, artifact and review gates evaluated from recorded evidence, bound to the Brokkr report.
* **Delivery report and PR.** Report with citations, a trace from delivery back to plan, spec and intake, and a PR request that waits for approval.
* **Knowledge update.** Post delivery write back of sourced claims.
* **Local only mode.** On by default; blocks connector fetches.
* **Server and web UI.** Fastify API with bearer auth plus a React UI served on one origin.
* **Export and delete.** Zip snapshot of the database and settings; per project data deletion.

## Quick start

### Requirements

Node 25 or newer, pnpm, git 2.38 or newer. A model provider key is optional; without one the director uses the `null` provider and refuses to draft. On macOS secrets use the Keychain; elsewhere set `SINDRI_SECRET_STORE=env`.

### Install

```sh
pnpm install
pnpm build
pnpm release:local   # packs apps/cli and packages/mimir-client into dist-packages/, checks licenses, writes dist/sbom.cdx.json
```

### Run

The commands below use `sindri` for `node apps/cli/dist/main.js`.

```sh
sindri init       # data dir (default ~/.sindri) and a 0600 auth token
sindri doctor     # node, git, data dir, provider key, Mimir reachability
sindri start      # API and web UI on http://127.0.0.1:7800
```

Every command accepts `--json`. Exit codes: 0 ok, 2 bad usage or config, 3 infrastructure problem. `sindri demo` creates a local sample repository and intake.

| Variable                                     | Meaning                                              |
| -------------------------------------------- | ---------------------------------------------------- |
| `SINDRI_DATA_DIR`                            | Data directory, default `~/.sindri`                  |
| `SINDRI_HOST`, `SINDRI_PORT`                 | Listen address, default `127.0.0.1:7800`             |
| `SINDRI_ALLOWED_ORIGINS`                     | Comma separated CORS allowlist                       |
| `SINDRI_ALLOW_REMOTE`, `SINDRI_TLS_CERT/KEY` | Non loopback listening, requires TLS                 |
| `SINDRI_SECRET_STORE=env`                    | Environment secrets instead of the Keychain          |
| `SINDRI_SECRET_<KEY>`                        | A secret, for example `SINDRI_SECRET_JIRA_API_TOKEN` |
| `SINDRI_MIMIR_URL`, `MIMIR_AUTH_TOKEN`       | Mimir address and token, used by `doctor`            |
| `SINDRI_WEB_DIST`, `SINDRI_LOG_LEVEL`        | Built web directory override, log level              |

### First task

With `sindri start` running, register a repo, index it and add a request. All writes need a bearer token and an `Idempotency-Key` header.

```sh
T=$(cat "${SINDRI_DATA_DIR:-$HOME/.sindri}/auth-token")
curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -H 'Idempotency-Key: p1' -d '{"name":"sample","repoPath":"/abs/path/to/repo"}' \
  http://127.0.0.1:7800/v1/projects
curl -s -X POST -H "authorization: Bearer $T" -H 'Idempotency-Key: b1' \
  http://127.0.0.1:7800/v1/projects/<id>/bootstrap
# {"result":{"indexed":["README.md","sindri:structure"],"unchanged":[],"removed":[],"skipped":[]}}
curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -H 'Idempotency-Key: i1' -d '{"projectId":"<id>","title":"Add due dates","body":"Todos need optional due dates."}' \
  http://127.0.0.1:7800/v1/intakes
```

Drafting a spec needs a provider: set one in Settings, then use the Director screen or `POST /v1/director/draft`. With the default `null` provider that call returns `provider_unavailable`. Importing a Jira or Linear URL returns 503 `local_only` until local only is turned off in Settings. The web UI at the same address walks the same steps: Projects, Inbox, Director, Specs, Knowledge, Settings, plus plans, executions and deliveries. Execution needs a reachable Mimir; the acceptance suite exercises a real Mimir process and Brokkr with deterministic agent fixtures.

## How it works

```
 ticket / idea
      |
      v
  intake (sanitized, untrusted) --> director (LLM, advisory) --> spec vN
                                                                   |  approve
                                                                   v
   project knowledge <-- knowledge update          planner --> plan vN (DAG, harnesses)
         ^                                                         |  approve
         |                                                         v
   delivery report <-- gates <-- Mimir events <-- @mimir/sdk --> Mimir --> HerdR
         |             (Brokkr verdict + independent review)
         v
   PR request (human approval)
```

Intake text is never trusted. The director reads it inside random per request delimiters together with cited project context, and its output is validated and advisory. A spec asks only blocking questions and is approved by a person. The planner expands an approved spec into a DAG and selects harnesses by id and exact version through the `HarnessService` interface.

On execution, `packages/mimir-client` submits missions through `@mimir/sdk` and reconciles Mimir's durable events into Sindri's own state. When Mimir reports a task as verifying, Sindri evaluates gates from recorded evidence only: test runs, artifacts, Brokkr's report bound to the task and commit, and a review from a reviewer separate from the implementer. Claims in agent output do not satisfy a gate. A failure triggers a bounded repair attempt, then escalation. Each delivery has a trace from intake to spec version, plan version, mission, task events and artifacts.

## Reference

Pipeline stages:

| Stage     | Package                               | State                                       |
| --------- | ------------------------------------- | ------------------------------------------- |
| Bootstrap | `packages/knowledge`                  | Working                                     |
| Intake    | `packages/intake`                     | Working (manual, Jira, Linear)              |
| Spec      | `packages/director`, `packages/specs` | Working with a provider                     |
| Plan      | `packages/planner`                    | Library and server routes                   |
| Harnesses | `packages/harnesses`                  | Real Brokkr SDK selection and inspection    |
| Execute   | `packages/mimir-client`               | SDK facade and delivery loop                |
| Gates     | `packages/delivery`                   | Command, artifact and review gates          |
| Deliver   | `packages/delivery`                   | Report, trace, PR request, knowledge update |

Connectors:

| Connector | Access                        | Auth handle      | Notes                              |
| --------- | ----------------------------- | ---------------- | ---------------------------------- |
| Jira      | `GET` issue and comments only | `apiTokenSecret` | Limited to the configured base URL |
| Linear    | GraphQL queries only          | `apiKeySecret`   | No mutations are sent              |
| Manual    | none                          | none             | Always available                   |

Server API (all under `/v1`, bearer auth): `projects`, `intakes` (including `intakes/import`), `director/draft`, `specs`, `plans`, `harnesses`, `executions`, `reviews`, `deliveries`, `knowledge`, `settings`, `export`, `mimir/status`. Route tables are in `apps/server/src/routes/`.

## Ecosystem

Four products make up the factory. Sindri plans and judges product correctness. [Brokkr](../brokkr) defines and verifies engineering quality. [Mimir](../mimir) commands supervised crews. HerdR runs the terminal sessions and is upstream Rust software.

* Sindri reaches Mimir only through `@mimir/sdk` and `@mimir/protocol`, and only `packages/mimir-client` imports them.
* Nothing in Sindri touches HerdR.
* Brokkr is consumed through `@brokkr/sdk` tarballs. Brokkr imports nothing from the ecosystem.
* Mimir does not know what a ticket, spec or harness is.
* No cross repo source or path imports; repos share only packed tarballs.

The Mimir packages are vendored as tarballs in `vendor/mimir/` so every checkout installs the same bytes offline. `@mimir/sdk` depends on `@mimir/protocol@0.0.0`, which no registry serves, so `pnpm-workspace.yaml` overrides it to the vendored tarball. An ESLint rule forbids `@mimir/*` imports outside `packages/mimir-client` and the test fake. The tested pairing is in `docs/compatibility.md`.

## Security and privacy

Sindri runs locally with no hosted service and no telemetry. The server listens on loopback with one bearer token, checks origin and host, and requires TLS before it will listen elsewhere. Local only mode is on by default and blocks connector fetches. Push, merge, deploy, delete and credential access are denied by default, and Sindri never auto merges (ADR-008). Credentials are handles resolved at call time. Ticket and agent text is data and cannot change policy. See [SECURITY.md](SECURITY.md), `docs/security.md` and `docs/security/`.

## Documentation

* `docs/getting-started.md`: install, init, doctor, connect Mimir, run.
* `docs/concepts.md`: projects, intake, director, specs, knowledge, evidence, plans.
* `docs/api.md`: HTTP API reference.
* `docs/connectors.md`: Jira and Linear setup, credential handles, local only.
* `docs/compatibility.md`: Sindri, `@mimir/sdk`, Mimir protocol and `@brokkr/sdk` versions.
* `docs/limits.md`: enforced limits and known gaps.
* `docs/security.md`: threat handling, egress, untrusted input.
* `docs/security/dependency-audit.md`: dependency audit report.
* `docs/licenses.md`: license policy and the MPL-2.0 test only ruling.
* `docs/adrs/`: ADR-001 to ADR-009 and an index (`README.md`): separate repository, SDK only Mimir dependency, provider neutral director, harnesses owned by Brokkr, evidence only completion, knowledge/evidence split, local only mode, no auto merge, MPL test only dependencies.
* `docs/issues/`: feature tracking files F01 to F18 and an index.

Some documents describe an earlier state of `main`; where they disagree with the code, the code is authoritative.

## Roadmap

Gate G4 (a raw idea becomes a reviewable spec and an approved plan) is built; planning and delivery code exist through gates, review and report. Open items:

* `@brokkr/sdk` wiring: `BrokkrHarnessService` rejects `not_wired` until it lands.
* `sindri demo` and the packaged first run experience.
* Gate G5: imported ticket to parallel crews to a verified PR, including one intentional failed test handled by a bounded retry, has not been run against a real Mimir.
* Gate G6: the full acceptance run with every delivery traceable from ticket to artifacts.
* Gate G7: release hardening and the release checklist; security audit findings are still being closed.
* Not planned: multi user auth, hosted mode, auto merge or deploy, telemetry.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md); participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

## Experimental release status

The planned public source tag is `v0.1.0`. See [release scope and setup](RELEASE-v0.1.0.md) for tested behavior and acceptance limits. Manual accessibility testing is pending. Vendor integrations without authenticated live acceptance remain experimental.
