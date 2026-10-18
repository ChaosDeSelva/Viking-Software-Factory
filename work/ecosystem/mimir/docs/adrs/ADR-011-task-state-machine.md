# ADR-011: Task state machine

Status: Accepted and implemented in pure domain code (2026-10-14). Code: `packages/core/src/domain/taskMachine.ts`, `missionMachine.ts`, `lease.ts`, `scheduler.ts` (task T9, merged at 56c13c0, review in flight). Server wiring (tick loop, persistence) is task T12, not started.

## Context
The newer spec (ADR-007) defines task states `pending, ready, leased, running, verifying, completed` plus `blocked, failed, cancelled`. A runtime reporting `done` is not evidence that the work is correct ("no task is complete on agent self report alone").

## Decision
Edges (all others throw `invalid_transition`):
* pending to ready; ready to leased; leased to running; running to verifying; verifying to completed.
* verifying to running when attempts are left (`attempt += 1`).
* running to blocked (runtime blocked or approval needed); blocked to running (input received or approval granted).
* running or leased to failed (runtime failed, runtime lost or lease expired); failed to ready on retry when attempts are left.
* Every non terminal status to cancelled. Terminal: completed and cancelled.

A session `done` moves the task to `verifying`, never `completed`. The verifying step runs verification evidence (exit codes, diffs, test logs). The long term gate is Brokkr's `VerificationReport` (D-011, Brokkr repo); Mimir's own test command runner is the fallback when no harness is configured. A model or Sindri cannot override the verdict (D-012).

Leases carry heartbeats and expiry; an expired lease marks the task failed with reason `lease_expired`. The scheduler is a pure deterministic function over missions, crews, tasks, dependencies, leases, usage and budgets; it never dispatches a task over a crew's `maxConcurrentTasks` or past an exceeded budget (property tests). After a restart, tasks whose sessions cannot be found become `blocked` with `unknown_after_restart`, never `completed` (T12, planned).

## Consequences
* Known gap recorded by T9: verifying to failed is not an edge, so a task that fails verification with no attempts left can only be cancelled. Add the edge with test rows if wanted.
* The machine does not touch `updatedAt` or `version`; the store owns them.
