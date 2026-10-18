import type { Plan, PlanTask } from "@sindri/planner";

/** Test fixtures for consumers of `@sindri/mimir-client` (exported as `./testing`). */

const DIGEST = "sha256:" + "ab".repeat(32);

export function planTask(id: string, overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id,
    objective: `do ${id}`,
    inputs: [],
    outputs: [],
    acceptanceCriteria: ["AC-1"],
    dependsOn: [],
    harnessId: "backend-node",
    harnessVersion: "1.0.0",
    harnessLockDigest: DIGEST,
    skills: [],
    selectionRationale: [],
    role: "implementer",
    budget: { wallClockMinutes: 30, tokens: 1000 },
    maxRetries: 1,
    escalation: "block",
    ...overrides,
  };
}

/** An approved plan with the given tasks. */
export function approvedPlan(tasks: PlanTask[], overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    projectId: "sindri-project-1",
    lineageId: "lineage-1",
    specId: "spec-1",
    specVersion: 1,
    version: 1,
    status: "approved",
    tasks,
    estimates: {
      taskCount: tasks.length,
      wallClockMinutes: 0,
      criticalPathMinutes: 0,
      tokens: 0,
      costUsd: null,
    },
    approvedBy: "jacob",
    approvedAt: "2026-10-14T00:00:00.000Z",
    createdAt: "2026-10-14T00:00:00.000Z",
    ...overrides,
  };
}
