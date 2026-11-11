import { newId, type EventEnvelope, type MissionId, type ProjectId } from "@mimir/protocol";
import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import { createFakeMimir, createReplayFetch, type FakeMimir, type TaskStep } from "@sindri/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MimirClientError, MimirClientFacade, type MimirClientFacadeOptions } from "./facade.js";
import { approvedPlan, planTask } from "./testing.js";

const fakes: FakeMimir[] = [];
let db: SqliteDatabase | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fakes.splice(0)) await f.close();
  db?.close();
  db = undefined;
});

async function newFake(scripts: Record<string, TaskStep[]> = {}): Promise<FakeMimir> {
  const fake = await createFakeMimir({ stepDelayMs: 0, scripts });
  fakes.push(fake);
  return fake;
}

async function boot(
  options: Partial<MimirClientFacadeOptions> = {},
  scripts: Record<string, TaskStep[]> = {},
) {
  const fake = await newFake(scripts);
  db = openDatabase(":memory:");
  const facade = new MimirClientFacade({ db, ...options });
  facade.connect({ baseUrl: fake.url, token: fake.token });
  return { fake, db, facade };
}

const bodiesOf = (fake: FakeMimir, method: string, path: string) =>
  fake.requests
    .filter((r) => r.method === method && r.path === path)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw request JSON, read freely in assertions
    .map((r) => r.body as Record<string, any>);

/** A fetch that rewrites the JSON of `GET /v1/events` pages before the SDK sees them. */
function rewritingEvents(change: (events: EventEnvelope[]) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (new URL(String(input)).pathname !== "/v1/events" || !res.ok) return res;
    const page = (await res.json()) as { events: EventEnvelope[] };
    change(page.events);
    return Response.json(page, { status: res.status });
  }) as typeof fetch;
}

describe("MimirClientFacade.ensureProject", () => {
  it("creates the project again when the connected Mimir does not have it (another or a reset Mimir)", async () => {
    const { facade, fake: first } = await boot();
    const original = await facade.ensureProject("/repos/app");
    expect(first.creates.projects).toBe(1);

    const second = await newFake();
    facade.connect({ baseUrl: second.url, token: second.token });
    const recreated = await facade.ensureProject("/repos/app");
    expect(second.creates.projects).toBe(1);
    const listed = (await facade.sdk.projects.list()).projects.map((p) => p.id);
    expect(listed).toEqual([recreated.id]);
    expect(recreated.id).not.toBe(original.id);
    // The mission can be created on the Mimir now in use.
    const { missionId } = await facade.createMissionFromPlan(approvedPlan([planTask("impl")]), {
      projectId: recreated.id,
    });
    expect((await facade.getMission(missionId)).mission.projectId).toBe(recreated.id);
    // And it is found, not created a third time, on the next call.
    expect((await facade.ensureProject("/repos/app")).id).toBe(recreated.id);
    expect(second.creates.projects).toBe(1);
  });

  it("names the project after the path itself when it has no last segment", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/");
    expect(project.name).toBe("/");
    expect(bodiesOf(fake, "POST", "/v1/projects")).toEqual([
      { name: "/", repoPath: "/", settings: {} },
    ]);
  });

  it("warns on the console by default when Mimir cannot update project settings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let owned: object = { verificationTimeoutMs: 1000 };
    const { facade } = await boot({ projectSettingsFor: () => owned });
    const first = await facade.ensureProject("/repos/app");
    owned = { verificationTimeoutMs: 2000 };
    // The fake has no PATCH route (404): the project is returned as it is.
    await expect(facade.ensureProject("/repos/app")).resolves.toEqual(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not support updating"), {
      projectId: first.id,
      status: 404,
    });
  });

  it("returns the project Mimir answers a settings update with, or the merged one without a usable body", async () => {
    let owned: object = { verificationTimeoutMs: 1000 };
    let answer: (id: string) => Response = () => new Response("ok", { status: 200 });
    const { facade } = await boot({
      projectSettingsFor: () => owned,
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        init?.method === "PATCH"
          ? answer(String(input).split("/").at(-1) as string)
          : fetch(input, init)) as typeof fetch,
    });
    const first = await facade.ensureProject("/repos/app", { keep: true });

    owned = { verificationTimeoutMs: 2000 };
    const merged = await facade.ensureProject("/repos/app");
    expect(merged).toEqual({ ...first, settings: { keep: true, verificationTimeoutMs: 2000 } });

    answer = (id) =>
      Response.json({ project: { ...first, id, settings: { fromMimir: true }, version: 7 } });
    const served = await facade.ensureProject("/repos/app");
    expect(served).toMatchObject({ id: first.id, settings: { fromMimir: true }, version: 7 });
  });
});

