# F09: Harness registry

Status: Partial

Implemented in: `packages/harnesses` (task S4)

The registry is owned by Brokkr (ADR-004). Sindri has the `HarnessService` interface and an in repo fake; `BrokkrHarnessService` rejects `not_wired` until `@brokkr/sdk` is installed (S4b).
