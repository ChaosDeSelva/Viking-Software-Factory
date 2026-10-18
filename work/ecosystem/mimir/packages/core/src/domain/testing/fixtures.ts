import {
  newId,
  type Budget,
  type Crew,
  type Mission,
  type Task,
  type TaskDependency,
  type UsageSample,
} from "@mimir/protocol";

/** Shared builders for domain tests. Not exported from the package. */

export const T0 = "2026-01-01T00:00:00.000Z";

export function at(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

export function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: newId("msn"),
    createdAt: T0,
    updatedAt: T0,
    version: 0,
    projectId: newId("prj"),
    objective: "ship it",
    status: "active",
    ...overrides,
  };
}

export function makeCrew(mission: Mission, overrides: Partial<Crew> = {}): Crew {
  return {
    id: newId("crw"),
    createdAt: T0,
    updatedAt: T0,
    version: 0,
    missionId: mission.id,
    template: "default",
    status: "running",
    limits: { maxConcurrentTasks: 2 },
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: newId("tsk"),
    createdAt: T0,
    updatedAt: T0,
    version: 0,
    missionId: newId("msn"),
    crewId: null,
    title: "a task",
    acceptance: "",
    status: "pending",
    attempt: 0,
    maxAttempts: 3,
    agentId: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

export function makeDep(taskId: Task["id"], dependsOnId: Task["id"]): TaskDependency {
  return {
    id: newId("tdp"),
    createdAt: T0,
    updatedAt: T0,
    version: 0,
    taskId,
    dependsOnId,
  };
}

export function makeBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    id: newId("bgt"),
    createdAt: T0,
    updatedAt: T0,
    version: 0,
    missionId: null,
    crewId: null,
    limitTokens: null,
    limitCost: null,
    warnAtFraction: 0.8,
    ...overrides,
  };
}

export function makeUsage(overrides: Partial<UsageSample> = {}): UsageSample {
  return {
    id: newId("usg"),
    createdAt: T0,
    updatedAt: T0,
    version: 0,
    agentId: newId("agt"),
    tokens: 0,
    estimatedCost: 0,
    source: "measured",
    ...overrides,
  };
}
