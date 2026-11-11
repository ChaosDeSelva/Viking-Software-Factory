import { describe, expect, it } from "vitest";
import { FakeDeliveryWorld, planTaskView, planView } from "../gates/fakes.js";
import type { ContextReader } from "../gates/ports.js";
import type { DeliveryReport } from "../report/delivery-report.js";
import { context, IMPL, SPEC } from "../report/scenario.test-helpers.js";
import type { ReviewRecord } from "../review/review-orchestrator.js";
import { DeliveryTracer } from "./trace.js";

const REPORT = {
  id: "dlv_1",
  executionId: "exe_1",
  status: "built",
  createdAt: "2026-10-14T12:00:00.000Z",
  deliveredAt: null,
} as DeliveryReport;

const reportsOf = (report: DeliveryReport | undefined) => ({
  get: (id: string) => (id === report?.id ? report : undefined),
});

function world(): FakeDeliveryWorld {
  const plan = planView(
    [planTaskView(IMPL), planTaskView("never-started", { acceptanceCriteria: [] })],
    { specId: SPEC.id },
  );
  // Plans from before lineages were recorded have none.
  delete plan.lineageId;
  const w = new FakeDeliveryWorld(plan);
  w.addTask(IMPL, "mt_impl", "crw_impl");
  return w;
}

const createdReview: ReviewRecord = {
  id: "rev_1",
  executionId: "exe_1",
  planTaskId: IMPL,
  implementerTaskId: "mt_impl",
  implementerCrewId: "crw_impl",
  implementerAttempt: 0,
  reviewerCrewId: "crw_rev",
  reviewerTaskId: "mt_rev",
  role: "reviewer",
  origin: "created",
  status: "requested",
  verdict: null,
  reason: null,
  findings: [],
  acceptance: [],
  decisions: [],
  reviewArtifactId: null,
  requestedAt: "2026-10-14T12:00:00.000Z",
  completedAt: null,
};

describe("DeliveryTracer.trace: missing records and optional sources", () => {
  it("refuses a delivery whose execution or specification is gone", async () => {
    const w = world();
    const noSpec: ContextReader = {
      spec: () => Promise.resolve(undefined),
      intake: () => Promise.resolve(undefined),
    };
    await expect(
      new DeliveryTracer({
        executions: w,
        context: noSpec,
        reports: reportsOf({ ...REPORT, executionId: "exe_gone" }),
      }).trace("dlv_1"),
    ).rejects.toMatchObject({ name: "TraceError", message: "unknown execution exe_gone" });
    await expect(
      new DeliveryTracer({ executions: w, context: noSpec, reports: reportsOf(REPORT) }).trace(
        "dlv_1",
      ),
    ).rejects.toMatchObject({ name: "TraceError", message: `unknown specification ${SPEC.id}` });
  });

  it("traces without gates, reviews, PR records, ticket or plan lineage", async () => {
    const w = world();
    const own = w.event("task.started", {}, { taskId: "mt_impl" });
    const loose = w.event("mission.started", {}, { taskId: null });
    const doc = await new DeliveryTracer({
      executions: w,
      context: {
        spec: () => Promise.resolve({ ...SPEC, intakeId: null }),
        intake: () => Promise.reject(new Error("not asked")),
      },
      reports: reportsOf(REPORT),
    }).trace("dlv_1");

    expect(doc.ticket).toBeNull();
    expect(doc.delivery.prs).toEqual([]);
    expect(doc.plan.lineageId).toBeNull();
    expect(doc.reviewTasks).toEqual([]);
    expect(doc.tasks).toEqual([
      expect.objectContaining({
        planTaskId: IMPL,
        mimirTaskId: "mt_impl",
        gate: null,
        reviews: [],
        events: [expect.objectContaining({ id: own })],
      }),
      expect.objectContaining({
        planTaskId: "never-started",
        mimirTaskId: null,
        status: "unknown",
        attempts: 0,
        gate: null,
        events: [],
        artifacts: [],
      }),
    ]);
    expect(doc.unattributedEvents.map((e) => e.id)).toEqual([loose]);
  });

  it("gives a ticket that is gone as null and lists a review task Sindri created on its own", async () => {
    const w = world();
    const reviewEvent = w.event("task.started", {}, { taskId: "mt_rev" });
    const artifact = w.artifact("mt_rev", "review", "{}");
    const doc = await new DeliveryTracer({
      executions: w,
      context: {
        spec: () => Promise.resolve({ ...SPEC, intakeId: "int_gone" }),
        intake: context.intake,
      },
      reports: reportsOf(REPORT),
      reviews: { list: () => [createdReview] },
    }).trace("dlv_1");

    expect(doc.ticket).toBeNull();
    expect(doc.reviewTasks).toEqual([
      {
        mimirTaskId: "mt_rev",
        review: {
          reviewId: "rev_1",
          ofPlanTaskId: IMPL,
          status: "requested",
          verdict: null,
          reviewArtifactId: null,
        },
        events: [
          expect.objectContaining({ id: reviewEvent }),
          expect.objectContaining({ type: "artifact.recorded" }),
        ],
        artifacts: [expect.objectContaining({ id: artifact, kind: "review" })],
      },
    ]);
    expect(doc.unattributedEvents).toEqual([]);
  });
});
