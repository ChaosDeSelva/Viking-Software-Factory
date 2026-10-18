import { openEventStore, encodeCursor, type AppendInput, type EventStore } from "@mimir/core";
import {
  SnapshotResponseSchema,
  newId,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
  type Project,
} from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ReadModel } from "./readmodel.js";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

function ev<T extends EventType>(
  type: T,
  payload: EventPayloadMap[T],
  extra: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    id: newId("evt"),
    schemaVersion: 1,
    streamId: "s",
    sequence: 1,
    occurredAt: T0,
    observedAt: T0,
    type,
    source: "mimir",
    provenance: "observed",
    payload,
    ...extra,
  };
}

function input<T extends EventType>(
  type: T,
  payload: EventPayloadMap[T],
  extra: Partial<AppendInput> = {},
): AppendInput {
  return {
    streamId: "s",
    occurredAt: T0,
    observedAt: T0,
    type,
    source: "mimir",
    provenance: "observed",
    payload,
    ...extra,
  };
}

const ids = () => ({
  projectId: newId("prj"),
  missionId: newId("msn"),
  crewId: newId("crw"),
  taskId: newId("tsk"),
  depId: newId("tsk"),
  agentId: newId("agt"),
  sessionId: newId("ses"),
  approvalId: newId("apr"),
  worktreeId: newId("wtr"),
});

