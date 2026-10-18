import { describe, expect, it } from "vitest";
import { crewKey, idempotencyKey, mapPlan, mimirRoleFor } from "./mapping.js";
import { approvedPlan, planTask } from "./testing.js";

describe("plan to Mimir mapping", () => {
  it("passes the exact assigned acceptance text to workers and reviewers", () => {
    const mapped = mapPlan(
      approvedPlan([planTask("review", { role: "reviewer", acceptanceCriteria: ["AC7"] })]),
      {
        acceptanceCriteria: [
          { id: "AC7", text: "An empty array returns zero." },
          { id: "AC8", text: "Unrelated requirement" },
        ],
      },
    );
    expect(mapped.tasks[0]!.brief).toContain("AC7: An empty array returns zero.");
    expect(mapped.tasks[0]!.brief).not.toContain("Unrelated requirement");
    expect(mapped.tasks[0]!.brief).toContain("each decision MUST be an object");
  });

  it("builds idempotency keys sindri:<planId>:<version>:<suffix>", () => {
    const plan = approvedPlan([planTask("a")], { id: "p9", version: 3 });
    expect(idempotencyKey(plan, "a")).toBe("sindri:p9:3:a");
    expect(idempotencyKey(plan, "@mission")).toBe("sindri:p9:3:@mission");
    // Re-executions of the same plan version get their own keys (run 1 keeps the plain form).
    expect(idempotencyKey(plan, "a", 1)).toBe("sindri:p9:3:a");
    expect(idempotencyKey(plan, "a", 2)).toBe("sindri:p9:3#2:a");
  });

  it("keeps mission and crew keys out of the task-id namespace", () => {
    const plan = approvedPlan([planTask("mission"), planTask("crew")]);
    const mapped = mapPlan(plan);
    const keys = [
      mapped.missionIdempotencyKey,
      ...mapped.crews.map((c) => c.idempotencyKey),
      ...mapped.tasks.map((t) => t.idempotencyKey),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(mapped.missionIdempotencyKey).toBe("sindri:plan-1:1:@mission");
  });

  it("derives every key from the run number", () => {
    const mapped = mapPlan(approvedPlan([planTask("a")]), { run: 3 });
    expect(mapped.missionIdempotencyKey).toBe("sindri:plan-1:1#3:@mission");
    expect(mapped.crews[0]!.idempotencyKey).toBe(
      "sindri:plan-1:1#3:@crew:backend-node:implementer",
    );
    expect(mapped.tasks[0]!.idempotencyKey).toBe("sindri:plan-1:1#3:a");
  });

  it("maps Sindri roles onto Mimir crew roles", () => {
    expect(mimirRoleFor("implementer")).toBe("implementer");
    expect(mimirRoleFor("qa")).toBe("qa");
    expect(mimirRoleFor("security")).toBe("reviewer");
    expect(mimirRoleFor("docs")).toBe("implementer");
  });

  it("makes one crew per distinct (harnessId, role) with agentKind, concurrency and attempts", () => {
    const plan = approvedPlan([
      planTask("impl-a", { maxRetries: 2 }),
      planTask("impl-b", { maxRetries: 0 }),
      planTask("review-a", { role: "reviewer", dependsOn: ["impl-a"] }),
      planTask("ui", { harnessId: "frontend-react", harnessVersion: "1.1.0" }),
    ]);
    const mapped = mapPlan(plan, {
      agentKindFor: (h, r) =>
        h === "frontend-react" ? "codex" : r === "reviewer" ? "claude" : "shell",
    });
    expect(mapped.crews.map((c) => c.key)).toEqual([
      "backend-node:implementer",
      "backend-node:reviewer",
      "frontend-react:implementer",
    ]);
    const impl = mapped.crews[0]!;
    expect(impl.idempotencyKey).toBe("sindri:plan-1:1:@crew:backend-node:implementer");
    expect(impl.taskIds).toEqual(["impl-a", "impl-b"]);
    expect(impl.request).toEqual({
      template: "implementer",
      // maxRetries 2 + the first run + DEFAULT_HUMAN_RETRIES (2) granted via resolveEscalation.
      limits: { maxConcurrentTasks: 2, maxAttemptsPerTask: 5 },
      budget: { limitTokens: 2000, enforce: "hard", onUnknown: "block" },
      members: [{ role: "implementer", agentKind: "shell", name: "backend-node-implementer" }],
    });
    expect(mapped.crews[1]!.request.members[0]!.agentKind).toBe("claude");
    expect(mapped.crews[2]!.request.members[0]!.agentKind).toBe("codex");
    expect(crewKey(plan.tasks[3]!)).toBe("frontend-react:implementer");
  });

  it("orders tasks so dependencies come first and carries the plan's intent", () => {
    const plan = approvedPlan([
      planTask("docs", { role: "docs", dependsOn: ["impl"] }),
      planTask("impl", {
        objective: "Build the API",
        acceptanceCriteria: ["AC-1", "AC-2"],
        inputs: ["spec"],
        outputs: ["src/api.ts"],
        skills: ["node-testing"],
      }),
    ]);
    const mapped = mapPlan(plan);
    expect(mapped.tasks.map((t) => t.planTaskId)).toEqual(["impl", "docs"]);
    const impl = mapped.tasks[0]!;
    expect(impl.idempotencyKey).toBe("sindri:plan-1:1:impl");
    expect(impl.crewKey).toBe("backend-node:implementer");
    expect(impl.title).toBe("impl: Build the API");
    expect(impl.acceptanceCriteria).toEqual(["AC-1", "AC-2"]);
    expect(impl.brief).toContain("Build the API");
    expect(impl.brief).toContain("backend-node@1.0.0");
    expect(impl.brief).toContain(plan.tasks[1]!.harnessLockDigest);
    expect(mapped.tasks[1]!.dependsOn).toEqual(["impl"]);
  });

  it("tells non-shell agents their Sindri role", () => {
    const mapped = mapPlan(approvedPlan([planTask("sec", { role: "security" })]));
    expect(mapped.tasks[0]!.brief).toContain("Role: security");
  });

  it("passes the objective verbatim as the instruction for shell crews", () => {
    const mapped = mapPlan(approvedPlan([planTask("a", { objective: "echo hi > out.txt" })]), {
      agentKindFor: () => "shell",
    });
    expect(mapped.tasks[0]!.brief).toBe("echo hi > out.txt");
  });

  it("sends each crew the summed token and cost budgets of its tasks (hard enforcement)", () => {
    const wall = { wallClockMinutes: 30 };
    const mapped = mapPlan(
      approvedPlan([
        planTask("a", { budget: { tokens: 1000, costUsd: 1.5, ...wall } }),
        planTask("b", { budget: { tokens: 500, ...wall } }),
        planTask("c", { harnessId: "other", budget: { ...wall } }),
      ]),
    );
    expect(mapped.crews[0]!.request.budget).toEqual({
      limitTokens: 1500,
      limitCost: 1.5,
      enforce: "hard",
      onUnknown: "block",
    });
    expect(mapped.crews[1]!.request.budget).toBeUndefined();
    expect(mapped.unforwardedBudgets).toEqual([]);
    expect(mapped.tasks.map((t) => t.timeoutMs)).toEqual([1800000, 1800000, 1800000]);
  });

  it("defaults agentKind to claude", () => {
    const mapped = mapPlan(approvedPlan([planTask("a")]));
    expect(mapped.crews[0]!.request.members[0]!.agentKind).toBe("claude");
  });

  it("refuses plans that are not approved, and cyclic plans", () => {
    expect(() => mapPlan(approvedPlan([planTask("a")], { status: "review" }))).toThrow(/approved/);
    expect(() =>
      mapPlan(
        approvedPlan([planTask("a", { dependsOn: ["b"] }), planTask("b", { dependsOn: ["a"] })]),
      ),
    ).toThrow(/cycle/);
  });
});

it("preserves task priority when mapping an approved plan to Mimir", () => {
  const mapped = mapPlan(approvedPlan([planTask("a", { priority: 75 })]));
  expect(mapped.tasks[0]!.priority).toBe(75);
});
