# ADR-002: SDK only dependency on Mimir

Status: Accepted (2026-10-14).

## Context

Sindri needs to submit missions and observe their events. Mimir exposes a versioned HTTP and event API with a published client.

## Decision

Sindri reaches Mimir only through `@mimir/sdk` (and `@mimir/protocol` for types). Only `packages/mimir-client` imports them; `packages/testing` may import the types to build a fake. Sindri never talks to HerdR and never reads Mimir's database or files.

## Consequences

* Compatibility is a version contract, not a source contract. See `docs/compatibility.md`.
* `packages/mimir-client` is a facade that maps Sindri concepts (execution, task) to Mimir concepts (mission, task) and back.
* Anything the SDK cannot do is a request to Mimir, not a workaround here. Task creation uses the SDK's `tasks.create` (the former `create-task` shim was removed in S5b). PR requests stay `not_supported` until the SDK exposes `POST /v1/tasks/:id/pr`.
