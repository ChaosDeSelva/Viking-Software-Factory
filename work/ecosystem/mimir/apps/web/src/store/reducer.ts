/**
 * The UI store: the server snapshot (`GET /v1/snapshot`) plus live events folded on top.
 * Folding is deliberately conservative: only status-like fields of entities we already hold
 * are updated. Events that create entities trigger a snapshot refresh instead
 * (`needsSnapshotRefresh`), so the server's ReadModel stays the source of truth.
 */
import type {
  Agent,
  Approval,
  Crew,
  EventEnvelope,
  EventPayloadMap,
  Mission,
  Project,
  SnapshotResponse,
  Task,
  TaskDependency,
  UsageTotals,
  Worktree,
} from "@mimir/protocol";
import type { AttentionItem } from "../api/client.js";
import type { ActionOutcome } from "../components/ActionResult.js";

export const MAX_EVENTS = 1000;

export type Connection = "connecting" | "open" | "reconnecting" | "closed";

export interface BudgetAlert {
  budgetId: string;
  level: "warning" | "exceeded";
  unit: "tokens" | "cost";
  used: number;
  limit: number;
  missionId: string | null;
  crewId: string | null;
  at: string;
}

export interface Gap {
  reason: string | null;
  at: string;
}

export interface State {
  status: "loading" | "ready" | "error";
  error: string | null;
  /** A refresh failed after a successful first load; the last-good data is kept. */
  refreshError: string | null;
  connection: Connection;
  gap: Gap | null;
  cursor: string | null;
  projects: Project[];
  missions: Mission[];
  crews: Crew[];
  tasks: Task[];
  taskDependencies: TaskDependency[];
  agents: Agent[];
  approvals: Approval[];
  worktrees: Worktree[];
  usage: UsageTotals | null;
  /** Live events received since the UI loaded (bounded, oldest first). */
  events: EventEnvelope[];
  budgetAlerts: Record<string, BudgetAlert>;
  serverAttention: AttentionItem[];
  /** Result of each approval decision made from this UI (audit ids or error), by approval id. */
  decisionOutcomes: Record<string, ActionOutcome>;
}

export type Action =
  | {
      type: "snapshot/loaded";
      snapshot: SnapshotResponse;
      /**
       * Id of the newest buffered event when the snapshot was requested (`null`: none buffered).
       * Events received after it are re-folded over the snapshot, because SSE and the HTTP
       * response are not ordered relative to each other. Omit on the initial load.
       */
      lastEventIdAtRequest?: string | null;
    }
  | { type: "snapshot/failed"; error: string }
  | { type: "event/received"; event: EventEnvelope }
  | { type: "connection/changed"; connection: Connection }
  | { type: "stream/gap"; reason: string | null; at: string }
  | { type: "gap/dismissed" }
  | { type: "attention/loaded"; items: AttentionItem[] }
  | { type: "decision/outcome"; approvalId: string; outcome: ActionOutcome };

export const initialState: State = {
  status: "loading",
  error: null,
  refreshError: null,
  connection: "connecting",
  gap: null,
  cursor: null,
  projects: [],
  missions: [],
  crews: [],
  tasks: [],
  taskDependencies: [],
  agents: [],
  approvals: [],
  worktrees: [],
  usage: null,
  events: [],
  budgetAlerts: {},
  serverAttention: [],
  decisionOutcomes: {},
};

const REFRESH_TYPES = new Set<string>([
  "mission.created",
  "task.created",
  "session.requested",
  "session.started",
  "approval.requested",
  "git.worktree_created",
  "git.worktree_removed",
  "recovery.reconciled",
  "recovery.unknown_marked",
]);

const KNOWN_PREFIXES = [
  "mission.",
  "task.",
  "session.",
  "tool.",
  "git.",
  "test.",
  "approval.",
  "budget.",
  "policy.",
  "recovery.",
  "summary.",
  "artifact.",
];

/** Events that create or reshape entities; the UI reloads the snapshot after them. */
export function needsSnapshotRefresh(event: EventEnvelope): boolean {
  const type = event.type as string;
  if (REFRESH_TYPES.has(type)) return true;
  // Types this protocol version does not define (project.created, crew.created, ...).
  return !KNOWN_PREFIXES.some((p) => type.startsWith(p));
}

function updateById<T extends { id: string }>(
  list: T[],
  id: string | undefined,
  f: (x: T) => T,
): T[] {
  if (id === undefined) return list;
  let changed = false;
  const next = list.map((x) => {
    if (x.id !== id) return x;
    changed = true;
    return f(x);
  });
  return changed ? next : list;
}

function withoutBlockedReason(t: Task): Task {
  if (t.blockedReason === undefined) return t;
  const copy = { ...t };
  delete copy.blockedReason;
  return copy;
}

