# ADR-003: Provider neutral director

Status: Accepted (2026-10-14).

## Context

The director classifies requests, loads project context and drafts specs and plans with an LLM. Locking to one vendor would make Sindri unusable offline and untestable.

## Decision

The director talks to the `LlmProvider` interface (`packages/director/src/provider.ts`). Implementations: Anthropic (default model id configurable), a deterministic `FakeProvider` for tests and demos, and a `NullProvider` whose calls fail with `provider_unavailable`. Provider output is advisory: it is validated against Zod schemas, cited claims are checked against retrieved sources, and a deterministic planner enforces structure.

## Consequences

* Tests and the demo need no network and no key.
* Model text never grants permissions. Injection handling is in `packages/director/src/untrusted.ts` (see `docs/security.md`).
* Every director call is recorded in `director_runs`, including failures.
