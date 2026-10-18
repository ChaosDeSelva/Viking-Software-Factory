# ADR-005: Runtime state comes only from `agent_status`

Status: Accepted (2026-10-14). Source: D-005.

## Context
Terminal text is easy to scrape and easy to fake: an agent, a repository file or a malicious page can print any string. Status ordering is best effort and screen text is not a state source.

## Decision
Runtime state comes only from HerdR `agent_status` (`idle`, `working`, `blocked`, `done`, `unknown`), tagged `provenance: observed`. Terminal text is observed output and never a state source. Missing or ambiguous state is `unknown`, and `unknown` never promotes to running.

Normalization: `idle` to `idle`; `working` to `running`; `blocked` to `blocked`; `done` to `completed` for the session only; `unknown` to `unknown`; `pane_exited` to `stopped`; a bound pane missing from a snapshot is `unknown` until reconcile proves `stopped`. Liveness after a stop request comes from `pane.process_info`, because `idle` after Ctrl C does not mean the agent stopped (spike finding).

## Consequences
* Session `done` moves the task to `verifying`, never straight to `completed` (ADR-011).
* Per harness provenance must be documented, since some harnesses use screen detection rather than hooks.
* A product claim of "measured usage" requires hook data; otherwise usage is `unavailable`.
