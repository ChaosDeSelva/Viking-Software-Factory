import { APPROVAL_REQUIRED } from "@mimir/core";
import {
  MimirError,
  newId,
  payloadSchemaFor,
  type EventType,
  type Mission,
  type Task,
} from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { missionTransition, taskTransition } from "./transitions.js";

const T0 = "2026-01-01T00:00:00.000Z";
const task = (over: Partial<Task> = {}): Task => ({
  id: newId("tsk"),
  missionId: newId("msn"),
  crewId: newId("crw"),
  title: "t",
  acceptance: "",
  status: "pending",
  attempt: 0,
  maxAttempts: 2,
  agentId: null,
  leaseExpiresAt: null,
  createdAt: T0,
  updatedAt: T0,
  version: 0,
  ...over,
});
const mission = (status: Mission["status"]): Mission => ({
  id: newId("msn"),
  projectId: newId("prj"),
  objective: "o",
  status,
  createdAt: T0,
  updatedAt: T0,
  version: 0,
});
const valid = (e: { type: string; payload: unknown }) =>
  expect(payloadSchemaFor(e.type as EventType).safeParse(e.payload).success, e.type).toBe(true);

describe("taskTransition", () => {
  it("maps machine transitions to protocol task events with valid payloads", () => {
    const agentId = newId("agt");
    const sessionId = newId("ses");
    const cases = [
      [task(), { type: "deps_completed" }, {}, "task.ready"],
      [
        task({ status: "ready" }),
        { type: "lease_granted", crewId: null, leaseExpiresAt: T0 },
        { agentId },
        "task.leased",
      ],
      [
        task({ status: "leased" }),
        { type: "session_started", agentId },
        { agentId, sessionId },
        "task.started",
      ],
      [task({ status: "running" }), { type: "runtime_completed" }, {}, "task.verifying"],
      [task({ status: "verifying" }), { type: "verification_passed" }, {}, "task.completed"],
      [
        task({ status: "running" }),
        { type: "runtime_failed", reason: "x" },
        { reason: "x" },
        "task.failed",
      ],
      [task({ status: "failed" }), { type: "retry" }, {}, "task.retried"],
      [
        task({ status: "ready" }),
        { type: "dispatch_gated", reason: APPROVAL_REQUIRED },
        {},
        "task.blocked",
      ],
      [task({ status: "running" }), { type: "cancel" }, { cancelReason: "op" }, "task.cancelled"],
    ] as const;
    for (const [t, ev, ctx, type] of cases) {
      const { emit } = taskTransition(t, ev as never, ctx);
      expect(emit.type).toBe(type);
      expect(emit).toMatchObject({
        streamId: `task:${t.id}`,
        taskId: t.id,
        missionId: t.missionId,
      });
      valid(emit);
    }
  });

  it("task.leased carries the 1-based attempt; task.blocked carries the reason", () => {
    const { emit } = taskTransition(
      task({ status: "ready", attempt: 1 }),
      { type: "lease_granted", crewId: null, leaseExpiresAt: T0 },
      { agentId: newId("agt") },
    );
    expect(emit.payload).toMatchObject({ attempt: 2 });
    const blocked = taskTransition(task({ status: "ready" }), {
      type: "dispatch_gated",
      reason: APPROVAL_REQUIRED,
    });
    expect(blocked.emit.payload).toMatchObject({ reason: APPROVAL_REQUIRED });
  });

  it("refuses to build an event that lacks the agent or session it must name", () => {
    expect(() =>
      taskTransition(task({ status: "ready" }), {
        type: "lease_granted",
        crewId: null,
        leaseExpiresAt: T0,
      }),
    ).toThrow(/task.leased needs agentId/);
    expect(() =>
      taskTransition(
        task({ status: "leased" }),
        { type: "session_started", agentId: null },
        { agentId: newId("agt") },
      ),
    ).toThrow(/task.started needs sessionId/);
  });

  it("a next attempt deferred for capacity is a retry that says why and that it waits", () => {
    const verifying = task({ status: "verifying", attempt: 0, maxAttempts: 3 });
    const withReason = taskTransition(
      verifying,
      { type: "verification_deferred" },
      { reason: "verification_failed: exit 1" },
    );
    expect(withReason.next).toMatchObject({ status: "ready", attempt: 1, agentId: null });
    expect(withReason.emit).toMatchObject({
      type: "task.retried",
      payload: {
        from: "verifying",
        to: "ready",
        attempt: 1,
        reason: "verification_failed: exit 1",
        deferred: "awaiting_capacity",
      },
    });
    valid(withReason.emit);
    expect(taskTransition(verifying, { type: "verification_deferred" }).emit.payload).toMatchObject(
      { reason: "verification_deferred", deferred: "awaiting_capacity" },
    );
    const retried = taskTransition(task({ status: "failed" }), { type: "retry" }).emit.payload;
    expect(retried).not.toHaveProperty("deferred");
    expect(retried).not.toHaveProperty("reason");
    expect(() =>
      taskTransition(task({ status: "verifying", attempt: 1, maxAttempts: 2 }), {
        type: "verification_deferred",
      }),
    ).toThrow(/no attempts left/);
  });

  it("defaults a failure's reason to the event and leaves out an absent cancel reason", () => {
    const failed = taskTransition(task({ status: "verifying" }), { type: "verification_errored" });
    expect(failed.emit.payload).toMatchObject({ reason: "verification_errored", to: "failed" });
    valid(failed.emit);
    const cancelled = taskTransition(task({ status: "ready" }), { type: "cancel" });
    expect(cancelled.emit.payload).toEqual({ from: "ready", to: "cancelled" });
    valid(cancelled.emit);
  });

  it("refuses an illegal edge before anything is emitted", () => {
    expect(() => taskTransition(task(), { type: "verification_passed" })).toThrow(MimirError);
  });
});

describe("missionTransition", () => {
  it.each([
    ["draft", { type: "start" }, "mission.started"],
    ["active", { type: "pause" }, "mission.paused"],
    ["paused", { type: "resume" }, "mission.resumed"],
    ["active", { type: "cancel", reason: "op" }, "mission.cancelled"],
    ["active", { type: "fail", reason: "x" }, "mission.failed"],
    [
      "active",
      { type: "complete", tasks: [{ status: "completed", attempt: 0, maxAttempts: 1 }] },
      "mission.completed",
    ],
  ] as const)("%s --%o--> %s", (status, ev, type) => {
    const { emit } = missionTransition(mission(status), ev as never);
    expect(emit.type).toBe(type);
    valid(emit);
  });
});
