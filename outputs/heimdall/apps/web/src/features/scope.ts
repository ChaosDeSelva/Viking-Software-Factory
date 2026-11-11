// What every top-bar page shows for the selected project. Pure, so the filtering rules are tested
// in node. Sindri and Mimir stay authoritative.
import {
  latestVersions,
  mergeProjects,
  projectAliases,
  projectKey,
  repoKey,
} from "./workflowState.ts";
import { openEscalations } from "./profileForm.ts";
type R = Record<string, any>;

/** Statuses of an agent or task that is doing work right now. */
export const ACTIVE = ["running", "starting", "leased", "verifying", "busy"];
/** Task statuses that need a person. */
export const ATTENTION = [
  "blocked",
  "failed",
  "needs_attention",
  "awaiting_approval",
];
/** Why Mimir parked a task on its budget; the crew's budget can be raised from Heimdall. */
export const BUDGET_REASONS = ["budget_exceeded", "budget_uncertain"];
/** Plain words for Mimir's blocked reasons; an unknown reason is shown as sent. */
export function blockedText(reason: unknown): string {
  const known: Record<string, string> = {
    budget_exceeded: "Crew budget used up",
    budget_uncertain: "Budget usage unknown",
  };
  return known[String(reason)] ?? String(reason ?? "");
}
export const isBudgetBlocked = (task: R | null | undefined) =>
  task?.status === "blocked" &&
  BUDGET_REASONS.includes(String(task.blockedReason));

export interface Scope {
  /** projectKey of the selection, or "all". */
  filter: string;
  allProjects: R[];
  activeProjects: R[];
  /** The selected project rows (one, or every active project for "all"). */
  projects: R[];
  missions: R[];
  tasks: R[];
  crews: R[];
  agents: R[];
  specs: R[];
  plans: R[];
  intakes: R[];
  deliveries: R[];
  executions: R[];
  approvals: R[];
  sindriProjects: R[];
  /** Sindri project ids behind the selection (one repository may be registered twice). */
  sindriIds: Set<string>;
  isArchived: (p: R) => boolean;
  /** Whether an event, notification row or other record belongs to the selection. */
  includes: (row: R) => boolean;
}

export function scopeOf(state: R | null, selection: string): Scope {
  const m = state?.mimir ?? {},
    s = state?.sindri ?? {};
  const sindriProjects: R[] = s.projects ?? [];
  const archived: string[] = state?.preferences?.archivedProjects ?? [];
  const allProjects = mergeProjects(m.projects ?? [], sindriProjects);
  // A Sindri-only project takes Mimir's ID once a run starts; its repository path does not change.
  const isArchived = (p: R) =>
    projectAliases(p, sindriProjects).some((id) => archived.includes(id));
  const activeProjects = allProjects.filter((p) => !isArchived(p));
  const filter = activeProjects.some((p) => projectKey(p) === selection)
    ? selection
    : "all";
  const projects = activeProjects.filter(
    (p) => filter === "all" || projectKey(p) === filter,
  );
  const projectIds = new Set(projects.map((p) => p.id));
  const repos = new Set(
    projects.map((p) => repoKey(p.repoPath)).filter(Boolean),
  );
  const missions: R[] = (m.missions ?? []).filter((r: R) =>
    projectIds.has(r.projectId),
  );
  const missionIds = new Set(missions.map((r) => r.id));
  const tasks: R[] = (m.tasks ?? []).filter((r: R) =>
    missionIds.has(r.missionId),
  );
  const crews: R[] = (m.crews ?? []).filter((r: R) =>
    missionIds.has(r.missionId),
  );
  const crewIds = new Set(crews.map((r) => r.id));
  const agents: R[] = (m.agents ?? []).filter((r: R) => crewIds.has(r.crewId));
  const sindriIds = new Set(
    sindriProjects
      .filter((p) => projectIds.has(p.id) || repos.has(repoKey(p.repoPath)))
      .map((p) => p.id),
  );
  const inSindri = (r: R) => sindriIds.has(r.projectId);
  const executions: R[] = (s.executions ?? []).filter(
    // A run that failed before Mimir had a mission is still a run of the project.
    (e: R) =>
      missionIds.has(e.execution?.mimirMissionId) ||
      sindriIds.has(e.execution?.projectId),
  );
  const taskIds = new Set(tasks.map((t) => t.id));
  const executionIds = new Set(executions.map((e) => e.execution.id));
  const includes = (row: R) => {
    if (row.projectId)
      return projectIds.has(row.projectId) || sindriIds.has(row.projectId);
    if (row.missionId) return missionIds.has(row.missionId);
    if (row.taskId) return taskIds.has(row.taskId);
    if (row.crewId) return crewIds.has(row.crewId);
    if (row.executionId) return executionIds.has(row.executionId);
    return filter === "all";
  };
  return {
    filter,
    allProjects,
    activeProjects,
    projects,
    missions,
    tasks,
    crews,
    agents,
    specs: latestVersions((s.specs ?? []).filter(inSindri)),
    plans: latestVersions((s.plans ?? []).filter(inSindri)),
    intakes: (s.intakes ?? []).filter(inSindri),
    deliveries: (s.deliveries ?? []).filter(inSindri),
    executions,
    approvals: (m.approvals ?? []).filter(
      (r: R) => r.status === "pending" && missionIds.has(r.missionId),
    ),
    sindriProjects,
    sindriIds,
    isArchived,
    includes,
  };
}

