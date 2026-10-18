import type { BudgetInput, CreateCrewMemberInput, CrewLimits, CrewRole } from "@mimir/protocol";
import {
  DEFAULT_CONCURRENCY,
  topoOrder,
  type Plan,
  type PlanTask,
  type Role,
} from "@sindri/planner";

/** Picks the Mimir `agentKind` (e.g. `claude`, `codex`, `shell`) for a harness and role. */
export type AgentKindResolver = (harnessId: string, role: Role) => string;

export interface MapPlanOptions {
  acceptanceCriteria?: { id: string; text: string }[];
  agentKindFor?: AgentKindResolver;
  /** Per-role crew concurrency; merged over the planner's `DEFAULT_CONCURRENCY`. */
  concurrency?: Partial<Record<Role, number>>;
  /**
   * Execution number of this plan version (1 for the first). Later runs get their own
   * idempotency keys, so they create a new mission instead of reattaching to a finished one.
   */
  run?: number;
  /** Extra Mimir attempts a human may grant per task after retries run out. Default 2. */
  humanRetries?: number;
}

/** Mimir attempts a human can add with `DeliveryLoop.resolveEscalation(..., "retry")`. */
export const DEFAULT_HUMAN_RETRIES = 2;

export interface MappedCrew {
  /** `<harnessId>:<role>` (Sindri role). */
  key: string;
  idempotencyKey: string;
  harnessId: string;
  role: Role;
  /** Plan task ids served by this crew, in plan order. */
  taskIds: string[];
  /** `CreateCrewRequest` without `missionId`. */
  request: {
    template: CrewRole;
    limits: CrewLimits;
    members: CreateCrewMemberInput[];
    /** Sum of the crew's tasks' token and cost budgets; absent when none set one. */
    budget?: BudgetInput;
  };
}

export interface MappedTask {
  planTaskId: string;
  timeoutMs: number;
  priority?: number;
  idempotencyKey: string;
  crewKey: string;
  title: string;
  /** One entry per plan acceptance criterion (`acceptanceCriteria` on `POST /v1/tasks`). */
  acceptanceCriteria: string[];
  /** The agent brief, or the bare shell command for `shell` crews (`brief` on `POST /v1/tasks`). */
  brief: string;
  /** Plan task ids this task depends on. */
  dependsOn: string[];
}

export interface MappedPlan {
  missionIdempotencyKey: string;
  objective: string;
  crews: MappedCrew[];
  /**
   * Budgets not forwarded to the runtime. Local CLI workers enforce the forwarded timeoutMs.
   */
  unforwardedBudgets: { planTaskId: string; unit: "wallClockMinutes"; value: number }[];
  /** Topologically ordered: every dependency precedes its dependants. */
  tasks: MappedTask[];
}

/**
 * Mimir has five crew roles. Sindri's `security` reviewers and `docs` writers run as Mimir
 * `reviewer` and `implementer` crews; the harness and Sindri role stay in the crew key.
 */
const ROLE_MAP: Record<Role, CrewRole> = {
  lead: "lead",
  implementer: "implementer",
  reviewer: "reviewer",
  qa: "qa",
  investigator: "investigator",
  security: "reviewer",
  docs: "implementer",
};

export const mimirRoleFor = (role: Role): CrewRole => ROLE_MAP[role];

/**
 * `sindri:<planId>:<version>[#<run>]:<suffix>`. The suffix is a plan task id, or `@mission` /
 * `@crew:<harnessId>:<role>`; `@` cannot appear in a plan task id, so the namespaces never
 * collide. Run 1 has no `#<run>` part.
 */
export const idempotencyKey = (
  plan: Pick<Plan, "id" | "version">,
  suffix: string,
  run = 1,
): string => `sindri:${plan.id}:${plan.version}${run > 1 ? `#${run}` : ""}:${suffix}`;

export const crewKey = (task: Pick<PlanTask, "harnessId" | "role">): string =>
  `${task.harnessId}:${task.role}`;

export const DEFAULT_AGENT_KIND = "claude";

