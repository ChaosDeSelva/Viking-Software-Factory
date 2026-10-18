import { describe, expect, it } from "vitest";
import { dryRun, estimatePlan, validatePlan } from "./dag.js";
import { DEFAULT_CAPS, type PlanTask } from "./schema.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const t = (id: string, over: Partial<PlanTask> = {}): PlanTask => ({
  id,
  objective: `do ${id}`,
  inputs: [],
  outputs: [],
  acceptanceCriteria: ["AC-1"],
  dependsOn: [],
  harnessId: "backend-node",
  harnessVersion: "1.0.0",
  harnessLockDigest: DIGEST,
  skills: ["api-design"],
  selectionRationale: [],
  role: "implementer",
  budget: { wallClockMinutes: 30, tokens: 1000 },
  maxRetries: 2,
  escalation: "ask",
  ...over,
});
const spec = { acceptanceCriteria: [{ id: "AC-1" }, { id: "AC-2" }] };
const tasks = () => [
  t("impl", { acceptanceCriteria: ["AC-1", "AC-2"] }),
  t("review", { role: "reviewer", dependsOn: ["impl"] }),
  t("qa", { role: "qa", dependsOn: ["review"] }),
  t("docs", { role: "docs", dependsOn: ["qa"], acceptanceCriteria: [] }),
];

describe("validatePlan", () => {
  it("accepts a well-formed DAG", () => {
    expect(validatePlan({ tasks: tasks() }, { spec })).toEqual([]);
  });

  it("rejects cycles, unknown and self dependencies, duplicate ids", () => {
    const cyc = tasks();
    cyc[0] = t("impl", { acceptanceCriteria: ["AC-1", "AC-2"], dependsOn: ["qa"] });
    expect(validatePlan({ tasks: cyc }, { spec }).join("\n")).toMatch(/cycle.*impl/);
    const bad = [...tasks(), t("x", { dependsOn: ["ghost", "x"] }), t("impl")];
    const issues = validatePlan({ tasks: bad }, { spec }).join("\n");
    expect(issues).toMatch(/x depends on unknown task ghost/);
    expect(issues).toMatch(/x depends on itself/);
    expect(issues).toMatch(/duplicate task id impl/);
  });

  it("requires every acceptance criterion to be covered and known", () => {
    const issues = validatePlan(
      { tasks: [t("impl", { acceptanceCriteria: ["AC-1", "AC-9"] })] },
      { spec },
    ).join("\n");
    expect(issues).toMatch(/AC-2 is not covered/);
    expect(issues).toMatch(/impl references unknown acceptance criterion AC-9/);
  });

  it("forbids further delegation", () => {
    const issues = validatePlan(
      { tasks: [...tasks(), t("sub", { role: "delegate" as "implementer" })] },
      { spec },
    ).join("\n");
    expect(issues).toMatch(/sub: role "delegate" is not allowed: tasks may not delegate/);
  });

  it("requires a pinned harness version and a lock digest", () => {
    const issues = validatePlan(
      {
        tasks: [
          t("impl", {
            acceptanceCriteria: ["AC-1", "AC-2"],
            harnessVersion: "^1.0.0",
            harnessLockDigest: "nope",
          }),
        ],
      },
      { spec },
    ).join("\n");
    expect(issues).toMatch(/harnessVersion/);
    expect(issues).toMatch(/harnessLockDigest/);
  });

  it("enforces per-task and total project caps", () => {
    const big = tasks().map((x) => ({
      ...x,
      maxRetries: 9,
      budget: { wallClockMinutes: 100, tokens: 10, costUsd: 3 },
    }));
    const issues = validatePlan(
      { tasks: big },
      {
        spec,
        caps: {
          ...DEFAULT_CAPS,
          maxRetries: 3,
          maxTaskWallClockMinutes: 90,
          maxTotalWallClockMinutes: 300,
          maxTotalCostUsd: 10,
          maxTasks: 3,
        },
      },
    ).join("\n");
    expect(issues).toMatch(/impl: maxRetries 9 exceeds cap 3/);
    expect(issues).toMatch(/impl: wallClockMinutes 100 exceeds cap 90/);
    expect(issues).toMatch(/total wallClockMinutes 400 exceeds cap 300/);
    expect(issues).toMatch(/total costUsd 12 exceeds cap 10/);
    expect(issues).toMatch(/4 tasks exceeds cap 3/);
  });
});

describe("estimatePlan", () => {
  it("sums budgets and computes the critical path", () => {
    const e = estimatePlan([
      t("a", { budget: { wallClockMinutes: 10, tokens: 5 } }),
      t("b", { budget: { wallClockMinutes: 20, tokens: 5 } }),
      t("c", { dependsOn: ["a", "b"], budget: { wallClockMinutes: 5 } }),
    ]);
    expect(e).toEqual({
      taskCount: 3,
      wallClockMinutes: 35,
      criticalPathMinutes: 25,
      tokens: 10,
      costUsd: null,
    });
  });
});

describe("dryRun", () => {
  it("dispatches in dependency order respecting per-role concurrency", () => {
    const plan = {
      tasks: [
        t("be"),
        t("fe"),
        t("ops"),
        t("rev-be", { role: "reviewer", dependsOn: ["be"] }),
        t("rev-fe", { role: "reviewer", dependsOn: ["fe"] }),
        t("qa", { role: "qa", dependsOn: ["rev-be", "rev-fe"] }),
        t("docs", { role: "docs", dependsOn: ["qa"] }),
      ],
    };
    const r = dryRun(plan, { concurrency: { implementer: 2, reviewer: 1 } });
    expect(r.steps.map((s) => s.tasks.map((x) => x.id))).toEqual([
      ["be", "fe"],
      ["ops", "rev-be"],
      ["rev-fe"],
      ["qa"],
      ["docs"],
    ]);
    expect(r.order).toEqual(["be", "fe", "ops", "rev-be", "rev-fe", "qa", "docs"]);
  });

  it("refuses to simulate a cyclic plan", () => {
    expect(() =>
      dryRun({ tasks: [t("a", { dependsOn: ["b"] }), t("b", { dependsOn: ["a"] })] }),
    ).toThrow(/cycle/);
  });

  it("refuses to simulate a plan with an unknown dependency instead of looping", () => {
    expect(() => dryRun({ tasks: [t("a", { dependsOn: ["ghost"] })] })).toThrow(/ghost/);
    expect(() => dryRun({ tasks: [t("a", { dependsOn: ["a"] })] })).toThrow(/cycle/);
  });
});
