import {
  MimirError,
  type AgentId,
  type CrewId,
  type Task,
  type TaskStatus,
  type Timestamp,
} from "@mimir/protocol";

/** Events that drive the task state machine. */
export type TaskEvent =
  | { type: "deps_completed" }
  | { type: "lease_granted"; crewId: CrewId | null; leaseExpiresAt: Timestamp }
  | { type: "session_started"; agentId: AgentId | null }
  | { type: "runtime_completed" }
  | { type: "verification_passed" }
  | { type: "verification_failed" }
  | { type: "verification_gated" }
  | { type: "runtime_blocked"; reason: string }
  | { type: "approval_needed"; reason: string }
  | { type: "input_received" }
  | { type: "approval_granted" }
  | { type: "cancel"; reason?: string }
  | { type: "runtime_failed"; reason: string }
  | { type: "runtime_lost" }
  | { type: "lease_expired" }
  | { type: "retry" }
  /** Scheduler parked a ready task because its budget is exhausted. */
  | { type: "budget_exceeded"; reason?: typeof BUDGET_EXCEEDED | typeof BUDGET_UNCERTAIN }
  /** Budget has room again; a budget-blocked task returns to ready. */
  | { type: "budget_restored" }
  /**
   * Policy gates a dispatch (the task's command needs an approval, or is denied): the ready task
   * is parked before any lease, worktree or session exists.
   */
  | { type: "dispatch_gated"; reason: typeof APPROVAL_REQUIRED | typeof POLICY_DENIED }
  /** The gating approval was granted: the parked task returns to ready and is dispatched. */
  | { type: "dispatch_approved" }
  /** The gating approval was rejected or expired: the task stays parked as policy_denied. */
  | { type: "dispatch_denied" }
  /**
   * Restart recovery: the task's session is gone from the runtime. The outcome is unknown, so the
   * task is parked (never auto-completed) until an operator retries or cancels it.
   */
  | { type: "recovery_unknown" };

export type TaskEventType = TaskEvent["type"];

/** Statuses with no outgoing edges. `failed` is not terminal: it can be retried or cancelled. */
export const TASK_TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "completed",
  "cancelled",
]);

/**
 * `attempt` is the 0-based index of the current attempt; another attempt is
 * allowed while attempt + 1 < maxAttempts (i.e. the number of attempts made,
 * attempt + 1, is below maxAttempts).
 */
export function attemptsLeft(task: Pick<Task, "attempt" | "maxAttempts">): boolean {
  return task.attempt + 1 < task.maxAttempts;
}

/** A task that will never change again on its own: terminal, or failed with no attempts left. */
export function isTaskSettled(task: Pick<Task, "status" | "attempt" | "maxAttempts">): boolean {
  return (
    TASK_TERMINAL_STATUSES.has(task.status) || (task.status === "failed" && !attemptsLeft(task))
  );
}

/** `blockedReason` used when the scheduler parks a ready task on an exhausted budget. */
export const BUDGET_EXCEEDED = "budget_exceeded";
/**
 * `blockedReason` when a hard budget cannot be evaluated (usage unknown, `onUnknown: block`) but
 * is not known to be exhausted.
 */
export const BUDGET_UNCERTAIN = "budget_uncertain";
/** `blockedReason` of a ready task whose dispatch waits for a human approval. */
export const APPROVAL_REQUIRED = "approval_required";
/** `blockedReason` of a task whose dispatch policy denied (or whose approval was rejected/expired). */
export const POLICY_DENIED = "policy_denied";
/** `blockedReason` of a leased/running task whose session was missing after a restart. */
export const UNKNOWN_AFTER_RESTART = "unknown_after_restart";

/** Blocked reasons that only their own dedicated events may release. */
const PARKED_REASONS: ReadonlySet<string> = new Set([
  BUDGET_EXCEEDED,
  BUDGET_UNCERTAIN,
  APPROVAL_REQUIRED,
  POLICY_DENIED,
  UNKNOWN_AFTER_RESTART,
]);

/** Whether a blocked task was parked by Mimir (budget, policy gate, restart) rather than by its runtime. */
export function isParked(task: Pick<Task, "status" | "blockedReason">): boolean {
  return (
    task.status === "blocked" &&
    task.blockedReason !== undefined &&
    PARKED_REASONS.has(task.blockedReason)
  );
}

type Edge = {
  from: readonly TaskStatus[];
  /** Target status; a function when the target depends on the task (verification_failed). */
  to: TaskStatus | ((task: Task) => TaskStatus);
  /** Returns why the edge is unavailable for this task, or null. */
  guard?: (task: Task) => string | null;
};

const NON_TERMINAL: readonly TaskStatus[] = [
  "pending",
  "ready",
  "leased",
  "running",
  "verifying",
  "blocked",
  "failed",
];

const needsAttempt = (task: Task) =>
  attemptsLeft(task) ? null : `no attempts left (attempt ${task.attempt} of ${task.maxAttempts})`;
const isBudgetReason = (reason: string | undefined) =>
  reason === BUDGET_EXCEEDED || reason === BUDGET_UNCERTAIN;
const budgetBlocked = (task: Task) =>
  isBudgetReason(task.blockedReason) ? null : "task is not blocked on budget";
