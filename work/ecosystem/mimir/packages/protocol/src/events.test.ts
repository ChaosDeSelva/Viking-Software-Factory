import { describe, expect, it } from "vitest";
import { MimirError } from "./errors.js";
import {
  EVENT_TYPES,
  EventEnvelopeSchema,
  EventTypeSchema,
  type EventPayloadMap,
  type EventType,
  parseEvent,
  payloadSchemaFor,
} from "./events.js";
import { newId } from "./ids.js";

const now = "2026-10-14T08:00:00.000Z";
const missionId = newId("msn");
const taskId = newId("tsk");
const crewId = newId("crw");
const agentId = newId("agt");
const sessionId = newId("ses");
const approvalId = newId("apr");
const worktreeId = newId("wtr");
const sha = "b".repeat(40);

const SAMPLE_PAYLOADS: { [K in EventType]: EventPayloadMap[K] } = {
  "mission.created": { projectId: newId("prj"), objective: "Ship it" },
  "mission.started": { from: "draft", to: "active" },
  "mission.paused": { from: "active", to: "paused", reason: "operator" },
  "mission.resumed": { from: "paused", to: "active" },
  "mission.cancelled": { from: "active", to: "cancelled", reason: "no longer needed" },
  "mission.completed": { from: "active", to: "completed" },
  "task.created": { missionId, crewId, title: "Do it", acceptance: "tests", dependsOn: [] },
  "task.ready": { from: "pending", to: "ready" },
  "task.leased": { from: "ready", to: "leased", agentId, attempt: 1, leaseExpiresAt: now },
  "task.started": { from: "leased", to: "running", agentId, sessionId },
  "task.blocked": { from: "running", to: "blocked", reason: "needs approval" },
  "task.verifying": { from: "running", to: "verifying" },
  "task.completed": { from: "verifying", to: "completed" },
  "task.failed": {
    from: "running",
    to: "failed",
    reason: "tests failed",
    attempt: 1,
    retryable: true,
  },
  "task.cancelled": { from: "running", to: "cancelled" },
  "task.retried": { from: "failed", to: "ready", attempt: 2 },
  "session.requested": { agentKind: "claude", crewId, taskId, workspaceLabel: "mimir/t1" },
  "session.started": { runtime: "herdr", runtimeRef: { paneId: "p1" } },
  "session.state_changed": { from: "starting", to: "running", runtimeStatus: "busy" },
  "session.output": { text: "hello\n", redacted: false, lines: 1 },
  "session.exited": { exitCode: 0 },
  "session.lost": { reason: "pane disappeared" },
  "tool.invoked": { tool: "bash", toolCallId: "tc1", input: { cmd: "ls" } },
  "tool.completed": { tool: "bash", toolCallId: "tc1", ok: true, durationMs: 12 },
  "git.worktree_created": { worktreeId, path: "/wt/1", branch: "mimir/t1", baseSha: sha },
  "git.worktree_removed": { worktreeId, path: "/wt/1" },
  "git.commit_observed": { worktreeId, sha, branch: "mimir/t1", message: "feat: x" },
  "git.conflict_detected": { worktreeId, branch: "mimir/t1", files: ["a.ts"] },
  "test.run_completed": {
    command: "pnpm test",
    passed: true,
    total: 10,
    failed: 0,
    durationMs: 900,
  },
  "approval.requested": { approvalId, action: "git.push", expiry: now, reason: "push to main" },
  "approval.decided": { approvalId, decision: "approved", actor: "user:local" },
  "approval.expired": { approvalId },
  "budget.warning": { budgetId: newId("bgt"), unit: "tokens", used: 800, limit: 1000 },
  "budget.exceeded": { budgetId: newId("bgt"), unit: "cost", used: 26, limit: 25 },
  "policy.denied": { action: "git.push", reason: "protected branch", policyId: newId("pol") },
  "recovery.reconciled": { sessions: 3, lostSessionIds: [sessionId], gap: false },
  "recovery.unknown_marked": { entityType: "session", entityId: sessionId, reason: "not found" },
  "summary.created": { scope: "task", text: "Did the thing", sourceEventIds: [newId("evt")] },
  "artifact.recorded": {
    artifactId: newId("art"),
    taskId,
    kind: "log",
    uri: "file:///a.log",
    hash: "sha256:x",
  },
  "mission.failed": { from: "active", to: "failed", reason: "task exhausted" },
  "session.input": { text: "please continue", redacted: false },
  "project.created": {
    project: {
      id: newId("prj"),
      name: "demo",
      repoPath: "/repo",
      settings: {},
      createdAt: now,
      updatedAt: now,
      version: 0,
    },
  },
  "crew.scheduling_changed": { crewId, paused: true },
  "crew.created": {
    crew: {
      id: crewId,
      missionId,
      template: "solo",
      status: "configured",
      limits: {},
      createdAt: now,
      updatedAt: now,
      version: 0,
    },
    members: [
      {
        id: newId("cmb"),
        crewId,
        role: "implementer",
        agentKind: "shell",
        name: "impl-1",
        createdAt: now,
        updatedAt: now,
        version: 0,
      },
    ],
  },
  "artifact.collection_skipped": {
    taskId,
    name: "big.log",
    reason: "file_too_large",
    bytes: 9_000_000,
    limitBytes: 8_388_608,
  },
  "artifact.collection_truncated": { taskId, found: 201, kept: 200, limit: 200 },
  "usage.recorded": {
    sample: {
      id: newId("usg"),
      agentId,
      tokens: null,
      estimatedCost: null,
      source: "unavailable",
      createdAt: now,
      updatedAt: now,
      version: 0,
    },
  },
  "approval.consumed": { approvalId, subject: "pr:tsk_x" },
};

