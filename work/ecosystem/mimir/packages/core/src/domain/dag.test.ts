import { MimirError, type Task } from "@mimir/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeTask } from "./testing/fixtures.js";
import { findCycle, readyTasks, validateDag, type DepEdge } from "./dag.js";

const tasks = Array.from({ length: 6 }, () => makeTask());
const id = (i: number) => tasks[i]!.id;
const e = (a: number, b: number): DepEdge => ({ taskId: id(a), dependsOnId: id(b) });

function catchErr(fn: () => void): MimirError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MimirError);
    return err as MimirError;
  }
  throw new Error("expected throw");
}

describe("validateDag", () => {
  it.each([
    ["empty", []],
    ["chain", [e(1, 0), e(2, 1)]],
    ["diamond", [e(1, 0), e(2, 0), e(3, 1), e(3, 2)]],
    ["duplicate edge", [e(1, 0), e(1, 0)]],
  ])("accepts %s", (_n, deps) => {
    expect(() => validateDag(tasks, deps)).not.toThrow();
  });

  it.each([
    ["2-cycle", [e(0, 1), e(1, 0)], [0, 1]],
    ["3-cycle", [e(0, 1), e(1, 2), e(2, 0)], [0, 1, 2]],
    ["cycle behind a tail", [e(5, 0), e(0, 1), e(1, 2), e(2, 0)], [0, 1, 2]],
  ] as const)("rejects %s and names the cycle", (_n, deps, members) => {
    const err = catchErr(() => validateDag(tasks, [...deps]));
    expect(err.code).toBe("validation_failed");
    const d = err.details as { reason: string; cycle: string[] };
    expect(d.reason).toBe("cycle");
    // closed path: first == last, members are exactly the cycle
    expect(d.cycle[0]).toBe(d.cycle.at(-1));
    expect(new Set(d.cycle)).toEqual(new Set(members.map(id)));
    for (const tid of d.cycle) expect(err.message).toContain(tid);
  });

  it("rejects self-dependency", () => {
    const err = catchErr(() => validateDag(tasks, [e(2, 2)]));
    expect(err.details).toMatchObject({ reason: "self_dependency", taskId: id(2) });
  });

  it.each([
    ["unknown taskId", { taskId: "tsk_unknown", dependsOnId: tasks[0]!.id }, "tsk_unknown"],
    ["unknown dependsOnId", { taskId: tasks[0]!.id, dependsOnId: "tsk_missing" }, "tsk_missing"],
  ])("rejects %s", (_n, dep, bad) => {
    const err = catchErr(() => validateDag(tasks, [dep as unknown as DepEdge]));
    expect(err.details).toMatchObject({ reason: "unknown_task", taskId: bad });
  });

  it("property: forward-only edges are always acyclic; any back edge closing a path is rejected", () => {
    const pool = Array.from({ length: 8 }, () => makeTask());
    const edge = fc
      .tuple(fc.nat(7), fc.nat(7))
      .filter(([a, b]) => a !== b)
      .map(([a, b]) => (a > b ? [a, b] : [b, a]) as [number, number]);
    fc.assert(
      fc.property(fc.array(edge, { maxLength: 20 }), (pairs) => {
        const deps = pairs.map(([a, b]) => ({ taskId: pool[a]!.id, dependsOnId: pool[b]!.id }));
        expect(() => validateDag(pool, deps)).not.toThrow();
        expect(findCycle(deps)).toBeNull();
        if (pairs.length > 0) {
          const [a, b] = pairs[0]!; // a depends on b; adding b->a closes a cycle
          const cyclic = [...deps, { taskId: pool[b]!.id, dependsOnId: pool[a]!.id }];
          const cycle = findCycle(cyclic);
          expect(cycle).not.toBeNull();
          // every consecutive pair in the reported cycle is a real edge
          const has = new Set(cyclic.map((d) => `${d.taskId}>${d.dependsOnId}`));
          for (let i = 0; i + 1 < cycle!.length; i++) {
            expect(has.has(`${cycle![i]}>${cycle![i + 1]}`)).toBe(true);
          }
        }
      }),
    );
  });
});

describe("readyTasks", () => {
  const mk = (status: Task["status"]) => makeTask({ status });
  it.each([
    ["pending, no deps", ["pending"], [], [0]],
    ["pending, dep completed", ["pending", "completed"], [[0, 1]], [0]],
    ["pending, dep running", ["pending", "running"], [[0, 1]], []],
    [
      "pending, one of two deps done",
      ["pending", "completed", "failed"],
      [
        [0, 1],
        [0, 2],
      ],
      [],
    ],
    ["non-pending excluded", ["ready", "running", "completed"], [], []],
    ["pending, dep missing from task set", ["pending"], [[0, -1]], []],
    ["two independent pending", ["pending", "pending"], [], [0, 1]],
  ] as const)("%s", (_n, statuses, depIdx, want) => {
    const ts = statuses.map(mk);
    const deps = depIdx.map(([a, b]) => ({
      taskId: ts[a]!.id,
      dependsOnId: b < 0 ? ("tsk_ghost" as Task["id"]) : ts[b]!.id,
    }));
    expect(readyTasks(ts, deps).map((t) => t.id)).toEqual(want.map((i) => ts[i]!.id));
  });
});
