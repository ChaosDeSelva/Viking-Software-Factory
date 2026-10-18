import {
  PlanTaskSchema,
  ROLES,
  type Estimates,
  type PlanTask,
  type ProjectCaps,
  type Role,
} from "./schema.js";

type DagTask = Pick<PlanTask, "id" | "dependsOn">;

export class PlanValidationError extends Error {
  override readonly name = "PlanValidationError";
  constructor(readonly issues: string[]) {
    super(`invalid plan: ${issues.join("; ")}`);
  }
}

/** Kahn topological order; `cycle` lists the tasks that could not be ordered. */
export function topoOrder(tasks: readonly DagTask[]): { order: string[]; cycle: string[] } {
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  for (const t of tasks) indegree.set(t.id, t.dependsOn.filter((d) => ids.has(d)).length);
  const order: string[] = [];
  const queue = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const t of tasks)
      if (t.dependsOn.includes(id)) {
        const n = (indegree.get(t.id) ?? 0) - 1;
        indegree.set(t.id, n);
        if (n === 0) queue.push(t.id);
      }
  }
  const done = new Set(order);
  return { order, cycle: tasks.filter((t) => !done.has(t.id)).map((t) => t.id) };
}

export interface ValidateContext {
  spec: { acceptanceCriteria: { id: string }[] };
  caps?: ProjectCaps;
}

const over = (what: string, value: number, cap: number | undefined) =>
  cap !== undefined && value > cap ? [`${what} ${value} exceeds cap ${cap}`] : [];

/**
 * Structural plan checks: schema, unique ids, known dependencies, acyclic, every
 * acceptance criterion covered, no delegation, pinned harness, budgets within caps.
 * Returns human-readable issues (empty when valid).
 */
export function validatePlan(plan: { tasks: readonly PlanTask[] }, ctx: ValidateContext): string[] {
  const issues: string[] = [];
  const caps = ctx.caps ?? {};
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if ((task.role as string) === "delegate" || !(ROLES as readonly string[]).includes(task.role)) {
      issues.push(
        `${task.id}: role "${task.role}" is not allowed: tasks may not delegate further work`,
      );
    }
    const parsed = PlanTaskSchema.safeParse(task);
    if (!parsed.success)
      for (const i of parsed.error.issues)
        if (i.path[0] !== "role") issues.push(`${task.id}: ${i.path.join(".")}: ${i.message}`);
    if (ids.has(task.id)) issues.push(`duplicate task id ${task.id}`);
    ids.add(task.id);
  }
  for (const task of plan.tasks)
    for (const d of task.dependsOn) {
      if (d === task.id) issues.push(`${task.id} depends on itself`);
      else if (!ids.has(d)) issues.push(`${task.id} depends on unknown task ${d}`);
    }
  const { cycle } = topoOrder(plan.tasks);
  if (cycle.length > 0) issues.push(`dependency cycle among ${cycle.join(", ")}`);

  const known = new Set(ctx.spec.acceptanceCriteria.map((a) => a.id));
  const covered = new Set(plan.tasks.flatMap((t) => t.acceptanceCriteria));
  for (const id of known)
    if (!covered.has(id)) issues.push(`acceptance criterion ${id} is not covered by any task`);
  for (const task of plan.tasks)
    for (const id of task.acceptanceCriteria)
      if (!known.has(id)) issues.push(`${task.id} references unknown acceptance criterion ${id}`);

  for (const task of plan.tasks) {
    issues.push(
      ...over(`${task.id}: maxRetries`, task.maxRetries, caps.maxRetries),
      ...over(
        `${task.id}: wallClockMinutes`,
        task.budget.wallClockMinutes,
        caps.maxTaskWallClockMinutes,
      ),
      ...over(`${task.id}: tokens`, task.budget.tokens ?? 0, caps.maxTaskTokens),
      ...over(`${task.id}: costUsd`, task.budget.costUsd ?? 0, caps.maxTaskCostUsd),
    );
  }
  const totals = estimatePlan(plan.tasks, { tolerateCycles: true });
  issues.push(
    ...over("total wallClockMinutes", totals.wallClockMinutes, caps.maxTotalWallClockMinutes),
    ...over("total tokens", totals.tokens, caps.maxTotalTokens),
    ...over("total costUsd", totals.costUsd ?? 0, caps.maxTotalCostUsd),
  );
  if (caps.maxTasks !== undefined && plan.tasks.length > caps.maxTasks)
    issues.push(`${plan.tasks.length} tasks exceeds cap ${caps.maxTasks}`);
  return issues;
}