describe("MimirClientFacade.createMissionFromPlan", () => {
  it("applies the configured criteria texts, agent kinds and concurrency", async () => {
    const { facade, fake } = await boot({
      acceptanceCriteriaFor: (plan) => [{ id: "AC-1", text: `criterion of ${plan.id}` }],
      agentKindFor: (harnessId, role) => (role === "reviewer" ? "codex" : `${harnessId}-kind`),
      concurrency: { implementer: 5 },
    });
    const project = await facade.ensureProject("/repos/app");
    await facade.createMissionFromPlan(
      approvedPlan([planTask("impl"), planTask("review", { role: "reviewer" })]),
      { projectId: project.id },
    );
    const crews = bodiesOf(fake, "POST", "/v1/crews");
    expect(crews.map((c) => c.members[0].agentKind)).toEqual(["backend-node-kind", "codex"]);
    expect(crews[0]!.limits.maxConcurrentTasks).toBe(5);
    const tasks = bodiesOf(fake, "POST", "/v1/tasks");
    expect(tasks).toHaveLength(2);
    for (const t of tasks) expect(t.brief).toContain("AC-1: criterion of plan-1");
  });

  it("forwards base commits of a rework, and leaves the field out without any", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const plan = approvedPlan([planTask("impl")]);
    const sha = "c".repeat(40);
    await facade.createMissionFromPlan(plan, { projectId: project.id, baseCommits: [] });
    await facade.createMissionFromPlan(plan, { projectId: project.id, run: 2, baseCommits: [sha] });
    const missions = bodiesOf(fake, "POST", "/v1/missions");
    expect(missions).toHaveLength(2);
    expect(missions[0]).not.toHaveProperty("baseCommits");
    expect(missions[1]).toMatchObject({ baseCommits: [sha] });
    expect(missions[1]!.objective).toContain("run 2");
  });

  it("sends the harness verification contract for a version 2 lock, priority, and no empty criteria list", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const digest = "sha256:" + "cd".repeat(32);
    const selection = (lockVersion: number) => ({
      harnesses: [
        {
          name: "backend-node",
          version: "1.0.0",
          digest,
          description: "",
          taskTypes: [],
          checks: [],
        },
        { name: "docs", version: "2.1.0", digest, description: "", taskTypes: [], checks: [] },
      ],
      skills: [],
      lock: { digest, harnesses: [], skills: [], lockVersion },
      rationale: [],
    });
    const plan = approvedPlan([
      planTask("locked", { harnessSelection: selection(2), priority: 7, acceptanceCriteria: [] }),
      planTask("old-lock", { harnessSelection: selection(1) }),
      planTask("no-selection"),
    ]);
    await facade.createMissionFromPlan(plan, { projectId: project.id });
    const byTitle = new Map(
      bodiesOf(fake, "POST", "/v1/tasks").map((t) => [String(t.title).split(":")[0], t]),
    );
    expect(byTitle.get("locked")).toMatchObject({
      priority: 7,
      verification: {
        harnesses: ["backend-node@1.0.0", "docs@2.1.0"],
        lock: { digest, lockVersion: 2 },
      },
    });
    expect(byTitle.get("locked")).not.toHaveProperty("acceptanceCriteria");
    expect(byTitle.get("old-lock")).not.toHaveProperty("verification");
    expect(byTitle.get("old-lock")).not.toHaveProperty("priority");
    expect(byTitle.get("old-lock")).toMatchObject({ acceptanceCriteria: ["AC-1"] });
    expect(byTitle.get("no-selection")).not.toHaveProperty("verification");
  });

  it("refuses to reuse a recorded submission of another kind", async () => {
    const { facade, db, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const plan = approvedPlan([planTask("impl")]);
    await facade.createMissionFromPlan(plan, { projectId: project.id });
    db.prepare(
      "UPDATE mimir_submissions SET kind = 'crew' WHERE idempotency_key = 'sindri:plan-1:1:@mission'",
    ).run();
    const before = fake.requests.length;
    const error = await facade
      .createMissionFromPlan(plan, { projectId: project.id })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MimirClientError);
    expect(error).toMatchObject({
      code: "submission_mismatch",
      message: "key sindri:plan-1:1:@mission was used for a crew",
    });
    expect(fake.requests.slice(before).filter((r) => r.method === "POST")).toEqual([]);
  });
});

