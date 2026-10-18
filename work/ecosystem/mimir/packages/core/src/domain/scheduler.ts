import type {
  AgentId,
  Crew,
  CrewId,
  Mission,
  Task,
  TaskId,
  TaskStatus,
  UsageSample,
} from "@mimir/protocol";
import { budgetGuard, type BudgetPolicy } from "./budget.js";
import type { DepEdge } from "./dag.js";
import type { Decision } from "./decisions.js";
import { leaseManager, type Lease } from "./lease.js";
import { canCompleteMission } from "./missionMachine.js";
import {
  APPROVAL_REQUIRED,
  BUDGET_EXCEEDED,
  BUDGET_UNCERTAIN,
  POLICY_DENIED,
  attemptsLeft,
  isTaskSettled,
} from "./taskMachine.js";
import { toMs } from "./time.js";

export interface ScheduleInput {
  now: Date;
  missions: readonly Mission[];
  crews: readonly Crew[];
  tasks: readonly Task[];
  deps: readonly DepEdge[];
  leases: readonly Lease[];
  usage: readonly UsageSample[];
  budgets: readonly BudgetPolicy[];
  /**
   * Agent -> crew map used to attribute usage to crew/mission budgets. Samples
   * that cannot be attributed make crew/mission budgets `uncertain` (hard
   * budgets then block by default), so omitting this fails closed.
   */
  agents?: readonly { id: AgentId; crewId: CrewId }[];
}

/** Task statuses that occupy one of a crew's concurrency slots (budget-blocked tasks excepted; see `occupiesSlot`). */
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "leased",
  "running",
  "verifying",
  "blocked",
]);

/** Used when a crew sets no `limits.maxConcurrentTasks`. */
export const DEFAULT_MAX_CONCURRENCY = 1;

const DISPATCHABLE_CREW: ReadonlySet<Crew["status"]> = new Set(["configured", "running"]);

/**
 * Retry backoff after a failure on the given attempt: min(60s, 1s * 2^attempt).
 * Measured from `task.updatedAt` (Task has no failedAt), so any later write to
 * the failed task restarts the backoff.
 */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** attempt);
}

export function crewConcurrency(crew: Pick<Crew, "limits">): number {
  return crew.limits.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENCY;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byAge = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  toMs(a.createdAt) - toMs(b.createdAt) || cmpStr(a.id, b.id);

/** Blocked reasons of tasks that were parked before dispatch, so they hold no session or slot. */
const SLOTLESS_REASONS: ReadonlySet<string | undefined> = new Set([
  BUDGET_EXCEEDED,
  BUDGET_UNCERTAIN,
  APPROVAL_REQUIRED,
  POLICY_DENIED,
]);

/**
 * Whether a task holds one of its crew's concurrency slots. Tasks parked before dispatch
 * (budget-blocked or policy-gated) do not; a task blocked `unknown_after_restart` does, since its
 * session may still be alive.
 */
export function occupiesSlot(task: Pick<Task, "status" | "blockedReason">): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status) && !SLOTLESS_REASONS.has(task.blockedReason);
}

/**
 * Pure, deterministic scheduling pass. Input array order never matters. Output order:
 * 1. Expired leases, by (expiresAt, taskId): `expire` when the task is leased or
 *    running, otherwise `release_lease` (no task transition).
 * 2. For each active mission in (createdAt, id) order: a mission outcome
 *    (`mission_complete` / `mission_failed`) and nothing else, or else its
 *    `retry`s, `unblock`s, then `dispatch`/`block` for ready tasks, each in task
 *    (createdAt, id) order.
 *
 * Capacity: a crew's slots are taken by its tasks that `occupiesSlot`, plus
 * ready tasks holding a live lease for that crew, plus dispatches in this pass.
 * `block` is emitted only when every candidate crew is budget-blocked (a task
 * waiting on capacity gets no decision). Decisions are edge-triggered; see
 * `Decision`. Pending tasks are not promoted; use `readyTasks`.
 */
