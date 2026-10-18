# ADR-006: Apache-2.0 and free

Status: Accepted (2026-10-14). Source: D-006. License file: `LICENSE`.

## Context
The user decided all products are open source and free. HerdR is Apache-2.0. Firstmate is AGPL plus commercial, so nothing is copied from it and no dependency is taken.

## Decision
Mimir (and Sindri and Brokkr) are Apache-2.0. No paid tier, license keys, gated features, hosted service or telemetry unless the user opts in. The only cost to a user is their own LLM provider. Every dependency must be Apache-2.0 compatible; avoid copyleft and source available dependencies.

## Consequences
* A dependency license scan runs in Phase 1 and a release SBOM enforces it. Status: scan not yet written (tracked under M17).
* Telemetry code (`packages/telemetry`) must stay local and opt in.
