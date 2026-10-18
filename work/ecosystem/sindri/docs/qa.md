# QA: coverage and the automated smoke

Two commands, both run from the repository root after `pnpm install`.

## `pnpm test:coverage`

Builds, then runs every workspace package's Vitest suite as one multi project run with V8 coverage
(`vitest.coverage.config.mjs`). It writes `coverage/` (gitignored): a text table, `lcov.info`,
`coverage-summary.json`, and `packages.json` (per package totals, printed as a table at the end by
`scripts/coverage-summary.mjs`).

Counted: `apps/*/src` and `packages/*/src`. Not counted: tests, `__tests__/`, `test/` helpers,
fixtures, `dist/`, declaration files.

Thresholds (statements, branches, functions, lines) are enforced per core package: `apps/server`,
`packages/delivery`, `packages/director`, `packages/intake`, `packages/knowledge`. Each is the
level measured on 2026-10-14 minus 2 points, so coverage cannot quietly regress. Raise a threshold
when coverage improves; never lower one to make a run pass.

`apps/cli` reports 0%: its tests spawn the built binary in a child process, which V8 coverage in
the test worker does not see. The CLI is exercised end to end by the smoke below.

`pnpm check` does not run coverage (it stays fast). `pnpm release:local` does
(`--skip-coverage` skips it for a quick repack).

## `pnpm qa:smoke`

`scripts/qa-smoke.mjs` drives Sindri end to end and prints a step table (step, result, duration,
evidence file). It exits 0 only if no step fails. A step may be `SKIP` with a stated reason.

```sh
pnpm install
pnpm qa:smoke                 # full run: build, release:local (with coverage), product steps, web e2e
pnpm qa:smoke --skip-build    # reuse the current build and skip the coverage run
pnpm qa:smoke --no-e2e        # skip the Playwright e2e suite step
pnpm qa:smoke --keep          # keep the temp HOME, repo and data dirs for inspection
```

Each step's output goes to `qa-smoke-output/<timestamp>/NN-<step>.log` (gitignored), with
`summary.txt` holding the final table and PNG screenshots from the UI step.

Nothing touches your real `~/.sindri` or the macOS Keychain: the smoke uses a temp `HOME`, the env
secret store, a free loopback port, and temp git repos.

### What it covers

| Step | What is checked |
| --- | --- |
| script self tests | The step runner, smoke helpers and coverage config (`pnpm test:scripts`) |
| build | `pnpm build` |
| coverage gate | `pnpm test:coverage` with the per package thresholds |
| release:local | Pack, license policy, SBOM (`--skip-coverage`: the gate ran in the step before) |
| extract CLI tarball | `dist-packages/sindri-cli-*.tgz` unpacks with `dist/main.js` |
| tarball runs standalone | The extracted CLI starts without the workspace (see limits) |
| install shim | `~/.local/bin/sindri` in the temp HOME |
| sindri init, doctor, token show | Data dir under the temp HOME, token mode 0600, doctor `ok` |
| sindri start (local only) | Server and web on one origin; health, 401 without token, `localOnly: true` |
| approval second factor | Pairing code read from `sindri start` output; wrong code 403; approve without `X-Sindri-Approval` 403, with it the request passes the factor |
| project + bootstrap | Temp git repo indexed; `.env` skipped; search finds content |
| fixture ticket intake | The Jira fixture `PROJ-123` entered as a manual intake; URL import refused with `local_only` |
| draft: provider_unavailable | With the `null` provider the draft is 503 `provider_unavailable` |
| UI: provider_unavailable + axe | Playwright drives the served web app: the Director shows the error as an alert; axe finds no serious or critical violations |
| sindri export | The zip has `sindri.db`, `settings.json`, `manifest.json` |
| purge: zero rows | `DELETE /v1/projects/:id/data`, then every table and column of the SQLite file is scanned for the project id (the purge request's own idempotency record excepted) |
| harness server, spec approve, plan approve | The same server code with the fake provider and fake Mimir (`apps/web/e2e/server.ts`): draft, blocking question gate (409), answer, submit, the fixture's injected instruction flagged and approval refused (409 `untrusted_unacknowledged`) until acknowledged, approve spec; propose, dry run, submit, approve plan, all approvals with `X-Sindri-Approval` |
| purge spec+plan: zero rows | Purge with specs and plans present leaves no rows |
| acceptance (../mimir) | Runs the acceptance test when it exists and a Mimir build is present; otherwise SKIP with the reason |
| web e2e | `pnpm --filter @sindri/web e2e`: the full browser flow with axe on every screen |

Approvals use the second factor: the smoke reads the pairing code that the server prints
(`sindri approval pairing code: ...`), mints an approval secret with `POST /v1/approval-session`,
and sends it as `X-Sindri-Approval`. It also checks that a wrong pairing code is refused and that
spec and plan approval with the bearer token alone get 403 `approval_required`.

### What it does not cover

* Real HerdR or a real Mimir server: Mimir is the in process fake from `packages/testing` unless
  the acceptance step runs.
* Real LLM providers: drafting uses the `null` provider (expecting `provider_unavailable`) or the
  deterministic fake provider.
* Real Jira or Linear: the ticket is a recorded fixture; URL import is only checked to be refused
  in local only mode.
* Real Brokkr verification and GitHub delivery.
* `sindri demo` (a stub until S8b lands; the smoke will switch to it).

### Known failing steps

`tarball runs standalone` fails on this build: the packed CLI does not carry its dependencies and
its `@sindri/*` dependencies are private workspace packages that are not packed. The installable
release is task S8b. Until then the shim points at the workspace build and says so in the table.

`web e2e` fails on this build: `apps/web/e2e/flow.spec.ts` expects the trace to show an artifact
kind `test-output`, while the fake Mimir emits Mimir's standard kind `test.output`.

`coverage gate` can fail on a heavily loaded machine: the `packages/knowledge` git config audit
has a 2 s budget and fails closed (`.git/config:unparseable`) when `git` is slow to start, which
some tests then see as the wrong finding.
