# Contributing to Brokkr

Thanks for helping. Brokkr is Apache-2.0, local first and free: no paid tier, no telemetry, no hosted service. Contributions keep it that way.

## Setup

Requirements: Node.js >= 25 (`.nvmrc`), pnpm 12 (`packageManager` in `package.json`), git.

```sh
pnpm install
pnpm build
pnpm check      # format:check, lint, typecheck, test: the gate every change must pass
```

## Coverage and QA smoke

`pnpm check` is the fast gate. Two slower commands back it (details in `docs/qa.md`):

- `pnpm test:coverage`: per package v8 coverage into `coverage/`, with enforced thresholds on the
  core packages (`scripts/coverage-config.json`). Do not lower a threshold to pass; add tests.
  `pnpm release:local` runs it first.
- `pnpm qa:smoke`: builds, packs, installs the release into a temp `HOME` and drives the CLI on
  the fixture repo; logs under `qa-smoke-output/<timestamp>/`.

## Layout

| Path                                                 | What lives there                                      |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `packages/core`                                      | Schemas, digests, errors, verdict and report types    |
| `packages/registry`                                  | Harness sources, trust, composition, lockfile         |
| `packages/resolver`                                  | Skill selection and repository inspection             |
| `packages/adapters/*`                                | Claude Code, Codex and generic instruction bundles    |
| `packages/runner`, `policy`, `evidence`, `reporters` | Verification pipeline                                 |
| `packages/sdk`                                       | The public SDK (`@brokkr/sdk`, `@brokkr/sdk/testing`) |
| `apps/cli`                                           | The `brokkr` command                                  |
| `harnesses/`                                         | Built in harness library and profiles                 |
| `tests/`                                             | Library and consumer contract tests                   |
| `examples/`                                          | Mimir- and Sindri style integration examples          |
| `docs/`                                              | User docs, ADRs, issues, gate results                 |

## How we work

1. **Test first.** Write the failing test, watch it fail for the right reason, make it pass, refactor. Reviews ask for the red output.
2. **Small commits** with a clear subject naming the epic, for example `feat(BRK-012): ...`.
3. **Evidence over claims.** A PR description pastes the commands run and their real output. "Tests pass" without output is not accepted.
4. **Never weaken verification.** A required check that is skipped, errored or timed out must never count as passed. Changes to verdict rules need an ADR.
5. **Security sensitive code** (runner, policy, registry trust, bundle writer) needs a test for the attack it prevents.
6. **Dependencies** must be Apache-2.0 compatible (MIT, BSD, ISC, Apache-2.0). No copyleft or source available code. Explain every new dependency in the PR.
7. **Public API changes** to `@brokkr/sdk`, the report schema or CLI exit codes break consumers. Update `tests/contracts/`, `docs/compatibility.md` and `CHANGELOG.md` in the same change.

## Adding a harness

See `docs/harness-authoring.md`. Run `brokkr harness validate harnesses/<name>`, add it to `harnesses/README.md` and to the expectations in `tests/harness-library.test.ts`.

## Decisions

Architecture decisions are ADRs in `docs/adrs/`. Add one when you change a contract, a default or a security boundary.

## Conduct

See `CODE_OF_CONDUCT.md`.
