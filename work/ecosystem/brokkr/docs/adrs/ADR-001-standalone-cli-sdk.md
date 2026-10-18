# ADR-001: Brokkr is a standalone CLI + SDK monorepo

* Status: accepted
* Date: 2026-10-14
* Brief: B1 (BRK-001..007)

## Context

Brokkr decides how AI coding agents must build software and checks the result deterministically. Mimir and Sindri both consume it, but Brokkr has to work without either of them, and without HerdR (spec §1, §12).

## Decision

* One pnpm + Turborepo TypeScript monorepo, laid out as in spec §4:
  * `apps/cli` is `@brokkr/cli`, bin `brokkr`.
  * `packages/core` holds schemas, domain types, exit codes, digests, and the bundle ledger.
  * `packages/registry`, `packages/resolver`, `packages/adapters/{claude-code,codex,generic}`.
  * `runner`, `policy`, `evidence`, `reporters` and `sdk` are placeholders until B2/B3.
* Dependency direction:
  * `core` has no internal dependencies.
  * `registry`, `resolver` and the adapters depend on `core` only.
  * `cli` composes all of them.
  * Adapters never import the registry. Everything they need comes through `AdapterContext`, which carries the composed harness and the skill catalog.
* Brokkr imports nothing from the wider ecosystem (Mimir, Sindri, HerdR).
* No server, database daemon, Docker or network access is needed. Everything is filesystem based. Built in harnesses ship in `<repo>/harnesses`, and the CLI resolves them relative to its own files. `BROKKR_BUILTIN_HARNESSES` overrides that location.
* CLI startup stays fast by lazy loading every command module. Only `commander` loads for `--help` (about 30 ms measured; the target is under 300 ms).
* The exit codes in spec §11.3 are a public contract:
  * `EXIT_CODES` in core is the source of truth, and `CLI_EXIT_CODES` in the bin mirrors it. A test asserts the two are equal.
  * `exitWith` coerces any unknown code to 3.

## Consequences

* B2 and B3 fill the placeholder packages without changing the layout.
* `@brokkr/sdk` (B3) can reuse registry, resolver and adapter functions directly. The CLI is a thin shell over the same APIs.
