import { MAX_BUDGET_TOKENS, UpdateBudgetResponseSchema, newId } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH } from "../test-helpers.js";
import { createTask, harness, type Harness, type Json } from "../orchestrator/test-harness.js";

// Integration tests: real git worktrees and server boots (slow on a busy host).
vi.setConfig({ testTimeout: 120_000 });

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function patch(h: Harness, url: string, body: unknown, key = h.key()) {
  const res = await h.app.inject({
    method: "PATCH",
    url,
    headers: { ...AUTH, "idempotency-key": key },
    payload: body as Record<string, unknown>,
  });
  return {
    status: res.statusCode,
    json: res.json() as Json,
    replayed: res.headers["idempotency-replayed"] === "true",
  };
}

/** Project → mission → crew whose budget is `limitTokens`, with tasks A and B (B after A). */
async function world(limitTokens = 100) {
  const h = await harness();
  harnesses.push(h);
  const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
  const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
  const missionId = m.json.mission.id as string;
  const c = await h.post("/v1/crews", {
    missionId,
    template: "solo",
    members: [{ role: "implementer", agentKind: "shell" }],
    budget: { limitTokens, onUnknown: "allow" },
  });
  const crewId = c.json.crew.id as string;
  const a = await createTask(h, missionId, "A", "echo a");
  const b = await createTask(h, missionId, "B", "echo b", [a]);
  return { h, missionId, crewId, a, b };
}

/** Measured usage for the agent that ran `taskId`, as an adapter reports it. */
function spend(h: Harness, taskId: string, tokens: number, estimatedCost: number | null = null) {
  const at = h.app.mimir.now().toISOString();
  h.store.append({
    streamId: `usage-test:${taskId}:${tokens}:${estimatedCost}`,
    type: "usage.recorded",
    source: "test",
    provenance: "observed",
    occurredAt: at,
    observedAt: at,
    payload: {
      sample: {
        id: newId("usg"),
        agentId: h.task(taskId).agentId!,
        tokens,
        estimatedCost,
        source: "measured",
        createdAt: at,
        updatedAt: at,
        version: 0,
      },
    },
  });
}

