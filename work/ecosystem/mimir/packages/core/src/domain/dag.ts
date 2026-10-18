import { MimirError, type Task, type TaskDependency, type TaskId } from "@mimir/protocol";

/** A dependency edge: `taskId` cannot start until `dependsOnId` is completed. */
export type DepEdge = Pick<TaskDependency, "taskId" | "dependsOnId">;

function adjacency(deps: readonly DepEdge[]): Map<TaskId, TaskId[]> {
  const adj = new Map<TaskId, TaskId[]>();
  for (const d of deps) {
    const list = adj.get(d.taskId);
    if (list) list.push(d.dependsOnId);
    else adj.set(d.taskId, [d.dependsOnId]);
  }
  return adj;
}

/**
 * Returns one dependency cycle as a closed path [a, b, ..., a] following edge
 * direction (each element depends on the next), or null if the graph is acyclic.
 * Deterministic: explores nodes and edges in input order.
 */
export function findCycle(deps: readonly DepEdge[]): TaskId[] | null {
  const adj = adjacency(deps);
  const state = new Map<TaskId, 1 | 2>(); // 1 = on stack, 2 = done
  for (const root of adj.keys()) {
    if (state.has(root)) continue;
    const path: TaskId[] = [root];
    const iters: number[] = [0];
    state.set(root, 1);
    while (path.length > 0) {
      const node = path[path.length - 1]!;
      const next = adj.get(node) ?? [];
      const i = iters[iters.length - 1]!;
      if (i >= next.length) {
        state.set(node, 2);
        path.pop();
        iters.pop();
        continue;
      }
      iters[iters.length - 1] = i + 1;
      const child = next[i]!;
      const s = state.get(child);
      if (s === 1) {
        return [...path.slice(path.indexOf(child)), child];
      }
      if (s === undefined) {
        state.set(child, 1);
        path.push(child);
        iters.push(0);
      }
    }
  }
  return null;
}

/**
 * Validates a mission's dependency graph. Throws MimirError('validation_failed')
 * with `details.reason` of `self_dependency`, `unknown_task` or `cycle`
 * (`details.cycle` is the closed path).
 */
export function validateDag(tasks: readonly Pick<Task, "id">[], deps: readonly DepEdge[]): void {
  const known = new Set<string>(tasks.map((t) => t.id));
  for (const d of deps) {
    if (d.taskId === d.dependsOnId) {
      throw new MimirError("validation_failed", `task ${d.taskId} depends on itself`, {
        reason: "self_dependency",
        taskId: d.taskId,
      });
    }
    for (const tid of [d.taskId, d.dependsOnId]) {
      if (!known.has(tid)) {
        throw new MimirError("validation_failed", `dependency references unknown task ${tid}`, {
          reason: "unknown_task",
          taskId: tid,
        });
      }
    }
  }
  const cycle = findCycle(deps);
  if (cycle) {
    throw new MimirError("validation_failed", `dependency cycle: ${cycle.join(" -> ")}`, {
      reason: "cycle",
      cycle,
    });
  }
}

/** Pending tasks whose every dependency is a known, completed task. Preserves input order. */
export function readyTasks<T extends Pick<Task, "id" | "status">>(
  tasks: readonly T[],
  deps: readonly DepEdge[],
): T[] {
  const status = new Map<string, Task["status"]>(tasks.map((t) => [t.id, t.status]));
  const adj = adjacency(deps);
  return tasks.filter(
    (t) =>
      t.status === "pending" &&
      (adj.get(t.id) ?? []).every((dep) => status.get(dep) === "completed"),
  );
}
