import type { CrewId, MissionId, TaskId, TaskStatus } from "@mimir/protocol";

/**
 * Decisions are edge-triggered: each one maps to exactly one legal state-machine
 * transition (or lease cleanup) on the input state, and once applied the next
 * `schedule` pass on the new state does not repeat it. A caller that drains
 * `schedule` until it returns `[]` (with a fixed clock and no external events)
 * terminates. `applyDecisions` is the reference implementation of applying them.
 *
 * The scheduler never promotes pending -> ready; run `readyTasks` and apply
 * `deps_completed` separately.
 */

/** ready -> leased (`lease_granted`), and grant a lease to `crewId`. */
export type DispatchDecision = { kind: "dispatch"; taskId: TaskId; crewId: CrewId };
/** ready -> blocked (`budget_exceeded`). Emitted once: the task then carries `blockedReason: 'budget_exceeded'`. */
export type BlockDecision = {
  kind: "block";
  taskId: TaskId;
  /** `budget_exceeded` when a budget is exhausted; `budget_uncertain` when usage is unknown. */
  reason: "budget_exceeded" | "budget_uncertain";
};
/** blocked -> ready (`budget_restored`) for a budget-blocked task whose budget has room again. */
export type UnblockDecision = { kind: "unblock"; taskId: TaskId };
/** leased|running -> failed (`lease_expired`), and drop the lease. */
export type ExpireDecision = { kind: "expire"; taskId: TaskId };
/**
 * Drop an expired lease whose task is not leased or running (e.g. blocked,
 * verifying, completed, or unknown). No task transition.
 */
export type ReleaseLeaseDecision = {
  kind: "release_lease";
  taskId: TaskId;
  reason: "expired";
  /** The task's status, or null if the task is not in the input. */
  taskStatus: TaskStatus | null;
};
/** failed -> ready (`retry`). */
export type RetryDecision = { kind: "retry"; taskId: TaskId };
/** active -> completed (`complete`). */
export type MissionCompleteDecision = { kind: "mission_complete"; missionId: MissionId };
/** active -> failed (`fail`). */
export type MissionFailedDecision = { kind: "mission_failed"; missionId: MissionId };

/** What the scheduler wants done. The caller applies these through the state machines. */
export type Decision =
  | DispatchDecision
  | BlockDecision
  | UnblockDecision
  | ExpireDecision
  | ReleaseLeaseDecision
  | RetryDecision
  | MissionCompleteDecision
  | MissionFailedDecision;