describe("ReadModel.apply", () => {
  it("starts empty with zero usage and the given cursor", () => {
    const rm = new ReadModel({ cursor: encodeCursor(0) });
    const snap = rm.snapshot();
    expect(SnapshotResponseSchema.parse(snap)).toEqual(snap);
    expect(snap).toMatchObject({
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
      cursor: encodeCursor(0),
    });
  });

  it("projects a mission through its lifecycle, bumping version and updatedAt", () => {
    const { projectId, missionId } = ids();
    const rm = new ReadModel();
    rm.apply(ev("mission.created", { projectId, objective: "ship it" }, { missionId }), "c1");
    expect(rm.missions.get(missionId)).toMatchObject({
      id: missionId,
      projectId,
      objective: "ship it",
      status: "draft",
      version: 0,
      createdAt: T0,
    });
    rm.apply(
      ev("mission.started", { from: "draft", to: "active" }, { missionId, occurredAt: T1 }),
      "c2",
    );
    expect(rm.missions.get(missionId)).toMatchObject({
      status: "active",
      version: 1,
      updatedAt: T1,
    });
    expect(rm.cursor).toBe("c2");
  });

  it("projects tasks, dependencies, leases, sessions and agents", () => {
    const { missionId, crewId, taskId, depId, agentId, sessionId } = ids();
    const rm = new ReadModel();
    rm.apply(
      ev(
        "task.created",
        { missionId, crewId, title: "dep", acceptance: "", dependsOn: [] },
        { taskId: depId },
      ),
    );
    rm.apply(
      ev(
        "task.created",
        { missionId, crewId, title: "A", acceptance: "tests pass", dependsOn: [depId] },
        { taskId, missionId },
      ),
    );
    expect(rm.tasks.get(taskId)).toMatchObject({
      missionId,
      crewId,
      title: "A",
      status: "pending",
      attempt: 0,
      agentId: null,
      leaseExpiresAt: null,
    });
    const deps = rm.snapshot().taskDependencies;
    expect(deps).toEqual([expect.objectContaining({ taskId, dependsOnId: depId })]);

    rm.apply(ev("task.ready", { from: "pending", to: "ready" }, { taskId }));
    rm.apply(
      ev(
        "task.leased",
        { from: "ready", to: "leased", agentId, attempt: 1, leaseExpiresAt: T1 },
        { taskId },
      ),
    );
    // task.leased carries the 1-based attempt number; Task.attempt is 0-based (core taskMachine)
    expect(rm.tasks.get(taskId)).toMatchObject({
      status: "leased",
      agentId,
      attempt: 0,
      leaseExpiresAt: T1,
    });

    rm.apply(
      ev(
        "session.requested",
        { agentKind: "shell", crewId, taskId, workspaceLabel: "w" },
        { sessionId, taskId },
      ),
    );
    rm.apply(
      ev("session.started", { runtime: "fake", runtimeRef: { paneId: "p1" } }, { sessionId }),
    );
    rm.apply(ev("task.started", { from: "leased", to: "running", agentId, sessionId }, { taskId }));
    expect(rm.agents.get(agentId)).toMatchObject({
      crewId,
      agentKind: "shell",
      runtimeSessionId: sessionId,
      taskId,
      status: "starting",
    });
    rm.apply(
      ev(
        "session.state_changed",
        { from: "starting", to: "running", runtimeStatus: "working" },
        { sessionId },
      ),
    );
    expect(rm.sessions.get(sessionId)).toMatchObject({
      state: "running",
      runtime: "fake",
      runtimeRef: { paneId: "p1" },
      runtimeStatus: "working",
    });
    expect(rm.agents.get(agentId)?.status).toBe("running");

    rm.apply(ev("session.exited", { exitCode: 0 }, { sessionId }));
    expect(rm.sessions.get(sessionId)?.exitCode).toBe(0);
    rm.apply(ev("task.verifying", { from: "running", to: "verifying" }, { taskId }));
    rm.apply(ev("task.completed", { from: "verifying", to: "completed" }, { taskId }));
    expect(rm.tasks.get(taskId)).toMatchObject({ status: "completed", leaseExpiresAt: null });

    rm.apply(ev("session.lost", { reason: "gone" }, { sessionId }));
    expect(rm.sessions.get(sessionId)).toMatchObject({ state: "unknown", lostReason: "gone" });
    expect(rm.agents.get(agentId)?.status).toBe("unknown");
  });

  it("sets blockedReason while a task is blocked and clears it afterwards", () => {
    const { missionId, taskId } = ids();
    const rm = new ReadModel();
    rm.apply(
      ev(
        "task.created",
        { missionId, crewId: null, title: "A", acceptance: "", dependsOn: [] },
        { taskId },
      ),
    );
    rm.apply(ev("task.blocked", { from: "running", to: "blocked", reason: "trust" }, { taskId }));
    expect(rm.tasks.get(taskId)?.blockedReason).toBe("trust");
    rm.apply(ev("task.cancelled", { from: "blocked", to: "cancelled" }, { taskId }));
    expect(rm.tasks.get(taskId)).not.toHaveProperty("blockedReason");
  });

  it("projects task failure and retry", () => {
    const { missionId, taskId, agentId } = ids();
    const rm = new ReadModel();
    rm.apply(
      ev(
        "task.created",
        { missionId, crewId: null, title: "A", acceptance: "", dependsOn: [] },
        { taskId },
      ),
    );
    rm.apply(
      ev(
        "task.leased",
        { from: "ready", to: "leased", agentId, attempt: 1, leaseExpiresAt: T1 },
        { taskId },
      ),
    );
    rm.apply(
      ev(
        "task.failed",
        { from: "running", to: "failed", reason: "boom", attempt: 1, retryable: true },
        { taskId },
      ),
    );
    expect(rm.tasks.get(taskId)).toMatchObject({ status: "failed", leaseExpiresAt: null });
    rm.apply(ev("task.retried", { from: "failed", to: "ready", attempt: 2 }, { taskId }));
    expect(rm.tasks.get(taskId)).toMatchObject({ status: "ready", attempt: 2, agentId: null });
  });

  it("projects approvals and worktrees", () => {
    const { missionId, taskId, approvalId, worktreeId } = ids();
    const rm = new ReadModel();
    rm.apply(
      ev(
        "approval.requested",
        { approvalId, action: "runtime.force_stop", expiry: null, reason: "stuck" },
        { missionId, taskId },
      ),
    );
    expect(rm.approvals.get(approvalId)).toMatchObject({
      status: "pending",
      action: "runtime.force_stop",
      missionId,
      taskId,
      actor: null,
      reason: "stuck",
    });
    rm.apply(ev("approval.decided", { approvalId, decision: "approved", actor: "operator" }, {}));
    expect(rm.approvals.get(approvalId)).toMatchObject({
      status: "approved",
      actor: "operator",
      version: 1,
    });

    const sha = "a".repeat(40);
    rm.apply(
      ev(
        "git.worktree_created",
        { worktreeId, path: "/w/1", branch: "mimir/t1", baseSha: sha },
        { taskId },
      ),
    );
    expect(rm.worktrees.get(worktreeId)).toMatchObject({ status: "active", taskId });
    rm.apply(ev("git.conflict_detected", { worktreeId, branch: "mimir/t1", files: ["a"] }));
    expect(rm.worktrees.get(worktreeId)?.status).toBe("conflicted");
    rm.apply(ev("git.worktree_removed", { worktreeId, path: "/w/1" }));
    expect(rm.worktrees.get(worktreeId)?.status).toBe("removed");
  });

  it("ignores events with invalid payloads or unknown targets without throwing", () => {
    const { missionId, taskId } = ids();
    const rm = new ReadModel();
    const skipped: string[] = [];
    const rm2 = new ReadModel({ onSkip: (e) => skipped.push(e.type) });
    const bad = ev("mission.created", { truncated: true } as never, { missionId });
    expect(() => rm.apply(bad)).not.toThrow();
    rm2.apply(bad);
    rm2.apply(ev("task.ready", { from: "pending", to: "ready" }, { taskId }));
    expect(rm.missions.size).toBe(0);
    expect(skipped).toEqual(["mission.created", "task.ready"]);
  });

  it("projects project.created, crew.created (with budget) and usage.recorded", () => {
    const { missionId, crewId, agentId } = ids();
    const rm = new ReadModel();
    const project: Project = {
      id: newId("prj"),
      name: "p",
      repoPath: "/r",
      settings: { testCommand: ["npm", "test"] },
      createdAt: T0,
      updatedAt: T0,
      version: 0,
    };
    rm.apply(ev("project.created", { project }));
    expect(rm.snapshot().projects).toEqual([project]);

    const crew = {
      id: crewId,
      missionId,
      template: "solo",
      status: "configured" as const,
      limits: { maxConcurrentTasks: 2 },
      createdAt: T0,
      updatedAt: T0,
      version: 0,
    };
    const member = {
      id: newId("cmb"),
      crewId,
      role: "implementer" as const,
      agentKind: "shell",
      name: "impl",
      createdAt: T0,
      updatedAt: T0,
      version: 0,
    };
    const budget = {
      id: newId("bgt"),
      missionId,
      crewId,
      limitTokens: 100,
      limitCost: null,
      warnAtFraction: 0.8,
      enforce: "soft" as const,
      createdAt: T0,
      updatedAt: T0,
      version: 0,
    };
    rm.apply(ev("crew.created", { crew, members: [member], budget }, { crewId, missionId }));
    expect(rm.snapshot().crews).toEqual([crew]);
    expect(rm.crewMembers.get(member.id)).toEqual(member);
    expect(rm.budgets.get(budget.id)).toEqual(budget);

    const sample = {
      id: newId("usg"),
      agentId,
      tokens: null,
      estimatedCost: null,
      source: "unavailable" as const,
      createdAt: T0,
      updatedAt: T0,
      version: 0,
    };
    rm.apply(ev("usage.recorded", { sample }));
    expect(rm.snapshot().usage).toMatchObject({ samples: 1, bySource: { unavailable: 1 } });
  });

  it("projects mission budgets, mission.failed, task instructions and verification retries", () => {
    const { projectId, missionId, taskId, agentId, sessionId } = ids();
    const rm = new ReadModel();
    const budget = {
      id: newId("bgt"),
      missionId,
      crewId: null,
      limitTokens: null,
      limitCost: 5,
      warnAtFraction: 0.8,
      createdAt: T0,
      updatedAt: T0,
      version: 0,
    };
    rm.apply(ev("mission.created", { projectId, objective: "o", budget }, { missionId }));
    expect(rm.budgets.get(budget.id)).toEqual(budget);
    rm.apply(ev("mission.started", { from: "draft", to: "active" }, { missionId }));
    rm.apply(ev("mission.failed", { from: "active", to: "failed" }, { missionId }));
    expect(rm.missions.get(missionId)?.status).toBe("failed");

    rm.apply(
      ev(
        "task.created",
        {
          missionId,
          crewId: null,
          title: "A",
          acceptance: "",
          dependsOn: [],
          brief: "ls",
          argv: ["ls", "-la"],
        },
        { taskId, missionId },
      ),
    );
    expect(rm.taskSpec(taskId)).toEqual({ brief: "ls", argv: ["ls", "-la"] });
    rm.apply(ev("task.verifying", { from: "running", to: "verifying" }, { taskId }));
    rm.apply(
      ev("task.started", { from: "verifying", to: "running", agentId, sessionId }, { taskId }),
    );
    // verification_failed with attempts left: back to running on the next attempt
    expect(rm.tasks.get(taskId)).toMatchObject({ status: "running", attempt: 1 });
  });

  it("task.leased assigns the leasing crew (envelope crewId) to an unassigned task", () => {
    const { missionId, crewId, taskId, agentId } = ids();
    const rm = new ReadModel();
    rm.apply(
      ev(
        "task.created",
        { missionId, crewId: null, title: "A", acceptance: "", dependsOn: [] },
        { taskId, missionId },
      ),
    );
    rm.apply(
      ev(
        "task.leased",
        { from: "ready", to: "leased", agentId, attempt: 1, leaseExpiresAt: T1 },
        { taskId, crewId },
      ),
    );
    expect(rm.tasks.get(taskId)?.crewId).toBe(crewId);
  });

  it("an unassigned task takes maxAttempts from the crew that leases it", () => {
    const { missionId, crewId, taskId, agentId } = ids();
    const rm = new ReadModel();
    const crew = {
      id: crewId,
      missionId,
      template: "solo",
      status: "configured" as const,
      limits: { maxAttemptsPerTask: 2 },
      createdAt: T0,
      updatedAt: T0,
      version: 0,
    };
    rm.apply(ev("crew.created", { crew, members: [] }, { crewId, missionId }));
    rm.apply(
      ev(
        "task.created",
        { missionId, crewId: null, title: "A", acceptance: "", dependsOn: [] },
        { taskId, missionId },
      ),
    );
    expect(rm.tasks.get(taskId)?.maxAttempts).toBe(3);
    rm.apply(
      ev(
        "task.leased",
        { from: "ready", to: "leased", agentId, attempt: 1, leaseExpiresAt: T1 },
        { taskId, crewId },
      ),
    );
    expect(rm.tasks.get(taskId)).toMatchObject({ crewId, maxAttempts: 2 });
  });

  it("session.started does not roll back a state observed before it", () => {
    const { crewId, taskId, sessionId } = ids();
    const rm = new ReadModel();
    rm.apply(
      ev(
        "session.requested",
        { agentKind: "shell", crewId, taskId, workspaceLabel: "w" },
        { sessionId },
      ),
    );
    rm.apply(ev("session.state_changed", { from: "requested", to: "running" }, { sessionId }));
    rm.apply(
      ev("session.started", { runtime: "fake", runtimeRef: { paneId: "p" } }, { sessionId }),
    );
    expect(rm.sessions.get(sessionId)).toMatchObject({ state: "running", runtime: "fake" });
  });

  it("projects approval subjects, consumption and worktree baseRef (fix round 1)", () => {
    const { taskId, approvalId, worktreeId } = ids();
    const rm = new ReadModel();
    rm.apply(
      ev(
        "approval.requested",
        { approvalId, action: "pr.create", expiry: null, subject: `pr:${taskId}` },
        { taskId },
      ),
    );
    expect(rm.approvalMeta.get(approvalId)).toMatchObject({
      subject: `pr:${taskId}`,
      consumed: false,
    });
    rm.apply(ev("approval.consumed", { approvalId, subject: `pr:${taskId}` }));
    expect(rm.approvalMeta.get(approvalId)?.consumed).toBe(true);
    rm.apply(
      ev(
        "git.worktree_created",
        { worktreeId, path: "/w", branch: "b", baseSha: "a".repeat(40), baseRef: "main" },
        { taskId },
      ),
    );
    expect(rm.worktreeBaseRefs.get(worktreeId)).toBe("main");
  });

  it("projects artifacts and approval request metadata", () => {
    const { taskId, approvalId, sessionId } = ids();
    const rm = new ReadModel();
    const artifactId = newId("art");
    rm.apply(
      ev(
        "artifact.recorded",
        { artifactId, taskId, kind: "git.diff", uri: "artifact://x", hash: "sha256:ab", bytes: 3 },
        { taskId },
      ),
    );
    expect(rm.artifacts.get(artifactId)).toMatchObject({
      id: artifactId,
      taskId,
      kind: "git.diff",
      hash: "sha256:ab",
      version: 0,
    });
    expect(rm.artifactBytes.get(artifactId)).toBe(3);
    rm.apply(
      ev(
        "approval.requested",
        {
          approvalId,
          action: "runtime.force_stop",
          expiry: null,
          reason: "stop it",
          requestedBy: { kind: "system", id: "mimir" },
        },
        { sessionId, taskId },
      ),
    );
    expect(rm.approvalMeta.get(approvalId)).toEqual({
      requestedBy: { kind: "system", id: "mimir" },
      payloadSummary: "stop it",
      sessionId,
      subject: null,
      consumed: false,
    });
  });
});

