// Human wording for source events: "task.output" reads "Task output". The raw type stays
// available (tooltip, inspector); a type this build does not know still gets readable words.
type R = Record<string, any>;

const KNOWN: Record<string, string> = {
  "task.output": "Task output",
  "session.output": "Agent output",
  "task.completed": "Task completed",
  "task.failed": "Task failed",
  "task.blocked": "Task blocked",
  "approval.requested": "Approval requested",
  "artifact.recorded": "Evidence recorded",
  "budget.warning": "Budget nearly used",
  "budget.updated": "Budget changed",
};

export function eventTitle(type: unknown): string {
  const raw = String(type ?? "event");
  if (KNOWN[raw]) return KNOWN[raw];
  const words = raw
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The record an event is about, in the order a reader would look for it. */
export const eventSubject = (e: R) =>
  e.taskId ?? e.executionId ?? e.missionId ?? e.eventId;