const notParked = (task: Task) =>
  isBudgetReason(task.blockedReason)
    ? "task is blocked on budget"
    : isParked(task)
      ? `task is parked (${task.blockedReason})`
      : null;
const awaitingApproval = (task: Task) =>
  task.blockedReason === APPROVAL_REQUIRED ? null : "task is not awaiting a dispatch approval";
const retryable = (task: Task) =>
  task.status === "blocked" &&
  task.blockedReason !== UNKNOWN_AFTER_RESTART &&
  task.blockedReason !== POLICY_DENIED
    ? "only failed, unknown_after_restart or policy_denied tasks can be retried"
    : needsAttempt(task);
/** A runtime-blocked task (not parked by Mimir) may be marked unknown at recovery. */
const recoverable = (task: Task) =>
  task.status === "blocked" && isParked(task) ? `task is parked (${task.blockedReason})` : null;

const EDGES: Record<TaskEventType, Edge> = {
  deps_completed: { from: ["pending"], to: "ready" },
  lease_granted: { from: ["ready"], to: "leased" },
  session_started: { from: ["leased"], to: "running" },
  runtime_completed: { from: ["running"], to: "verifying" },
  verification_passed: { from: ["verifying"], to: "completed" },
  // With attempts left the task goes back to work; without, it fails for good.
  verification_failed: {
    from: ["verifying"],
    to: (task) => (attemptsLeft(task) ? "running" : "failed"),
  },
  verification_gated: { from: ["verifying"], to: "blocked" },
  runtime_blocked: { from: ["running"], to: "blocked" },
  approval_needed: { from: ["running"], to: "blocked" },
  input_received: { from: ["blocked"], to: "running", guard: notParked },
  approval_granted: { from: ["blocked"], to: "running", guard: notParked },
  cancel: { from: NON_TERMINAL, to: "cancelled" },
  runtime_failed: { from: ["running", "leased"], to: "failed" },
  runtime_lost: { from: ["running", "leased"], to: "failed" },
  lease_expired: { from: ["running", "leased"], to: "failed" },
  retry: { from: ["failed", "blocked"], to: "ready", guard: retryable },
  budget_exceeded: { from: ["ready"], to: "blocked" },
  budget_restored: { from: ["blocked"], to: "ready", guard: budgetBlocked },
  dispatch_gated: { from: ["ready"], to: "blocked" },
  dispatch_approved: { from: ["blocked"], to: "ready", guard: awaitingApproval },
  dispatch_denied: { from: ["blocked"], to: "blocked", guard: awaitingApproval },
  recovery_unknown: { from: ["leased", "running", "blocked"], to: "blocked", guard: recoverable },
};

function resolve(task: Task, type: TaskEventType): { to: TaskStatus; refusal: string | null } {
  const edge = EDGES[type];
  const to = typeof edge.to === "function" ? edge.to(task) : edge.to;
  if (!edge.from.includes(task.status)) return { to, refusal: "no such edge" };
  return { to, refusal: edge.guard?.(task) ?? null };
}

/** The status `event` would move `task` to, or null if the transition is not allowed (guards included). */
export function taskTarget(task: Task, event: TaskEventType): TaskStatus | null {
  const r = resolve(task, event);
  return r.refusal === null ? r.to : null;
}

function can(task: Task, event: TaskEventType): boolean {
  return taskTarget(task, event) !== null;
}

function transition(task: Task, event: TaskEvent): Task {
  const from = task.status;
  const { to, refusal } = resolve(task, event.type);
  if (refusal !== null) {
    throw new MimirError(
      "invalid_transition",
      `task ${task.id}: cannot go from ${from} to ${to} on ${event.type} (${refusal})`,
      { entity: "task", taskId: task.id, from, to, event: event.type, reason: refusal },
    );
  }

  const next: Task = { ...task, status: to };
  delete next.blockedReason;
  switch (event.type) {
    case "lease_granted":
      next.leaseExpiresAt = event.leaseExpiresAt;
      if (event.crewId !== null) next.crewId = event.crewId;
      break;
    case "session_started":
      if (event.agentId !== null) next.agentId = event.agentId;
      break;
    case "verification_failed":
      if (to === "running") next.attempt = task.attempt + 1;
      break;
    case "retry":
      next.attempt = task.attempt + 1;
      next.agentId = null;
      break;
    case "runtime_blocked":
    case "approval_needed":
      next.blockedReason = event.reason === "" ? event.type : event.reason;
      break;
    case "budget_exceeded":
      next.blockedReason = event.reason ?? BUDGET_EXCEEDED;
      break;
    case "dispatch_gated":
      next.blockedReason = event.reason;
      break;
    case "verification_gated":
    case "dispatch_denied":
      next.blockedReason = POLICY_DENIED;
      break;
    case "recovery_unknown":
      next.blockedReason = UNKNOWN_AFTER_RESTART;
      break;
    default:
      break;
  }
  if (to === "completed" || to === "failed" || to === "cancelled" || to === "ready") {
    next.leaseExpiresAt = null;
  }
  return next;
}

export const taskMachine = { transition, can, target: taskTarget } as const;
