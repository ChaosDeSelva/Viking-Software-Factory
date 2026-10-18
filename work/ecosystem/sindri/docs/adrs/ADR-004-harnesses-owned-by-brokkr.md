# ADR-004: Harnesses are owned by Brokkr and consumed via SDK

Status: Accepted (2026-10-14). Decision D-010.

## Context

A harness is a versioned definition of how a kind of work is done and verified (skills, checks, policy). It is engineering quality knowledge, not planning knowledge.

## Decision

Brokkr owns the harness registry, skill resolver and verification. Sindri defines a narrow `HarnessService` interface (`packages/harnesses/src/types.ts`) and a `BrokkrHarnessService` wrapper over `@brokkr/sdk` (`packages/harnesses/src/brokkr.ts`). The planner selects harnesses by id and exact version and records the selection with its reasons.

## Consequences

* Until the Brokkr SDK tarball is installed (task S4b), `BrokkrHarnessService` rejects with `not_wired`, and planning uses the in repo fake (`packages/harnesses/src/fake.ts`).
* Brokkr's verdict is not overridable by Sindri or a model (D-012). Sindri judges product correctness separately.
