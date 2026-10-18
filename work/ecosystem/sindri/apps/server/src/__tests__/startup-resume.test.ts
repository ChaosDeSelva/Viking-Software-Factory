import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../app.js";
import { approvedPlan, approvedSpec } from "./flow.js";
import { TOKEN } from "./helpers.js";
import { MIMIR_SECRET, startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

let f: MimirFlow | undefined;
let second: FastifyInstance | undefined;
afterEach(async () => {
  await second?.close();
  second = undefined;
  await f?.close();
  f = undefined;
});

const count = (flow: MimirFlow, sql: string, ...p: unknown[]) =>
  (flow.h.db.prepare(sql).get(...p) as { n: number }).n;

/** A second server over the same database, as after a restart. */
function restart(flow: MimirFlow): FastifyInstance {
  return buildServer({
    db: flow.h.db,
    dataDir: flow.h.dir,
    authToken: TOKEN,
    providerFactory: () => flow.provider,
    secrets: { get: (k) => Promise.resolve(k === MIMIR_SECRET ? flow.fake.token : undefined) },
  });
}
const get = (app: FastifyInstance, url: string) =>
  app.inject({ url, headers: { authorization: `Bearer ${TOKEN}` } });

describe("startup resume (review I2)", () => {
  it("resumes non-final executions at startup so approvals reach the inbox without a client", async () => {
    const flow = (f = await startMimirFlow(
      { "implement-frontend": [{ kind: "approval", action: "fs.write" }] },
      {},
      40,
    ));
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (
      await flow.h.call({ method: "POST", url: "/v1/executions", payload: { planId: plan.id } })
    ).json();
    // Crash before Mimir asks for the approval.
    await flow.h.app.close();
    const approvals = "SELECT COUNT(*) AS n FROM execution_approvals WHERE execution_id = ?";
    expect(count(flow, approvals, execution.id)).toBe(0);

    second = restart(flow);
    await second.ready();
    const inbox = await until(
      async () => (await get(second!, `/v1/reviews?projectId=${flow.projectId}`)).json(),
      (r) => r.approvals.length === 1,
    );
    expect(inbox.approvals[0]).toMatchObject({ executionId: execution.id, action: "fs.write" });
  });

  it("assesses at startup an execution that settled without an assessment", async () => {
    const flow = (f = await startMimirFlow());
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (
      await flow.h.call({ method: "POST", url: "/v1/executions", payload: { planId: plan.id } })
    ).json();
    const gates = "SELECT COUNT(*) AS n FROM gate_evaluations WHERE execution_id = ?";
    await until(
      async () => count(flow, gates, execution.id),
      (n) => n === plan.tasks.length,
    );
    await flow.h.app.close();
    // As if the process died after settling but before assessing.
    flow.h.db.prepare("DELETE FROM gate_evaluations").run();
    flow.h.db.prepare("DELETE FROM quality_assessments").run();

    second = restart(flow);
    await second.ready();
    await until(
      async () => count(flow, gates, execution.id),
      (n) => n === plan.tasks.length,
    );
    // And only once.
    await new Promise((r) => setTimeout(r, 300));
    expect(count(flow, gates, execution.id)).toBe(plan.tasks.length);
  });
});
