import { afterEach, describe, expect, it } from "vitest";
import { approvedPlan, approvedSpec } from "./flow.js";
import { startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

let f: MimirFlow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const count = (flow: MimirFlow, table: string) =>
  (flow.h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("execution event stream is read-only (review I1)", () => {
  it("assesses once on settle; opening the stream adds no gate, review or delivery rows and no LLM call", async () => {
    const flow = (f = await startMimirFlow());
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (
      await flow.h.call({ method: "POST", url: "/v1/executions", payload: { planId: plan.id } })
    ).json();
    const detail = async () =>
      (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json();
    await until(detail, (d) => d.execution.status === "verified_pending_review");
    await until(detail, (d) => d.gates.length === plan.tasks.length);
    await until(
      async () => count(flow, "deliveries"),
      (n) => n === 1,
    );
    // Settle the dust: the assessment ran exactly once.
    await new Promise((r) => setTimeout(r, 200));
    const before = {
      gates: count(flow, "gate_evaluations"),
      deliveries: count(flow, "deliveries"),
      reviews: count(flow, "reviews"),
      llm: flow.provider.calls.length,
    };
    expect(before.gates).toBe(plan.tasks.length);
    expect(before.deliveries).toBe(1);

    // Replay-only and live streams, twice each.
    const address = await flow.h.app.listen({ host: "127.0.0.1", port: 0 });
    for (let i = 0; i < 2; i++) {
      const replay = await flow.h.call({ url: `/v1/executions/${execution.id}/events?follow=0` });
      expect(replay.statusCode).toBe(200);
      const ctrl = new AbortController();
      const res = await fetch(`${address}/v1/executions/${execution.id}/events`, {
        headers: { authorization: `Bearer ${"t".repeat(64)}` },
        signal: ctrl.signal,
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await new Promise((r) => setTimeout(r, 150));
      ctrl.abort();
    }
    await new Promise((r) => setTimeout(r, 200));
    expect({
      gates: count(flow, "gate_evaluations"),
      deliveries: count(flow, "deliveries"),
      reviews: count(flow, "reviews"),
      llm: flow.provider.calls.length,
    }).toEqual(before);

    // The explicit route re-assesses.
    const again = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/assess`,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect(count(flow, "gate_evaluations")).toBe(2 * plan.tasks.length);
  });

  it("requires a bearer token for the stream", async () => {
    const flow = (f = await startMimirFlow());
    const res = await flow.h.app.inject({ url: "/v1/executions/exe_x/events" });
    expect(res.statusCode).toBe(401);
  });
});
