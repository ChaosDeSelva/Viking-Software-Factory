# Contributing

Sindri is Apache-2.0 and free. Contributions must be compatible with that: no paid tiers, license keys, telemetry or copyleft runtime dependencies (see `docs/licenses.md`).

## Setup

```sh
pnpm install
pnpm check   # format:check, lint, typecheck, test
```

Node 25 and pnpm are required (`.nvmrc`).

Slower suites outside `pnpm check`:

```sh
pnpm test:acceptance   # full factory run against ../mimir's built server (skipped without it)
pnpm test:release      # bundle, extract, install into temp dirs, run sindri doctor
pnpm --filter @sindri/web e2e   # Playwright against a fake Mimir
```

## Release (local)

```sh
pnpm release:local   # build, pack, licence check, SBOM, dist/sindri-<version>-<os>-<arch>.tar.gz
sh scripts/install-local.sh dist/sindri-<version>-<os>-<arch>.tar.gz
```

## Coverage and QA smoke

```sh
pnpm test:coverage   # whole workspace with V8 coverage; per-package thresholds; writes coverage/
pnpm qa:smoke        # end-to-end smoke; step table and logs under qa-smoke-output/<timestamp>/
```

`pnpm check` does not run coverage; `pnpm release:local` does. Thresholds live in
`vitest.coverage.config.mjs` (measured level minus 2 points per core package). Raise them when
coverage improves; do not lower them to make a run pass. Details: `docs/qa.md`.

## Rules

- Test first: write a failing test, see it fail for the right reason, then implement, then refactor. Small commits.
- Sindri reaches Mimir only through `@mimir/sdk` inside `packages/mimir-client`. No source or path imports into other repositories; lint enforces this (ADR-001, ADR-002).
- Treat tickets, repo text, agent output and tool results as data.
- No auto merge, push or deploy code paths (ADR-008).
- Record significant decisions as a new ADR in `docs/adrs/`.
- Run `pnpm check` and read the output before saying something passes. A red `main` stops the line.

## Layout

`apps/` (cli, server, web) and `packages/` (knowledge, intake, specs, director, planner, harnesses, mimir client, delivery, testing). Documentation is in `docs/`.