describe("PATCH /v1/crews/:id/budget", () => {
  it("unblocks tasks held by an exhausted crew budget on the next tick, and survives a restart", async () => {
    const { h, missionId, crewId, a, b } = await world(100);
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(a).status).toBe("completed");
    spend(h, a, 500);
    await h.tick();
    await h.tick();
    expect(h.task(b)).toMatchObject({ status: "blocked", blockedReason: "budget_exceeded" });

    // What a client (Sindri) sees: which budget, by how much.
    const exceeded = h.events(["budget.exceeded"]);
    expect(exceeded).toHaveLength(1);
    const budgetId = (exceeded[0]!.payload as { budgetId: string }).budgetId;
    expect(exceeded[0]).toMatchObject({
      missionId,
      crewId,
      payload: {
        budgetId,
        unit: "tokens",
        used: 500,
        limit: 100,
        scope: "crew",
        overBy: 400,
        budgetVersion: 0,
      },
    });
    const items = (await h.get("/v1/attention")).json.items as Record<string, unknown>[];
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "budget_exceeded",
        budgetId,
        scope: "crew",
        crewId,
        spentTokens: 500,
        limitTokens: 100,
        limitCost: null,
        budgetVersion: 0,
      }),
    );

    const key = h.key();
    const raised = await patch(h, `/v1/crews/${crewId}/budget`, { limitTokens: 2000 }, key);
    expect(raised.status).toBe(200);
    expect(UpdateBudgetResponseSchema.parse(raised.json)).toMatchObject({
      changed: true,
      budget: { id: budgetId, crewId, missionId, limitTokens: 2000, version: 1 },
    });
    // Idempotent: a replayed key returns the stored reply; the same values change nothing.
    const replay = await patch(h, `/v1/crews/${crewId}/budget`, { limitTokens: 2000 }, key);
    expect(replay).toMatchObject({ status: 200, replayed: true, json: raised.json });
    const same = await patch(h, `/v1/crews/${crewId}/budget`, { limitTokens: 2000 });
    expect(same).toMatchObject({ status: 200, json: { changed: false } });
    expect(h.events(["budget.updated"])).toEqual([
      expect.objectContaining({
        crewId,
        missionId,
        payload: expect.objectContaining({
          budget: expect.objectContaining({ limitTokens: 2000, version: 1 }),
          previous: expect.objectContaining({ limitTokens: 100, version: 0 }),
        }),
      }),
    ]);
    // Audited as an operator action.
    expect(h.store.audit.list().filter((e) => e.action === "crew.budget.update")).toEqual([
      expect.objectContaining({ actor: "operator", decision: "succeeded", target: budgetId }),
      expect.objectContaining({ actor: "operator", decision: "succeeded", target: budgetId }),
    ]);

    await h.tick();
    expect(h.task(b).status).not.toBe("blocked");
    expect((await h.get("/v1/attention")).json.items).not.toContainEqual(
      expect.objectContaining({ kind: "budget_exceeded" }),
    );
    for (let i = 0; i < 5 && h.task(b).status !== "completed"; i++) {
      await h.tick();
      await h.advance(1000);
    }
    expect(h.task(b).status).toBe("completed");

    await h.restart();
    expect(h.app.mimir.readModel.budgets.get(budgetId)).toMatchObject({
      limitTokens: 2000,
      version: 1,
    });
    // The raised limit is reached again: reported again, for the new version.
    spend(h, b, 1600);
    await h.tick();
    const again = h.events(["budget.exceeded"]);
    expect(again).toHaveLength(2);
    expect(again[1]!.payload).toMatchObject({
      used: 2100,
      limit: 2000,
      overBy: 100,
      budgetVersion: 1,
    });
    await h.tick();
    expect(h.events(["budget.exceeded"])).toHaveLength(2);
  });

  it("validates limits and scope", async () => {
    const { h, crewId, missionId } = await world();
    const url = `/v1/crews/${crewId}/budget`;
    for (const body of [
      {},
      { limitTokens: 0 },
      { limitTokens: -5 },
      { limitTokens: 1.5 },
      { limitTokens: MAX_BUDGET_TOKENS + 1 },
      { limitCost: 0 },
      { limitCost: 2_000_000 },
      { warnAtFraction: 2 },
      { limitTokens: 10, surprise: true },
    ]) {
      const res = await patch(h, url, body);
      expect([res.status, body]).toEqual([422, body]);
    }
    expect((await patch(h, `/v1/crews/${newId("crw")}/budget`, { limitTokens: 5 })).status).toBe(
      404,
    );
    expect((await patch(h, url, { limitTokens: 5, expectedVersion: 3 })).status).toBe(409);
    // null removes one limit; the other dimension can be added.
    const res = await patch(h, url, { limitTokens: null, limitCost: 12.5, expectedVersion: 0 });
    expect(res.json).toMatchObject({
      changed: true,
      budget: { limitTokens: null, limitCost: 12.5, version: 1 },
    });
    expect(h.events(["budget.updated"])).toHaveLength(1);
    await h.post(`/v1/missions/${missionId}/cancel`);
    expect((await patch(h, url, { limitTokens: 5 })).status).toBe(409);
  });
});