function foldEvent(state: State, e: EventEnvelope): State {
  const p = e.payload as Record<string, unknown>;
  const type = e.type;

  if (type.startsWith("task.") && type !== "task.created") {
    const to = p["to"] as Task["status"] | undefined;
    if (to === undefined) return state;
    const tasks = updateById(state.tasks, e.taskId, (t) => {
      let next: Task = { ...withoutBlockedReason(t), status: to, updatedAt: e.occurredAt };
      if (typeof p["attempt"] === "number") next = { ...next, attempt: p["attempt"] };
      if (type === "task.leased") {
        const pl = p as EventPayloadMap["task.leased"];
        next = { ...next, agentId: pl.agentId, leaseExpiresAt: pl.leaseExpiresAt };
      }
      if (type === "task.started") {
        next = { ...next, agentId: (p as EventPayloadMap["task.started"]).agentId };
      }
      if (type === "task.blocked") {
        next = { ...next, blockedReason: (p as EventPayloadMap["task.blocked"]).reason };
      }
      return next;
    });
    return tasks === state.tasks ? state : { ...state, tasks };
  }

  if (type.startsWith("mission.") && type !== "mission.created") {
    const to = p["to"] as Mission["status"] | undefined;
    if (to === undefined) return state;
    const missions = updateById(state.missions, e.missionId, (m) => ({
      ...m,
      status: to,
      updatedAt: e.occurredAt,
    }));
    return missions === state.missions ? state : { ...state, missions };
  }

  if (type === "approval.decided") {
    const pl = p as EventPayloadMap["approval.decided"];
    const approvals = updateById(state.approvals, pl.approvalId, (a) => ({
      ...a,
      status: pl.decision,
      actor: pl.actor,
      reason: pl.reason ?? a.reason,
      updatedAt: e.occurredAt,
    }));
    return { ...state, approvals };
  }

  if (type === "approval.expired") {
    const pl = p as EventPayloadMap["approval.expired"];
    const approvals = updateById(state.approvals, pl.approvalId, (a) => ({
      ...a,
      status: "expired" as const,
      updatedAt: e.occurredAt,
    }));
    return { ...state, approvals };
  }

  if (type === "session.state_changed" || type === "session.lost") {
    if (e.sessionId === undefined) return state;
    const to: Agent["status"] =
      type === "session.lost" ? "unknown" : (p as EventPayloadMap["session.state_changed"]).to;
    let changed = false;
    const agents = state.agents.map((a) => {
      if (a.runtimeSessionId !== e.sessionId) return a;
      changed = true;
      return { ...a, status: to, updatedAt: e.occurredAt };
    });
    return changed ? { ...state, agents } : state;
  }

  if (type === "budget.warning" || type === "budget.exceeded") {
    const pl = p as EventPayloadMap["budget.warning"];
    const alert: BudgetAlert = {
      budgetId: pl.budgetId,
      level: type === "budget.warning" ? "warning" : "exceeded",
      unit: pl.unit,
      used: pl.used,
      limit: pl.limit,
      missionId: e.missionId ?? null,
      crewId: e.crewId ?? null,
      at: e.occurredAt,
    };
    return { ...state, budgetAlerts: { ...state.budgetAlerts, [pl.budgetId]: alert } };
  }

  return state;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot/loaded": {
      const s = action.snapshot;
      const next: State = {
        ...state,
        status: "ready",
        error: null,
        refreshError: null,
        gap: null,
        cursor: s.cursor,
        projects: s.projects,
        missions: s.missions,
        crews: s.crews,
        tasks: s.tasks,
        taskDependencies: s.taskDependencies,
        agents: s.agents,
        approvals: s.approvals,
        worktrees: s.worktrees,
        usage: s.usage,
      };
      if (action.lastEventIdAtRequest === undefined) return next;
      const mark =
        action.lastEventIdAtRequest === null
          ? -1
          : state.events.findIndex((e) => e.id === action.lastEventIdAtRequest);
      // A mark that fell out of the bounded buffer means everything buffered may be newer.
      const newer = state.events.slice(mark + 1);
      return newer.reduce(foldEvent, next);
    }
    case "snapshot/failed":
      // After the first load, keep the last-good data and surface a non-blocking error instead.
      return state.status === "ready"
        ? { ...state, refreshError: action.error }
        : { ...state, status: "error", error: action.error };
    case "event/received": {
      const e = action.event;
      if (state.events.some((x) => x.id === e.id)) return state;
      const events =
        state.events.length >= MAX_EVENTS
          ? [...state.events.slice(state.events.length - MAX_EVENTS + 1), e]
          : [...state.events, e];
      return foldEvent({ ...state, events }, e);
    }
    case "connection/changed":
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
    case "stream/gap":
      return { ...state, gap: { reason: action.reason, at: action.at } };
    case "gap/dismissed":
      return { ...state, gap: null };
    case "attention/loaded":
      return { ...state, serverAttention: action.items };
    case "decision/outcome":
      return {
        ...state,
        decisionOutcomes: { ...state.decisionOutcomes, [action.approvalId]: action.outcome },
      };
  }
}