export function schedule(input: ScheduleInput): Decision[] {
  const now = input.now.getTime();
  const taskById = new Map<string, Task>(input.tasks.map((t) => [t.id, t]));
  const out: Decision[] = leaseManager.expire(input.leases, input.now).decisions.map((d) => {
    const status = taskById.get(d.taskId)?.status ?? null;
    return status === "leased" || status === "running"
      ? d
      : { kind: "release_lease", taskId: d.taskId, reason: "expired", taskStatus: status };
  });

  const liveLeases = input.leases.filter((l) => !leaseManager.isExpired(l, input.now));
  const liveLeased = new Set<string>(liveLeases.map((l) => l.taskId));
  const active = new Map<string, number>();
  const take = (crewId: string) => active.set(crewId, (active.get(crewId) ?? 0) + 1);
  for (const t of input.tasks) {
    if (t.crewId !== null && occupiesSlot(t)) take(t.crewId);
  }
  for (const l of liveLeases) {
    if (taskById.get(l.taskId)?.status === "ready") take(l.crewId);
  }

  const attribution = { agents: input.agents ?? [], crews: input.crews };
  const verdict = new Map<string, "allow" | "exhausted" | "uncertain">();
  const budgetVerdict = (b: BudgetPolicy) => {
    let v = verdict.get(b.id);
    if (v === undefined) {
      const r = budgetGuard.evaluate(b, input.usage, attribution);
      v = budgetGuard.enforce(b, r) === "allow" ? "allow" : r.exhausted ? "exhausted" : "uncertain";
      verdict.set(b.id, v);
    }
    return v;
  };
  const budgetAllows = (b: BudgetPolicy) => budgetVerdict(b) === "allow";

  const depsOf = new Map<string, TaskId[]>();
  for (const d of input.deps) {
    depsOf.set(d.taskId, [...(depsOf.get(d.taskId) ?? []), d.dependsOnId]);
  }

  const missions = input.missions.filter((m) => m.status === "active").sort(byAge);
  for (const mission of missions) {
    const tasks = input.tasks
      .filter((t) => t.missionId === mission.id)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || byAge(a, b));
    const crews = input.crews
      .filter(
        (c) => c.missionId === mission.id && !c.schedulingPaused && DISPATCHABLE_CREW.has(c.status),
      )
      .sort(byAge);
    const candidatesFor = (t: Task) =>
      t.crewId === null ? crews : crews.filter((c) => c.id === t.crewId);
    const crewBudgetOk = (crew: Crew) => {
      const target = { crewId: crew.id, missionId: mission.id };
      return input.budgets.filter((b) => budgetGuard.appliesTo(b, target)).every(budgetAllows);
    };

    const outcome = missionOutcome(tasks, taskById, depsOf);
    if (outcome !== null) {
      out.push({ kind: outcome, missionId: mission.id });
      continue;
    }

    for (const t of tasks) {
      if (
        t.status === "failed" &&
        attemptsLeft(t) &&
        now - toMs(t.updatedAt) >= backoffMs(t.attempt)
      ) {
        out.push({ kind: "retry", taskId: t.id });
      }
    }

    for (const t of tasks) {
      if (
        t.status === "blocked" &&
        (t.blockedReason === BUDGET_EXCEEDED || t.blockedReason === BUDGET_UNCERTAIN)
      ) {
        if (candidatesFor(t).some(crewBudgetOk)) out.push({ kind: "unblock", taskId: t.id });
      }
    }

    for (const t of tasks) {
      if (t.status !== "ready" || liveLeased.has(t.id)) continue;
      const candidates = candidatesFor(t);
      const affordable = candidates.filter(crewBudgetOk);
      const chosen = affordable.find((c) => (active.get(c.id) ?? 0) < crewConcurrency(c));
      if (chosen) {
        take(chosen.id);
        out.push({ kind: "dispatch", taskId: t.id, crewId: chosen.id });
      } else if (candidates.length > 0 && affordable.length === 0) {
        const exhausted = candidates.some((c) =>
          input.budgets
            .filter((b) => budgetGuard.appliesTo(b, { crewId: c.id, missionId: mission.id }))
            .some((b) => budgetVerdict(b) === "exhausted"),
        );
        out.push({
          kind: "block",
          taskId: t.id,
          reason: exhausted ? "budget_exceeded" : "budget_uncertain",
        });
      }
    }
  }
  return out;
}

/**
 * mission_complete when every task is settled, none failed for good and at least
 * one completed; mission_failed when everything is settled or stuck behind a dead
 * dependency (cancelled or exhausted-failed) and the mission cannot complete.
 */
function missionOutcome(
  tasks: readonly Task[],
  taskById: ReadonlyMap<string, Task>,
  depsOf: ReadonlyMap<string, TaskId[]>,
): "mission_complete" | "mission_failed" | null {
  if (tasks.length === 0) return null;
  const isDeadEnd = (t: Task) => isTaskSettled(t) && t.status !== "completed";
  const doomedMemo = new Map<string, boolean>();
  const doomed = (t: Task): boolean => {
    if (isDeadEnd(t)) return true;
    if (t.status !== "pending") return false;
    const memo = doomedMemo.get(t.id);
    if (memo !== undefined) return memo;
    doomedMemo.set(t.id, false); // cycle guard
    const result = (depsOf.get(t.id) ?? []).some((d) => {
      const dep = taskById.get(d);
      return dep !== undefined && doomed(dep);
    });
    doomedMemo.set(t.id, result);
    return result;
  };

  if (tasks.every(isTaskSettled)) {
    return canCompleteMission(tasks) ? "mission_complete" : "mission_failed";
  }
  const stuck = tasks.every((t) => isTaskSettled(t) || (t.status === "pending" && doomed(t)));
  return stuck ? "mission_failed" : null;
}
