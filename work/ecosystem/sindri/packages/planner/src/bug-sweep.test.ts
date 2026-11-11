import { FakeProvider, type CompleteRequest } from "@sindri/director";
import { FakeHarnessService } from "@sindri/harnesses";
import { openIntake } from "@sindri/intake";
import { openDatabase, openKnowledge, SECRET_REDACTED } from "@sindri/knowledge";
import { openSpecs } from "@sindri/specs";
import { describe, expect, it } from "vitest";
import { dryRun, estimatePlan, PlanValidationError, topoOrder, validatePlan } from "./dag.js";
import { openPlanner, SKELETON_MARKER } from "./planner.js";
import type { PlanTask } from "./schema.js";

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
  skills: [],
  selectionRationale: [],
  role: "implementer",
  budget: { wallClockMinutes: 30 },
  maxRetries: 1,
  escalation: "ask",
  ...over,
});
const spec = { acceptanceCriteria: [{ id: "AC-1" }] };

describe("a dependency listed twice is one dependency, not a cycle", () => {
  const tasks = () => [t("impl"), t("review", { role: "reviewer", dependsOn: ["impl", "impl"] })];

  it("orders the tasks", () => {
    expect(topoOrder(tasks())).toEqual({ order: ["impl", "review"], cycle: [] });
  });
  it("validates, estimates and dry-runs the plan", () => {
    expect(validatePlan({ tasks: tasks() }, { spec })).toEqual([]);
    expect(estimatePlan(tasks()).criticalPathMinutes).toBe(60);
    expect(dryRun({ tasks: tasks() }).order).toEqual(["impl", "review"]);
  });
  it("still reports a real cycle", () => {
    const cyc = [t("a", { dependsOn: ["b", "b"] }), t("b", { dependsOn: ["a"] })];
    expect(topoOrder(cyc).cycle).toEqual(["a", "b"]);
  });
});

describe("dryRun with duplicate task ids", () => {
  it("fails instead of looping forever", () => {
    // Both entries share one id, so "every id done" was never reached and steps grew unbounded.
    const plan = { tasks: [t("a"), t("a")] };
    expect(() => dryRun(plan)).toThrow(PlanValidationError);
    expect(() => dryRun(plan)).toThrow("duplicate task id a");
  });
});

describe("validatePlan with tasks that are not plan tasks", () => {
  it("returns issues for missing fields instead of throwing", () => {
    const issues = validatePlan({ tasks: [{ id: "a" } as unknown as PlanTask] }, { spec });
    expect(issues.join("\n")).toMatch(/a: dependsOn: /);
    expect(issues.join("\n")).toMatch(/a: budget: /);
  });
  it("returns an issue for an entry that is not an object", () => {
    const issues = validatePlan({ tasks: [t("ok"), null as unknown as PlanTask] }, { spec });
    expect(issues).toEqual(["task 1 is not an object"]);
  });
});

describe("propose: secrets in the model's task text", () => {
  it("are redacted before the plan is stored", async () => {
    const db = openDatabase(":memory:");
    try {
      const projectId = openKnowledge(db).projects.create({ name: "d", repoPath: "/tmp/d" }).id;
      const intakeId = openIntake(db).createManual({ projectId, title: "t", body: "b" }).id;
      const specs = openSpecs(db);
      const draft = specs.createDraft({
        projectId,
        intakeId,
        title: "Export",
        body: {
          problem: "p",
          goals: [],
          nonGoals: [],
          constraints: [],
          assumptions: [],
          acceptanceCriteria: [
            { id: "AC-1", text: "API endpoint returns CSV", verification: "test" },
          ],
          risks: [],
          openQuestions: [],
        },
        provenance: {
          problem: [{ intakeId }],
          goals: [],
          nonGoals: [],
          constraints: [],
          assumptions: [],
          risks: [],
          openQuestions: [],
          acceptanceCriteria: { "AC-1": [{ intakeId }] },
        },
      });
      specs.submitForReview(draft.id);
      const approved = specs.approve(draft.id, { approver: "me" });
      // The planning provider may read the workspace, so its text can quote a key from a file.
      const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const provider = new FakeProvider((req: CompleteRequest) => {
        const text = req.messages[0]?.content ?? "";
        const skeleton = JSON.parse(
          text.slice(text.indexOf(SKELETON_MARKER) + SKELETON_MARKER.length),
        ) as { tasks: { id: string }[] };
        return {
          output: {
            tasks: skeleton.tasks.map((s) => ({
              id: s.id,
              objective: `Call the API with ${key}`,
              inputs: [`config with api_key = ${key}`],
              outputs: [`log line Bearer ${key}`],
            })),
          },
        };
      });
      const plan = await openPlanner(db).propose(approved, {
        provider,
        harnesses: new FakeHarnessService(),
      });
      expect(JSON.stringify(plan)).not.toContain(key);
      expect(plan.tasks[0]?.objective).toBe(`Call the API with ${SECRET_REDACTED}`);
      expect(JSON.stringify(openPlanner(db).get(plan.id))).not.toContain(key);
    } finally {
      db.close();
    }
  });
});
