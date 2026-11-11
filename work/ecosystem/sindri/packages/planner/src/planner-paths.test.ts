import {
  FakeProvider,
  listRuns,
  ProviderError,
  type CompleteRequest,
  type LlmProvider,
} from "@sindri/director";
import {
  FakeHarnessService,
  HarnessServiceError,
  type HarnessService,
  type Selection,
} from "@sindri/harnesses";
import { openIntake } from "@sindri/intake";
import { openDatabase, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { openSpecs, type SpecBody, type Specification, type Specs } from "@sindri/specs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlanValidationError } from "./dag.js";
import type { ProjectCaps } from "./schema.js";
import {
  openPlanner,
  PlanStateError,
  ROLE_TOKEN_BUDGETS,
  SKELETON_MARKER,
  type Planner,
} from "./planner.js";

/** Scripted model: fills every skeleton task it is shown. */
const fill = (req: CompleteRequest) => {
  const text = req.messages[0]?.content ?? "";
  const skeleton = JSON.parse(
    text.slice(text.indexOf(SKELETON_MARKER) + SKELETON_MARKER.length),
  ) as { tasks: { id: string }[] };
  return {
    output: {
      tasks: skeleton.tasks.map((t) => ({
        id: t.id,
        objective: `Objective for ${t.id}`,
        inputs: [],
        outputs: [],
      })),
    },
  };
};

/** Wraps a harness service, overriding single methods. */
const wrap = (inner: HarnessService, over: Partial<HarnessService>): HarnessService => ({
  resolve: (i) => inner.resolve(i),
  listHarnesses: () => inner.listHarnesses(),
  inspectRepo: () => inner.inspectRepo(),
  ...over,
});

describe("planner paths", () => {
  let db: SqliteDatabase;
  let specs: Specs;
  let planner: Planner;
  let projectId: string;
  let intakeId: string;
  let harnesses: FakeHarnessService;

  const approvedSpec = (acs: SpecBody["acceptanceCriteria"]): Specification => {
    const s = specs.createDraft({
      projectId,
      intakeId,
      title: "CSV export",
      body: {
        problem: "Reports cannot be exported.",
        goals: [],
        nonGoals: [],
        constraints: [],
        assumptions: [],
        acceptanceCriteria: acs,
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
        acceptanceCriteria: Object.fromEntries(acs.map((a) => [a.id, [{ intakeId }]])),
      },
    });
    specs.submitForReview(s.id);
    return specs.approve(s.id, { approver: "jacob" });
  };
  const apiSpec = () =>
    approvedSpec([{ id: "AC-1", text: "API endpoint returns CSV", verification: "test" }]);

  beforeEach(() => {
    db = openDatabase(":memory:");
    projectId = openKnowledge(db).projects.create({ name: "demo", repoPath: "/tmp/demo" }).id;
    intakeId = openIntake(db).createManual({ projectId, title: "CSV export", body: "pls" }).id;
    specs = openSpecs(db);
    planner = openPlanner(db);
    harnesses = new FakeHarnessService();
  });
  afterEach(() => db.close());

  const propose = (
    spec: Pick<Specification, "id">,
    over: Partial<Parameters<Planner["propose"]>[1]> = {},
  ) => planner.propose(spec, { provider: new FakeProvider(fill), harnesses, ...over });

  describe("concurrent revisions of one version", () => {
    it("store one new version and reject the other as stale, not with a database error", async () => {
      const v1 = await propose(apiSpec());
      const edit = (objective: string) =>
        v1.tasks.map((t, i) => (i === 0 ? { ...t, objective } : t));
      const results = await Promise.allSettled([
        planner.revise(v1.id, { tasks: edit("first") }, { harnesses }),
        planner.revise(v1.id, { tasks: edit("second") }, { harnesses }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
      const rejected = results[1] as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(PlanStateError);
      expect(String(rejected.reason)).toMatch(/latest version/);
      expect(planner.listLineage(v1.lineageId).map((p) => p.version)).toEqual([1, 2]);
      expect(planner.listLineage(v1.lineageId)[1]?.tasks[0]?.objective).toBe("first");
    });
  });

  describe("propose", () => {
    it("refuses an unknown specification", async () => {
      await expect(propose({ id: "nope" })).rejects.toThrow(
        new PlanStateError("unknown specification nope"),
      );
    });

    it("plans documentation-only work without a QA task", async () => {
      const plan = await propose(
        approvedSpec([{ id: "AC-1", text: "README documents the limits", verification: "manual" }]),
      );
      expect(plan.tasks.map((t) => [t.id, t.role, t.dependsOn])).toEqual([["docs", "docs", []]]);
    });

    it("passes impacted repository paths to harness selection", async () => {
      await propose(apiSpec(), {
        repoIndex: { impactedSystems: [{ area: "api", paths: ["src/server/routes.ts"] }] },
      });
      const backend = harnesses.calls.find((c) => c.task.id === "implement-backend");
      expect(backend?.task.paths).toEqual(["src/server/routes.ts"]);
      expect(harnesses.calls.find((c) => c.task.id === "qa")?.task.paths).toBeUndefined();
    });

    it("forwards the workspace and its label to the provider only when given", async () => {
      const provider = new FakeProvider(fill);
      await propose(apiSpec(), { provider, workspace: "/tmp/ws", workspaceLabel: "repo" });
      await propose(apiSpec(), { provider });
      expect(provider.calls.map((c) => [c.workspace, c.workspaceLabel])).toEqual([
        ["/tmp/ws", "repo"],
        [undefined, undefined],
      ]);
      expect("workspace" in (provider.calls[1] as object)).toBe(false);
    });

    it("rejects an empty harness selection as an unresolvable harness", async () => {
      const empty = wrap(harnesses, {
        resolve: async (i) => ({ ...(await harnesses.resolve(i)), harnesses: [] }),
      });
      await expect(propose(apiSpec(), { harnesses: empty })).rejects.toThrow(
        new PlanValidationError(["implement-backend: no resolvable harness (empty selection)"]),
      );
    });

    it("passes on harness failures that are not selection errors", async () => {
      const broken = wrap(harnesses, { resolve: () => Promise.reject(new Error("socket closed")) });
      await expect(propose(apiSpec(), { harnesses: broken })).rejects.toThrow("socket closed");
    });

    it("records a provider failure that is not a ProviderError under the provider's name", async () => {
      const provider = new FakeProvider([{ error: new Error("boom") }]);
      await expect(propose(apiSpec(), { provider })).rejects.toThrow("boom");
      expect(listRuns(db, projectId).map((r) => [r.model, r.outcome])).toEqual([["fake", "error"]]);
    });

    it("rejects a response without structured output and records it", async () => {
      const provider: LlmProvider = {
        name: "plain",
        complete: () =>
          Promise.resolve({ text: "sure", usage: null, model: "m-1", stopReason: "end_turn" }),
      } as LlmProvider;
      await expect(propose(apiSpec(), { provider })).rejects.toThrow(
        new ProviderError("invalid_output", "model returned no structured output"),
      );
      expect(listRuns(db, projectId).map((r) => [r.model, r.outcome])).toEqual([
        ["m-1", "invalid_output"],
      ]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
    });

    it("rejects model output that repeats a task id", async () => {
      const provider = new FakeProvider((req) => {
        const { output } = fill(req);
        return { output: { tasks: [...output.tasks, output.tasks[0]] } };
      });
      await expect(propose(apiSpec(), { provider })).rejects.toMatchObject({
        code: "invalid_output",
      });
    });

    it("keeps the role token budget when the token cap is unset, and caps it when set", async () => {
      const plan = await propose(apiSpec(), {
        caps: { maxTaskTokens: undefined } as unknown as ProjectCaps,
      });
      expect(plan.tasks[0]?.budget).toEqual({
        wallClockMinutes: 90,
        tokens: ROLE_TOKEN_BUDGETS.implementer,
      });
      const capped = await propose(apiSpec(), { caps: { maxTaskTokens: 1000 } });
      expect(capped.tasks[0]?.budget.tokens).toBe(1000);
    });
  });

  describe("lifecycle", () => {
    it("lists plans for a specification in creation order", async () => {
      const spec = apiSpec();
      const a = await propose(spec);
      const b = await propose(spec);
      expect(planner.listForSpec(spec.id).map((p) => p.id)).toEqual([a.id, b.id]);
      expect(planner.listForSpec("other")).toEqual([]);
    });

    it("refuses unknown plans", () => {
      expect(() => planner.submitForReview("nope")).toThrow(
        new PlanStateError("unknown plan nope"),
      );
      expect(() => planner.approve("nope", "jacob")).toThrow(/unknown plan nope/);
      expect(() => planner.dryRun("nope")).toThrow(/unknown plan nope/);
      expect(planner.get("nope")).toBeUndefined();
    });

    it("submits only drafts and needs a named approver", async () => {
      const plan = await propose(apiSpec());
      planner.submitForReview(plan.id);
      expect(() => planner.submitForReview(plan.id)).toThrow(
        `plan ${plan.id} is review, not draft`,
      );
      expect(() => planner.approve(plan.id, "  ")).toThrow("approver is required");
      expect(planner.get(plan.id)?.status).toBe("review");
    });

    it("dry-runs a plan object without storing it", async () => {
      const plan = await propose(apiSpec());
      const r = planner.dryRun({ tasks: plan.tasks }, { concurrency: { implementer: 1 } });
      expect(r.order).toEqual(plan.tasks.map((t) => t.id));
    });

    it("opens and closes its own database from a path", () => {
      const own = openPlanner(":memory:");
      expect(own.get("x")).toBeUndefined();
      own.close();
      expect(() => own.get("x")).toThrow();
    });
  });

  describe("revise: re-resolving a changed harness", () => {
    const changeFrontend = async () => {
      const v1 = await propose(
        approvedSpec([
          { id: "AC-1", text: "An Export button on the reports page", verification: "test" },
        ]),
      );
      return {
        v1,
        tasks: v1.tasks.map((t) =>
          t.id === "implement-frontend" ? { ...t, harnessVersion: "1.0.0" } : t,
        ),
      };
    };

    it("turns a selection error into a plan validation error", async () => {
      const { v1, tasks } = await changeFrontend();
      const failing = wrap(harnesses, {
        resolve: () => Promise.reject(new HarnessServiceError("no_match", "nothing fits")),
      });
      await expect(planner.revise(v1.id, { tasks }, { harnesses: failing })).rejects.toThrow(
        new PlanValidationError(["implement-frontend: no resolvable harness (nothing fits)"]),
      );
      expect(planner.listLineage(v1.lineageId)).toHaveLength(1);
    });

    it("passes on other failures", async () => {
      const { v1, tasks } = await changeFrontend();
      const failing = wrap(harnesses, { resolve: () => Promise.reject(new Error("down")) });
      await expect(planner.revise(v1.id, { tasks }, { harnesses: failing })).rejects.toThrow(
        "down",
      );
    });

    it("asks without task types when the harness summary disappears between calls", async () => {
      const { v1, tasks } = await changeFrontend();
      let listed = 0;
      const flaky = wrap(harnesses, {
        listHarnesses: async () => (listed++ === 0 ? harnesses.listHarnesses() : []),
      });
      const v2 = await planner.revise(v1.id, { tasks }, { harnesses: flaky });
      expect(harnesses.calls.at(-1)?.task.taskTypes).toEqual([]);
      const fe = v2.tasks.find((t) => t.id === "implement-frontend");
      expect((fe?.harnessSelection as Selection).harnesses[0]?.version).toBe("1.0.0");
    });
  });
});
