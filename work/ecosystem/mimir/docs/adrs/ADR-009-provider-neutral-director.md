# ADR-009: Provider neutral director (Sindri)

Status: Accepted (2026-10-14). Source: D-009. Owned by the Sindri repository; recorded here because Mimir's boundary depends on it.

## Context
Sindri's director classifies work, loads context and drafts specs and plans using an LLM.

## Decision
The director is provider neutral with Claude as the default, behind the `packages/director` interface in Sindri. Model output is advisory; a deterministic planner and Mimir's scheduler enforce limits.

## Consequences
* Mimir has no model dependency. Its policy engine and scheduler never consult model output (see `packages/core/src/policy/evaluate.ts`, which ignores `context`).
* Verification verdicts are never overridable by a model (D-012, recorded in the Brokkr repo).
