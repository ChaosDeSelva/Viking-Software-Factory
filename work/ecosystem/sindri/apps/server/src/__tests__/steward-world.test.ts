import { FakeProvider } from "@sindri/director";
import { openPlanner, type Planner } from "@sindri/planner";
import type { EscalationSubject, PlanApprovalSubject, SpecApprovalSubject } from "@sindri/steward";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { demoPlanResponder } from "../demo-plan-responder.js";
import type { Factory } from "../factory.js";
import { createServices, type Services } from "../services.js";
import { ServerStewardWorld } from "../steward-world.js";
import { approvedPlan, approvedSpec, startFlow, type Flow } from "./flow.js";

const NOW = new Date("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const USER = { actor: "user" };

interface FakeTask {
  planTaskId: string;
  status: string;
  attempts: number;
  escalation?: string;
  escalationReason?: string | null;
}

/** The hub and delivery service as the world reads them, scripted per execution. */
class FakeRuns {
  execs = new Map<string, { status: string }>();
  tasks = new Map<string, FakeTask[]>();
  gates = new Map<string, unknown[]>();
  reviews = new Map<string, unknown[]>();
  resolved: unknown[][] = [];
  takeoverError: unknown = null;
  hub = {
    reader: {
      get: (id: string) => this.execs.get(id),
      tasks: (id: string) => this.tasks.get(id) ?? [],
    },
    takeover: async (
      id: string,
      fn: (
        h: { loop: { resolveEscalation: (...a: unknown[]) => unknown } },
        s: AbortSignal,
      ) => unknown,
    ) => {
      if (this.takeoverError) throw this.takeoverError;
      await fn(
        { loop: { resolveEscalation: (...a: unknown[]) => this.resolved.push(a) } },
        new AbortController().signal,
      );
      return id;
    },
  };
  delivery = {
    gateResults: (id: string) => this.gates.get(id) ?? [],
    reviews: (id: string) => this.reviews.get(id) ?? [],
  };
}

let f: Flow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup() {
  f = await startFlow();
  const fl = f;
  const services = createServices({
    db: fl.h.db,
    providerFactory: () => new FakeProvider(demoPlanResponder()),
    now: () => NOW,
  });
  const planner = openPlanner(fl.h.db, { now: () => NOW });
  const runs = new FakeRuns();
  const world = (
    o: {
      planner?: Planner;
      services?: Services;
      app?: FastifyInstance;
      deliveryWindowMs?: number;
    } = {},
  ) =>
    new ServerStewardWorld({
      app: o.app ?? fl.h.app,
      services: o.services ?? services,
      factory: {
        planner: o.planner ?? planner,
        hub: runs.hub,
        delivery: runs.delivery,
      } as unknown as Factory,
      authToken: "t".repeat(64),
      now: () => NOW,
      ...(o.deliveryWindowMs !== undefined ? { deliveryWindowMs: o.deliveryWindowMs } : {}),
    });
  let seq = 0;
  /** An execution row of a plan (the world reads executions from the database). */
  const exec = (planId: string, status: string, finishedAt: string | null = null) => {
    const id = `exe_${++seq}`;
    fl.h.db
      .prepare(
        `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at, finished_at)
         VALUES (?, ?, 1, ?, ?, '{}', ?, ?)`,
      )
      .run(
        id,
        planId,
        `msn_${id}`,
        status,
        `2026-03-01T00:00:${String(seq).padStart(2, "0")}Z`,
        finishedAt,
      );
    runs.execs.set(id, { status });
    return id;
  };
  const setStatus = (id: string, status: string) => {
    fl.h.db.prepare("UPDATE executions SET status = ? WHERE id = ?").run(status, id);
    runs.execs.set(id, { status });
  };
  const rework = (executionId: string, specLineageId: string) =>
    services.rework.create({
      projectId: fl.projectId,
      sourceExecutionId: executionId,
      specLineageId,
      baseCommits: [],
      feedback: "Use ISO dates",
    });
  const draft = async () => {
    const d = await fl.h.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: { projectId: fl.projectId, request: "Add CSV export to the reports page" },
    });
    expect(d.statusCode).toBe(201);
    return d.json().spec as { id: string; lineageId: string };
  };
  const approval = async () => (await fl.h.approvalHeaders())["x-sindri-approval"]!;
  return { fl, services, planner, runs, world, exec, setStatus, rework, draft, approval };
}

