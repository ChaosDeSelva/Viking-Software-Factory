# Contributing to Mimir

Mimir is Apache-2.0 licensed and local first. Everything below runs on your machine. By taking part
you agree to the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities as described in
[SECURITY.md](SECURITY.md), not as ordinary changes.

## Setup

* Node 25 (see `.nvmrc`) and pnpm 12 (`corepack enable` or `npm i -g pnpm`).
* git 2.38 or newer. HerdR 0.9.0 or newer if you work on the adapter.
* `pnpm install`, then `pnpm build`.

## Workflow

* `pnpm dev` starts the server (`127.0.0.1:7700`, override with `MIMIR_PORT`) and the web app (Vite).
* `pnpm check` runs lint, typecheck, and tests; it must pass before you commit.
* `pnpm build` builds every package. `pnpm format` runs Prettier.
* `pnpm release:local` builds the release tarball and SDK tarballs; `pnpm test:release` tests that
  script (slow, not part of `pnpm check`).
* `pnpm test:coverage` runs every package's tests with V8 coverage into `coverage/` (text, lcov,
  json summary) and fails if a core package (`core`, `protocol`, `herdr-adapter`, `git`,
  `apps/server`) drops below its floor in `scripts/coverage-thresholds.json`. `release:local` runs
  it; it is not part of `pnpm check`. Raise a floor when you add coverage; never lower one.
* `pnpm qa:smoke` builds, releases, installs into a temp `HOME` and drives the released product
  end to end, with a step table and evidence in `qa-smoke-output/`. See [docs/qa.md](docs/qa.md).
* `node scripts/generate-api-docs.mjs` regenerates `docs/api.md` after `pnpm --filter @mimir/protocol openapi`.
* Write the test first and watch it fail before adding the source it covers.
* Keep commits small; describe the why in the message. Commit trailers follow the project convention.

## Layout

* `apps/server`, `apps/web`, `apps/cli`: the Fastify API, the React UI, and the `mimir` command.
* `packages/*`: shared libraries (`@mimir/protocol`, `@mimir/sdk`, `@mimir/core`, `@mimir/git`,
  `@mimir/herdr-adapter`, `@mimir/fake-runtime`, `@mimir/telemetry`, `@mimir/testing`).
* `docs/`: user docs, ADRs (`docs/adrs`), threat model, per epic status (`docs/issues`).

## Rules that bind every change

* Only `packages/herdr-adapter` talks to HerdR. Never invent HerdR methods; check `docs/herdr/schema-*.json`.
* Mimir does not know what a software factory is: no tickets, specs or harness concepts here.
* Runtime state comes only from HerdR `agent_status`; unknown stays `unknown`.
* No telemetry, paid tiers or gated features. Dependencies must be Apache-2.0 compatible
  (see [docs/licenses.md](docs/licenses.md)).
* Do not promise global event ordering; ordering is per stream.
