import { FakeProvider } from "@sindri/director";
import type { SqliteDatabase } from "@sindri/knowledge";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";
import { MimirClientFacade } from "@sindri/mimir-client";
import { approvedPlan, planTask } from "@sindri/mimir-client/testing";
import { createFakeMimir, type FakeMimir } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryLoop } from "../delivery-loop.js";
import { executionReaderFor, mimirActionsFor } from "../gates/binding.js";
import { BROKKR_REPORT_KIND } from "../gates/brokkr-report.js";
import { GateRunner } from "../gates/gate-runner.js";
import type { ContextReader } from "../gates/ports.js";
import { DeliveryReports } from "../report/delivery-report.js";
import {
  approveReview,
  context,
  IMPL,
  INTAKE,
  QA,
  scenario,
  SPEC,
} from "../report/scenario.test-helpers.js";
import { ReviewOrchestrator } from "../review/review-orchestrator.js";
import { DeliveryTracer, TraceError } from "./trace.js";

let fake: FakeMimir | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => {
  await fake?.close();
  db?.close();
  fake = undefined;
  db = undefined;
});

describe("DeliveryTracer.trace (scripted world)", () => {
  it("links ticket -> spec version -> plan version -> mission -> tasks -> events -> artifacts", async () => {
    const s = await scenario();
    await approveReview(s);
    await s.gates.evaluate(s.w.executionId, IMPL);
    await s.gates.evaluate(s.w.executionId, QA);
    const { deliveryId } = await s.reports.requestPr(s.w.executionId);
    const tracer = new DeliveryTracer({
      executions: s.w,
      context,
      reports: s.reports,
      gates: s.gates,
      reviews: s.reviews,
    });
    const doc = await tracer.trace(deliveryId);
    expect(doc).toMatchObject({
      schemaVersion: 1,
      delivery: { id: deliveryId, status: "delivered_pending_merge", prs: [{ planTaskId: IMPL }] },
      ticket: INTAKE,
      spec: {
        id: SPEC.id,
        version: 2,
        lineageId: SPEC.lineageId,
        acceptanceCriteria: ["AC-1", "AC-2"],
      },
      plan: { id: "pln_1", version: 1, specId: SPEC.id, specVersion: 2 },
      mission: { id: s.w.missionId },
      execution: { id: s.w.executionId },
    });
    const impl = doc.tasks.find((t) => t.planTaskId === IMPL)!;
    expect(impl).toMatchObject({ mimirTaskId: "mt_impl", gate: { passed: true } });
    expect(impl.artifacts.map((a) => a.kind)).toEqual(
      expect.arrayContaining([BROKKR_REPORT_KIND, "screenshot-desktop", "changed-files"]),
    );
    const qa = doc.tasks.find((t) => t.planTaskId === QA)!;
    expect(qa.reviews).toEqual([
      expect.objectContaining({ ofPlanTaskId: IMPL, verdict: "approve" }),
    ]);
    // Every recorded event appears exactly once.
    const traced = [...doc.tasks.flatMap((t) => t.events), ...doc.unattributedEvents].map(
      (e) => e.id,
    );
    expect(traced.sort()).toEqual(s.w.eventLog.map((e) => e.mimirEventId).sort());
    // Each event carries who recorded it and how, so trusted evidence is distinguishable.
    expect(impl.events[0]).toEqual(
      expect.objectContaining({ source: "mimir.server", provenance: expect.any(String) }),
    );
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  it("throws for an unknown delivery", async () => {
    const s = await scenario();
    const tracer = new DeliveryTracer({ executions: s.w, context, reports: s.reports });
    await expect(tracer.trace("dlv_nope")).rejects.toBeInstanceOf(TraceError);
  });
});

describe("DeliveryTracer.trace (full fake Mimir run through S5's DeliveryLoop)", () => {
  it("produces a complete trace document", async () => {
    fake = await createFakeMimir({
      stepDelayMs: 0,
      scripts: {
        impl: [{ kind: "complete", artifacts: [BROKKR_REPORT_KIND, "screenshot", "diff"] }],
      },
    });
    const d = (db = openDeliveryTestDb());
    const facade = new MimirClientFacade({ db: d }).connect({
      baseUrl: fake.url,
      token: fake.token,
    });
    const loop = new DeliveryLoop({ db: d, mimir: facade, logger: { warn: () => undefined } });
    const project = await facade.ensureProject("/repos/app");
    const plan = approvedPlan([
      planTask("impl"),
      planTask("review-impl", { role: "reviewer", dependsOn: ["impl"] }),
    ]);
    const execution = await loop.createExecution(plan, { projectId: project.id });
    expect((await loop.run(execution.id)).status).toBe("verified_pending_review");

    const executions = executionReaderFor({ db: d, loop, mimir: facade });
    const mimir = mimirActionsFor(facade);
    const content = {
      read: (a: { taskId: string; kind: string }) => Promise.resolve(`${a.taskId}:${a.kind}`),
    };
    const ctx: ContextReader = {
      spec: (id) =>
        Promise.resolve(
          id === plan.specId
            ? {
                ...SPEC,
                id: plan.specId,
                version: plan.specVersion,
                acceptanceCriteria: [SPEC.acceptanceCriteria[0]!],
              }
            : undefined,
        ),
      intake: context.intake,
    };
    const reviews = new ReviewOrchestrator({ db: d, executions, mimir, content });
    const gates = new GateRunner({ db: d, executions, mimir, content, reviews });
    await reviews.requestReview(execution.id, "impl");
    await gates.evaluate(execution.id, "impl");
    await gates.evaluate(execution.id, "review-impl");
    const reports = new DeliveryReports({
      db: d,
      executions,
      mimir,
      content,
      context: ctx,
      provider: new FakeProvider([{ text: "Nothing to cite." }]),
      gates,
      reviews,
    });
    const report = await reports.build(execution.id);
    const doc = await new DeliveryTracer({
      executions,
      context: ctx,
      reports,
      gates,
      reviews,
    }).trace(report.id);

    expect(doc.ticket?.id).toBe(INTAKE.id);
    expect(doc.spec.id).toBe(plan.specId);
    expect(doc.plan).toMatchObject({ id: plan.id, version: plan.version });
    expect(doc.mission.id).toBe(execution.mimirMissionId);
    expect(doc.tasks.map((t) => t.planTaskId)).toEqual(["impl", "review-impl"]);
    const missionEvents = fake.events().filter((e) => e.missionId === execution.mimirMissionId);
    const traced = [...doc.tasks.flatMap((t) => t.events), ...doc.unattributedEvents];
    expect(traced.map((e) => e.id).sort()).toEqual(missionEvents.map((e) => e.id).sort());
    for (const t of doc.tasks) {
      const own = missionEvents.filter((e) => e.taskId === t.mimirTaskId);
      expect(t.events.map((e) => e.id).sort()).toEqual(own.map((e) => e.id).sort());
    }
    const impl = doc.tasks[0]!;
    expect(impl.artifacts.map((a) => a.kind).sort()).toEqual([
      BROKKR_REPORT_KIND,
      "diff",
      "screenshot",
    ]);
    expect(impl.gate?.passed).toBe(false); // the fake's report bytes are not a Brokkr report
    expect(doc.tasks[1]!.reviews).toEqual([expect.objectContaining({ ofPlanTaskId: "impl" })]);
  });
});