/**
 * Notifications for the selection. Connection notices are about the services, not a project, so
 * they appear only in the all-projects view (the bottom bar carries connection state).
 */
export function scopedNotifications(notifications: R[], scope: Scope): R[] {
  const missionIds = new Set(scope.missions.map((m) => m.id));
  const taskIds = new Set(scope.tasks.map((t) => t.id));
  return notifications.filter((n) =>
    n.kind === "connection"
      ? scope.filter === "all"
      : n.kind === "missions"
        ? missionIds.has(n.resourceId ?? n.row?.id)
        : n.kind === "tasks"
          ? taskIds.has(n.resourceId ?? n.row?.id)
          : scope.includes(n.row ?? {}),
  );
}

/**
 * Crew and agent counts that agree with Mimir: every crew Mimir lists for the selection, and how
 * many of them have an agent or task working right now.
 */
export function crewCounts(scope: Pick<Scope, "crews" | "agents" | "tasks">) {
  const working = scope.crews.filter(
    (crew) =>
      scope.agents.some(
        (a) => a.crewId === crew.id && ACTIVE.includes(a.status),
      ) ||
      scope.tasks.some(
        (t) => t.crewId === crew.id && ACTIVE.includes(t.status),
      ),
  );
  return {
    crews: scope.crews.length,
    workingCrews: working.length,
    agents: scope.agents.length,
    workingAgents: scope.agents.filter((a) => ACTIVE.includes(a.status)).length,
  };
}

/** The agent working on a task now, when its session can be watched. */
export function liveAgentOf(task: R, agents: R[]): R | undefined {
  const agent =
    agents.find((a) => a.id === task.agentId) ??
    agents.find((a) => a.taskId === task.id);
  return agent?.runtimeSessionId && ACTIVE.includes(agent.status)
    ? agent
    : undefined;
}

export interface AttentionItem {
  id: string;
  kind: "approval" | "budget" | "blocked" | "failed" | "escalation" | "review";
  title: string;
  detail: string;
  open: { kind: string; row: R };
  row: R;
}

/** One list of everything that waits on a person in the selection, most urgent kinds first. */
export function attentionItems(
  scope: Scope,
  specTitle: (e: R) => string,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of scope.approvals)
    items.push({
      id: "approval:" + a.id,
      kind: "approval",
      title: "Approval needed: " + String(a.action ?? "action"),
      detail: String(a.reason ?? ""),
      open: { kind: "approvals", row: a },
      row: a,
    });
  // A task of a cancelled or finished mission waits on no one, even if it ended failed or blocked.
  const ended = new Set(
    scope.missions
      .filter(
        (m) =>
          m.status === "cancelled" ||
          m.status === "completed" ||
          m.status === "failed",
      )
      .map((m) => m.id),
  );
  for (const t of scope.tasks) {
    if (ended.has(t.missionId)) continue;
    if (isBudgetBlocked(t))
      items.push({
        id: "budget:" + t.id,
        kind: "budget",
        title: String(t.title ?? t.id),
        detail:
          t.blockedReason === "budget_uncertain"
            ? "Blocked: Mimir cannot measure usage and the budget blocks when unknown."
            : "Blocked: the crew's budget is used up.",
        open: { kind: "tasks", row: t },
        row: t,
      });
    else if (t.status === "blocked" || t.status === "failed")
      items.push({
        id: t.status + ":" + t.id,
        kind: t.status,
        title: String(t.title ?? t.id),
        detail: t.blockedReason
          ? "Blocked: " + blockedText(t.blockedReason)
          : t.status === "failed"
            ? "Failed"
            : "Blocked",
        open: { kind: "tasks", row: t },
        row: t,
      });
  }
  for (const e of scope.executions)
    for (const t of openEscalations(e))
      items.push({
        id: "escalation:" + e.execution.id + ":" + t.planTaskId,
        kind: "escalation",
        title: `${t.planTaskId} · ${specTitle(e)}`,
        detail:
          "Human decision needed" +
          (t.escalation?.reason ? ": " + t.escalation.reason : ""),
        open: {
          kind: "escalation",
          row: { ...t, id: t.planTaskId, executionId: e.execution.id },
        },
        row: t,
      });
  for (const r of [...scope.specs, ...scope.plans].filter(
    (x) => x.status === "review",
  ))
    items.push({
      id: "review:" + r.id,
      kind: "review",
      title: String(r.title ?? `Plan v${r.version}`),
      detail: r.tasks
        ? "Plan ready for review"
        : "Specification ready for review",
      open: { kind: r.tasks ? "plans" : "specs", row: r },
      row: r,
    });
  return items;
}
