import { MimirError, type Mission, type MissionStatus, type Task } from "@mimir/protocol";
import { isTaskSettled } from "./taskMachine.js";

type TaskLike = Pick<Task, "status" | "attempt" | "maxAttempts">;

export type MissionEvent =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  /** `tasks` are all of the mission's tasks; the guard needs them. */
  | { type: "complete"; tasks: readonly TaskLike[] }
  | { type: "cancel"; reason?: string }
  | { type: "fail"; reason: string };

export type MissionEventType = MissionEvent["type"];

export const MISSION_TERMINAL_STATUSES: ReadonlySet<MissionStatus> = new Set<MissionStatus>([
  "completed",
  "cancelled",
  "failed",
]);

/**
 * All tasks terminal (completed or cancelled) and at least one completed. A task
 * that failed for good means the mission fails instead; the scheduler applies
 * the same rule (see `missionOutcome`).
 */
export function canCompleteMission(tasks: readonly TaskLike[]): boolean {
  return (
    tasks.every((t) => isTaskSettled(t) && t.status !== "failed") &&
    tasks.some((t) => t.status === "completed")
  );
}

const EDGES: Record<MissionEventType, { from: readonly MissionStatus[]; to: MissionStatus }> = {
  start: { from: ["draft"], to: "active" },
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  complete: { from: ["active"], to: "completed" },
  cancel: { from: ["draft", "active", "paused"], to: "cancelled" },
  fail: { from: ["active", "paused"], to: "failed" },
};

function transition(mission: Mission, event: MissionEvent): Mission {
  const edge = EDGES[event.type];
  const from = mission.status;
  let reason: string | null = null;
  if (!edge.from.includes(from)) reason = "no such edge";
  else if (event.type === "complete" && !canCompleteMission(event.tasks)) {
    reason = "not all tasks are terminal, or none completed";
  }
  if (reason !== null) {
    throw new MimirError(
      "invalid_transition",
      `mission ${mission.id}: cannot go from ${from} to ${edge.to} on ${event.type} (${reason})`,
      { entity: "mission", missionId: mission.id, from, to: edge.to, event: event.type, reason },
    );
  }
  return { ...mission, status: edge.to };
}

export const missionMachine = { transition } as const;
