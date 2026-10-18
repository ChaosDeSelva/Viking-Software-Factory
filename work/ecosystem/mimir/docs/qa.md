# QA: coverage and the automated smoke

Two commands, both local, both outside `pnpm check` (which stays fast):

| Command | What it does |
|---|---|
| `pnpm test:coverage` | Every package's test suite with V8 coverage, plus per package floors |
| `pnpm qa:smoke` | Build, `release:local` (which includes `test:coverage`), then the released product end to end |

Both run the full test suite, so they take as long as `pnpm test` or longer (V8 coverage adds overhead).

## `pnpm test:coverage`

`scripts/coverage.mjs` runs each workspace package's Vitest suite from the package directory with
its own config, as `pnpm test` does, with `@vitest/coverage-v8` turned on. It writes:

* `coverage/<package>/`: `lcov.info`, `coverage-summary.json` (json summary) and the text table.
* `coverage/<dir>.vitest.log`: the full test output of each package.
* `coverage/lcov.info`: every package merged, with paths relative to the repo root.
* `coverage/coverage-summary.json`: totals per package.

`coverage/` is gitignored. Measured: `src/**` of each package. Not measured: tests, `test/`,
fixtures, test helpers and harnesses, `.d.ts` files, and the process entry points (`src/main.ts`),
which the release test, `pnpm chaos` and the smoke run as real processes instead.

The core packages (`core`, `protocol`, `herdr-adapter`, `git`, `apps/server`) each have a floor
for statements, branches, functions and lines in `scripts/coverage-thresholds.json`, set at the
measured value minus 2 points. The run fails if a test fails or a core package drops below a floor.
Raise a floor when coverage grows. Never lower one to make a run pass.

`apps/cli` measures low because its tests run the built CLI as a child process, which in process
V8 coverage cannot see. That is a gap in the measurement, not missing tests.

Useful flags: `node scripts/coverage.mjs --only packages/core,apps/server` (build first), and
`MIMIR_COVERAGE_CONCURRENCY=2` to run fewer packages at once on a busy machine.

## `pnpm qa:smoke`

Run it after cloning and `pnpm install`. Needs Node 25, pnpm, git, macOS arm64 (the release
target), and the Playwright Chromium (`pnpm --filter @mimir/web exec playwright install chromium`
once). Port 5173 must be free (the Playwright setup runs Vite there).

It prints a table of steps, each with its result, duration and evidence file, and exits 0 only if
every step passed. Every step's stdout and stderr land in `qa-smoke-output/<timestamp>/`
(gitignored), together with `summary.txt` (the table), both server logs, and the exported mission.

| Step | Checks |
|---|---|
| build | `pnpm build` |
| release:local | the release tarball and the SDK/protocol tarballs; the coverage gate runs inside it |
| extract tarball | the bundle contains the CLI, server and web app |
| install shim into temp HOME | `scripts/install-local.sh` from the bundle into a throwaway `HOME` |
| mimir doctor | the shim runs; node, pnpm, git and data dir checks pass; the exit code matches the report |
| server start | the released server on a free port with `MIMIR_RUNTIME=fake` and a temp data dir |
| demo mission | a 3-task mission (A, B after A, C) over the HTTP API: every task goes created, ready, leased, started, verifying, completed; A and B run plain `echo` words from the default allowlist; C quotes its argument, so it is not plain words, the gate classifies the whole `sh -c` argv, and its dispatch needs an approval; each approved task went blocked, then leased, then completed; B was leased only after A completed |
| events replay | `GET /v1/events` paged 7 at a time with `nextCursor` equals one full read; resuming from a cursor continues right after it; per stream sequences have no gaps or duplicates |
| SSE resume | `GET /v1/events/stream` from a cursor, then a reconnect with `Last-Event-ID` resumes with no gap or duplicate and keeps delivering live events |
| SIGKILL and restart | a second mission is killed with `SIGKILL` while tasks run; after a restart on the same data dir every event seen before the kill is still there, unchanged and in order, and an SSE client resumes across the restart |
| restart recovery | the tasks whose sessions died are parked `unknown_after_restart` (not guessed), an operator retry runs them, and the mission completes |
| mimir export | `mimir export` writes the demo mission (0600) with as many events as the API returns |
| axe scan | `apps/web/e2e/qa-mission.spec.ts` through the Playwright setup in `apps/web`: zero axe violations on the mission page while running, and when complete in light and dark mode |

`pnpm qa:smoke -- --skip-coverage` runs `release:local` without its coverage gate. Use it when you
run `pnpm test:coverage` on its own, or on a loaded machine where timing sensitive suites (the git
and server orchestration tests) time out and would otherwise stop the smoke before it reaches the
product. The table names the release step `release:local (--skip-coverage)` so the run says so.

For a faster loop while working on the smoke itself: build a tarball once with
`node scripts/release-local.mjs --skip-coverage --out-dir /tmp/rel`, then run
`node scripts/qa-smoke.mjs --tarball /tmp/rel/mimir-<version>-macos-arm64.tar.gz`. `--keep` keeps
the temp work dir (data dir, sample repo, install).

### What it does not cover

* Real HerdR. The smoke uses the in process FakeRuntime. Sessions die with the server process,
  which is why restarted tasks park as `unknown_after_restart`. With HerdR they would be
  re adopted. Use `pnpm chaos` and the herdr adapter live tests for that path.
* Real agents and LLM providers. Fake sessions only print and exit.
* Real issue trackers (Jira, Linear) and any network service. Mimir has none of these. Sindri's
  smoke covers its connectors with fixtures.
* `mimir start` and `mimir demo`, which are placeholders on this base. The smoke starts the server
  with `node` and creates the demo mission over HTTP. It will switch to them when they land.
* The web app served by the Mimir server itself. The axe scan uses the Playwright harness (Vite
  plus an in memory server) because the server does not serve the built web app on this base.
* Performance (`pnpm bench:check`) and fault injection (`pnpm chaos`), which have their own commands.
