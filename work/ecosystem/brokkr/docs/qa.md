# QA: coverage and automated smoke

Two commands, both local, no network beyond the pnpm store already on the machine.

## Coverage: `pnpm test:coverage`

Runs each package's suite with v8 coverage and writes `coverage/<package>/` (gitignored):
text on stdout, `lcov.info`, and `coverage-summary.json`. Then prints one table.

* Thresholds live in `scripts/coverage-config.json`. They are enforced for the core packages
  (`runner`, `policy`, `registry`, `resolver`, `evidence`, `sdk`) at the level measured on
  2026-10-14 minus 2 points, so the gate cannot regress. Never lower one to make a run pass;
  add tests. `core` and `reporters` are measured and reported without a gate.
* Excluded: `*.test.ts`, `*.d.ts`, `test/**`, `dist/**`, fixtures, and the type only
  `packages/sdk/src/types.ts`.
* `apps/cli` is not run under coverage: its e2e suites assert process start up time and spawn
  process trees, and v8 coverage instrumentation of child processes pushes them past their limits.
  Its suite is covered by `pnpm test`.
* `pnpm check` stays fast and does not run coverage. `pnpm release:local` runs it first
  (skip with `BROKKR_SKIP_COVERAGE=1`; `release:repro` does).
* One package: `node scripts/coverage.mjs runner`.

## Smoke: `pnpm qa:smoke`

After cloning and `pnpm install`, one command drives the shipped product end to end and exits 0 only
if every step passes. Flags: `--with-coverage` (run the coverage gate inside `release:local`),
`--skip-repro` (skip the double build). Takes about 75 s without `release:repro`, plus two more
`release:local` builds with it.

Steps: build; `release:local`; extract the archive and install the shim into a temporary `HOME`;
a bad `.sha256` is refused by the installer; then, with the installed `brokkr` and a temp `BROKKR_HOME`,
on a copy of `tests/fixtures/react-app` (git initialised, `react` + `typescript` added):
`doctor`, `harness list`, `harness validate` (good and broken manifest), `init`, `skills resolve`,
`prepare` (claude code and codex), `verify` (the documented failing verdict: exit 1, `typecheck` passed,
`unit` failed, required browser checks skipped and never counted as passed), `report` in md, html
(offline) and json, `runs list`, a tampered evidence log is refused with an integrity error, `runs prune`;
then the SDK tarball consumer (`pnpm smoke:pack`) and `pnpm release:repro` (byte identical archives).

Every step's stdout and stderr is written to `qa-smoke-output/<timestamp>/NN-<step>.log`
(gitignored); the final table names the file and `summary.txt` repeats it.
The step runner and table are unit tested: `pnpm test:qa`.

## What it does not cover

* Real HerdR, real LLM providers, real Jira or Linear (Brokkr has no such dependencies; Mimir and
  Sindri have their own smoke scripts in their repos).
* Browser checks (`screenshot-*`, `axe`): the fixture has no Playwright, so they are reported
  skipped and the verdict is `failed` by design.
* Windows, and Node versions other than the one on `PATH`.
* `pnpm install --offline` of the fixture needs `typescript` and `react` in the local pnpm store.
