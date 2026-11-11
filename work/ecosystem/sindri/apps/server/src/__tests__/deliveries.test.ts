import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryService } from "../delivery-service.js";
import { approvedPlan, approvedSpec } from "./flow.js";
import { startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

let f: MimirFlow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function run(flow: MimirFlow) {
  const plan = await approvedPlan(flow, await approvedSpec(flow));
  const res = await flow.h.call({
    method: "POST",
    url: "/v1/executions",
    payload: { planId: plan.id },
  });
  expect(res.statusCode).toBe(201);
  return { plan, execution: res.json().execution as { id: string; mimirMissionId: string } };
}
const statusOf = (flow: MimirFlow, id: string) => async () =>
  (await flow.h.call({ url: `/v1/executions/${id}` })).json().execution.status as string;
const reviews = async (flow: MimirFlow) =>
  (await flow.h.call({ url: `/v1/reviews?projectId=${flow.projectId}` })).json();

/** Waits until the settle assessment has evaluated every plan task (not just the first). */
const assessed = (flow: MimirFlow, executionId: string, tasks: number) =>
  until(
    async () => (await flow.h.call({ url: `/v1/executions/${executionId}` })).json().gates.length,
    (n: number) => n === tasks,
  );

describe("reviews inbox", () => {
  it("lists approvals awaiting a human", async () => {
    const flow = (f = await startMimirFlow({
      "implement-frontend": [{ kind: "approval", action: "fs.write" }],
    }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "awaiting_human");
    const inbox = await reviews(flow);
    expect(inbox.deliveryService).toBe("s6");
    expect(inbox.approvals).toHaveLength(1);
    expect(inbox.approvals[0]).toMatchObject({
      executionId: execution.id,
      action: "fs.write",
      status: "pending",
    });
    expect(inbox.escalations).toEqual([]);
    expect((await flow.h.call({ url: "/v1/reviews?projectId=nope" })).statusCode).toBe(404);
  });

  it("lists escalations", async () => {
    const flow = (f = await startMimirFlow({
      qa: [
        { kind: "fail", reason: "flaky" },
        { kind: "fail", reason: "flaky" },
      ],
    }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "awaiting_human");
    const inbox = await reviews(flow);
    expect(inbox.escalations).toEqual([
      expect.objectContaining({ executionId: execution.id, planTaskId: "qa", escalation: "ask" }),
    ]);
  });

  it("assesses a verified execution: Brokkr gate failures and the independent review", async () => {
    const flow = (f = await startMimirFlow());
    const { plan, execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    await assessed(flow, execution.id, plan.tasks.length);
    const inbox = await reviews(flow);
    // No Brokkr verification report was recorded, so no task passes (fail closed, D-012).
    for (const t of plan.tasks)
      expect(inbox.gateFailures).toContainEqual(
        expect.objectContaining({
          executionId: execution.id,
          planTaskId: t.id,
          gateId: "brokkr",
          reason: "verification_report_missing",
        }),
      );
    // The plan's own review task was adopted; it wrote no review.json.
    expect(inbox.gateFailures).toContainEqual(
      expect.objectContaining({
        planTaskId: "implement-frontend",
        gateId: "independent-review",
        reason: "review_request_changes:missing_review",
      }),
    );
    expect(inbox.findings).toContainEqual(
      expect.objectContaining({
        executionId: execution.id,
        planTaskId: "implement-frontend",
        verdict: "request_changes",
        message: "missing_review",
      }),
    );
    const detail = (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json();
    expect(detail.gates.find((g: { planTaskId: string }) => g.planTaskId === "qa")).toMatchObject({
      passed: false,
    });
  });
});

describe("deliveries", () => {
  it("builds a report, PR text and trace for a verified execution", async () => {
    // The fake Mimir stamps its events `fake-mimir`; production trusts only `mimir.server`.
    const flow = (f = await startMimirFlow({}, { trustedSources: ["fake-mimir"] }));
    const { plan, execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");

    const list = (await flow.h.call({ url: `/v1/deliveries?projectId=${flow.projectId}` })).json();
    expect(list.deliveries.map((d: { id: string }) => d.id)).toEqual([execution.id]);

    const res = await flow.h.call({ url: `/v1/deliveries/${execution.id}` });
    expect(res.statusCode).toBe(200);
    const { report, prDescription, deliveryService } = res.json();
    expect(deliveryService).toBe("s6");
    expect(report).toMatchObject({
      executionId: execution.id,
      plan: { id: plan.id, version: 1 },
      missionId: execution.mimirMissionId,
    });
    const ac1 = report.requirements.find((r: { criterionId: string }) => r.criterionId === "AC1");
    expect(ac1.tasks.length).toBeGreaterThan(0);
    expect(report.testResults.length).toBeGreaterThan(0);
    // Every kept summary sentence cites evidence.
    for (const s of report.summary.sentences) expect(s.text).toMatch(/\[ref:/);
    expect(prDescription).toMatch(/AC1/);

    const trace = await flow.h.call({ url: `/v1/deliveries/${execution.id}/trace` });
    expect(trace.statusCode).toBe(200);
    const doc = trace.json().trace;
    expect(doc).toMatchObject({
      schemaVersion: 1,
      delivery: { id: report.id },
      plan: { id: plan.id },
      mission: { id: execution.mimirMissionId },
      execution: { id: execution.id },
    });
    expect(doc.tasks).toHaveLength(plan.tasks.length);
    expect(doc.tasks.some((t: { artifacts: unknown[] }) => t.artifacts.length > 0)).toBe(true);
    expect((await flow.h.call({ url: "/v1/deliveries/nope" })).statusCode).toBe(404);
    expect((await flow.h.call({ url: "/v1/deliveries/nope/trace" })).statusCode).toBe(404);
  });

  it("requires approval to propose and decide sourced delivery knowledge", async () => {
    const flow = (f = await startMimirFlow({}, { trustedSources: ["fake-mimir"] }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const report = (await flow.h.call({ url: `/v1/deliveries/${execution.id}` })).json().report;
    const url = `/v1/deliveries/${execution.id}/proposals`;
    expect((await flow.h.call({ url })).json().proposals).toEqual([]);
    expect((await flow.h.call({ method: "POST", url })).statusCode).toBe(403);
    const headers = await flow.h.approvalHeaders();
    expect((await flow.h.call({ method: "POST", url, headers })).statusCode).toBe(409);
    // Model the persisted delivery transition; remote PR behavior has its own integration test.
    flow.h.db
      .prepare("UPDATE deliveries SET status = 'delivered_pending_merge' WHERE id = ?")
      .run(report.id);
    const proposed = await flow.h.call({ method: "POST", url, headers });
    expect(proposed.statusCode).toBe(200);
    const proposals = proposed.json().proposals;
    expect(proposals.length).toBeGreaterThan(1);
    for (const [i, decision] of ["accepted", "rejected"].entries()) {
      const res = await flow.h.call({
        method: "POST",
        url: `${url}/${proposals[i].id}/decision`,
        headers,
        payload: { decision },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().proposal.status).toBe(decision);
    }
    expect(
      (
        await flow.h.call({
          method: "POST",
          url: `${url}/missing/decision`,
          headers,
          payload: { decision: "accepted" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await flow.h.call({
          method: "POST",
          url: `${url}/${proposals[0].id}/decision`,
          headers,
          payload: { decision: "invalid" },
        })
      ).statusCode,
    ).toBe(422);
  });

  it("is not a delivery while the execution runs", async () => {
    const flow = (f = await startMimirFlow({
      "implement-frontend": [{ kind: "approval", action: "fs.write" }],
    }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "awaiting_human");
    const res = await flow.h.call({ url: `/v1/deliveries/${execution.id}` });
    expect(res.statusCode).toBe(409);
    const pr = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/pr`,
      headers: await flow.h.approvalHeaders(),
    });
    expect(pr.statusCode).toBe(409);
  });

  it("refuses a PR while quality gates have not passed", async () => {
    const flow = (f = await startMimirFlow());
    const { plan, execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    await assessed(flow, execution.id, plan.tasks.length);
    const pr = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/pr`,
      headers: await flow.h.approvalHeaders(),
    });
    expect(pr.statusCode).toBe(409);
    expect(pr.json().error).toMatchObject({ code: "invalid_state" });
    expect(pr.json().error.message).toMatch(/quality gates have not passed/);
  });

  it("uses an injected delivery service for PR requests", async () => {
    const calls: string[] = [];
    const stub: Partial<DeliveryService> = {
      kind: "s6",
      assess: () => Promise.resolve(),
      gateResults: () => [],
      reviews: () => [],
      requestPr: (id) => {
        calls.push(id);
        return Promise.resolve({ deliveryId: "dlv_1", status: "delivered_pending_merge", prs: [] });
      },
    };
    const flow = (f = await startMimirFlow({}, { deliveryService: stub as DeliveryService }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const pr = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/pr`,
      headers: await flow.h.approvalHeaders(),
    });
    expect(pr.statusCode).toBe(200);
    expect(pr.json().pr).toMatchObject({ status: "delivered_pending_merge" });
    expect(calls).toEqual([execution.id]);
  });
});

/** Answer the draft's blocking question, then submit and approve it: returns the approved id. */
async function approveDraft(flow: MimirFlow, specId: string): Promise<string> {
  const a = await flow.h.call({
    method: "POST",
    url: `/v1/specs/${specId}/answer`,
    payload: { questionId: "Q1", answer: "Date and total" },
  });
  expect(a.statusCode).toBe(201);
  const id = a.json().spec.id as string;
  expect(
    (await flow.h.call({ method: "POST", url: `/v1/specs/${id}/submit`, payload: {} })).statusCode,
  ).toBe(200);
  expect(
    (
      await flow.h.call({
        method: "POST",
        url: `/v1/specs/${id}/approve`,
        payload: {},
        headers: await flow.h.approvalHeaders(),
      })
    ).statusCode,
  ).toBe(200);
  return id;
}

describe("requesting changes to a delivery", () => {
  it("drafts a rework spec and runs its plan on top of the delivered results", async () => {
    const flow = (f = await startMimirFlow({}, { trustedSources: ["fake-mimir"] }));
    const { plan, execution } = await run(flow);

    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const empty = await flow.h.call({
      method: "POST",
      url: `/v1/deliveries/${execution.id}/rework`,
      payload: { feedback: "   " },
    });
    expect(empty.statusCode).toBe(422);
    expect(
      (
        await flow.h.call({
          method: "POST",
          url: "/v1/deliveries/nope/rework",
          payload: { feedback: "x" },
        })
      ).statusCode,
    ).toBe(404);

    const res = await flow.h.call({
      method: "POST",
      url: `/v1/deliveries/${execution.id}/rework`,
      payload: { feedback: "Use ISO dates in the export." },
    });
    expect(res.statusCode).toBe(201);
    const { rework, spec } = res.json();
    expect(rework).toMatchObject({
      sourceExecutionId: execution.id,
      specLineageId: spec.lineageId,
      feedback: "Use ISO dates in the export.",
    });
    // The delivered change is the results nothing else in the plan builds on.
    const full = (await flow.h.call({ url: `/v1/plans/${plan.id}` })).json().plan as {
      specId: string;
      tasks: { id: string; dependsOn: string[] }[];
    };
    const dependedOn = new Set(full.tasks.flatMap((t) => t.dependsOn));
    const leaves = full.tasks.filter((t) => !dependedOn.has(t.id)).length;
    expect(rework.baseCommits).toHaveLength(leaves);
    for (const c of rework.baseCommits) expect(c).toMatch(/^[0-9a-f]{40}$/);
    expect(spec.status).toBe("draft");
    expect(spec.id).not.toBe(full.specId);

    const listed = (await flow.h.call({ url: `/v1/deliveries/${execution.id}/reworks` })).json();
    expect(listed.reworks.map((r: { id: string }) => r.id)).toContain(rework.id);
    expect(listed.reworks.at(-1).specs[0]).toMatchObject({ id: spec.id, status: "draft" });

    // The rework's own plan starts from those commits; the original mission did not.
    const reworkPlan = await approvedPlan(flow, await approveDraft(flow, spec.id));
    const second = await flow.h.call({
      method: "POST",
      url: "/v1/executions",
      payload: { planId: reworkPlan.id },
    });
    expect(second.statusCode).toBe(201);
    const missions = flow.fake.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/missions",
    );
    expect((missions[0]!.body as { baseCommits?: string[] }).baseCommits).toBeUndefined();
    expect((missions.at(-1)!.body as { baseCommits?: string[] }).baseCommits).toEqual(
      rework.baseCommits,
    );
  });
});

describe("mimir status", () => {
  it("reports configuration and reachability", async () => {
    const flow = (f = await startMimirFlow());
    const ok = (await flow.h.call({ url: "/v1/mimir/status" })).json();
    expect(ok).toMatchObject({ configured: true, reachable: true, url: flow.fake.url });
    await flow.fake.stop();
    const down = (await flow.h.call({ url: "/v1/mimir/status" })).json();
    expect(down).toMatchObject({ configured: true, reachable: false });
    await flow.fake.start();
  });
});