/** A stand-in app whose in-process route call answers with `res`. */
const appAnswering = (res: { statusCode: number; json: () => unknown }, calls: unknown[] = []) =>
  ({
    inject: async (opts: unknown) => {
      calls.push(opts);
      return res;
    },
  }) as unknown as FastifyInstance;

describe("ServerStewardWorld readers", () => {
  it("escalations: open runs only, with the task objective and its own gate failures", async () => {
    const { fl, planner, runs, world, exec } = await setup();
    const plan = await approvedPlan(fl, await approvedSpec(fl));
    const [t1, t2] = plan.tasks.map((t) => t.id);
    const open = exec(plan.id, "awaiting_human");
    runs.tasks.set(open, [
      {
        planTaskId: t1!,
        status: "failed",
        attempts: 2,
        escalation: "retry_exhausted",
        escalationReason: "tests failed",
      },
      { planTaskId: t2!, status: "completed", attempts: 1 },
      {
        planTaskId: "unplanned",
        status: "failed",
        attempts: 1,
        escalation: "blocked",
        escalationReason: null,
      },
    ]);
    runs.gates.set(open, [
      {
        planTaskId: t1,
        passed: false,
        failures: [{ gateId: "tests", reason: "2 failed" }],
        advisories: [],
      },
      {
        planTaskId: t2,
        passed: false,
        failures: [{ gateId: "lint", reason: "style" }],
        advisories: [],
      },
    ]);
    const quiet = exec(plan.id, "running");
    runs.tasks.set(quiet, [{ planTaskId: t1!, status: "running", attempts: 1 }]);
    const done = exec(plan.id, "failed");
    runs.tasks.set(done, [
      { planTaskId: t1!, status: "failed", attempts: 1, escalation: "blocked" },
    ]);

    const out = world().escalations();
    expect(out).toEqual([
      {
        projectId: fl.projectId,
        executionId: open,
        planTaskId: t1,
        objective: planner.get(plan.id)!.tasks[0]!.objective,
        escalation: "retry_exhausted",
        reason: "tests failed",
        attempts: 2,
        taskStatus: "failed",
        gateFailures: ["tests: 2 failed"],
      },
      expect.objectContaining({ planTaskId: "unplanned", objective: null, gateFailures: [] }),
    ]);
    // A plan the planner no longer knows leaves the objective unknown.
    const blind = world({ planner: { ...planner, get: () => undefined } }).escalations();
    expect(blind.map((e) => e.objective)).toEqual([null, null]);
  });

  it("deliveries: recent, assessed, without a rework; findings and gates as the steward reads them", async () => {
    const { fl, planner, runs, world, exec, rework } = await setup();
    const specId = await approvedSpec(fl);
    const plan = await approvedPlan(fl, specId);
    const old = exec(
      plan.id,
      "verified_pending_review",
      new Date(NOW.getTime() - 2 * DAY).toISOString(),
    );
    runs.gates.set(old, [{ planTaskId: "qa", passed: true, failures: [], advisories: [] }]);
    const reworked = exec(plan.id, "verified_pending_review");
    runs.gates.set(reworked, [{ planTaskId: "qa", passed: true, failures: [], advisories: [] }]);
    rework(reworked, "lin_rework_1");
    exec(plan.id, "verified_pending_review"); // not assessed yet
    exec(plan.id, "running");
    const fresh = exec(
      plan.id,
      "verified_pending_review",
      new Date(NOW.getTime() - DAY / 2).toISOString(),
    );
    runs.reviews.set(fresh, [
      { role: "reviewer", verdict: "request_changes", reason: null, findings: [] },
      { role: "security", verdict: "request_changes", reason: "Leaks a token", findings: [] },
      {
        role: "qa",
        verdict: "approve",
        reason: null,
        findings: [{ severity: "minor", message: "Typo" }],
      },
    ]);
    runs.gates.set(fresh, [
      {
        planTaskId: "qa",
        passed: true,
        failures: [],
        advisories: [{ gateId: "lint", reason: "long line" }],
      },
    ]);

    const out = world({ deliveryWindowMs: DAY }).deliveries();
    expect(out).toEqual([
      {
        projectId: fl.projectId,
        executionId: fresh,
        specTitle: "CSV export for reports",
        findings: [
          { severity: "major", message: "changes requested", role: "reviewer" },
          { severity: "major", message: "Leaks a token", role: "security" },
          { severity: "minor", message: "Typo", role: "qa" },
        ],
        gates: [{ planTaskId: "qa", passed: true, failures: ["lint: long line"] }],
      },
    ]);
    // The default window is 14 days: the two-day-old delivery is suggested too.
    expect(
      world()
        .deliveries()
        .map((d) => d.executionId),
    ).toEqual([fresh, old]);
    // Without its plan the spec title is unknown.
    const blind = world({ planner: { ...planner, get: () => undefined }, deliveryWindowMs: DAY });
    expect(blind.deliveries()[0]!.specTitle).toBeNull();
  });

  it("specsInReview: blocking questions, high-risk assumptions and the Director's provenance", async () => {
    const { fl, services, world, draft } = await setup();
    const sp = await draft();
    const rev = await fl.h.call({
      method: "POST",
      url: `/v1/specs/${sp.id}/revise`,
      payload: {
        body: {
          assumptions: [
            { text: "Exports run in the browser", risk: "high" },
            { text: "Reports stay small", risk: "low" },
          ],
        },
      },
    });
    expect(rev.statusCode).toBe(201);
    const v2 = rev.json().spec.id as string;
    expect(
      (await fl.h.call({ method: "POST", url: `/v1/specs/${v2}/submit`, payload: {} })).statusCode,
    ).toBe(200);
    // A draft lineage is not in review.
    await draft();

    const [s] = world().specsInReview();
    expect(world().specsInReview()).toHaveLength(1);
    expect(s).toMatchObject({
      projectId: fl.projectId,
      specId: v2,
      lineageId: sp.lineageId,
      version: 2,
      blockingQuestions: ["Q1"],
      acceptanceCriteria: 1,
      highRiskAssumptions: ["Exports run in the browser"],
      untrustedFlagged: false,
    });
    expect(s!.unverifiedClaims).toBe(services.director().provenance(v2).unverifiedClaims.length);

    // No Director (its provider cannot be built): nothing flagged or left unverified.
    const noDirector = {
      ...services,
      director: () => {
        throw new Error("no provider");
      },
    } as Services;
    expect(world({ services: noDirector }).specsInReview()[0]).toMatchObject({
      untrustedFlagged: false,
      unverifiedClaims: 0,
    });
  });

  it("plansProposed: the latest draft or review version of each lineage, once", async () => {
    const { fl, world } = await setup();
    const specId = await approvedSpec(fl);
    const approved = await approvedPlan(fl, specId);
    const full = (await fl.h.call({ url: `/v1/plans/${approved.id}` })).json().plan;
    // A second plan lineage with two versions: only its latest (v2, draft) is proposed.
    const p = await fl.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    const v1 = p.json().plan.id as string;
    const v2 = await fl.h.call({
      method: "POST",
      url: `/v1/plans/${v1}/revise`,
      payload: { tasks: full.tasks },
    });
    expect(v2.statusCode).toBe(201);
    const out = world().plansProposed();
    expect(out).toEqual([
      {
        projectId: fl.projectId,
        planId: v2.json().plan.id,
        version: 2,
        status: "draft",
        specId,
        specTitle: "CSV export for reports",
        specApproved: true,
        tasks: full.tasks.map((t: { id: string; objective: string }) => ({
          id: t.id,
          objective: t.objective,
        })),
        problems: [],
      },
    ]);
  });

  it("knowledge: the project's valid entries", async () => {
    const { fl, world } = await setup();
    const add = await fl.h.call({
      method: "POST",
      url: "/v1/knowledge",
      payload: {
        projectId: fl.projectId,
        claim: "Reports are exported in UTC",
        sourceRefs: [{ url: "https://example.com/doc" }],
        confidence: 0.9,
      },
    });
    expect(add.statusCode).toBe(201);
    expect(world().knowledge(fl.projectId)).toEqual([
      { id: add.json().entry.id, claim: "Reports are exported in UTC" },
    ]);
    expect(world().knowledge("nope")).toEqual([]);
  });
});

