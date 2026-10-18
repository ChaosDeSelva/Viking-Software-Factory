import { createFakeMimir, type FakeMimir } from "@sindri/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer, type BuildServerOptions } from "../app.js";
import { approvedPlan, approvedSpec } from "./flow.js";
import { TOKEN } from "./helpers.js";
import { MIMIR_SECRET, startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

let f: MimirFlow | undefined;
let second: FastifyInstance | undefined;
let other: FakeMimir | undefined;
afterEach(async () => {
  await second?.close();
  second = undefined;
  await f?.close();
  f = undefined;
  await other?.close();
  other = undefined;
});

const count = (flow: MimirFlow, sql: string, ...p: unknown[]) =>
  (flow.h.db.prepare(sql).get(...p) as { n: number }).n;

function restart(flow: MimirFlow, opts: Partial<BuildServerOptions> = {}): FastifyInstance {
  return buildServer({
    db: flow.h.db,
    dataDir: flow.h.dir,
    authToken: TOKEN,
    providerFactory: () => flow.provider,
    secrets: { get: (k) => Promise.resolve(k === MIMIR_SECRET ? flow.fake.token : undefined) },
    ...opts,
  });
}
const get = (app: FastifyInstance, url: string) =>
  app.inject({ url, headers: { authorization: `Bearer ${TOKEN}` } });

describe("startup resume retries until Mimir is reachable (S7b parked item)", () => {
  it("resumes the run once Mimir comes back, without a client", { timeout: 30_000 }, async () => {
    const flow = (f = await startMimirFlow(
      { "implement-frontend": [{ kind: "approval", action: "fs.write" }] },
      {},
      40,
    ));
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const { execution } = (
      await flow.h.call({ method: "POST", url: "/v1/executions", payload: { planId: plan.id } })
    ).json();
    await flow.h.app.close();
    await flow.fake.stop();

    second = restart(flow, { resumeRetryMs: 50 });
    await second.ready();
    await new Promise((r) => setTimeout(r, 300));
    await flow.fake.start();
    const inbox = await until(
      async () => (await get(second!, `/v1/reviews?projectId=${flow.projectId}`)).json(),
      (r) => r.approvals.length === 1,
    );
    expect(inbox.approvals[0]).toMatchObject({ executionId: execution.id, action: "fs.write" });
  });
});

describe("assessment claims backfill (S7b parked item M-A)", () => {
  it("does not re-assess verified executions from a database written before claims existed", async () => {
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
    // A pre-fix database: assessed (gate rows) but no claim rows and no backfill applied.
    flow.h.db.prepare("DELETE FROM quality_assessments").run();
    flow.h.db.prepare("DELETE FROM schema_migrations WHERE namespace = 'server_backfill'").run();
    const llmCalls = flow.provider.calls.length;

    second = restart(flow);
    await second.ready();
    await new Promise((r) => setTimeout(r, 500));
    expect(count(flow, gates, execution.id)).toBe(plan.tasks.length);
    expect(flow.provider.calls.length).toBe(llmCalls);
    expect(
      count(
        flow,
        "SELECT COUNT(*) AS n FROM quality_assessments WHERE execution_id = ?",
        execution.id,
      ),
    ).toBe(1);
  });
});

describe("Mimir URL change (S7b review m2)", () => {
  it(
    "stops runs on the old connection when the Mimir URL changes",
    { timeout: 30_000 },
    async () => {
      // Slow steps: the run stays attached to this Mimir while it follows events.
      const flow = (f = await startMimirFlow({}, {}, 400));
      const plan = await approvedPlan(flow, await approvedSpec(flow));
      const { execution } = (
        await flow.h.call({ method: "POST", url: "/v1/executions", payload: { planId: plan.id } })
      ).json();
      await until(
        async () => (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json().running,
        (running) => running === true,
      );
      other = await createFakeMimir({ token: flow.fake.token });
      const st = (await flow.h.call({ url: "/v1/settings" })).json().settings;
      const put = await flow.h.call({
        method: "PUT",
        url: "/v1/settings",
        payload: { ...st, mimirUrl: other.url },
      });
      expect(put.statusCode).toBe(200);
      await until(
        async () => (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json().running,
        (running) => running === false,
        3_000,
      );
    },
  );
});
