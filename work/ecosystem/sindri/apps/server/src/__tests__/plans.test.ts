import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approvedPlan, approvedSpec, startFlow, type Flow } from "./flow.js";

let f: Flow;
beforeEach(async () => {
  f = await startFlow();
});
afterEach(async () => f.close());

const propose = (specId: string) =>
  f.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } });

describe("plans", () => {
  it("proposes a draft plan from an approved spec with harness choice and rationale", async () => {
    const specId = await approvedSpec(f);
    const res = await propose(specId);
    expect(res.statusCode).toBe(201);
    const { plan, harnessSource } = res.json();
    expect(harnessSource).toBe("fake");
    expect(plan).toMatchObject({ specId, version: 1, status: "draft", projectId: f.projectId });
    const impl = plan.tasks.find((t: { role: string }) => t.role === "implementer");
    expect(impl.harnessId).toBeTruthy();
    expect(impl.harnessLockDigest).toMatch(/^sha256:/);
    expect(impl.selectionRationale.length).toBeGreaterThan(0);
  });

  it("refuses to plan an unapproved spec (409) and an unknown spec (404)", async () => {
    const d = await f.h.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: { projectId: f.projectId, request: "Add CSV export" },
    });
    const draft = await propose(d.json().spec.id);
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error.code).toBe("invalid_state");
    const unknown = await propose("nope");
    expect(unknown.statusCode).toBe(404);
    const bad = await f.h.call({ method: "POST", url: "/v1/plans/propose", payload: {} });
    expect(bad.statusCode).toBe(422);
  });

  it("lists, gets, submits and approves; approving twice is 409", async () => {
    const specId = await approvedSpec(f);
    const plan = await approvedPlan(f, specId);
    // The approver is the authenticated approval principal (audit M9).
    expect(plan).toMatchObject({
      status: "approved",
      approvedBy: expect.stringMatching(/^local:.+\/web#aps_[0-9a-f]+$/),
    });
    const bySpec = await f.h.call({ url: `/v1/plans?specId=${specId}` });
    expect(bySpec.json().plans.map((p: { id: string }) => p.id)).toEqual([plan.id]);
    const byProject = await f.h.call({ url: `/v1/plans?projectId=${f.projectId}` });
    expect(byProject.json().plans).toHaveLength(1);
    const got = await f.h.call({ url: `/v1/plans/${plan.id}` });
    expect(got.json()).toMatchObject({
      plan: { id: plan.id },
      versions: [{ id: plan.id, version: 1, status: "approved" }],
    });
    const again = await f.h.call({
      method: "POST",
      url: `/v1/plans/${plan.id}/approve`,
      headers: await f.h.approvalHeaders(),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect((await f.h.call({ url: "/v1/plans?projectId=missing" })).statusCode).toBe(404);
    expect((await f.h.call({ url: "/v1/plans" })).statusCode).toBe(422);
  });

  it("returns the dry-run order", async () => {
    const specId = await approvedSpec(f);
    const plan = (await propose(specId)).json().plan;
    const res = await f.h.call({ url: `/v1/plans/${plan.id}/dry-run` });
    expect(res.statusCode).toBe(200);
    const { dryRun } = res.json();
    expect(dryRun.order).toHaveLength(plan.tasks.length);
    expect(dryRun.steps[0].step).toBe(1);
    expect(dryRun.order.at(-1)).toBe("qa");
  });

  it("revising creates a new draft version listed under versions", async () => {
    const specId = await approvedSpec(f);
    const plan = await approvedPlan(f, specId);
    const full = (await f.h.call({ url: `/v1/plans/${plan.id}` })).json().plan;
    const res = await f.h.call({
      method: "POST",
      url: `/v1/plans/${plan.id}/revise`,
      payload: { tasks: full.tasks },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().plan).toMatchObject({ version: 2, status: "draft" });
    const versions = (await f.h.call({ url: `/v1/plans/${plan.id}/versions` })).json().versions;
    expect(versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual(
      [
        [1, "approved"],
        [2, "draft"],
      ],
    );
  });

  it("returns 404 for unknown plans", async () => {
    for (const url of ["/v1/plans/x", "/v1/plans/x/dry-run", "/v1/plans/x/versions"])
      expect((await f.h.call({ url })).statusCode).toBe(404);
    const res = await f.h.call({
      method: "POST",
      url: "/v1/plans/x/approve",
      payload: {},
      headers: await f.h.approvalHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("uses the installed Brokkr SDK when enabled", async () => {
    const specId = await approvedSpec(f);
    const st = (await f.h.call({ url: "/v1/settings" })).json().settings;
    await f.h.call({ method: "PUT", url: "/v1/settings", payload: { ...st, brokkrEnabled: true } });
    const res = await propose(specId);
    expect(res.statusCode).toBe(201);
  });
});
