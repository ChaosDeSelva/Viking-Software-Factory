# ADR-007: Local only mode

Status: Accepted (2026-10-14).

## Context

Users must be able to run Sindri on a machine that never talks to a provider or tracker, and to know that is true.

## Decision

`settings.localOnly` defaults to `true`. While it is on, Sindri performs no connector fetches (`POST /v1/intakes/import` returns 503 `local_only`) and uses no remote model provider. The default provider is `null`. Turning it off is an explicit settings change. There is no telemetry in any mode.

## Consequences

* Manual intake, bootstrap, search, specs and knowledge all work offline.
* Provider and connector use is a deliberate step, documented in `docs/security.md` as an egress boundary.
