import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../settings.js";
import { approvedPlan, approvedSpec, startFlow, type Flow } from "./flow.js";
import { startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

let f: Flow | MimirFlow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const create = (flow: Flow, planId: string) =>
  flow.h.call({ method: "POST", url: "/v1/executions", payload: { planId } });
const getExec = async (flow: Flow, id: string) =>
  (await flow.h.call({ url: `/v1/executions/${id}` })).json();
const status = (flow: Flow, id: string) => async () => (await getExec(flow, id)).execution.status;

describe("executions without Mimir", () => {
  it("returns 503 mimir_unavailable for an approved plan when Mimir is not configured", async () => {
    const flow = (f = await startFlow());
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const res = await create(flow, plan.id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("mimir_unavailable");
  });

  it("refuses unknown (404) and unapproved (409) plans", async () => {
    const flow = (f = await startFlow());
    expect((await create(flow, "nope")).statusCode).toBe(404);
    const specId = await approvedSpec(flow);
    const draft = (
      await flow.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } })
    ).json().plan;
    const res = await create(flow, draft.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("invalid_state");
    expect((await flow.h.call({ url: "/v1/executions/nope" })).statusCode).toBe(404);
  });

  it("blocks a non-loopback Mimir URL in local-only mode", async () => {
    const flow = (f = await startFlow());
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    // Settings refuse this combination (422); a row stored before that check is still blocked.
    new SettingsStore(flow.h.db, () => new Date()).put({
      ...DEFAULT_SETTINGS,
      localOnly: true,
      mimirUrl: "https://mimir.example.com",
      mimirTokenSecret: "x",
    });
    const res = await create(flow, plan.id);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("local_only");
  });
});

describe("executions with a fake Mimir", () => {
  it("runs an approved plan, surfaces a gated action and continues after a human approval", async () => {
    const flow = (f = await startMimirFlow({
      "implement-frontend": [{ kind: "approval", action: "fs.write", reason: "write export.ts" }],
    }));
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const res = await create(flow, plan.id);
    expect(res.statusCode).toBe(201);
    const { execution, tasks } = res.json();
    expect(execution).toMatchObject({ planId: plan.id, projectId: flow.projectId });
    expect(tasks).toHaveLength(plan.tasks.length);

    await until(status(flow, execution.id), (s) => s === "awaiting_human");
    const detail = await getExec(flow, execution.id);
    expect(detail.links.mission).toBe(`${flow.fake.url}/missions/${execution.mimirMissionId}`);
    // Agent deep links from the session ids Mimir put on the task's events.
    const impl = detail.links.agents.find(
      (a: { planTaskId: string }) => a.planTaskId === "implement-frontend",
    );
    expect(impl.sessionId).toMatch(/^ses/);
    expect(impl.url).toBe(`${flow.fake.url}/agents/${impl.sessionId}`);
    const pending = detail.approvals.filter((a: { status: string }) => a.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ action: "fs.write", planTaskId: "implement-frontend" });

    const decide = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/${pending[0].mimirApprovalId}`,
      payload: { decision: "approved" },
      headers: await flow.h.approvalHeaders(),
    });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().approval.status).toBe("approved");
    await until(status(flow, execution.id), (s) => s === "verified_pending_review");

    // Deciding again is a conflict; unknown approvals are 404.
    const again = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/${pending[0].id}`,
      payload: { decision: "rejected" },
      headers: await flow.h.approvalHeaders(),
    });
    expect(again.statusCode).toBe(409);
    const unknown = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/apr_nope`,
      payload: { decision: "approved" },
      headers: await flow.h.approvalHeaders(),
    });
    expect(unknown.statusCode).toBe(404);
    const list = (await flow.h.call({ url: `/v1/executions?projectId=${flow.projectId}` })).json();
    expect(list.executions.map((e: { id: string }) => e.id)).toEqual([execution.id]);
  });

  it("replays execution events over SSE and resumes after Last-Event-ID", async () => {
    const flow = (f = await startMimirFlow());
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (await create(flow, plan.id)).json();
    await until(status(flow, execution.id), (s) => s === "verified_pending_review");
    const all = await flow.h.call({ url: `/v1/executions/${execution.id}/events?follow=0` });
    expect(all.statusCode).toBe(200);
    expect(all.headers["content-type"]).toMatch(/text\/event-stream/);
    const ids = [...all.body.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    expect(all.body).toMatch(/event: execution.event\ndata: \{.*"type":"mission.completed"/);
    expect(all.body).toMatch(/event: execution.snapshot/);
    const rest = await flow.h.call({
      url: `/v1/executions/${execution.id}/events?follow=0`,
      headers: { "last-event-id": ids[2] as string },
    });
    const restIds = [...rest.body.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]);
    expect(restIds).toEqual(ids.slice(3));
  });

  it("relays live events to an open stream", async () => {
    const flow = (f = await startMimirFlow({
      "implement-frontend": [{ kind: "approval", action: "fs.write" }],
    }));
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (await create(flow, plan.id)).json();
    await until(status(flow, execution.id), (s) => s === "awaiting_human");
    const address = await flow.h.app.listen({ host: "127.0.0.1", port: 0 });
    const ctrl = new AbortController();
    const res = await fetch(`${address}/v1/executions/${execution.id}/events`, {
      headers: { authorization: `Bearer ${"t".repeat(64)}` },
      signal: ctrl.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const approvalId = (await getExec(flow, execution.id)).approvals[0].mimirApprovalId;
    await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/${approvalId}`,
      payload: { decision: "approved" },
      headers: await flow.h.approvalHeaders(),
    });
    let text = "";
    const dec = new TextDecoder();
    while (!/"to":"verified_pending_review"/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value);
    }
    ctrl.abort();
    expect(text).toMatch(/"type":"approval.decided"/);
    expect(text).toMatch(/event: execution.notice\ndata: \{.*"to":"verified_pending_review"/);
  });

  it("resolves an escalated task with a human retry and runs on to verification", async () => {
    const flow = (f = await startMimirFlow({
      qa: [
        { kind: "fail", reason: "flaky" },
        { kind: "fail", reason: "flaky" },
      ],
    }));
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (await create(flow, plan.id)).json();
    await until(status(flow, execution.id), (s) => s === "awaiting_human");
    const qa = (await getExec(flow, execution.id)).tasks.find(
      (t: { planTaskId: string }) => t.planTaskId === "qa",
    );
    expect(qa.escalation).toBe("ask");
    const bad = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/escalations/qa`,
      payload: { decision: "maybe", reason: "x" },
    });
    expect(bad.statusCode).toBe(422);
    const res = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/escalations/qa`,
      payload: { decision: "retry", reason: "flaky runner, try again" },
    });
    expect(res.statusCode).toBe(200);
    await until(status(flow, execution.id), (s) => s === "verified_pending_review");
    const none = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/escalations/implement-frontend`,
      payload: { decision: "retry", reason: "x" },
    });
    expect(none.statusCode).toBe(409);
  });

  it("aborts an execution from an escalation", async () => {
    const flow = (f = await startMimirFlow({
      qa: [
        { kind: "fail", reason: "broken" },
        { kind: "fail", reason: "broken" },
      ],
    }));
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (await create(flow, plan.id)).json();
    await until(status(flow, execution.id), (s) => s === "awaiting_human");
    const res = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/escalations/qa`,
      payload: { decision: "abort", reason: "not worth it" },
    });
    expect(res.statusCode).toBe(200);
    await until(status(flow, execution.id), (s) => s === "cancelled");
  });
});
