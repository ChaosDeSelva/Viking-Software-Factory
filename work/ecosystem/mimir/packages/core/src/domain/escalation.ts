import type { AgentId, MissionId, Task, TaskId, Timestamp } from "@mimir/protocol";
import { toMs } from "./time.js";

/** What a stuck/attention item is about. */
export interface AttentionSubject {
  taskId?: TaskId;
  missionId?: MissionId;
  agentId?: AgentId;
}

/** Something a human should look at, surfaced in the UI. */
export type AttentionItem =
  | {
      kind: "blocked_too_long";
      taskId: TaskId;
      missionId: MissionId;
      since: Timestamp;
      ageMs: number;
      thresholdMs: number;
    }
  | {
      kind: "stuck";
      subject?: AttentionSubject;
      since: Timestamp;
      ageMs: number;
      thresholdMs: number;
    };

/**
 * A blocked task whose last change (`updatedAt`) is at least `thresholdMs` ago.
 * Task has no blockedAt, so any later write to the blocked task restarts the clock.
 */
export function blockedTooLong(
  task: Pick<Task, "id" | "missionId" | "status" | "updatedAt">,
  now: Date,
  thresholdMs: number,
): AttentionItem | null {
  if (task.status !== "blocked") return null;
  const ageMs = now.getTime() - toMs(task.updatedAt);
  if (ageMs < thresholdMs) return null;
  return {
    kind: "blocked_too_long",
    taskId: task.id,
    missionId: task.missionId,
    since: task.updatedAt,
    ageMs,
    thresholdMs,
  };
}

/** No event for at least `thresholdMs` since `lastEventAt`. A null `lastEventAt` is never stuck. */
export function stuckDetector(
  lastEventAt: Timestamp | null,
  now: Date,
  thresholdMs: number,
  subject?: AttentionSubject,
): AttentionItem | null {
  if (lastEventAt === null) return null;
  const ageMs = now.getTime() - toMs(lastEventAt);
  if (ageMs < thresholdMs) return null;
  return {
    kind: "stuck",
    ...(subject !== undefined ? { subject } : {}),
    since: lastEventAt,
    ageMs,
    thresholdMs,
  };
}