describe("ReadModel with a store", () => {
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  it("rebuilds from the store on boot and stays current through subscribe", () => {
    const store = openEventStore(":memory:");
    stores.push(store);
    const { projectId, missionId, taskId, depId } = ids();
    store.append(input("mission.created", { projectId, objective: "o" }, { missionId }));
    store.append(
      input(
        "task.created",
        { missionId, crewId: null, title: "A", acceptance: "", dependsOn: [] },
        { taskId: depId },
      ),
    );
    store.append(
      input(
        "task.created",
        { missionId, crewId: null, title: "B", acceptance: "", dependsOn: [depId] },
        { taskId },
      ),
    );

    const rm = ReadModel.load(store, { pageSize: 1 });
    expect(rm.missions.get(missionId)?.status).toBe("draft");
    expect(rm.tasks.size).toBe(2);
    expect(rm.cursor).toBe(store.latestCursor());

    store.append(input("mission.started", { from: "draft", to: "active" }, { missionId }));
    expect(rm.missions.get(missionId)?.status).toBe("active");
    expect(rm.cursor).toBe(store.latestCursor());

    // A second rebuild yields an identical snapshot (deterministic dependency ids).
    const again = ReadModel.load(store);
    expect(again.snapshot()).toEqual(rm.snapshot());
    rm.detach();
    again.detach();
  });

  it("boots from the earliest retained event after a prune", () => {
    const store = openEventStore(":memory:");
    stores.push(store);
    const { projectId } = ids();
    const missions = [1, 2, 3].map(() => newId("msn"));
    for (const missionId of missions) {
      store.append(input("mission.created", { projectId, objective: "o" }, { missionId }));
    }
    store.prune(encodeCursor(1));
    const rm = ReadModel.load(store);
    expect([...rm.missions.keys()]).toEqual(missions.slice(1));
    expect(rm.cursor).toBe(store.latestCursor());
    rm.detach();
  });
});
