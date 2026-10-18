# ADR-005: Evidence only completion

Status: Accepted (2026-10-14).

## Context

Agents routinely report success that did not happen.

## Decision

A task is complete only when recorded evidence says so: exit codes, test logs, diffs and Brokkr verification reports reached through Mimir artifacts. An agent's statement, a status line in terminal text, or model prose is never completion evidence. Runtime state comes from observed signals only; unknown stays unknown.

## Consequences

* Delivery gates (part of S6, in progress) read artifacts, not claims.
* Evidence rows are append only. A project's data cannot be deleted while it has `task_evidence` (the server returns 409; see `docs/api.md`).
