import { newId, type TaskStatus } from "@mimir/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { T0, at, makeTask } from "./testing/fixtures.js";
import { blockedTooLong, stuckDetector } from "./escalation.js";

const MIN = 60_000;

describe("blockedTooLong", () => {
  it.each([
    ["blocked", 10 * MIN, 5 * MIN, true],
    ["blocked", 5 * MIN, 5 * MIN, true],
    ["blocked", 5 * MIN - 1, 5 * MIN, false],
    ["running", 60 * MIN, 5 * MIN, false],
    ["ready", 60 * MIN, 5 * MIN, false],
  ] as const)("%s for %ims (threshold %i) -> %s", (status: TaskStatus, age, threshold, want) => {
    const task = makeTask({ status, updatedAt: T0 });
    const item = blockedTooLong(task, new Date(at(age)), threshold);
    if (!want) return expect(item).toBeNull();
    expect(item).toEqual({
      kind: "blocked_too_long",
      taskId: task.id,
      missionId: task.missionId,
      since: T0,
      ageMs: age,
      thresholdMs: threshold,
    });
  });
});

describe("stuckDetector", () => {
  const subject = { taskId: newId("tsk") };
  it.each([
    [MIN, 2 * MIN, null],
    [2 * MIN, 2 * MIN, "stuck"],
    [3 * MIN, 2 * MIN, "stuck"],
  ] as const)("silent %ims, threshold %ims -> %s", (age, threshold, want) => {
    const item = stuckDetector(T0, new Date(at(age)), threshold, subject);
    if (want === null) return expect(item).toBeNull();
    expect(item).toEqual({ kind: "stuck", subject, since: T0, ageMs: age, thresholdMs: threshold });
  });

  it("treats a missing last event as never-heard-from (not stuck)", () => {
    expect(stuckDetector(null, new Date(at(10 * MIN)), MIN)).toBeNull();
  });

  it("property: flags iff age >= threshold", () => {
    fc.assert(
      fc.property(fc.nat(10 * MIN), fc.integer({ min: 1, max: 10 * MIN }), (age, threshold) => {
        const item = stuckDetector(T0, new Date(at(age)), threshold);
        expect(item !== null).toBe(age >= threshold);
      }),
    );
  });
});
