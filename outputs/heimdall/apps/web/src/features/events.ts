// Human wording for source events: "task.output" reads "Task output". The raw type stays
// available (tooltip, inspector); a type this build does not know still gets readable words.
type R = Record<string, any>;

const KNOWN: Record<string, string> = {
  "mission.decision_log_requested": "Verification requested project decisions",
  "mission.decision_log_pinned": "Project decisions confirmed",
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

/** Summarizes the observation at the time of the event. Current controls live on the linked record. */
export function eventContext(event: R): string {
  const p = event.payload ?? {};
  const detail = (...values: unknown[]) =>
    values
      .find((v): v is string => typeof v === "string" && v.trim().length > 0)
      ?.trim() ?? "";
  const reason = detail(p.reason, p.runtimeStatus);
  switch (event.type) {
    case "mission.created":
      return detail(p.objective);
    case "mission.decision_log_requested":
      return "Verification is waiting for the coordinator to confirm the accepted project decisions.";
    case "mission.decision_log_pinned":
      return p.decisionLogRef
        ? "Verification can use the accepted decisions for this change."
        : "The coordinator confirmed that this change has no decision entries to include.";
    case "task.created":
      return detail(p.title);
    case "session.requested":
      return p.agentKind
        ? `Requested a ${p.agentKind} session for this task.`
        : "";
    case "session.model_reported":
      return detail(p.model);
    case "session.exited":
      return typeof p.exitCode === "number"
        ? `Agent process exited with code ${p.exitCode}.`
        : "";
    case "session.output":
      return typeof p.lines === "number"
        ? `${p.lines} lines added to the session transcript.`
        : "";
    case "tool.invoked":
      return detail(p.tool);
    case "tool.completed":
      return typeof p.ok === "boolean"
        ? [detail(p.tool), p.ok ? "Succeeded" : "Failed"]
            .filter(Boolean)
            .join(" · ")
        : detail(p.tool);
    case "budget.warning":
    case "budget.exceeded":
      return typeof p.used === "number" && typeof p.limit === "number"
        ? `${p.scope ? p.scope + " budget · " : ""}${p.used} of ${p.limit} ${p.unit === "cost" ? "USD" : "tokens"} used`
        : "";
    case "artifact.collection_truncated":
      return typeof p.kept === "number" && typeof p.found === "number"
        ? `Kept ${p.kept} of ${p.found} evidence files.`
        : "";
    case "git.worktree_created":
      return detail(p.branch);
    case "task.verifying":
      return "The agent finished its attempt. Verification is checking the result.";
    case "test.run_completed":
      return typeof p.passed === "boolean"
        ? `${p.passed ? "Passed" : "Failed"}${typeof p.exitCode === "number" ? ` (exit ${p.exitCode})` : ""}${p.command ? ` · ${p.command}` : ""}`
        : "";
    case "task.completed":
      return p.verificationSkipped === "document_deliverable"
        ? "The task produced a document for review."
        : p.resultCommit
          ? "Verification passed and the resulting changes were saved."
          : "";
    case "task.retried":
      return [
        p.attempt ? `Attempt ${p.attempt}` : "Retry requested",
        reason,
        p.deferred === "awaiting_capacity" ? "Waiting for a free worker" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "approval.requested":
      return detail(p.summary, p.reason, p.action);
    case "approval.decided":
      return [detail(p.actor), detail(p.decision), reason]
        .filter(Boolean)
        .join(" · ");
    case "artifact.recorded":
      return detail(p.name, p.kind);
    case "recovery.reconciled":
      return typeof p.sessions === "number"
        ? `Checked ${p.sessions} sessions after reconnecting${Array.isArray(p.lostSessionIds) && p.lostSessionIds.length ? `; ${p.lostSessionIds.length} missing` : ""}.`
        : "";
    default:
      if (reason) return reason;
      if (typeof p.from === "string" && typeof p.to === "string")
        return `${p.from} → ${p.to}`;
      return "";
  }
}
