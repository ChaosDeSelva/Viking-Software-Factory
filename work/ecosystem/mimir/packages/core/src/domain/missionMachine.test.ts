import { MimirError, MissionStatusSchema, type MissionStatus } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { makeMission, makeTask } from "./testing/fixtures.js";
import { canCompleteMission, missionMachine, type MissionEvent } from "./missionMachine.js";

const ALL: readonly MissionStatus[] = MissionStatusSchema.options;
const done = [makeTask({ status: "completed" })];

const EVENTS: Record<MissionEvent["type"], MissionEvent> = {
  start: { type: "start" },
  pause: { type: "pause" },
  resume: { type: "resume" },
  complete: { type: "complete", tasks: done },
  cancel: { type: "cancel" },
  fail: { type: "fail", reason: "task exhausted" },
};

const ALLOWED: ReadonlyArray<[MissionStatus, MissionEvent["type"], MissionStatus]> = [
  ["draft", "start", "active"],
  ["active", "pause", "paused"],
  ["paused", "resume", "active"],
  ["active", "complete", "completed"],
  ["draft", "cancel", "cancelled"],
  ["active", "cancel", "cancelled"],
  ["paused", "cancel", "cancelled"],
  ["active", "fail", "failed"],
  ["paused", "fail", "failed"],
];

const allowedKey = new Set(ALLOWED.map(([f, e]) => `${f}|${e}`));
const FORBIDDEN = ALL.flatMap((from) =>
  (Object.keys(EVENTS) as MissionEvent["type"][])
    .filter((ev) => !allowedKey.has(`${from}|${ev}`))
    .map((ev) => [from, ev] as const),
);

describe("missionMachine.transition", () => {
  it("tables cover every pair", () => {
    expect(ALLOWED.length + FORBIDDEN.length).toBe(ALL.length * Object.keys(EVENTS).length);
  });

  it.each(ALLOWED)("%s --%s--> %s", (from, ev, to) => {
    const m = makeMission({ status: from });
    expect(missionMachine.transition(m, EVENTS[ev]).status).toBe(to);
    expect(m.status).toBe(from);
  });

  it.each(FORBIDDEN)("%s --%s--> invalid_transition", (from, ev) => {
    const m = makeMission({ status: from });
    try {
      missionMachine.transition(m, EVENTS[ev]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MimirError);
      expect((e as MimirError).code).toBe("invalid_transition");
      expect((e as MimirError).message).toContain(from);
      expect((e as MimirError).details).toMatchObject({ entity: "mission", from, event: ev });
    }
  });
});

describe("mission completion guard", () => {
  it.each([
    ["no tasks", [], false],
    ["all completed", ["completed", "completed"], true],
    ["completed + cancelled", ["completed", "cancelled"], true],
    ["only cancelled", ["cancelled"], false],
    ["one running", ["completed", "running"], false],
    ["an exhausted failure fails the mission instead", ["completed", "failed:exhausted"], false],
    ["retryable failure is not terminal", ["completed", "failed"], false],
  ] as const)("%s -> %s", (_name, statuses, ok) => {
    const tasks = statuses.map((s) =>
      s === "failed:exhausted"
        ? makeTask({ status: "failed", attempt: 2, maxAttempts: 3 })
        : makeTask({ status: s }),
    );
    expect(canCompleteMission(tasks)).toBe(ok);
    const m = makeMission({ status: "active" });
    if (ok) {
      expect(missionMachine.transition(m, { type: "complete", tasks }).status).toBe("completed");
    } else {
      expect(() => missionMachine.transition(m, { type: "complete", tasks })).toThrow(MimirError);
    }
  });
});
