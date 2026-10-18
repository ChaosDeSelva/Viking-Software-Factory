# ADR-006: Knowledge and evidence split

Status: Accepted (2026-10-14).

## Context

Project knowledge ("the API uses cursor pagination") is a claim that can be wrong or go stale. Evidence ("test run 12 exited 0") is a record of something that happened.

## Decision

They live in different tables and have different rules. Knowledge entries require at least one source, carry a confidence, and can be retracted or superseded with history. Evidence is immutable. Knowledge proposed from a run must cite evidence as a source; evidence is never rewritten from knowledge.

## Consequences

* `packages/knowledge` owns the index and entries; evidence is written by the delivery side.
* Uncited claims are rejected by the API (`sourceRefs` must have at least one item).
