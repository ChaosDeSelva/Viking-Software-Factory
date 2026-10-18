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
