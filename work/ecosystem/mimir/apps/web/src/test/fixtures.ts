import {
  newId,
  type Agent,
  type Approval,
  type Crew,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
  type Mission,
  type Project,
  type SnapshotResponse,
  type Task,
  type TaskDependency,
} from "@mimir/protocol";

const T0 = "2026-10-14T10:00:00.000Z";

const base = { createdAt: T0, updatedAt: T0, version: 0 };

export function project(over: Partial<Project> = {}): Project {
  return { id: newId("prj"), name: "demo", repoPath: "/tmp/demo", settings: {}, ...base, ...over };
}

export function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: newId("msn"),
    projectId: newId("prj"),
    objective: "Ship the thing",
    status: "active",
    ...base,
    ...over,
  };
}

export function crew(over: Partial<Crew> = {}): Crew {
  return {
    id: newId("crw"),
    missionId: newId("msn"),
    template: "default",
    status: "running",
    limits: { maxConcurrentTasks: 2 },
    ...base,
    ...over,
  };
}

export function task(over: Partial<Task> = {}): Task {
  return {
    id: newId("tsk"),
    missionId: newId("msn"),
    crewId: null,
    title: "Task",
    acceptance: "tests pass",
    status: "pending",
    attempt: 0,
    maxAttempts: 3,
    agentId: null,
    leaseExpiresAt: null,
    ...base,
    ...over,
  };
}

export function dependency(taskId: Task["id"], dependsOnId: Task["id"]): TaskDependency {
  return { id: newId("tdp"), taskId, dependsOnId, ...base };
}

export function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: newId("agt"),
    crewId: newId("crw"),
    role: "implementer",
    agentKind: "shell",
    runtimeSessionId: newId("ses"),
    status: "running",
    taskId: null,
    ...base,
    ...over,
  };
}

export function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: newId("apr"),
    action: "shell.destructive",
    status: "pending",
    actor: null,
    expiry: null,
    missionId: null,
    taskId: null,
    reason: "rm -rf build",
    ...base,
    ...over,
  };
}

export function snapshot(over: Partial<SnapshotResponse> = {}): SnapshotResponse {
  return {
    projects: [],
    missions: [],
    crews: [],
    tasks: [],
    taskDependencies: [],
    agents: [],
    approvals: [],
    worktrees: [],
    usage: {
      tokens: 0,
      estimatedCost: 0,
      samples: 0,
      bySource: { measured: 0, estimated: 0, unavailable: 0 },
    },
    cursor: "c0",
    ...over,
  };
}

let seq = 0;

export function event<T extends EventType>(
  type: T,
  payload: EventPayloadMap[T],
  over: Partial<EventEnvelope> = {},
): EventEnvelope {
  seq += 1;
  const at = new Date(Date.parse(T0) + seq * 1000).toISOString();
  return {
    id: newId("evt"),
    schemaVersion: 1,
    streamId: over.taskId ?? over.missionId ?? "global",
    sequence: seq,
    occurredAt: at,
    observedAt: at,
    type,
    source: "mimir",
    provenance: "observed",
    payload,
    ...over,
  };
}
