import { IDEMPOTENCY_HEADER, newId, type Mission, type Project } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeMimirServer, type FakeMimirServer } from "./fake-mimir-server.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: FakeMimirServer;
beforeEach(async () => {
  s = await fakeMimirServer();
});
afterEach(async () => {
  await s.close();
});

const auth = () => ({ authorization: `Bearer ${s.token}` });
async function get(path: string): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${s.url}${path}`, { headers: auth() });
  return { status: res.status, body: await res.json() };
}
async function post(path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${s.url}${path}`, {
    method: "POST",
    headers: {
      ...auth(),
      "content-type": "application/json",
      [IDEMPOTENCY_HEADER]: crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

async function patch(path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${s.url}${path}`, {
    method: "PATCH",
    headers: {
      ...auth(),
      "content-type": "application/json",
      [IDEMPOTENCY_HEADER]: crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

async function mission(): Promise<{ project: Project; mission: Mission }> {
  const { project } = (await post("/v1/projects", { name: "p", repoPath: "/tmp/r" })).body;
  const { mission } = (await post("/v1/missions", { projectId: project.id, objective: "o" })).body;
  return { project, mission };
}
async function crew(missionId: string, limits?: unknown, budget?: unknown): Promise<Json> {
  return (
    await post("/v1/crews", {
      missionId,
      template: "solo",
      ...(limits === undefined ? {} : { limits }),
      ...(budget === undefined ? {} : { budget }),
      members: [{ role: "implementer", agentKind: "shell" }],
    })
  ).body;
}

describe("budgets", () => {
  it("creates, merges and versions crew and mission budgets; refuses stale or empty changes", async () => {
    const a = await mission();
    const created = await crew(a.mission.id);
    const crewPath = `/v1/crews/${created.crew.id}/budget`;
    expect((await patch(crewPath, { warnAtFraction: 0.5 })).body.error.code).toBe(
      "validation_failed",
    );
    const first = await patch(crewPath, {
      limitTokens: 100,
      onUnknown: "block",
      expectedVersion: 0,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      changed: true,
      budget: { crewId: created.crew.id, missionId: a.mission.id, limitTokens: 100, version: 0 },
    });
    expect((await patch(crewPath, { limitTokens: 100 })).body.changed).toBe(false);
    const raised = await patch(crewPath, { limitCost: 2, expectedVersion: 0 });
    expect(raised.body.budget).toMatchObject({ limitTokens: 100, limitCost: 2, version: 1 });
    expect((await patch(crewPath, { limitCost: 3, expectedVersion: 0 })).status).toBe(409);
    const m = await patch(`/v1/missions/${a.mission.id}/budget`, {
      limitCost: 1,
      enforce: "soft",
    });
    expect(m.body.budget).toMatchObject({ missionId: a.mission.id, crewId: null });
    expect((await patch(`/v1/crews/${newId("crw")}/budget`, { limitCost: 1 })).status).toBe(404);
    const events = (await get(`/v1/events?types=budget.updated`)).body.events;
    expect(events).toHaveLength(3);
    await post(`/v1/missions/${a.mission.id}/cancel`, {});
    expect((await patch(crewPath, { limitCost: 9 })).body.error.code).toBe("invalid_transition");
  });

  it("refuses a hard budget without onUnknown while the runtime reports no usage", async () => {
    const a = await mission();
    const created = await crew(a.mission.id);
    const hard = await patch(`/v1/crews/${created.crew.id}/budget`, { limitTokens: 100 });
    expect(hard.status).toBe(422);
    expect(hard.body.error.details.reason).toBe("budget_on_unknown_required");
    const atCreation = await post("/v1/missions", {
      projectId: a.project.id,
      objective: "o",
      budget: { limitCost: 1 },
    });
    expect(atCreation.body.error.details.reason).toBe("budget_on_unknown_required");
    expect((await crew(a.mission.id, undefined, { limitTokens: 5 })).error.details.reason).toBe(
      "budget_on_unknown_required",
    );
    await s.close();
    s = await fakeMimirServer({ runtimeReportsUsage: true });
    const b = await mission();
    const c = await crew(b.mission.id);
    expect((await patch(`/v1/crews/${c.crew.id}/budget`, { limitTokens: 100 })).status).toBe(200);
  });

  it("merges a PATCH onto the budget set at mission or crew creation", async () => {
    const { project } = (await post("/v1/projects", { name: "p", repoPath: "/tmp/r" })).body;
    const created = await post("/v1/missions", {
      projectId: project.id,
      objective: "o",
      budget: { limitTokens: 50, onUnknown: "block" },
    });
    const missionId = created.body.mission.id;
    const c = await crew(missionId, undefined, { limitCost: 2, onUnknown: "allow" });
    for (const [path, change, kept] of [
      [`/v1/missions/${missionId}/budget`, { limitCost: 1 }, { limitTokens: 50 }],
      [`/v1/crews/${c.crew.id}/budget`, { limitTokens: 9 }, { limitCost: 2 }],
    ] as const) {
      const same = await patch(path, { ...kept, expectedVersion: 0 });
      expect(same.body.changed).toBe(false);
      const merged = await patch(path, { ...change, expectedVersion: 0 });
      expect(merged.body.budget).toMatchObject({ ...kept, ...change, version: 1 });
      expect(merged.body.budget.id).toBe(same.body.budget.id);
      expect(
        (await get(`/v1/events?types=budget.updated`)).body.events.at(-1).payload.previous,
      ).toMatchObject({ id: same.body.budget.id, version: 0 });
    }
  });
});

describe("crews", () => {
  it("creates, lists by mission, and pauses/resumes scheduling once per change", async () => {
    const a = await mission();
    const b = await mission();
    const created = await crew(a.mission.id);
    await crew(b.mission.id);
    expect(created.members[0].name).toBe("implementer-1");
    const listed = (await get(`/v1/crews?missionId=${a.mission.id}`)).body.crews;
    expect(listed.map((c: Json) => c.id)).toEqual([created.crew.id]);
    expect((await get("/v1/crews")).body.crews).toHaveLength(2);

    const id = created.crew.id;
    const p1 = await post(`/v1/crews/${id}/pause`, {});
    expect(p1.status).toBe(200);
    expect(p1.body.crew.schedulingPaused).toBe(true);
    const p2 = await post(`/v1/crews/${id}/pause`);
    expect(p2.body.crew.version).toBe(p1.body.crew.version);
    const changes = () => s.events().filter((e) => e.event.type === "crew.scheduling_changed");
    expect(changes()).toHaveLength(1);
    expect((await post(`/v1/crews/${id}/resume`, { expectedVersion: 1 })).body.error.code).toBe(
      "conflict",
    );
    const r = await post(`/v1/crews/${id}/resume`, { expectedVersion: p1.body.crew.version });
    expect(r.body.crew.schedulingPaused).toBe(false);
    expect(changes().map((e) => e.event.payload)).toEqual([
      { crewId: id, paused: true },
      { crewId: id, paused: false },
    ]);
  });

  it("refuses to change scheduling for a terminal mission and 404s an unknown crew", async () => {
    const a = await mission();
    const { crew: c } = await crew(a.mission.id);
    await post(`/v1/missions/${a.mission.id}/cancel`, { reason: "done" });
    expect((await post(`/v1/crews/${c.id}/pause`, {})).body.error.code).toBe("invalid_transition");
    expect((await post(`/v1/crews/crw_nope/pause`, {})).status).toBe(404);
  });
});

describe("missions", () => {
  it("filters the list, and enforces expectedVersion and allowed transitions", async () => {
    const a = await mission();
    const b = await mission();
    expect((await get(`/v1/missions?projectId=${a.project.id}`)).body.missions).toHaveLength(1);
    await post(`/v1/missions/${b.mission.id}/start`);
    expect((await get("/v1/missions?status=active")).body.missions.map((m: Json) => m.id)).toEqual([
      b.mission.id,
    ]);
    expect(
      (await post(`/v1/missions/${a.mission.id}/start`, { expectedVersion: 9 })).body.error.code,
    ).toBe("conflict");
    expect((await post(`/v1/missions/${b.mission.id}/start`, {})).body.error.code).toBe(
      "invalid_transition",
    );
    const got = (await get(`/v1/missions/${b.mission.id}`)).body;
    expect(got.mission.status).toBe("active");
    expect(got.crews).toEqual([]);
  });
});

describe("tasks", () => {
  it("gets a task with its mission, artifacts and approvals; lists with filters", async () => {
    const a = await mission();
    const t = s.seedTask({ missionId: a.mission.id, status: "blocked" });
    const other = s.seedTask({ missionId: a.mission.id, status: "pending" });
    const art = s.seedArtifact({ taskId: t.id });
    const apr = s.seedApproval({ taskId: t.id, missionId: a.mission.id });
    const got = (await get(`/v1/tasks/${t.id}`)).body;
    expect(got.mission.id).toBe(a.mission.id);
    expect(got.artifacts.map((x: Json) => x.id)).toEqual([art.id]);
    expect(got.approvals.map((x: Json) => x.id)).toEqual([apr.id]);
    const orphan = s.seedTask({ missionId: newId("msn") });
    expect((await get(`/v1/tasks/${orphan.id}`)).body.mission).toBeNull();

    const blocked = (await get(`/v1/tasks?missionId=${a.mission.id}&status=blocked`)).body.tasks;
    expect(blocked.map((x: Json) => x.id)).toEqual([t.id]);
    expect((await get(`/v1/tasks?missionId=${a.mission.id}`)).body.tasks).toHaveLength(2);
    expect(other.status).toBe("pending");
  });

  it("verify records an unsuccessful fixture artifact only for settled tasks", async () => {
    const a = await mission();
    const done = s.seedTask({ missionId: a.mission.id, status: "completed" });
    const r = await post(`/v1/tasks/${done.id}/verify`);
    expect(r.status).toBe(200);
    expect(r.body.passed).toBe(false);
    const content = await fetch(`${s.url}/v1/artifacts/${r.body.artifactId}/content`, {
      headers: auth(),
    });
    expect(JSON.parse(await content.text())).toMatchObject({ passed: false });
    const pending = s.seedTask({ missionId: a.mission.id });
    expect((await post(`/v1/tasks/${pending.id}/verify`, {})).body.error.code).toBe(
      "invalid_transition",
    );
    expect(
      (await post(`/v1/tasks/${done.id}/verify`, { expectedVersion: 99 })).body.error.code,
    ).toBe("conflict");
  });

  it("retries a failed task to ready with the next attempt and refuses other states", async () => {
    const a = await mission();
    const t = s.seedTask({ missionId: a.mission.id, status: "failed" });
    expect((await post(`/v1/tasks/${t.id}/retry`, { expectedVersion: 5 })).status).toBe(409);
    expect((await post(`/v1/tasks/${t.id}/retry`, { reason: "flaky" })).status).toBe(202);
    expect(s.state.tasks.get(t.id)).toMatchObject({ status: "ready", attempt: 1 });
    expect(s.events().at(-1)?.event.payload).toEqual({
      from: "failed",
      to: "ready",
      attempt: 1,
      reason: "flaky",
    });
    expect((await post(`/v1/tasks/${t.id}/retry`)).body.error.code).toBe("invalid_transition");
  });

  it("POST /v1/tasks takes maxAttempts from the crew and rejects foreign crews and dependencies", async () => {
    const a = await mission();
    const b = await mission();
    const { crew: c } = await crew(a.mission.id, { maxAttemptsPerTask: 7 });
    const { crew: foreign } = await crew(b.mission.id);
    const created = await post("/v1/tasks", {
      missionId: a.mission.id,
      crewId: c.id,
      title: "t",
      brief: "b",
      argv: ["echo", "hi"],
    });
    expect(created.status).toBe(201);
    expect(created.body.task).toMatchObject({ crewId: c.id, maxAttempts: 7 });
    expect(s.events().at(-1)?.event).toMatchObject({ crewId: c.id });
    expect(s.events().at(-1)?.event.payload).toMatchObject({ argv: ["echo", "hi"] });
    const bad = await post("/v1/tasks", {
      missionId: a.mission.id,
      crewId: foreign.id,
      title: "t",
      brief: "b",
    });
    expect(bad.body.error.details).toMatchObject({ reason: "unknown_crew" });
  });
});

describe("approvals", () => {
  it("lists by status and mission and decides a pending approval once", async () => {
    const a = await mission();
    const mine = s.seedApproval({ missionId: a.mission.id });
    const global = s.seedApproval();
    expect((await get(`/v1/approvals?missionId=${a.mission.id}`)).body.approvals).toHaveLength(1);
    expect((await get("/v1/approvals?status=pending")).body.approvals).toHaveLength(2);
    expect(
      (await post(`/v1/approvals/${global.id}/decision`, { decision: "rejected" })).status,
    ).toBe(202);
    expect(s.events().at(-1)?.event).toMatchObject({
      type: "approval.decided",
      streamId: "approvals",
      payload: { approvalId: global.id, decision: "rejected", actor: "local" },
    });
    const ok = await post(`/v1/approvals/${mine.id}/decision`, {
      decision: "approved",
      reason: "fine",
    });
    expect(ok.status).toBe(202);
    expect(s.state.approvals.get(mine.id)).toMatchObject({ status: "approved", reason: "fine" });
    // Not a pr.create approval: nothing is delivered or consumed.
    expect(s.events().map((e) => e.event.type)).not.toContain("approval.consumed");
    expect((await post(`/v1/approvals/${mine.id}/decision`, { decision: "approved" })).status).toBe(
      409,
    );
  });
});

describe("sessions", () => {
  it("observes, records input/stop commands, and 404s unknown sessions", async () => {
    const a = await mission();
    const { crew: c } = await crew(a.mission.id);
    const agent = s.seedAgent({ crewId: c.id });
    const sid = agent.runtimeSessionId as string;
    const obs = (await get(`/v1/sessions/${sid}`)).body;
    expect(obs).toMatchObject({ available: false, persisted: { id: sid, crewId: c.id } });
    expect((await post(`/v1/sessions/${sid}/input`, { text: "hi" })).status).toBe(202);
    expect((await post(`/v1/sessions/${sid}/stop`, { mode: "soft" })).status).toBe(202);
    expect(s.state.sessionCommands.get(sid)).toEqual([
      { input: { text: "hi" } },
      { stop: { mode: "soft" } },
    ]);
    const unknown = newId("ses");
    expect((await get(`/v1/sessions/${unknown}`)).status).toBe(404);
    expect((await post(`/v1/sessions/${unknown}/input`, { text: "x" })).status).toBe(404);
  });

  it("validates the terminal lines parameter", async () => {
    const a = await mission();
    const { crew: c } = await crew(a.mission.id);
    const sid = s.seedAgent({ crewId: c.id }).runtimeSessionId as string;
    for (const lines of ["0", "abc", "10001", "1.5"]) {
      const r = await get(`/v1/sessions/${sid}/terminal?lines=${lines}`);
      expect(r.status, lines).toBe(422);
    }
    const r = await get(`/v1/sessions/${sid}/terminal?lines=1`);
    expect(r.body.text).toBe("");
  });
});

describe("usage", () => {
  it("filters samples by agent, crew, mission and project like the real server", async () => {
    const a = await mission();
    const b = await mission();
    const { crew: ca } = await crew(a.mission.id);
    const { crew: cb } = await crew(b.mission.id);
    const agA = s.seedAgent({ crewId: ca.id });
    const agB = s.seedAgent({ crewId: cb.id });
    s.seedUsageSample({ agentId: agA.id, tokens: 10, estimatedCost: 1 });
    s.seedUsageSample({ agentId: agB.id, tokens: 5, source: "estimated" });
    s.seedUsageSample({ agentId: newId("agt"), source: "unavailable" });
    const tokens = async (q: string) => (await get(`/v1/usage${q}`)).body.totals.tokens;
    expect(await tokens("")).toBe(15);
    expect(await tokens(`?agentId=${agA.id}`)).toBe(10);
    expect(await tokens(`?missionId=${b.mission.id}`)).toBe(5);
    expect(await tokens(`?crewId=${ca.id}`)).toBe(10);
    expect(await tokens(`?projectId=${b.project.id}`)).toBe(5);
    const snap = (await get("/v1/snapshot")).body;
    expect(snap.usage).toEqual({
      tokens: 15,
      estimatedCost: 1,
      samples: 3,
      bySource: { measured: 1, estimated: 1, unavailable: 1 },
    });
  });
});

describe("plumbing", () => {
  it("answers 422 for a body that is not JSON and 401 without the token", async () => {
    const res = await fetch(`${s.url}/v1/projects`, {
      method: "POST",
      headers: { ...auth(), [IDEMPOTENCY_HEADER]: "k" },
      body: "{nope",
    });
    expect(res.status).toBe(422);
    expect((await fetch(`${s.url}/v1/projects`)).status).toBe(401);
  });

  it("rejects a reused idempotency key with a different body", async () => {
    const send = (name: string) =>
      fetch(`${s.url}/v1/projects`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json", [IDEMPOTENCY_HEADER]: "same" },
        body: JSON.stringify({ name, repoPath: "/r" }),
      });
    expect((await send("a")).status).toBe(201);
    const second = await send("b");
    expect(((await second.json()) as Json).error.code).toBe("idempotency_replay_mismatch");
  });

  it("collects repeated query keys into a list", async () => {
    const r = await get("/v1/events?types=mission.created&types=mission.started");
    expect(r.status).toBe(200);
    expect(s.requests.at(-1)?.url).toContain("types=mission.created&types=mission.started");
  });

  it("sendGap ends every stream with a gap frame; dropSseClients cuts them without one", async () => {
    const open = () =>
      fetch(`${s.url}/v1/events/stream`, { headers: { ...auth(), accept: "text/event-stream" } });
    const first = await open();
    await s.waitForSseClients(1);
    s.sendGap("test");
    const text = await first.text();
    expect(text).toContain('event: gap\ndata: {"reason":"test","lastEventId":"MA=="}');
    expect(s.sseClientCount()).toBe(0);

    const second = await open();
    await s.waitForSseClients(1);
    s.dropSseClients();
    await expect(second.text()).rejects.toThrow();
    expect(s.sseClientCount()).toBe(0);
    await expect(s.waitForSseClients(1, 20)).rejects.toThrow(/waitForSseClients/);
  });
});

describe("reads", () => {
  it("serves capabilities, projects, a mission with its crews and tasks, and artifact metadata", async () => {
    const a = await mission();
    const { crew: c } = await crew(a.mission.id);
    const t = s.seedTask({ missionId: a.mission.id });
    expect((await get("/v1/capabilities")).body).toMatchObject({ runtime: null });
    expect((await get("/v1/projects")).body.projects.map((p: Json) => p.id)).toEqual([
      a.project.id,
    ]);
    const got = (await get(`/v1/missions/${a.mission.id}`)).body;
    expect(got.crews.map((x: Json) => x.id)).toEqual([c.id]);
    expect(got.tasks.map((x: Json) => x.id)).toEqual([t.id]);
    const art = s.seedArtifact({ taskId: t.id });
    expect((await get(`/v1/artifacts/${art.id}`)).body.artifact.id).toBe(art.id);
  });

  it("rejects a malformed or future cursor and 404s an unknown route", async () => {
    expect((await get("/v1/events?cursor=!!")).status).toBe(422);
    expect((await get("/v1/events?cursor=OTk=")).body.error.code).toBe("cursor_expired");
    expect((await get("/v1/nope")).status).toBe(404);
  });

  it("lists only pending approvals as attention", async () => {
    const pending = s.seedApproval();
    s.seedApproval({ status: "approved" });
    const items = (await get("/v1/attention")).body.items;
    expect(items.map((i: Json) => i.approvalId)).toEqual([pending.id]);
  });
});

describe("streams", () => {
  it("skips filtered events, sends heartbeats, and stop() can be called twice", async () => {
    await s.close();
    s = await fakeMimirServer({ heartbeatMs: 10 });
    const a = await mission();
    const res = await fetch(`${s.url}/v1/events/stream?missionId=${a.mission.id}`, {
      headers: { ...auth(), accept: "text/event-stream" },
    });
    await s.waitForSseClients(1);
    s.appendEvent({ type: "mission.created", missionId: newId("msn") });
    const mine = s.appendEvent({ type: "mission.started", missionId: a.mission.id });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!(text.includes(mine.event.id) && text.includes(": heartbeat"))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain(": heartbeat");
    expect(text.match(/^data: /gm)).toHaveLength(1);
    await s.stop();
    await s.stop();
  });
});