function envelope(type: EventType, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: newId("evt"),
    schemaVersion: 1,
    streamId: `mission:${missionId}`,
    sequence: 0,
    occurredAt: now,
    observedAt: now,
    type,
    source: "mimir.scheduler",
    provenance: "derived",
    missionId,
    payload,
    ...extra,
  };
}

describe("event types", () => {
  it("is exactly the specified list", () => {
    expect(EVENT_TYPES).toEqual([
      "mission.created",
      "mission.started",
      "mission.paused",
      "mission.resumed",
      "mission.cancelled",
      "mission.completed",
      "task.created",
      "task.ready",
      "task.leased",
      "task.started",
      "task.blocked",
      "task.verifying",
      "task.completed",
      "task.failed",
      "task.cancelled",
      "task.retried",
      "session.requested",
      "session.started",
      "session.state_changed",
      "session.output",
      "session.exited",
      "session.lost",
      "tool.invoked",
      "tool.completed",
      "git.worktree_created",
      "git.worktree_removed",
      "git.commit_observed",
      "git.conflict_detected",
      "test.run_completed",
      "approval.requested",
      "approval.decided",
      "approval.expired",
      "budget.warning",
      "budget.exceeded",
      "policy.denied",
      "recovery.reconciled",
      "recovery.unknown_marked",
      "summary.created",
      "artifact.recorded",
      "mission.failed",
      "session.input",
      "project.created",
      "crew.created",
      "crew.scheduling_changed",
      "usage.recorded",
      "approval.consumed",
      "artifact.collection_skipped",
      "artifact.collection_truncated",
    ]);
    expect(EventTypeSchema.safeParse("mission.exploded").success).toBe(false);
  });
});

