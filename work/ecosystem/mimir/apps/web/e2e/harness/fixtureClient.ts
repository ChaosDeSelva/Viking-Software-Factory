import type { EventEnvelope } from "@mimir/protocol";
import type { MimirClient } from "../../src/api/client.js";

const T = "2026-10-14T10:00:00.000Z";
const id = (p: string, n: number) => `${p}_01J00000000000000000000${String(n).padStart(3, "0")}`;
export const IDS = {
  project: id("prj", 1),
  mission: id("msn", 1),
  crew: id("crw", 1),
  taskA: id("tsk", 1),
  taskB: id("tsk", 2),
  taskC: id("tsk", 3),
  agent: id("agt", 1),
  session: id("ses", 1),
  approval: id("apr", 1),
  artifact: id("art", 1),
} as const;
const base = { createdAt: T, updatedAt: T, version: 1 };
const usage = {
  tokens: 1200,
  estimatedCost: 0.12,
  samples: 3,
  bySource: { measured: 1, estimated: 1, unavailable: 1 },
};
const ok = { operationId: id("op", 1), commandId: id("cmd", 1) };

let seq = 0;
function ev(type: string, payload: unknown, over: Record<string, unknown> = {}): EventEnvelope {
  seq += 1;
  return {
    id: id("evt", seq),
    schemaVersion: 1,
    streamId: IDS.mission,
    sequence: seq,
    occurredAt: T,
    observedAt: T,
    type,
    source: "mimir",
    provenance: "observed",
    missionId: IDS.mission,
    payload,
    ...over,
  } as never;
}

const events: EventEnvelope[] = [
  ev(
    "task.started",
    { from: "leased", to: "running", agentId: IDS.agent, sessionId: IDS.session },
    { taskId: IDS.taskB, sessionId: IDS.session, crewId: IDS.crew },
  ),
  ev(
    "test.run_completed",
    { command: "pnpm test", passed: false, total: 10, failed: 1, durationMs: 900 },
    { taskId: IDS.taskA },
  ),
  ev(
    "artifact.recorded",
    {
      artifactId: IDS.artifact,
      taskId: IDS.taskA,
      kind: "diff",
      uri: "file:///x.diff",
      hash: "sha256:1",
    },
    { taskId: IDS.taskA },
  ),
  ev("policy.denied", { action: "git.push", reason: "requires approval" }, { taskId: IDS.taskC }),
  ev(
    "summary.created",
    { scope: "mission", text: "Task A finished", sourceEventIds: [] },
    { provenance: "summarized" },
  ),
];

export const fixtureClient: MimirClient = {
  health: async () => ({ status: "ok" as const, runtime: { ok: true } }),
  capabilities: async () => ({
    serverVersion: "0.1.0",
    protocolVersion: 1 as const,
    runtime: {
      runtime: "fake",
      version: "1",
      features: {
        createSession: true,
        sendInput: true,
        sendKeys: true,
        softStop: true,
        forceStop: true,
        pause: false,
        subscribe: true,
        terminalRead: true,
        processInfo: false,
        multiHost: false,
        notify: false,
      },
      agentKinds: ["shell", "claude"],
    },
  }),
  snapshot: async () =>
    ({
      projects: [
        {
          id: IDS.project,
          name: "demo",
          repoPath: "/repos/demo",
          settings: { testCommand: ["pnpm", "test"], protectedBranches: ["main"] },
          ...base,
        },
      ],
      missions: [
        {
          id: IDS.mission,
          projectId: IDS.project,
          objective: "Add login",
          status: "active",
          ...base,
        },
      ],
      crews: [
        {
          id: IDS.crew,
          missionId: IDS.mission,
          template: "default",
          status: "running",
          limits: { maxConcurrentTasks: 2 },
          ...base,
        },
      ],
      tasks: [
        {
          id: IDS.taskA,
          missionId: IDS.mission,
          crewId: IDS.crew,
          title: "Task A",
          acceptance: "",
          status: "completed",
          attempt: 1,
          maxAttempts: 3,
          agentId: null,
          leaseExpiresAt: null,
          ...base,
        },
        {
          id: IDS.taskB,
          missionId: IDS.mission,
          crewId: IDS.crew,
          title: "Task B",
          acceptance: "",
          status: "running",
          attempt: 1,
          maxAttempts: 3,
          agentId: IDS.agent,
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
          ...base,
        },
        {
          id: IDS.taskC,
          missionId: IDS.mission,
          crewId: IDS.crew,
          title: "Task C",
          acceptance: "",
          status: "blocked",
          blockedReason: "awaiting approval",
          attempt: 0,
          maxAttempts: 3,
          agentId: null,
          leaseExpiresAt: null,
          ...base,
        },
      ],
      taskDependencies: [{ id: id("tdp", 1), taskId: IDS.taskB, dependsOnId: IDS.taskA, ...base }],
      agents: [
        {
          id: IDS.agent,
          crewId: IDS.crew,
          role: "implementer",
          agentKind: "shell",
          runtimeSessionId: IDS.session,
          status: "running",
          taskId: IDS.taskB,
          ...base,
        },
      ],
      approvals: [
        {
          id: IDS.approval,
          action: "shell.destructive",
          status: "pending",
          actor: null,
          expiry: null,
          missionId: IDS.mission,
          taskId: IDS.taskC,
          reason: "rm -rf build",
          ...base,
        },
      ],
      worktrees: [],
      usage,
      cursor: "c0",
    }) as never,
  projects: { list: async () => ({ projects: [] }), create: async () => ({}) as never },
  missions: {
    list: async () => ({ missions: [] }),
    get: async () => ({}) as never,
    create: async () => ({}) as never,
    start: async () => ok as never,
    cancel: async () => ok as never,
  },
  crews: { list: async () => ({ crews: [] }), create: async () => ({}) as never },
  tasks: {
    list: async () => ({ tasks: [] }),
    create: async () => ({}) as never,
    retry: async () => ok as never,
    requestPr: async () => ({ ...ok, status: "delivered" as const }) as never,
  },
  approvals: { list: async () => ({ approvals: [] }), decide: async () => ok as never },
  sessions: {
    input: async () => ok as never,
    stop: async () => ok as never,
    terminal: async () => ({ text: "$ pnpm test\n✓ 10 tests\n", provenance: "observed" as const }),
  },
  events: {
    list: async () => ({ events, nextCursor: null, hasMore: false, lastCursor: null }),
    stream: (opts) => ({
      cursor: undefined,
      async *[Symbol.asyncIterator]() {
        opts?.onStatus?.("open");
        yield* events.slice(0, 3);
        await new Promise((r) => opts?.signal?.addEventListener("abort", r));
      },
    }),
    replayAll: async () => ({ events, cursor: "c0" }),
  },
  attention: { list: async () => ({ items: [] }) },
  artifacts: {
    content: async () => ({}) as never,
    get: async () =>
      ({
        artifact: {
          id: IDS.artifact,
          taskId: IDS.taskA,
          kind: "diff",
          uri: "file:///x.diff",
          hash: "sha256:1",
          ...base,
        },
      }) as never,
  },
  usage: { get: async () => ({ totals: usage, samples: [] }) },
};
