import {
  attemptsLeft,
  missionMachine,
  taskMachine,
  type MissionEvent,
  type TaskEvent,
} from "@mimir/core";
import { MimirError, type Mission, type Task } from "@mimir/protocol";
import type { EmitInput } from "../emit.js";

/** What the emitted task event needs beyond the machine transition. */
export interface TaskEventContext {
  resultCommit?: string;
  /** Required for `task.leased` and `task.started`. */
  agentId?: string | undefined;
  /** Required for `task.started`. */
  sessionId?: string | undefined;
  /** `task.failed` reason (defaults to the machine event type). */
  reason?: string;
  /** `task.cancelled` reason. */
  cancelReason?: string;
}

type TaskEmit = EmitInput<
  | "task.ready"
  | "task.leased"
  | "task.started"
  | "task.blocked"
  | "task.verifying"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.retried"
>;

const need = (value: string | undefined, what: string, event: string): string => {
  if (value === undefined) throw new MimirError("internal", `${event} needs ${what}`);
  return value;
};

/**
 * Validates `event` against the core task machine and builds the matching protocol event.
 * Throws `invalid_transition` when the machine refuses it, so no illegal edge is ever appended.
 */
export function taskTransition(
  task: Task,
  event: TaskEvent,
  ctx: TaskEventContext = {},
): { next: Task; emit: TaskEmit } {
  const next = taskMachine.transition(task, event);
  const from = task.status;
  const base = { streamId: `task:${task.id}`, taskId: task.id, missionId: task.missionId };
  const crew = next.crewId === null ? {} : { crewId: next.crewId };
  const emitOf = (e: Omit<TaskEmit, "streamId" | "taskId" | "missionId">): TaskEmit =>
    ({ ...base, ...crew, ...e }) as TaskEmit;
  switch (next.status) {
    case "ready":
      if (event.type === "retry") {
        return {
          next,
          emit: emitOf({
            type: "task.retried",
            payload: { from, to: "ready", attempt: next.attempt },
          }),
        };
      }
      return { next, emit: emitOf({ type: "task.ready", payload: { from, to: "ready" } }) };
    case "leased": {
      if (event.type !== "lease_granted") break;
      return {
        next,
        emit: emitOf({
          type: "task.leased",
          payload: {
            from,
            to: "leased",
            agentId: need(ctx.agentId, "agentId", "task.leased") as never,
            // protocol: the 1-based attempt number; Task.attempt is 0-based
            attempt: next.attempt + 1,
            leaseExpiresAt: event.leaseExpiresAt,
          },
        }),
      };
    }
    case "running":
      return {
        next,
        emit: emitOf({
          type: "task.started",
          sessionId: need(ctx.sessionId, "sessionId", "task.started"),
          payload: {
            from,
            to: "running",
            agentId: need(ctx.agentId, "agentId", "task.started") as never,
            sessionId: need(ctx.sessionId, "sessionId", "task.started") as never,
          },
        }),
      };
    case "blocked":
      return {
        next,
        emit: emitOf({
          type: "task.blocked",
          payload: { from, to: "blocked", reason: next.blockedReason ?? event.type },
        }),
      };
    case "verifying":
      return { next, emit: emitOf({ type: "task.verifying", payload: { from, to: "verifying" } }) };
    case "completed":
      return {
        next,
        emit: emitOf({
          type: "task.completed",
          payload: {
            from,
            to: "completed",
            ...(ctx.resultCommit ? { resultCommit: ctx.resultCommit } : {}),
          },
        }),
      };
    case "failed":
      return {
        next,
        emit: emitOf({
          type: "task.failed",
          payload: {
            from,
            to: "failed",
            reason: ctx.reason ?? event.type,
            attempt: next.attempt,
            retryable: attemptsLeft(next),
          },
        }),
      };
    case "cancelled":
      return {
        next,
        emit: emitOf({
          type: "task.cancelled",
          payload: {
            from,
            to: "cancelled",
            ...(ctx.cancelReason !== undefined ? { reason: ctx.cancelReason } : {}),
          },
        }),
      };
    default:
      break;
  }
  throw new MimirError("internal", `no protocol event for task ${from} -> ${next.status}`);
}

type MissionEmit = EmitInput<
  | "mission.started"
  | "mission.paused"
  | "mission.resumed"
  | "mission.cancelled"
  | "mission.completed"
  | "mission.failed"
>;

/** Validates `event` against the core mission machine and builds the protocol event. */
export function missionTransition(
  mission: Mission,
  event: MissionEvent,
): { next: Mission; emit: MissionEmit } {
  const next = missionMachine.transition(mission, event);
  const from = mission.status;
  const reason =
    "reason" in event && event.reason !== undefined ? { reason: event.reason } : undefined;
  const base = { streamId: `mission:${mission.id}`, missionId: mission.id };
  const type: MissionEmit["type"] =
    next.status === "active"
      ? from === "paused"
        ? "mission.resumed"
        : "mission.started"
      : next.status === "paused"
        ? "mission.paused"
        : next.status === "cancelled"
          ? "mission.cancelled"
          : next.status === "completed"
            ? "mission.completed"
            : "mission.failed";
  return {
    next,
    emit: { ...base, type, payload: { from, to: next.status, ...reason } } as MissionEmit,
  };
}