describe("EventEnvelopeSchema", () => {
  it("parses a valid envelope with optional fields", () => {
    const e = envelope(
      "session.output",
      { text: "x", redacted: true, lines: 1 },
      {
        sourceEventId: "herdr:42",
        correlationId: "corr-1",
        crewId,
        taskId,
        sessionId,
      },
    );
    expect(EventEnvelopeSchema.parse(e)).toEqual(e);
  });

  it.each([
    ["schemaVersion", 2],
    ["sequence", -1],
    ["sequence", 1.5],
    ["occurredAt", "now"],
    ["observedAt", 0],
    ["type", "nope"],
    ["provenance", "guessed"],
    ["id", "evt_bad"],
    ["sessionId", "pane-1"],
  ])("rejects invalid %s", (field, value) => {
    const r = EventEnvelopeSchema.safeParse(envelope("mission.started", {}, { [field]: value }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([field]);
  });

  it.each(["id", "streamId", "sequence", "occurredAt", "observedAt", "type", "source"])(
    "requires %s",
    (field) => {
      const e: Record<string, unknown> = envelope("mission.started", {});
      delete e[field];
      const r = EventEnvelopeSchema.safeParse(e);
      expect(r.error?.issues[0]?.path).toEqual([field]);
    },
  );
});

describe("payloads", () => {
  it("every EventType has a payload schema", () => {
    for (const type of EVENT_TYPES) {
      expect(payloadSchemaFor(type), type).toBeDefined();
    }
  });

  it.each(EVENT_TYPES)("parseEvent round-trips a %s sample", (type) => {
    const e = envelope(type, SAMPLE_PAYLOADS[type]);
    const parsed = parseEvent(JSON.stringify(e));
    expect(parsed).toEqual(e);
    expect(parseEvent(e)).toEqual(e);
  });

  it("session.output and session.state_changed have the specified shapes", () => {
    expect(payloadSchemaFor("session.output").safeParse({ text: "x", lines: 1 }).success).toBe(
      false,
    );
    expect(
      payloadSchemaFor("session.state_changed").safeParse({ from: "idle", to: "asleep" }).error
        ?.issues[0]?.path,
    ).toEqual(["to"]);
  });

  it("parseEvent rejects a bad payload with a payload-prefixed path", () => {
    const e = envelope("session.output", { text: "x", redacted: "no", lines: 1 });
    try {
      parseEvent(e);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MimirError);
      const m = err as MimirError;
      expect(m.code).toBe("validation_failed");
      expect(m.details).toMatchObject({ issues: [{ path: ["payload", "redacted"] }] });
    }
  });

  it("id-like payload fields are validated", () => {
    expect(
      payloadSchemaFor("recovery.reconciled").safeParse({
        sessions: 1,
        lostSessionIds: ["pane-1"],
        gap: false,
      }).error?.issues[0]?.path,
    ).toEqual(["lostSessionIds", 0]);
    expect(
      payloadSchemaFor("git.worktree_created").safeParse({
        worktreeId: worktreeId,
        path: "/wt",
        branch: "b",
        baseSha: "not-a-sha",
      }).error?.issues[0]?.path,
    ).toEqual(["baseSha"]);
  });

  it("accepts the optional orchestration fields added for T12", () => {
    const budget = {
      id: newId("bgt"),
      missionId,
      crewId: null,
      limitTokens: 1000,
      limitCost: null,
      warnAtFraction: 0.8,
      enforce: "hard",
      onUnknown: "allow",
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    const ok = (type: EventType, payload: unknown) =>
      expect(payloadSchemaFor(type).safeParse(payload).success, type).toBe(true);
    ok("mission.created", { projectId: newId("prj"), objective: "o", budget });
    ok("task.created", {
      missionId,
      crewId: null,
      title: "t",
      acceptance: "",
      dependsOn: [],
      brief: "echo hi",
      argv: ["sh", "-c", "echo hi"],
    });
    ok("test.run_completed", {
      command: "npm test",
      passed: false,
      exitCode: 1,
      output: "1 failed",
    });
    ok("test.run_completed", { command: "npm test", passed: false, exitCode: null });
    ok("artifact.recorded", {
      artifactId: newId("art"),
      taskId,
      kind: "git.diff",
      uri: "artifact://x",
      hash: "sha256:x",
      bytes: 12,
    });
    ok("artifact.recorded", {
      artifactId: newId("art"),
      taskId,
      kind: "review",
      uri: "artifact://x",
      hash: "sha256:x",
      name: "review.json",
    });
    ok("approval.requested", {
      approvalId,
      action: "runtime.force_stop",
      expiry: null,
      requestedBy: { kind: "system", id: "mimir" },
    });
    ok("crew.created", { ...SAMPLE_PAYLOADS["crew.created"], budget: { ...budget, crewId } });
    expect(
      payloadSchemaFor("approval.requested").safeParse({
        approvalId,
        action: "x",
        expiry: null,
        requestedBy: { kind: "robot", id: "r" },
      }).success,
    ).toBe(false);
    expect(
      payloadSchemaFor("mission.created").safeParse({
        projectId: newId("prj"),
        objective: "o",
        budget: { ...budget, enforce: "sometimes" },
      }).success,
    ).toBe(false);
  });

  it("binds approvals to a subject and persists worktree baseRef (T12 fix round 1)", () => {
    expect(
      payloadSchemaFor("approval.requested").safeParse({
        approvalId,
        action: "pr.create",
        expiry: null,
        subject: `pr:${taskId}`,
      }).success,
    ).toBe(true);
    expect(payloadSchemaFor("approval.consumed").safeParse({ approvalId }).success).toBe(true);
    expect(payloadSchemaFor("approval.consumed").safeParse({ approvalId: "x" }).success).toBe(
      false,
    );
    const wt = payloadSchemaFor("git.worktree_created").parse({
      worktreeId,
      path: "/wt",
      branch: "b",
      baseSha: sha,
      baseRef: "main",
    });
    expect(wt).toMatchObject({ baseRef: "main" });
  });

  it("parseEvent rejects a bad envelope and invalid JSON", () => {
    expect(() => parseEvent({ ...envelope("task.ready", {}), sequence: -3 })).toThrow(MimirError);
    expect(() => parseEvent("{not json")).toThrow(MimirError);
  });
});

describe("artifact collection events (T12b)", () => {
  it("collection_skipped requires a known reason; collection_truncated counts", () => {
    const skipped = payloadSchemaFor("artifact.collection_skipped");
    expect(skipped.safeParse({ taskId, name: "x", reason: "symlink" }).success).toBe(true);
    expect(skipped.safeParse({ taskId, name: "x", reason: "because" }).success).toBe(false);
    const truncated = payloadSchemaFor("artifact.collection_truncated");
    expect(truncated.safeParse({ taskId, found: 3, kept: 2, limit: 2 }).success).toBe(true);
    expect(truncated.safeParse({ taskId, found: 3, kept: -1, limit: 2 }).success).toBe(false);
  });
});