describe("ServerStewardWorld outcomes", () => {
  it("escalation.resolve: the retried task, then the run", async () => {
    const { runs, world } = await setup();
    const w = world();
    const outcome = (appliedValue: string, context: unknown) =>
      w.outcome({ type: "escalation.resolve", context, appliedValue, applied: {} });
    runs.execs.set("e1", { status: "running" });
    const ctx = { executionId: "e1", planTaskId: "t1", attempts: 1 };
    expect(outcome("retry", { ...ctx, executionId: "gone" })).toBeNull();
    expect(
      w.outcome({
        type: "escalation.resolve",
        context: null,
        appliedValue: "retry",
        applied: null,
      }),
    ).toBeNull();

    runs.tasks.set("e1", [{ planTaskId: "t1", status: "completed", attempts: 2 }]);
    expect(outcome("retry", ctx)).toEqual({
      result: "passed",
      detail: "the retried task completed",
    });
    runs.tasks.set("e1", [
      { planTaskId: "t1", status: "failed", attempts: 2, escalation: "blocked" },
    ]);
    expect(outcome("retry", ctx)).toEqual({
      result: "failed",
      detail: "the task escalated again after the retry",
    });
    // Still the same escalation (no new attempt yet), or a retry without its attempt count.
    expect(outcome("retry", { ...ctx, attempts: 2 })).toBeNull();
    runs.tasks.set("e1", [{ planTaskId: "t1", status: "running", attempts: 2 }]);
    expect(outcome("retry", { executionId: "e1", planTaskId: "t1" })).toBeNull();
    expect(outcome("skip", ctx)).toBeNull();
    // A task the run no longer lists: the run decides.
    expect(outcome("retry", { ...ctx, planTaskId: "gone" })).toBeNull();

    runs.execs.set("e1", { status: "verified_pending_review" });
    expect(outcome("skip", ctx)).toEqual({ result: "passed", detail: "the run finished verified" });
    runs.execs.set("e1", { status: "cancelled" });
    expect(outcome("skip", ctx)).toEqual({ result: "failed", detail: "the run ended cancelled" });
    runs.execs.set("e1", { status: "failed" });
    expect(outcome("abort", ctx)).toEqual({ result: "failed", detail: "the run ended failed" });
  });

  it("spec.answer and spec.approve: the runs of the spec lineage", async () => {
    const { fl, world, exec, setStatus, rework, services } = await setup();
    const specId = await approvedSpec(fl);
    const plan = await approvedPlan(fl, specId);
    const lineageId = services.specs.get(specId)!.lineageId;
    const w = world();
    const outcome = (type: string, appliedValue: string | null) =>
      w.outcome({ type, context: { lineageId }, appliedValue, applied: {} });
    expect(outcome("spec.answer", "Date and total")).toBeNull();
    const first = exec(plan.id, "failed");
    expect(outcome("spec.answer", "x")).toEqual({
      result: "failed",
      detail: `execution ${first} ended failed`,
    });
    const second = exec(plan.id, "running");
    // One run still going: no verdict yet.
    expect(outcome("spec.answer", "x")).toBeNull();
    setStatus(second, "cancelled");
    expect(outcome("spec.approve", "approve")).toEqual({
      result: "failed",
      detail: `execution ${second} ended cancelled`,
    });
    setStatus(second, "verified_pending_review");
    expect(outcome("spec.approve", "approve")).toEqual({
      result: "passed",
      detail: `delivery ${second} was verified`,
    });
    rework(second, "lin_rework_2");
    expect(outcome("spec.answer", "x")).toEqual({
      result: "reworked",
      detail: `changes were requested on delivery ${second}`,
    });
    // A held approval performed nothing: no outcome.
    expect(outcome("spec.approve", "hold")).toBeNull();
    expect(
      w.outcome({ type: "spec.answer", context: undefined, appliedValue: "x", applied: null }),
    ).toBeNull();
  });

  it("plan.approve: the runs of the plan", async () => {
    const { fl, world, exec } = await setup();
    const plan = await approvedPlan(fl, await approvedSpec(fl));
    const w = world();
    const outcome = (appliedValue: string, context: unknown) =>
      w.outcome({ type: "plan.approve", context, appliedValue, applied: {} });
    expect(outcome("approve", { planId: plan.id })).toBeNull();
    const run = exec(plan.id, "verified_pending_review");
    expect(outcome("approve", { planId: plan.id })).toEqual({
      result: "passed",
      detail: `delivery ${run} was verified`,
    });
    expect(outcome("hold", { planId: plan.id })).toBeNull();
    expect(outcome("approve", {})).toBeNull();
  });

  it("rework.suggest: accepted as is, or the drafted change request's runs", async () => {
    const { fl, world, exec, rework, services } = await setup();
    const specId = await approvedSpec(fl);
    const plan = await approvedPlan(fl, specId);
    const delivered = exec(plan.id, "verified_pending_review");
    const w = world();
    const outcome = (appliedValue: string | null, applied: Record<string, unknown> | null) =>
      w.outcome({
        type: "rework.suggest",
        context: { executionId: delivered },
        appliedValue,
        applied,
      });
    expect(outcome(" accept ", {})).toBeNull();
    expect(outcome("Use ISO dates", null)).toBeNull();
    expect(
      w.outcome({ type: "rework.suggest", context: {}, appliedValue: "accept", applied: {} }),
    ).toBeNull();
    expect(outcome("Use ISO dates", { specLineageId: 7 })).toBeNull();
    const lineageId = services.specs.get(specId)!.lineageId;
    // The change request's lineage ran and verified.
    expect(outcome("Use ISO dates", { specLineageId: lineageId })).toEqual({
      result: "passed",
      detail: `delivery ${delivered} was verified`,
    });
    rework(delivered, "lin_rework_3");
    expect(outcome("accept", {})).toEqual({
      result: "reworked",
      detail: "changes were requested on the delivery after all",
    });
    expect(w.outcome({ type: "nope", context: {}, appliedValue: "x", applied: {} })).toBeNull();
  });
});