describe("MimirClientFacade mission commands and reads", () => {
  it("cancels with and without a reason under one key per mission, and reads the mission", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const a = await facade.createMissionFromPlan(approvedPlan([planTask("impl")]), {
      projectId: project.id,
    });
    const b = await facade.createMissionFromPlan(approvedPlan([planTask("impl")]), {
      projectId: project.id,
      run: 2,
    });
    await facade.cancel(a.missionId, "superseded");
    await facade.cancel(b.missionId);
    const cancels = fake.requests.filter((r) => r.path.endsWith("/cancel"));
    expect(cancels.map((r) => r.body)).toEqual([{ reason: "superseded" }, {}]);
    expect(cancels.map((r) => r.idempotencyKey)).toEqual([
      `sindri:cancel:${a.missionId}`,
      `sindri:cancel:${b.missionId}`,
    ]);
    const read = await facade.getMission(a.missionId);
    expect(read.mission).toMatchObject({ id: a.missionId, status: "cancelled" });
    expect(read.tasks.map((t) => t.id)).toEqual([a.taskIdMap.impl]);
    await expect(facade.getMission(newId("msn"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("finds an approval only under the mission it belongs to", async () => {
    const { facade } = await boot({}, { impl: [{ kind: "approval", action: "git.push" }] });
    const project = await facade.ensureProject("/repos/app");
    const mine = await facade.createMissionFromPlan(approvedPlan([planTask("impl")]), {
      projectId: project.id,
    });
    const other = await facade.createMissionFromPlan(approvedPlan([planTask("other")]), {
      projectId: project.id,
      run: 2,
    });
    await facade.start(mine.missionId);
    let approvalId = "";
    for await (const e of facade.follow(mine.missionId)) {
      if (e.type === "approval.requested") {
        approvalId = e.payload.approvalId;
        break;
      }
    }
    await expect(facade.approvalForMission(mine.missionId, approvalId)).resolves.toMatchObject({
      id: approvalId,
      missionId: mine.missionId,
      status: "pending",
    });
    await expect(facade.approvalForMission(other.missionId, approvalId)).resolves.toBeUndefined();
    await expect(facade.approvalForMission(mine.missionId, newId("apr"))).resolves.toBeUndefined();

    // Without a reason the decision carries none; the key is one per approval.
    await facade.decideApproval(approvalId, "rejected");
    const decision = (await facade.replayEnvelopes(mine.missionId)).find(
      (e) => e.type === "approval.decided",
    )!;
    expect(decision.payload).toEqual({ approvalId, decision: "rejected", actor: "operator" });
  });

  it("lists the result commit of completed tasks only", async () => {
    const { facade, fake } = await boot({}, { blocked: [{ kind: "fail" }] });
    const project = await facade.ensureProject("/repos/app");
    const { missionId, taskIdMap } = await facade.createMissionFromPlan(
      approvedPlan([planTask("done"), planTask("blocked")]),
      { projectId: project.id },
    );
    expect(await facade.taskResultCommits(missionId)).toEqual([]);
    await facade.start(missionId);
    const pending = new Set(["task.completed", "task.failed"]);
    for await (const e of facade.follow(missionId)) {
      pending.delete(e.type);
      if (pending.size === 0) break;
    }
    expect(await facade.taskResultCommits(missionId)).toEqual([
      { taskId: taskIdMap.done, resultCommit: fake.headShaOf(taskIdMap.done!) },
    ]);
  });

  it("uses the caller's key for an instruction, a soft stop by default, and a keyless retry with a reason", async () => {
    const { facade, fake } = await boot({}, { impl: [{ kind: "fail", reason: "boom" }] });
    const project = await facade.ensureProject("/repos/app");
    const { missionId, taskIdMap } = await facade.createMissionFromPlan(
      approvedPlan([planTask("impl")]),
      { projectId: project.id },
    );
    await facade.start(missionId);
    let sessionId = "";
    for await (const e of facade.follow(missionId)) {
      if (e.type === "task.started") sessionId = e.payload.sessionId;
      if (e.type === "task.failed") break;
    }
    await facade.sendInstruction(sessionId, "look again", { idempotencyKey: "instruction-1" });
    await facade.sendInstruction(sessionId, "look again", { idempotencyKey: "instruction-1" });
    await facade.stop(sessionId);
    expect(fake.sessionCommands).toEqual([
      { sessionId, kind: "input", body: { text: "look again" } },
      { sessionId, kind: "stop", body: { mode: "soft" } },
    ]);
    await facade.retry(taskIdMap.impl!, { reason: "flaky" });
    const retry = fake.requests.find((r) => r.path.endsWith("/retry"))!;
    expect(retry.body).toEqual({ reason: "flaky" });
    expect(retry.idempotencyKey).toEqual(expect.any(String));
    expect(retry.idempotencyKey).not.toContain("sindri:retry:");
  });
});

describe("MimirClientFacade.follow and catchUp", () => {
  it("replays a mission's history when no cursor is stored, then stores where it got to", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    // Created through the SDK, so the facade has neither a record nor a cursor for it.
    const { mission } = await facade.sdk.missions.create({
      projectId: project.id,
      objective: "direct",
    });
    await facade.createTask({ missionId: mission.id, title: "a: one", brief: "do a" }, "direct-a");
    expect(facade.storedCursor(mission.id)).toBeNull();
    const gaps: unknown[] = [];
    const stream = facade.follow(mission.id, { onGap: (g) => gaps.push(g) });
    expect(stream.cursor).toBeUndefined();
    const types: string[] = [];
    await facade.start(mission.id);
    for await (const e of stream) {
      types.push(e.type);
      if (e.type === "mission.completed") break;
    }
    const all = fake.events().filter((e) => e.missionId === mission.id);
    expect(types).toEqual(all.map((e) => e.type));
    expect(types.slice(0, 2)).toEqual(["mission.created", "task.created"]);
    expect(gaps).toEqual([]);
    expect(facade.storedCursor(mission.id)).toEqual(expect.any(String));
    expect(stream.cursor).toEqual(expect.any(String));
  });

  it("skips an event whose payload fails protocol validation and reports it", async () => {
    const broken = (events: EventEnvelope[]) => {
      for (const e of events) if (e.type === "task.created") e.payload = { nope: true };
    };
    const { facade } = await boot({ fetch: rewritingEvents(broken) });
    const project = await facade.ensureProject("/repos/app");
    const { mission } = await facade.sdk.missions.create({
      projectId: project.id,
      objective: "direct",
    });
    await facade.createTask({ missionId: mission.id, title: "a: one", brief: "do a" }, "direct-a");

    const invalid: string[] = [];
    const caught = await facade.catchUp(mission.id, {
      onInvalidEvent: (env, err) => invalid.push(`${env.type}:${err instanceof Error}`),
      signal: new AbortController().signal,
    });
    expect(caught.events.map((e) => e.type)).toEqual(["mission.created"]);
    expect(caught.cursor).toEqual(expect.any(String));
    expect(invalid).toEqual(["task.created:true"]);
    // Without a callback the event is dropped silently, and nothing was stored.
    expect((await facade.catchUp(mission.id)).events).toHaveLength(1);
    expect(facade.storedCursor(mission.id)).toBeNull();

    const followed: string[] = [];
    const skipped: string[] = [];
    const ac = new AbortController();
    await facade.start(mission.id);
    for await (const e of facade.follow(mission.id, {
      signal: ac.signal,
      onInvalidEvent: (env) => skipped.push(env.type),
    })) {
      followed.push(e.type);
      if (e.type === "mission.completed") break;
    }
    ac.abort();
    expect(skipped).toEqual(["task.created"]);
    expect(followed).not.toContain("task.created");
    expect(followed[0]).toBe("mission.created");
  });

  it("does not deliver an event twice when the stream sends the replayed history again", async () => {
    const booting: { fake?: FakeMimir } = {};
    // The stream is opened from the very beginning whatever cursor the client asked for.
    const rewind = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const fake = booting.fake;
      if (url.pathname !== "/v1/events/stream" || !fake) return fetch(input, init);
      url.searchParams.set("cursor", fake.cursorAt(0));
      const headers = new Headers(init?.headers);
      headers.delete("last-event-id");
      return fetch(url, { ...init, headers });
    }) as typeof fetch;
    const booted = await boot({ fetch: rewind });
    booting.fake = booted.fake;
    const { facade, fake } = booted;
    const project = await facade.ensureProject("/repos/app");
    const { mission } = await facade.sdk.missions.create({
      projectId: project.id,
      objective: "direct",
    });
    await facade.createTask({ missionId: mission.id, title: "a: one", brief: "do a" }, "direct-a");
    const ids: string[] = [];
    const ac = new AbortController();
    const stream = facade.follow(mission.id, { signal: ac.signal });
    await facade.start(mission.id);
    for await (const e of stream) {
      ids.push(e.id);
      if (e.type === "mission.completed") break;
    }
    ac.abort();
    const all = fake.events().filter((e) => e.missionId === mission.id);
    expect(ids).toEqual(all.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("MimirClientFacade.requestPr", () => {
  const taskId = newId("tsk");
  const approvalId = newId("apr");
  const accepted = { operationId: newId("op"), commandId: newId("cmd") };
  const consumed = (id: string): EventEnvelope =>
    ({
      id: newId("evt"),
      schemaVersion: 1,
      streamId: `approval:${approvalId}`,
      sequence: 0,
      occurredAt: "2026-10-14T00:00:00.000Z",
      observedAt: "2026-10-14T00:00:00.000Z",
      type: "approval.consumed",
      source: "mimir",
      provenance: "observed",
      missionId: newId("msn") as MissionId,
      payload: { approvalId: id },
    }) as EventEnvelope;

  function facadeWith(pr: object, events: EventEnvelope[] = []) {
    const replay = createReplayFetch([
      { method: "POST", url: /\/v1\/tasks\/[^/]+\/pr$/, status: 202, body: pr },
      { url: /\/v1\/events\?/, body: { events, nextCursor: null } },
    ]);
    db = openDatabase(":memory:");
    const facade = new MimirClientFacade({ db, fetch: replay.fetch });
    facade.connect({ baseUrl: "http://mimir.test", token: "t" });
    return { facade, replay };
  }

  it("reports a delivered request without looking at approvals", async () => {
    const { facade, replay } = facadeWith({ ...accepted, status: "delivered" });
    await expect(facade.requestPr(taskId, "pr-key")).resolves.toEqual({ status: "requested" });
    expect(replay.requests).toHaveLength(1);
    expect(replay.requests[0]).toMatchObject({
      method: "POST",
      url: `http://mimir.test/v1/tasks/${taskId}/pr`,
      headers: { "idempotency-key": "pr-key", authorization: "Bearer t" },
    });
  });

  it("waits for a human while the approval Mimir asks for has not been used", async () => {
    const pr = { ...accepted, status: "approval_required", approvalId };
    const none = facadeWith(pr);
    await expect(none.facade.requestPr(taskId, "pr-key")).resolves.toEqual({
      status: "awaiting_approval",
      approvalId,
    });
    const query = new URL(none.replay.requests[1]!.url).searchParams;
    expect(query.get("streamId")).toBe(`approval:${approvalId}`);
    expect(query.get("types")).toBe("approval.consumed");
    db?.close();
    // A consumed event of another approval does not count.
    const other = facadeWith(pr, [consumed(newId("apr"))]);
    await expect(other.facade.requestPr(taskId, "pr-key")).resolves.toEqual({
      status: "awaiting_approval",
      approvalId,
    });
  });

  it("reports the request as made once the approval was consumed", async () => {
    const { facade } = facadeWith({ ...accepted, status: "approval_required", approvalId }, [
      consumed(approvalId),
    ]);
    await expect(facade.requestPr(taskId, "pr-key")).resolves.toEqual({ status: "requested" });
  });
});

describe("MimirClientFacade before connect", () => {
  it("refuses every Mimir call with not_connected but still reads its own cursors", async () => {
    db = openDatabase(":memory:");
    const facade = new MimirClientFacade({ db, now: () => new Date("2026-10-14T12:00:00.000Z") });
    const missionId = newId("msn");
    expect(() => facade.sdk).toThrow(MimirClientError);
    await expect(facade.ensureProject("/repos/app")).rejects.toMatchObject({
      code: "not_connected",
    });
    await expect(
      facade.createMissionFromPlan(approvedPlan([planTask("impl")]), {
        projectId: newId("prj") as ProjectId,
      }),
    ).rejects.toMatchObject({ code: "not_connected" });
    expect(() => facade.follow(missionId)).toThrow(/connect\(\) first/);
    expect(facade.storedCursor(missionId)).toBeNull();
    facade.saveCursor(missionId, "Mw==");
    facade.saveCursor(missionId, "NA==");
    expect(facade.storedCursor(missionId)).toBe("NA==");
    expect(
      db
        .prepare("SELECT cursor, updated_at FROM execution_cursors WHERE mission_id = ?")
        .get(missionId),
    ).toEqual({ cursor: "NA==", updated_at: "2026-10-14T12:00:00.000Z" });
  });
});
