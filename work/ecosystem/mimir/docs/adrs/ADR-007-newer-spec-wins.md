# ADR-007: The newer spec wins

Status: Accepted (2026-10-14). Source: D-007.

## Context
Two generations of Mimir spec exist: `MIMIR_BUILD_PLAN.md` (Oct 13) and `02_MIMIR.md` (Oct 14).

## Decision
Where they conflict, `02_MIMIR.md` wins, because Sindri's SDK is written against it. The reconciliation table is in `05_ROADMAP_PLAN.md`. Highlights that shape the code: `apps/server` not `apps/daemon`; `packages/protocol` + `packages/sdk` not `packages/contracts`; `packages/herdr-adapter`; API prefix `/v1`; task states `pending, ready, leased, running, verifying, completed` plus `blocked, failed, cancelled`; evidence label `provenance: observed | derived | summarized`; event envelope `{id, schemaVersion, streamId, sequence, occurredAt, type, source, provenance, correlationId, payload}`.

From the older spec we keep role templates, the chaos test list, nonfunctional targets (UI under 1 s, 20 sessions, 10 minute setup), the security threat list, Git rules (protected branches, symlink validation) and usage labels `measured / estimated / unavailable`.

## Consequences
* Any divergence between a new decision and the older spec is not a bug in the code.
* The older spec's `fidelity` field does not exist in the protocol.