describe("ServerStewardWorld actions", () => {
  it("in-process route calls map refusals, including bodies without an error code or JSON", async () => {
    const { world, approval } = await setup();
    const subject = { specId: "spc_1" } as SpecApprovalSubject;
    const ctx = { actor: "user", approval: await approval() };
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const notJson = {
      statusCode: 502,
      json: () => {
        throw new SyntaxError("Unexpected token");
      },
    };
    await expect(
      world({ app: appAnswering(notJson, calls) }).approveSpec(subject, ctx),
    ).rejects.toMatchObject({
      status: 502,
      code: "internal",
      message: "/v1/specs/spc_1/approve failed with 502",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/v1/specs/spc_1/approve",
      headers: { host: "127.0.0.1", "x-sindri-approval": ctx.approval },
    });
    expect(calls[0]!.headers["idempotency-key"]).toMatch(/^steward-/);
    const noCode = { statusCode: 409, json: () => ({ error: { message: "spec changed" } }) };
    await expect(
      world({ app: appAnswering(noCode) }).approveSpec(subject, ctx),
    ).rejects.toMatchObject({
      status: 409,
      code: "internal",
      message: "spec changed",
    });
    const noError = { statusCode: 500, json: () => ({}) };
    await expect(
      world({ app: appAnswering(noError) }).approveSpec(subject, ctx),
    ).rejects.toMatchObject({
      status: 500,
      message: "/v1/specs/spc_1/approve failed with 500",
    });
    // A success without a JSON body is still a success.
    const empty = { statusCode: 204, json: notJson.json };
    await expect(world({ app: appAnswering(empty) }).approveSpec(subject, ctx)).resolves.toEqual({
      reversible: false,
      data: { specId: "spc_1" },
    });
  });

  it("approvals need the approval factor before anything is called", async () => {
    const { world } = await setup();
    const calls: unknown[] = [];
    const w = world({ app: appAnswering({ statusCode: 200, json: () => ({}) }, calls) });
    await expect(
      w.approveSpec({ specId: "spc_1" } as SpecApprovalSubject, USER),
    ).rejects.toMatchObject({
      status: 403,
      code: "approval_required",
    });
    expect(calls).toEqual([]);
  });

  it("approvePlan without the approval factor leaves a draft plan a draft", async () => {
    const { fl, world, planner } = await setup();
    const specId = await approvedSpec(fl);
    const p = await fl.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    const planId = p.json().plan.id as string;
    await expect(
      world().approvePlan({ planId } as PlanApprovalSubject, USER),
    ).rejects.toMatchObject({
      status: 403,
      code: "approval_required",
    });
    expect(planner.get(planId)!.status).toBe("draft");
  });

  it("approvePlan approves a plan already in review without submitting it again", async () => {
    const { fl, world, planner, approval } = await setup();
    const specId = await approvedSpec(fl);
    const p = await fl.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });
    const planId = p.json().plan.id as string;
    await fl.h.call({ method: "POST", url: `/v1/plans/${planId}/submit`, payload: {} });
    const res = await world().approvePlan({ planId } as PlanApprovalSubject, {
      actor: "user",
      approval: await approval(),
    });
    expect(res).toEqual({ reversible: false, data: { planId } });
    expect(planner.get(planId)!.status).toBe("approved");
    // A route refusal comes back with its own code: the plan is no longer the latest in review.
    await expect(
      world().approvePlan({ planId } as PlanApprovalSubject, {
        actor: "user",
        approval: await approval(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "invalid_state" });
  });

  it("answerQuestion refuses a gone or closed specification and a question no longer open", async () => {
    const { fl, world, draft } = await setup();
    const w = world();
    const sp = await draft();
    const [q1] = w.questions();
    expect(q1).toMatchObject({
      specId: sp.id,
      question: { id: "Q1", recommendation: "Date, customer and total" },
    });
    const answered = await w.answerQuestion(q1!, "Date and total", USER);
    expect(answered.data).toMatchObject({ questionId: "Q1", questionIndex: 0, answeredVersion: 2 });
    await expect(w.answerQuestion(q1!, "again", USER)).rejects.toMatchObject({
      code: "invalid_state",
      message: "question Q1 is no longer open",
    });
    await expect(w.answerQuestion({ ...q1!, lineageId: "nope" }, "x", USER)).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringMatching(/is gone/),
    });
    const specId = await approvedSpec(fl);
    const lineageId = (await fl.h.call({ url: `/v1/specs/${specId}` })).json().spec.lineageId;
    await expect(
      w.answerQuestion({ ...q1!, lineageId, question: { ...q1!.question, id: "Q2" } }, "x", USER),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringMatching(/is approved/),
    });
  });

  it("revertAnswer refuses a planned or gone lineage; reverting twice does not duplicate the question", async () => {
    const { world, draft, planner, services } = await setup();
    const w = world();
    await draft();
    const q2 = w.questions().find((q) => q.question.id === "Q2")!;
    const { data } = await w.answerQuestion(q2, "reports.csv", USER);
    const lineageId = data["lineageId"] as string;

    const planned = world({ planner: { ...planner, listForSpec: () => [{} as never] } });
    await expect(planned.revertAnswer(data, USER)).rejects.toMatchObject({
      code: "invalid_state",
      message: "version 2 of this specification has a plan; revise it by hand instead",
    });
    await expect(w.revertAnswer({ ...data, lineageId: "nope" }, USER)).rejects.toMatchObject({
      code: "invalid_state",
      message: "the specification is gone; it cannot be revised",
    });

    await w.revertAnswer(data, USER);
    await w.revertAnswer(data, USER);
    const versions = services.specs.listLineage(lineageId);
    const latest = versions.at(-1)!;
    expect(latest.version).toBe(4);
    expect(latest.body.openQuestions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
    expect(latest.body.constraints.some((c) => c.includes("reports.csv"))).toBe(false);
    // Nothing recorded at all: there is no lineage to revise.
    await expect(w.revertAnswer({}, USER)).rejects.toMatchObject({ code: "invalid_state" });
    // Without its old position the reopened question goes last.
    const q1 = w.questions().find((q) => q.question.id === "Q1")!;
    const a1 = await w.answerQuestion(q1, "Date and total", USER);
    const noIndex = { ...a1.data };
    delete noIndex["questionIndex"];
    await w.revertAnswer(noIndex, USER);
    expect(
      services.specs
        .listLineage(lineageId)
        .at(-1)!
        .body.openQuestions.map((q) => q.id),
    ).toEqual(["Q2", "Q1"]);
    // Without the question or constraints recorded, a revert only records a new version.
    await w.revertAnswer({ lineageId, answeredVersion: 2 }, USER);
    expect(services.specs.listLineage(lineageId).at(-1)!.body.openQuestions).toHaveLength(2);
  });

  it("resolveEscalation refuses runs that are gone, finished or not escalated, and maps Mimir failures", async () => {
    const { runs, world } = await setup();
    const w = world();
    const s = {
      projectId: "p",
      executionId: "e1",
      planTaskId: "t1",
      attempts: 1,
    } as EscalationSubject;
    await expect(w.resolveEscalation(s, "retry", "why", USER)).rejects.toMatchObject({
      code: "not_found",
    });
    runs.execs.set("e1", { status: "failed" });
    await expect(w.resolveEscalation(s, "retry", "why", USER)).rejects.toMatchObject({
      code: "invalid_state",
      message: "the execution has finished",
    });
    runs.execs.set("e1", { status: "awaiting_human" });
    runs.tasks.set("e1", [{ planTaskId: "t1", status: "failed", attempts: 1 }]);
    await expect(w.resolveEscalation(s, "retry", "why", USER)).rejects.toMatchObject({
      code: "invalid_state",
      message: "this task has no open escalation",
    });
    runs.tasks.set("e1", [
      { planTaskId: "t1", status: "failed", attempts: 1, escalation: "blocked" },
    ]);
    runs.takeoverError = new TypeError("fetch failed");
    await expect(w.resolveEscalation(s, "retry", "why", USER)).rejects.toMatchObject({
      status: 503,
      code: "mimir_unavailable",
    });
    const other = new Error("loop refused");
    runs.takeoverError = other;
    await expect(w.resolveEscalation(s, "retry", "why", USER)).rejects.toBe(other);
    runs.takeoverError = null;
    await expect(w.resolveEscalation(s, "skip", "why", { actor: "ops" })).resolves.toEqual({
      reversible: false,
      data: { executionId: "e1", planTaskId: "t1", decision: "skip" },
    });
    expect(runs.resolved).toEqual([
      [
        "e1",
        "t1",
        { decision: "skip", actor: "ops", reason: "why", signal: expect.any(AbortSignal) },
      ],
    ]);
  });

  it("resolveEscalation refuses a decision made for an earlier escalation of the task", async () => {
    const { runs, world } = await setup();
    runs.execs.set("e1", { status: "awaiting_human" });
    // The decision was made when the task escalated after 1 attempt; it has since been retried
    // and escalated again.
    runs.tasks.set("e1", [
      { planTaskId: "t1", status: "failed", attempts: 2, escalation: "blocked" },
    ]);
    const stale = {
      projectId: "p",
      executionId: "e1",
      planTaskId: "t1",
      attempts: 1,
    } as EscalationSubject;
    await expect(world().resolveEscalation(stale, "retry", "why", USER)).rejects.toMatchObject({
      code: "invalid_state",
    });
    expect(runs.resolved).toEqual([]);
  });

  it("discardRework refuses once a version of the change request was approved", async () => {
    const { fl, world, services } = await setup();
    const specId = await approvedSpec(fl);
    const specLineageId = services.specs.get(specId)!.lineageId;
    await expect(world().discardRework({ specLineageId })).rejects.toMatchObject({
      code: "invalid_state",
      message: "the drafted change request was approved meanwhile; it can no longer be discarded",
    });
    expect(services.specs.get(specId)!.status).toBe("approved");
    // Nothing recorded: nothing to discard.
    await expect(world().discardRework({})).resolves.toBeUndefined();
  });
});
