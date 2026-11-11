import type { ReviewRecord } from "@sindri/delivery";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryService } from "../delivery-service.js";
import { approvedPlan, approvedSpec } from "./flow.js";
import { ORIGIN } from "./helpers.js";
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

describe("executions: refusals", () => {
  it("answers 503 when Mimir cannot be reached to start a run", async () => {
    const flow = (f = await startMimirFlow());
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    await flow.fake.stop();
    const res = await flow.h.call({
      method: "POST",
      url: "/v1/executions",
      payload: { planId: plan.id },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("mimir_unavailable");
    expect((await flow.h.call({ url: "/v1/executions?projectId=prj_nope" })).statusCode).toBe(404);
  });

  it("refuses unknown tasks, approvals and deliveries of a finished run", async () => {
    const flow = (f = await startMimirFlow());
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const escalate = (task: string) =>
      flow.h.call({
        method: "POST",
        url: `/v1/executions/${execution.id}/escalations/${task}`,
        payload: { decision: "retry", reason: "again" },
      });
    expect((await escalate("ghost")).json().error.message).toBe("execution task not found");
    // An id that is neither a local approval nor a PR approval of this mission.
    const approval = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/apr_nope`,
      payload: { decision: "approved" },
      headers: await flow.h.approvalHeaders(),
    });
    expect(approval.statusCode).toBe(404);
    expect(approval.json().error.message).toBe("approval not found");
    expect((await flow.h.call({ url: "/v1/deliveries/exe_nope/reworks" })).statusCode).toBe(404);
    const pr = await flow.h.call({
      method: "POST",
      url: "/v1/executions/exe_nope/pr",
      headers: await flow.h.approvalHeaders(),
    });
    expect(pr.statusCode).toBe(404);
    expect(pr.json().error.message).toBe("execution not found");
    // No local delivery artifact was recorded for this run.
    const local = await flow.h.call({ url: `/v1/deliveries/${execution.id}/local` });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toEqual({ result: null });
  });

  it("refuses an escalation decision once the run has finished", async () => {
    const flow = (f = await startMimirFlow({
      qa: [
        { kind: "fail", reason: "flaky" },
        { kind: "fail", reason: "flaky" },
      ],
    }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "awaiting_human");
    const cancel = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/cancel`,
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().execution.status).toBe("cancelled");
    // The task keeps its escalation as a record, but nothing can be decided on it any more.
    const res = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/escalations/qa`,
      payload: { decision: "retry", reason: "again" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe("the execution has finished");
  });

  it("answers 503 when Mimir cannot be reached to decide an approval or cancel", async () => {
    const flow = (f = await startMimirFlow({
      "implement-frontend": [{ kind: "approval", action: "fs.write" }],
    }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "awaiting_human");
    const view = (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json();
    await flow.fake.stop();
    const decide = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/${view.approvals[0].id}`,
      payload: { decision: "approved" },
      headers: await flow.h.approvalHeaders(),
    });
    expect([decide.statusCode, decide.json().error.code]).toEqual([503, "mimir_unavailable"]);
    const cancel = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/cancel`,
      payload: {},
    });
    expect([cancel.statusCode, cancel.json().error.code]).toEqual([503, "mimir_unavailable"]);
    expect(await statusOf(flow, execution.id)()).toBe("awaiting_human");
  });
});

describe("executions: PR approvals Mimir raises after the run settled", () => {
  it("relays the human decision on a pr.create approval once, through Mimir", async () => {
    const flow = (f = await startMimirFlow({
      "implement-frontend": [{ kind: "approval", action: "pr.create" }],
    }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "awaiting_human");
    const mimirApprovalId = flow.fake.approvals()[0]!.id;
    // Not one Sindri recorded while following the run: it is read from Mimir.
    flow.h.db.prepare("DELETE FROM execution_approvals WHERE execution_id = ?").run(execution.id);
    const headers = await flow.h.approvalHeaders();
    const first = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/${mimirApprovalId}`,
      payload: { decision: "approved", reason: "ship it" },
      headers,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().approval).toMatchObject({
      id: mimirApprovalId,
      action: "pr.create",
      status: "approved",
    });
    await until(
      () => Promise.resolve(flow.fake.approvals()[0]!.status),
      (s) => s === "approved",
    );
    const again = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/${mimirApprovalId}`,
      payload: { decision: "rejected" },
      headers,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe("approval is already approved");
  });
});

describe("events stream", () => {
  it("passes the CORS headers of an allowed origin to the stream", async () => {
    const flow = (f = await startMimirFlow());
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const res = await flow.h.call({
      url: `/v1/executions/${execution.id}/events?follow=0`,
      headers: { origin: ORIGIN, "last-event-id": "evt_unknown" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    // An unknown Last-Event-ID replays from the start.
    expect(res.body.startsWith("event: execution.snapshot")).toBe(true);
    expect(res.body).toContain("event: execution.event");
  });
});

describe("deliveries: rework refusals", () => {
  /** Hides every result commit Mimir reports, while `hide` is set. */
  function hidingResults() {
    const state = { hide: false };
    const mimirFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!state.hide || new URL(url).pathname !== "/v1/tasks") return res;
      const body = (await res.json()) as { tasks: Record<string, unknown>[] };
      for (const t of body.tasks) delete t["resultCommit"];
      return Response.json(body, { status: res.status });
    };
    return { state, mimirFetch };
  }

  it("refuses a rework of a delivery without a verified result commit", async () => {
    const { state, mimirFetch } = hidingResults();
    const flow = (f = await startMimirFlow({}, { mimirFetch }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    state.hide = true;
    const res = await flow.h.call({
      method: "POST",
      url: `/v1/deliveries/${execution.id}/rework`,
      payload: { feedback: "Use ISO dates." },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe(
      "this delivery has no verified result commit to build a rework on",
    );
    // Nothing was drafted, and the delivery is free for a later request.
    expect(
      (await flow.h.call({ url: `/v1/deliveries/${execution.id}/reworks` })).json().reworks,
    ).toEqual([]);
    state.hide = false;
  });
});

describe("reviews inbox: findings", () => {
  it("lists each finding of a review, and a reason for a request without findings", async () => {
    const review = (over: Partial<ReviewRecord>) =>
      ({
        id: "rev_1",
        planTaskId: "implement-frontend",
        role: "reviewer",
        verdict: "request_changes",
        reason: null,
        findings: [],
        ...over,
      }) as unknown as ReviewRecord;
    const stub: Partial<DeliveryService> = {
      kind: "custom",
      assess: () => Promise.resolve(),
      gateResults: () => [],
      reviews: () => [
        review({ findings: [{ severity: "minor", message: "rename x" }] }),
        review({ id: "rev_2", reason: null }),
        review({ id: "rev_3", verdict: "approve" }),
      ],
    };
    const flow = (f = await startMimirFlow({}, { deliveryService: stub as DeliveryService }));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const inbox = (await flow.h.call({ url: `/v1/reviews?projectId=${flow.projectId}` })).json();
    expect(inbox.deliveryService).toBe("custom");
    expect(inbox.findings).toEqual([
      expect.objectContaining({ reviewId: "rev_1", severity: "minor", message: "rename x" }),
      expect.objectContaining({
        reviewId: "rev_2",
        severity: "major",
        message: "changes requested",
      }),
    ]);
  });
});

describe("deliveries: what a rework request tells the drafter", () => {
  const withReport = (report: () => Promise<unknown>) => {
    const stub: Partial<DeliveryService> = {
      kind: "custom",
      assess: () => Promise.resolve(),
      gateResults: () => [],
      reviews: () => [],
      report: report as DeliveryService["report"],
    };
    return startMimirFlow({}, { deliveryService: stub as DeliveryService });
  };
  const draftRequest = (flow: MimirFlow) =>
    flow.provider.calls
      .filter((c) => c.metadata?.purpose !== "classify")
      .map((c) => c.messages.map((m) => m.content).join("\n"))
      .find((t) => t.includes("Rework of a delivered change")) ?? "";

  it("names the files the delivered change touched", async () => {
    const flow = (f = await withReport(() =>
      Promise.resolve({ changedFiles: [{ path: "src/export.ts" }, { path: "src/csv.ts" }] }),
    ));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const res = await flow.h.call({
      method: "POST",
      url: `/v1/deliveries/${execution.id}/rework`,
      payload: { feedback: "Use ISO dates." },
    });
    expect(res.statusCode).toBe(201);
    expect(draftRequest(flow)).toContain("- src/export.ts");
    expect(draftRequest(flow)).toContain("- src/csv.ts");
  });

  it("still drafts the rework when the delivery report cannot be built", async () => {
    const flow = (f = await withReport(() => Promise.reject(new Error("no report"))));
    const { execution } = await run(flow);
    await until(statusOf(flow, execution.id), (s) => s === "verified_pending_review");
    const res = await flow.h.call({
      method: "POST",
      url: `/v1/deliveries/${execution.id}/rework`,
      payload: { feedback: "Use ISO dates." },
    });
    expect(res.statusCode).toBe(201);
    const request = draftRequest(flow);
    expect(request).toContain("Use ISO dates.");
    expect(request).not.toContain("Files the delivered change touched");
  });
});