export function assertValidPlan(plan: { tasks: readonly PlanTask[] }, ctx: ValidateContext): void {
  const issues = validatePlan(plan, ctx);
  if (issues.length > 0) throw new PlanValidationError(issues);
}

/** Sum budgets and compute the longest dependency chain in minutes. */
export function estimatePlan(
  tasks: readonly PlanTask[],
  options: { tolerateCycles?: boolean } = {},
): Estimates {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const finish = new Map<string, number>();
  const { order, cycle } = topoOrder(tasks);
  if (cycle.length > 0 && !options.tolerateCycles)
    throw new PlanValidationError([`dependency cycle among ${cycle.join(", ")}`]);
  for (const id of order) {
    const t = byId.get(id) as PlanTask;
    const start = Math.max(0, ...t.dependsOn.map((d) => finish.get(d) ?? 0));
    finish.set(id, start + t.budget.wallClockMinutes);
  }
  const costs = tasks.map((t) => t.budget.costUsd).filter((c): c is number => c !== undefined);
  return {
    taskCount: tasks.length,
    wallClockMinutes: tasks.reduce((s, t) => s + t.budget.wallClockMinutes, 0),
    criticalPathMinutes: Math.max(0, ...finish.values()),
    tokens: tasks.reduce((s, t) => s + (t.budget.tokens ?? 0), 0),
    costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

export const DEFAULT_CONCURRENCY: Record<Role, number> = {
  lead: 1,
  implementer: 2,
  reviewer: 1,
  qa: 1,
  investigator: 1,
  security: 1,
  docs: 1,
};

export interface DryRunOptions {
  concurrency?: Partial<Record<Role, number>>;
}

export interface DryRunStep {
  step: number;
  tasks: { id: string; role: Role }[];
}

export interface DryRunResult {
  steps: DryRunStep[];
  order: string[];
}

/**
 * Simulated dispatch: each step starts every ready task (all dependencies finished) in plan
 * order, up to the per-role concurrency; all tasks in a step finish before the next step.
 * Nothing is dispatched; Mimir's scheduler remains the enforcer.
 */
export function dryRun(
  plan: { tasks: readonly Pick<PlanTask, "id" | "dependsOn" | "role">[] },
  options: DryRunOptions = {},
): DryRunResult {
  const { cycle } = topoOrder(plan.tasks);
  if (cycle.length > 0)
    throw new PlanValidationError([`dependency cycle among ${cycle.join(", ")}`]);
  const ids = new Set(plan.tasks.map((t) => t.id));
  const unknown = plan.tasks.flatMap((t) =>
    t.dependsOn.filter((d) => !ids.has(d)).map((d) => `${t.id} depends on unknown task ${d}`),
  );
  if (unknown.length > 0) throw new PlanValidationError(unknown);
  const limit = { ...DEFAULT_CONCURRENCY, ...options.concurrency };
  const done = new Set<string>();
  const steps: DryRunStep[] = [];
  while (done.size < plan.tasks.length) {
    const used = new Map<Role, number>();
    const started: DryRunStep["tasks"] = [];
    for (const t of plan.tasks) {
      if (done.has(t.id) || !t.dependsOn.every((d) => done.has(d))) continue;
      const n = used.get(t.role) ?? 0;
      if (n >= Math.max(1, limit[t.role])) continue;
      used.set(t.role, n + 1);
      started.push({ id: t.id, role: t.role });
    }
    for (const s of started) done.add(s.id);
    steps.push({ step: steps.length + 1, tasks: started });
  }
  return { steps, order: steps.flatMap((s) => s.tasks.map((t) => t.id)) };
}