/** `shell` crews run the instruction with `sh -c`, so it must be the bare command. */
function instructionFor(
  task: PlanTask,
  agentKind: string,
  criteria: { id: string; text: string }[] = [],
): string {
  if (agentKind === "shell") return task.objective;
  const lines = [
    task.objective,
    "",
    `Acceptance criteria: ${task.acceptanceCriteria.join(", ") || "(none)"}`,
    `Role: ${task.role}`,
    `Harness: ${task.harnessId}@${task.harnessVersion} (lock ${task.harnessLockDigest})`,
  ];
  for (const id of task.acceptanceCriteria) {
    const criterion = criteria.find((c) => c.id === id);
    if (criterion) lines.push(`${id}: ${criterion.text}`);
  }
  if (task.skills.length > 0) lines.push(`Skills: ${task.skills.join(", ")}`);
  if (task.inputs.length > 0) lines.push(`Inputs: ${task.inputs.join(", ")}`);
  if (task.outputs.length > 0) lines.push(`Outputs: ${task.outputs.join(", ")}`);
  lines.push(
    "Work only in this task worktree. Dependency changes are already present. Do not push, merge into the original project, or modify factory configuration. Run the project checks and leave your source changes in the worktree.",
  );
  if (["reviewer", "qa", "security"].includes(task.role))
    lines.push(
      'Independently inspect the inherited implementation and acceptance criteria. Write .mimir/artifacts/review.json as a JSON object with exactly this structure: {"verdict":"approve","findings":[{"severity":"info","message":"finding or evidence, at most 2000 characters","file":"optional path"}],"acceptance":[{"criterionId":"the exact assigned criterion ID","satisfied":true,"note":"evidence"}],"decisions":[]}. Allowed verdicts are approve and request_changes. Allowed severities are info, minor, major, critical, blocking. Assess every assigned criterion exactly once, without adding other criterion IDs or renumbering them. Keep decisions an empty array unless there is an architecture decision; each decision MUST be an object {"title":"short title","context":"context","decision":"decision text"}, never a string. Use request_changes for real defects or missing evidence. Do not approve without checking.',
    );
  return lines.join("\n");
}

/** Pure mapping of an approved plan to the Mimir requests that execute it. */
export function mapPlan(plan: Plan, options: MapPlanOptions = {}): MappedPlan {
  if (plan.status !== "approved") {
    throw new Error(`plan ${plan.id} v${plan.version} is ${plan.status}; only approved plans run`);
  }
  const { order, cycle } = topoOrder(plan.tasks);
  if (cycle.length > 0) throw new Error(`plan has a dependency cycle: ${cycle.join(" -> ")}`);
  const agentKindFor = options.agentKindFor ?? (() => DEFAULT_AGENT_KIND);
  const concurrency = { ...DEFAULT_CONCURRENCY, ...options.concurrency };
  const run = options.run ?? 1;
  const humanRetries = options.humanRetries ?? DEFAULT_HUMAN_RETRIES;

  const crews = new Map<string, MappedCrew & { maxRetries: number }>();
  for (const task of plan.tasks) {
    const key = crewKey(task);
    const existing = crews.get(key);
    if (existing) {
      existing.taskIds.push(task.id);
      existing.maxRetries = Math.max(existing.maxRetries, task.maxRetries);
      continue;
    }
    const role = mimirRoleFor(task.role);
    crews.set(key, {
      key,
      idempotencyKey: idempotencyKey(plan, `@crew:${key}`, run),
      harnessId: task.harnessId,
      role: task.role,
      taskIds: [task.id],
      maxRetries: task.maxRetries,
      request: {
        template: role,
        limits: {},
        members: [
          {
            role,
            agentKind: agentKindFor(task.harnessId, task.role),
            name: `${task.harnessId}-${task.role}`,
          },
        ],
      },
    });
  }
  const byTask = new Map(plan.tasks.map((t) => [t.id, t]));
  const mappedCrews: MappedCrew[] = [...crews.values()].map(({ maxRetries, ...crew }) => {
    const budgets = crew.taskIds.map((id) => (byTask.get(id) as PlanTask).budget);
    const limitTokens = budgets.reduce((n, b) => n + (b.tokens ?? 0), 0);
    const limitCost = budgets.reduce((n, b) => n + (b.costUsd ?? 0), 0);
    const budget: BudgetInput | undefined =
      limitTokens > 0 || limitCost > 0
        ? {
            ...(limitTokens > 0 ? { limitTokens } : {}),
            ...(limitCost > 0 ? { limitCost } : {}),
            enforce: "hard",
            onUnknown: "block",
          }
        : undefined;
    return {
      ...crew,
      request: {
        ...crew.request,
        ...(budget ? { budget } : {}),
        // Sindri decides retries; Mimir must allow the first run, one attempt per automatic
        // retry, and the extra attempts a human may grant after an `ask` escalation.
        limits: {
          maxConcurrentTasks: concurrency[crew.role],
          maxAttemptsPerTask: maxRetries + 1 + humanRetries,
        },
      },
    };
  });

  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const tasks: MappedTask[] = order.map((id) => {
    const task = byId.get(id) as PlanTask;
    return {
      planTaskId: id,
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      timeoutMs: Math.min(86_400_000, task.budget.wallClockMinutes * 60_000),
      idempotencyKey: idempotencyKey(plan, id, run),
      crewKey: crewKey(task),
      title: `${id}: ${task.objective}`,
      acceptanceCriteria: [...task.acceptanceCriteria],
      brief: instructionFor(
        task,
        agentKindFor(task.harnessId, task.role),
        options.acceptanceCriteria,
      ),
      dependsOn: [...task.dependsOn],
    };
  });

  return {
    missionIdempotencyKey: idempotencyKey(plan, "@mission", run),
    objective: `Sindri plan ${plan.id} v${plan.version}${run > 1 ? ` run ${run}` : ""} (spec ${plan.specId} v${plan.specVersion})`,
    crews: mappedCrews,
    unforwardedBudgets: [],
    tasks,
  };
}