describe("budget events of a budget with both limits", () => {
  it("report the dimension that ran out, not always tokens", async () => {
    const { h, missionId, crewId, a, b } = await world(1_000_000);
    // Add a cost limit to the crew's token budget.
    expect((await patch(h, `/v1/crews/${crewId}/budget`, { limitCost: 1 })).status).toBe(200);
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(a).status).toBe("completed");
    // Few tokens, but five times the cost limit.
    spend(h, a, 10, 5);
    await h.tick();
    await h.tick();
    expect(h.task(b)).toMatchObject({ status: "blocked", blockedReason: "budget_exceeded" });
    const exceeded = h.events(["budget.exceeded"]);
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]!.payload).toMatchObject({
      unit: "cost",
      used: 5,
      limit: 1,
      overBy: 4,
      budgetVersion: 1,
    });
  });

  it("warn about the dimension closest to its limit", async () => {
    const { h, missionId, crewId, a } = await world(1000);
    expect((await patch(h, `/v1/crews/${crewId}/budget`, { limitCost: 10 })).status).toBe(200);
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(a).status).toBe("completed");
    // 10% of the tokens, 90% of the cost: a cost warning.
    spend(h, a, 100, 9);
    await h.tick();
    expect(h.events(["budget.exceeded"])).toEqual([]);
    expect(h.events(["budget.warning"]).map((e) => e.payload)).toEqual([
      expect.objectContaining({ unit: "cost", used: 9, limit: 10, overBy: -1 }),
    ]);
  });

  it("leave attention once the mission is over, since the budget can no longer be raised", async () => {
    const { h, missionId, crewId, a } = await world(100);
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    spend(h, a, 500);
    await h.tick();
    const exceeded = { kind: "budget_exceeded", crewId };
    expect((await h.get("/v1/attention")).json.items).toContainEqual(
      expect.objectContaining(exceeded),
    );
    await h.post(`/v1/missions/${missionId}/cancel`);
    expect((await patch(h, `/v1/crews/${crewId}/budget`, { limitTokens: 2000 })).status).toBe(409);
    expect((await h.get("/v1/attention")).json.items).not.toContainEqual(
      expect.objectContaining(exceeded),
    );
  });

  it("report a zero limit as the exhausted dimension", async () => {
    const h = await harness();
    harnesses.push(h);
    const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
    const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
    const missionId = m.json.mission.id as string;
    await h.post("/v1/crews", {
      missionId,
      template: "solo",
      members: [{ role: "implementer", agentKind: "shell" }],
      budget: { limitTokens: 1000, limitCost: 0, onUnknown: "allow" },
    });
    const a = await createTask(h, missionId, "A", "echo a");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(a)).toMatchObject({ status: "blocked", blockedReason: "budget_exceeded" });
    expect(h.events(["budget.exceeded"]).map((e) => e.payload)).toEqual([
      expect.objectContaining({ unit: "cost", used: 0, limit: 0, overBy: 0 }),
    ]);
  });
});

describe("PATCH /v1/missions/:id/budget", () => {
  it("creates the mission's budget when it has none, then changes it in place", async () => {
    const { h, missionId } = await world();
    const url = `/v1/missions/${missionId}/budget`;
    expect((await patch(h, url, { warnAtFraction: 0.5 })).status).toBe(422);
    const empty = await h.app.inject({
      method: "PATCH",
      url,
      headers: { ...AUTH, "idempotency-key": h.key() },
    });
    expect(empty.statusCode).toBe(422);
    // A scope without a budget is at version 0: any other expected version is a conflict.
    expect(
      await patch(h, url, { limitTokens: 5, expectedVersion: 1, onUnknown: "allow" }),
    ).toMatchObject({
      status: 409,
      json: { error: { code: "conflict", details: { version: null } } },
    });
    // The fake runtime reports no usage: a hard budget must say what unknown usage means.
    expect((await patch(h, url, { limitTokens: 5000, enforce: "hard" })).json).toMatchObject({
      error: { details: { reason: "budget_on_unknown_required" } },
    });
    const created = await patch(h, url, {
      limitTokens: 5000,
      enforce: "hard",
      onUnknown: "allow",
    });
    expect(created).toMatchObject({
      status: 200,
      json: {
        changed: true,
        budget: { missionId, crewId: null, limitTokens: 5000, enforce: "hard", version: 0 },
      },
    });
    const id = created.json.budget.id as string;
    const changed = await patch(h, url, { limitTokens: 9000 });
    expect(changed.json).toMatchObject({ budget: { id, limitTokens: 9000, version: 1 } });
    expect(h.events(["budget.updated"]).map((e) => e.payload)).toEqual([
      expect.objectContaining({ previous: null }),
      expect.objectContaining({ previous: expect.objectContaining({ limitTokens: 5000 }) }),
    ]);
    expect((await patch(h, `/v1/missions/${newId("msn")}/budget`, { limitTokens: 5 })).status).toBe(
      404,
    );
  });
});
