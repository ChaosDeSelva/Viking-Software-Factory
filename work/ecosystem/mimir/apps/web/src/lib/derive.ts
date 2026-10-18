/** Pure view derivations over the store. No percentages, no guesses. */
import type { EventEnvelope, Provenance, Task, TaskDependency, TaskStatus } from "@mimir/protocol";
import type { AttentionItem } from "../api/client.js";
import type { State } from "../store/reducer.js";

export interface Progress {
  completed: number;
  total: number;
}

/** Progress is completed/total tasks of the mission (every task counts toward total). */
export function taskProgress(tasks: readonly Task[], missionId: string): Progress {
  let completed = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.missionId !== missionId) continue;
    total += 1;
    if (t.status === "completed") completed += 1;
  }
  return { completed, total };
}

export type BoardColumnId =
  "pending" | "ready" | "running" | "verifying" | "completed" | "blocked" | "failed";

export const BOARD_COLUMNS: readonly { id: BoardColumnId; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "ready", label: "Ready" },
  { id: "running", label: "Running" },
  { id: "verifying", label: "Verifying" },
  { id: "completed", label: "Completed" },
  { id: "blocked", label: "Blocked" },
  { id: "failed", label: "Failed / cancelled" },
];

export function boardColumnFor(status: TaskStatus): BoardColumnId {
  if (status === "leased") return "running";
  if (status === "cancelled") return "failed";
  return status;
}

/** Longest-path layering for the Plan DAG. Cycles and dangling edges are tolerated. */
export function layerTasks(tasks: readonly Task[], deps: readonly TaskDependency[]): Task[][] {
  const byId = new Map(tasks.map((t) => [t.id as string, t]));
  const parents = new Map<string, string[]>();
  for (const d of deps) {
    if (!byId.has(d.taskId) || !byId.has(d.dependsOnId)) continue;
    const list = parents.get(d.taskId) ?? [];
    list.push(d.dependsOnId);
    parents.set(d.taskId, list);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // cycle: break it
    visiting.add(id);
    let d = 0;
    for (const p of parents.get(id) ?? []) d = Math.max(d, depthOf(p) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const layers: Task[][] = [];
  for (const t of tasks) {
    const d = depthOf(t.id);
    while (layers.length <= d) layers.push([]);
    (layers[d] as Task[]).push(t);
  }
  return layers.filter((l) => l.length > 0);
}

const KIND_ORDER: Record<AttentionItem["kind"], number> = {
  approval: 0,
  blocked: 1,
  stuck: 2,
  budget: 3,
  unknown: 4,
};

/**
 * Notes: budget alerts last for this page session (no "restored" event exists in protocol v1), and
 * "stuck" compares `leaseExpiresAt` with the browser clock; server `/v1/attention` items (T12) are
 * authoritative when present.
 *
 * "Needs attention": pending approvals, blocked tasks, stuck tasks (lease expired while
 * leased/running), budget alerts and agents in `unknown` state, plus anything the server's
 * `GET /v1/attention` reported.
 */
export function deriveAttention(state: State, now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of state.approvals) {
    if (a.status !== "pending") continue;
    items.push({
      id: `approval:${a.id}`,
      kind: "approval",
      title: `Approval needed: ${a.action}`,
      ...(a.reason ? { detail: a.reason } : {}),
      ...(a.missionId ? { missionId: a.missionId } : {}),
      ...(a.taskId ? { taskId: a.taskId } : {}),
      approvalId: a.id,
    });
  }
  for (const t of state.tasks) {
    if (t.status === "blocked") {
      items.push({
        id: `blocked:${t.id}`,
        kind: "blocked",
        title: `Blocked: ${t.title}`,
        detail: `Reason: ${t.blockedReason ?? "not reported"}`,
        missionId: t.missionId,
        taskId: t.id,
      });
    } else if (
      (t.status === "leased" || t.status === "running") &&
      t.leaseExpiresAt !== null &&
      Date.parse(t.leaseExpiresAt) < now
    ) {
      items.push({
        id: `stuck:${t.id}`,
        kind: "stuck",
        title: `Stuck: ${t.title}`,
        detail: `Lease expired at ${t.leaseExpiresAt}`,
        missionId: t.missionId,
        taskId: t.id,
      });
    }
  }
  for (const b of Object.values(state.budgetAlerts)) {
    items.push({
      id: `budget:${b.budgetId}`,
      kind: "budget",
      title: b.level === "exceeded" ? "Budget exceeded" : "Budget warning",
      detail: `${b.used} of ${b.limit} ${b.unit}`,
      ...(b.missionId ? { missionId: b.missionId } : {}),
    });
  }
  for (const a of state.agents) {
    if (a.status !== "unknown") continue;
    items.push({
      id: `unknown:${a.id}`,
      kind: "unknown",
      title: `Agent state unknown (${a.role})`,
      detail: "Runtime has not reported a state; not assumed.",
      ...(a.runtimeSessionId ? { sessionId: a.runtimeSessionId } : {}),
      ...(a.taskId ? { taskId: a.taskId } : {}),
    });
  }
  // Server items may describe the same entity under a different id: dedupe by entity too.
  const entityKey = (i: AttentionItem) =>
    `${i.kind}:${i.approvalId ?? i.taskId ?? i.sessionId ?? i.missionId ?? i.id}`;
  const seen = new Set([...items.map((i) => i.id), ...items.map(entityKey)]);
  for (const s of state.serverAttention) {
    if (seen.has(s.id) || seen.has(entityKey(s))) continue;
    seen.add(s.id).add(entityKey(s));
    items.push(s);
  }
  return items.sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind]);
}

export interface EventFilter {
  missionId?: string;
  crewId?: string;
  taskId?: string;
  sessionId?: string;
  type?: string;
  provenance?: Provenance;
  search?: string;
}

export function filterEvents(events: readonly EventEnvelope[], f: EventFilter): EventEnvelope[] {
  const needle = f.search?.trim().toLowerCase() ?? "";
  return events.filter((e) => {
    if (f.missionId && e.missionId !== f.missionId) return false;
    if (f.crewId && e.crewId !== f.crewId) return false;
    if (f.taskId && e.taskId !== f.taskId) return false;
    if (f.sessionId && e.sessionId !== f.sessionId) return false;
    if (f.type && e.type !== f.type) return false;
    if (f.provenance && e.provenance !== f.provenance) return false;
    if (needle.length > 0) {
      const hay = [
        e.type,
        e.id,
        e.missionId,
        e.crewId,
        e.taskId,
        e.sessionId,
        e.source,
        JSON.stringify(e.payload),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
