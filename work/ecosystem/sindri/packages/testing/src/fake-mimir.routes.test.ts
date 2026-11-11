import { createHash } from "node:crypto";
import { newId, type EventEnvelope, type MissionId, type TaskId } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMimir, type FakeMimir, type FakeMimirOptions } from "./fake-mimir.js";

let fake: FakeMimir | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await fake?.close();
  fake = undefined;
});

async function boot(options: FakeMimirOptions = {}): Promise<FakeMimir> {
  fake = await createFakeMimir({ stepDelayMs: 0, ...options });
  return fake;
}

interface Json {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw response JSON, read freely in assertions
  body: Record<string, any>;
  headers: Headers;
}
const auth = (f: FakeMimir) => ({ authorization: `Bearer ${f.token}` });
let keys = 0;
async function post(f: FakeMimir, path: string, body?: unknown, key?: string): Promise<Json> {
  const res = await fetch(f.url + path, {
    method: "POST",
    headers: {
      ...auth(f),
      "content-type": "application/json",
      "idempotency-key": key ?? `routes-${++keys}`,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json["body"], headers: res.headers };
}
async function get(f: FakeMimir, path: string): Promise<Json> {
  const res = await fetch(f.url + path, { headers: auth(f) });
  return { status: res.status, body: (await res.json()) as Json["body"], headers: res.headers };
}

async function project(f: FakeMimir, repoPath = "/tmp/p"): Promise<string> {
  return (await post(f, "/v1/projects", { name: "p", repoPath })).body.project.id as string;
}
async function mission(f: FakeMimir, projectId: string, objective = "o"): Promise<MissionId> {
  return (await post(f, "/v1/missions", { projectId, objective })).body.mission.id as MissionId;
}
async function crew(f: FakeMimir, missionId: string, extra: object = {}): Promise<string> {
  const res = await post(f, "/v1/crews", {
    missionId,
    template: "implementer",
    members: [{ role: "implementer", agentKind: "shell" }],
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.crew.id as string;
}
async function task(f: FakeMimir, missionId: string, title: string, extra: object = {}) {
  const res = await post(f, "/v1/tasks", { missionId, title, brief: `do ${title}`, ...extra });
  expect(res.status).toBe(201);
  return res.body.task.id as TaskId;
}

/** Waits (by polling the fake's own log) until an event matches. */
async function until(f: FakeMimir, match: (e: EventEnvelope) => boolean): Promise<EventEnvelope> {
  for (;;) {
    const found = f.events().find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Opens the SSE stream; `read` returns the text received once `done` accepts it. */
async function openSse(f: FakeMimir, query: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(`${f.url}/v1/events/stream${query}`, {
    headers: { ...auth(f), ...headers },
    signal: ac.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return {
    res,
    async read(done: (text: string) => boolean): Promise<string> {
      while (!done(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
    close: () => ac.abort(),
  };
}
const sseTypes = (text: string) => [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1] as string);

describe("createFakeMimir: reads", () => {
  it("uses the documented defaults when booted without options", async () => {
    fake = await createFakeMimir();
    expect(fake.token).toBe("fake-mimir-token");
    const caps = await get(fake, "/v1/capabilities");
    expect(caps.status).toBe(200);
    expect(caps.body).toMatchObject({ serverVersion: "fake-mimir", protocolVersion: 1 });
  });

  it("serves a snapshot whose cursor is the latest one, and empty usage totals", async () => {
    const f = await boot();
    const projectId = await project(f);
    const missionId = await mission(f, projectId);
    const crewId = await crew(f, missionId);
    const taskId = await task(f, missionId, "a: one", { crewId });
    const snap = await get(f, "/v1/snapshot");
    expect(snap.status).toBe(200);
    expect(snap.body.projects.map((p: { id: string }) => p.id)).toEqual([projectId]);
    expect(snap.body.missions.map((m: { id: string }) => m.id)).toEqual([missionId]);
    expect(snap.body.crews.map((c: { id: string }) => c.id)).toEqual([crewId]);
    expect(snap.body.tasks.map((t: { id: string }) => t.id)).toEqual([taskId]);
    expect(snap.body.cursor).toBe(f.latestCursor());
    expect(f.latestCursor()).toBe(f.cursorAt(f.events().length));
    const usage = await get(f, `/v1/usage?missionId=${missionId}`);
    expect(usage.status).toBe(200);
    expect(usage.body).toEqual({
      totals: {
        tokens: 0,
        estimatedCost: 0,
        samples: 0,
        bySource: { measured: 0, estimated: 0, unavailable: 0 },
      },
      samples: [],
    });
    expect((await get(f, "/v1/usage?missionId=nope")).status).toBe(422);
  });

  it("lists projects, and missions filtered by project and status", async () => {
    const f = await boot();
    const p1 = await project(f, "/tmp/one");
    const p2 = await project(f, "/tmp/two");
    const m1 = await mission(f, p1);
    const m2 = await mission(f, p2);
    expect((await post(f, `/v1/missions/${m2}/start`, {})).status).toBe(202);
    const ids = (r: Json) => r.body.missions.map((m: { id: string }) => m.id);
    expect((await get(f, "/v1/projects")).body.projects.map((p: { id: string }) => p.id)).toEqual([
      p1,
      p2,
    ]);
    expect(ids(await get(f, "/v1/missions"))).toEqual([m1, m2]);
    expect(ids(await get(f, `/v1/missions?projectId=${p1}`))).toEqual([m1]);
    expect(ids(await get(f, "/v1/missions?status=active"))).toEqual([m2]);
    expect(ids(await get(f, `/v1/missions?projectId=${p1}&status=active`))).toEqual([]);
    expect((await get(f, "/v1/missions?status=bogus")).status).toBe(422);
  });

  it("returns a mission with only its own crews and tasks, and 404 for an unknown one", async () => {
    const f = await boot();
    const projectId = await project(f);
    const m1 = await mission(f, projectId);
    const m2 = await mission(f, projectId);
    const c1 = await crew(f, m1);
    await crew(f, m2);
    const t1 = await task(f, m1, "a: one", { crewId: c1 });
    await task(f, m2, "b: two");
    const res = await get(f, `/v1/missions/${m1}`);
    expect(res.status).toBe(200);
    expect(res.body.mission.id).toBe(m1);
    expect(res.body.crews.map((c: { id: string }) => c.id)).toEqual([c1]);
    expect(res.body.tasks.map((t: { id: string }) => t.id)).toEqual([t1]);
    const missing = await get(f, `/v1/missions/${newId("msn")}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
  });

  it("lists crews and tasks with their filters", async () => {
    const f = await boot();
    const projectId = await project(f);
    const m1 = await mission(f, projectId);
    const m2 = await mission(f, projectId);
    const c1 = await crew(f, m1, { limits: { maxAttemptsPerTask: 4 } });
    const c2 = await crew(f, m2, {
      members: [{ role: "reviewer", agentKind: "claude", name: "rita" }],
    });
    const t1 = await task(f, m1, "a: one", { crewId: c1 });
    const t2 = await task(f, m1, "b: two");
    const t3 = await task(f, m2, "c: three", { crewId: c2 });
    const crewIds = (r: Json) => r.body.crews.map((c: { id: string }) => c.id);
    const taskIds = (r: Json) => r.body.tasks.map((t: { id: string }) => t.id);
    expect(crewIds(await get(f, "/v1/crews"))).toEqual([c1, c2]);
    expect(crewIds(await get(f, `/v1/crews?missionId=${m2}`))).toEqual([c2]);
    expect(taskIds(await get(f, "/v1/tasks"))).toEqual([t1, t2, t3]);
    expect(taskIds(await get(f, `/v1/tasks?missionId=${m1}`))).toEqual([t1, t2]);
    expect(taskIds(await get(f, `/v1/tasks?crewId=${c1}`))).toEqual([t1]);
    expect(taskIds(await get(f, "/v1/tasks?status=pending"))).toEqual([t1, t2, t3]);
    expect(taskIds(await get(f, "/v1/tasks?status=completed"))).toEqual([]);
    // Attempts come from the crew's limits; a task without a crew gets one.
    const byId = new Map(f.tasks().map((t) => [t.id as string, t]));
    expect(byId.get(t1)?.maxAttempts).toBe(4);
    expect(byId.get(t2)?.maxAttempts).toBe(1);
    expect(byId.get(t3)?.maxAttempts).toBe(1);
  });

  it("names crew members after their role unless a name is given", async () => {
    const f = await boot();
    const missionId = await mission(f, await project(f));
    const res = await post(f, "/v1/crews", {
      missionId,
      template: "mixed",
      members: [
        { role: "implementer", agentKind: "shell" },
        { role: "reviewer", agentKind: "claude", name: "rita" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.crew.limits).toEqual({});
    expect(res.body.members.map((m: { name: string }) => m.name)).toEqual([
      "implementer-1",
      "rita",
    ]);
    expect(f.creates.crews).toBe(1);
    const orphan = await post(f, "/v1/crews", {
      missionId: newId("msn"),
      template: "t",
      members: [{ role: "implementer", agentKind: "shell" }],
    });
    expect(orphan.status).toBe(404);
    expect(f.creates.crews).toBe(1);
  });

  it("pages GET /v1/events with limit, cursor, stream and type filters", async () => {
    const f = await boot();
    const projectId = await project(f);
    const m1 = await mission(f, projectId);
    const m2 = await mission(f, projectId);
    const t1 = await task(f, m1, "a: one");
    await task(f, m1, "b: two");
    await task(f, m2, "c: three");
    // Log: mission.created(m1), mission.created(m2), task.created x3.
    const first = await get(f, "/v1/events?limit=2");
    expect(first.body.events.map((e: EventEnvelope) => e.type)).toEqual([
      "mission.created",
      "mission.created",
    ]);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toBe(f.cursorAt(2));
    expect(first.body.lastCursor).toBe(f.cursorAt(2));
    const rest = await get(f, `/v1/events?cursor=${first.body.nextCursor}`);
    expect(rest.body.events).toHaveLength(3);
    expect(rest.body.hasMore).toBe(false);
    expect(rest.body.nextCursor).toBeNull();
    expect(rest.body.lastCursor).toBe(f.latestCursor());
    // Caught up: an empty page keeps the caller's cursor.
    const empty = await get(f, `/v1/events?cursor=${f.latestCursor()}`);
    expect(empty.body.events).toEqual([]);
    expect(empty.body.lastCursor).toBe(f.latestCursor());

    const byStream = await get(f, `/v1/events?streamId=${encodeURIComponent(`task:${t1}`)}`);
    expect(byStream.body.events.map((e: EventEnvelope) => e.taskId)).toEqual([t1]);
    const byMission = await get(f, `/v1/events?missionId=${m2}`);
    expect(byMission.body.events.map((e: EventEnvelope) => e.type)).toEqual([
      "mission.created",
      "task.created",
    ]);
    const byTypes = await get(f, "/v1/events?types=task.created&types=mission.started");
    expect(byTypes.body.events.map((e: EventEnvelope) => e.type)).toEqual([
      "task.created",
      "task.created",
      "task.created",
    ]);
  });

  it("rejects a cursor that is not one of its own (422) or is ahead of the log (410)", async () => {
    const f = await boot();
    await mission(f, await project(f));
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    for (const bad of [b64("abc"), b64("-1"), b64("1.5")]) {
      const res = await get(f, `/v1/events?cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");
    }
    const ahead = await get(f, `/v1/events?cursor=${f.cursorAt(99)}`);
    expect(ahead.status).toBe(410);
    expect(ahead.body.error.code).toBe("cursor_expired");
    const stream = await fetch(`${f.url}/v1/events/stream?cursor=${f.cursorAt(99)}`, {
      headers: auth(f),
    });
    expect(stream.status).toBe(410);
    expect(((await stream.json()) as Json["body"]).error.code).toBe("cursor_expired");
  });

  it("answers 404 for a route it does not serve and 422 for a body that is not JSON", async () => {
    const f = await boot();
    const unknown = await get(f, "/v1/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ code: "not_found" });
    // Same shape but another method is no match either.
    expect((await post(f, "/v1/health", {})).status).toBe(404);
    const garbled = await post(f, "/v1/projects", "{not json");
    expect(garbled.status).toBe(422);
    expect(garbled.body.error.code).toBe("validation_failed");
    expect(f.creates.projects).toBe(0);
    expect((await post(f, "/v1/missions", "null")).status).toBe(422);
    expect(f.creates.missions).toBe(0);
    // Unparseable requests are not recorded; the others are, with body and key.
    expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/nope",
      "POST /v1/health",
      "POST /v1/missions",
    ]);
    expect(f.requests[0]).not.toHaveProperty("body");
    expect(f.requests[1]).toMatchObject({ body: {}, idempotencyKey: expect.any(String) });
  });

  it("requires an idempotency key on every POST", async () => {
    const f = await boot();
    const res = await fetch(`${f.url}/v1/projects`, {
      method: "POST",
      headers: { ...auth(f), "content-type": "application/json" },
      body: JSON.stringify({ name: "p", repoPath: "/tmp/p" }),
    });
    expect(res.status).toBe(422);
    expect(f.creates.projects).toBe(0);
    expect(f.requests[0]).not.toHaveProperty("idempotencyKey");
  });

  it("failNext answers the chosen status once, for the matching method and path prefix only", async () => {
    const f = await boot();
    f.failNext("get", "/v1/projects", 503);
    expect((await get(f, "/v1/capabilities")).status).toBe(200);
    expect((await post(f, "/v1/projects", { name: "p", repoPath: "/tmp/p" })).status).toBe(201);
    const failed = await get(f, "/v1/projects");
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: { code: "internal", message: "injected failure" } });
    expect((await get(f, "/v1/projects")).status).toBe(200);
  });
});

describe("createFakeMimir: mission and task commands", () => {
  it("starts a mission from an empty body once, and refuses to start it again", async () => {
    const f = await boot();
    const missionId = await mission(f, await project(f));
    const started = await post(f, `/v1/missions/${missionId}/start`);
    expect(started.status).toBe(202);
    expect(started.body).toEqual({
      operationId: expect.stringMatching(/^op_/),
      commandId: expect.stringMatching(/^cmd_/),
    });
    const again = await post(f, `/v1/missions/${missionId}/start`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("invalid_transition");
    expect(f.events().filter((e) => e.type === "mission.started")).toHaveLength(1);
    expect((await post(f, `/v1/missions/${newId("msn")}/start`, {})).status).toBe(404);
  });

  it("refuses to add a task to a mission that has started", async () => {
    const f = await boot();
    const missionId = await mission(f, await project(f));
    await post(f, `/v1/missions/${missionId}/start`, {});
    const res = await post(f, "/v1/tasks", { missionId, title: "late", brief: "b" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_transition");
    expect(f.tasks()).toEqual([]);
  });

  it("cancels a mission with or without a reason, once", async () => {
    const f = await boot();
    const projectId = await project(f);
    const m1 = await mission(f, projectId);
    const m2 = await mission(f, projectId);
    expect(
      (await post(f, `/v1/missions/${m1}/cancel`, { reason: "changed our mind" })).status,
    ).toBe(202);
    expect((await post(f, `/v1/missions/${m2}/cancel`, {})).status).toBe(202);
    const cancelled = f.events().filter((e) => e.type === "mission.cancelled");
    expect(cancelled.map((e) => e.payload)).toEqual([
      { from: "draft", to: "cancelled", reason: "changed our mind" },
      { from: "draft", to: "cancelled" },
    ]);
    expect((await get(f, `/v1/missions/${m1}`)).body.mission.status).toBe("cancelled");
    const again = await post(f, `/v1/missions/${m1}/cancel`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("invalid_transition");
    // A cancelled mission cannot be started either.
    expect((await post(f, `/v1/missions/${m1}/start`, {})).status).toBe(409);
  });

  it("refuses a crew or a dependency that belongs to another mission", async () => {
    const f = await boot();
    const projectId = await project(f);
    const m1 = await mission(f, projectId);
    const m2 = await mission(f, projectId);
    const foreignCrew = await crew(f, m2);
    const foreignTask = await task(f, m2, "x: other");
    const wrongCrew = await post(f, "/v1/tasks", {
      missionId: m1,
      crewId: foreignCrew,
      title: "a",
      brief: "b",
    });
    expect(wrongCrew.status).toBe(409);
    expect(wrongCrew.body.error.message).toBe("crew not in mission");
    const wrongDep = await post(f, "/v1/tasks", {
      missionId: m1,
      title: "a",
      brief: "b",
      dependsOn: [foreignTask],
    });
    expect(wrongDep.status).toBe(409);
    expect(wrongDep.body.error.message).toBe("dependency in other mission");
    const unknownCrew = await post(f, "/v1/tasks", {
      missionId: m1,
      crewId: newId("crw"),
      title: "a",
      brief: "b",
    });
    expect(unknownCrew.status).toBe(404);
    expect(f.tasks().map((t) => t.id)).toEqual([foreignTask]);
  });

  it("records an explicit argv on task.created and joins acceptance criteria", async () => {
    const f = await boot();
    const missionId = await mission(f, await project(f));
    const withArgv = await task(f, missionId, "a: one", {
      argv: ["sh", "-c", "true"],
      acceptanceCriteria: ["AC-1", "AC-2"],
    });
    const without = await task(f, missionId, "b: two");
    const payload = (id: string) =>
      f.events().find((e) => e.type === "task.created" && e.taskId === id)!.payload as Record<
        string,
        unknown
      >;
    expect(payload(withArgv)).toMatchObject({
      argv: ["sh", "-c", "true"],
      acceptance: "AC-1\nAC-2",
    });
    expect(payload(without)).not.toHaveProperty("argv");
    expect(payload(without)).toMatchObject({ acceptance: "", dependsOn: [] });
  });

  it("lets tasks of one POST /v1/missions depend on each other by client-chosen id", async () => {
    const f = await boot();
    const projectId = await project(f);
    const a = newId("tsk") as TaskId;
    const b = newId("tsk") as TaskId;
    const res = await post(f, "/v1/missions", {
      projectId,
      objective: "dag",
      tasks: [
        { id: a, title: "a: first", brief: "b" },
        { id: b, title: "b: second", brief: "b", dependsOn: [a] },
      ],
    });
    expect(res.status).toBe(201);
    const missionId = res.body.mission.id as string;
    await post(f, `/v1/missions/${missionId}/start`, {});
    await until(f, (e) => e.type === "mission.completed" && e.missionId === missionId);
    const order = f
      .events()
      .filter((e) => e.type === "task.completed")
      .map((e) => e.taskId);
    expect(order).toEqual([a, b]);
    expect(f.tasks().map((t) => t.resultCommit)).toEqual([f.headShaOf(a), f.headShaOf(b)]);
    // A crew cannot be named before the mission exists.
    const withCrew = await post(f, "/v1/missions", {
      projectId,
      objective: "dag",
      tasks: [{ title: "c", brief: "b", crewId: newId("crw") }],
    });
    expect(withCrew.status).toBe(404);
    expect(f.creates.missions).toBe(1);
    expect(
      (await post(f, "/v1/missions", { projectId: newId("prj"), objective: "o" })).status,
    ).toBe(404);
  });

  it("drops the unknown baseCommits field but validates the rest of the mission body", async () => {
    const f = await boot();
    const projectId = await project(f);
    const ok = await post(f, "/v1/missions", {
      projectId,
      objective: "rework",
      baseCommits: ["a".repeat(40)],
    });
    expect(ok.status).toBe(201);
    expect(ok.body).not.toHaveProperty("tasks");
    expect((await post(f, "/v1/missions", { projectId, objective: "o", nope: 1 })).status).toBe(
      422,
    );
  });
});

describe("createFakeMimir: scripted task outcomes", () => {
  it("prefers a script for the exact title over one for its prefix, and completes unscripted tasks", async () => {
    const f = await boot({
      scripts: {
        a: [{ kind: "complete", artifacts: ["diff"] }],
        "a: exact": [{ kind: "fail" }],
      },
    });
    const missionId = await mission(f, await project(f));
    const exact = await task(f, missionId, "a: exact");
    const prefixed = await task(f, missionId, "a: other");
    const unscripted = await task(f, missionId, "plain title");
    await post(f, `/v1/missions/${missionId}/start`, {});
    const failed = await until(f, (e) => e.type === "task.failed");
    await until(f, (e) => e.type === "task.completed" && e.taskId === unscripted);
    await until(f, (e) => e.type === "task.completed" && e.taskId === prefixed);
    expect(failed.taskId).toBe(exact);
    // Defaults: the reason, and not retryable once the attempts (1 without a crew) are used.
    expect(failed.payload).toMatchObject({
      reason: "scripted failure",
      attempt: 1,
      retryable: false,
    });
    const kindsOf = (id: string) => f.artifacts().flatMap((a) => (a.taskId === id ? [a.kind] : []));
    expect(kindsOf(prefixed)).toEqual(["diff"]);
    expect(kindsOf(unscripted)).toEqual(["diff", "changed-files", "test.output"]);
    expect(kindsOf(exact)).toEqual([]);
    // One failed task keeps the mission open.
    expect(f.events().some((e) => e.type === "mission.completed")).toBe(false);
  });

  it("script() added after boot applies to tasks created later, with given artifact contents", async () => {
    const f = await boot();
    f.script("a", [
      {
        kind: "complete",
        artifacts: ["diff", "review", "changed-files"],
        contents: { diff: "the diff", review: (taskId) => `review of ${taskId}` },
      },
    ]);
    const missionId = await mission(f, await project(f));
    const taskId = await task(f, missionId, "a: one");
    await post(f, `/v1/missions/${missionId}/start`, {});
    await until(f, (e) => e.type === "mission.completed");
    const content = async (kind: string) => {
      const artifact = f.artifacts().find((a) => a.kind === kind)!;
      const res = await fetch(`${f.url}/v1/artifacts/${artifact.id}/content`, { headers: auth(f) });
      const text = await res.text();
      expect(res.headers.get("x-artifact-hash")).toBe(artifact.hash);
      expect(artifact.hash).toBe("sha256:" + createHash("sha256").update(text).digest("hex"));
      return text;
    };
    expect(await content("diff")).toBe("the diff");
    expect(await content("review")).toBe(`review of ${taskId}`);
    expect(JSON.parse(await content("changed-files"))).toMatchObject({
      headSha: f.headShaOf(taskId),
      files: [],
    });
    expect((await get(f, `/v1/artifacts/${newId("art")}`)).status).toBe(404);
  });

  it("tamper() changes the served bytes but not the recorded hash, and refuses unknown artifacts", async () => {
    const f = await boot();
    const missionId = await mission(f, await project(f));
    await task(f, missionId, "a: one");
    await post(f, `/v1/missions/${missionId}/start`, {});
    await until(f, (e) => e.type === "mission.completed");
    const artifact = f.artifacts().find((a) => a.kind === "diff")!;
    f.tamper(artifact.id, "tampered");
    const res = await fetch(`${f.url}/v1/artifacts/${artifact.id}/content`, { headers: auth(f) });
    expect(await res.text()).toBe("tampered");
    expect(res.headers.get("x-artifact-hash")).toBe(artifact.hash);
    expect(artifact.hash).not.toBe(
      "sha256:" + createHash("sha256").update("tampered").digest("hex"),
    );
    expect(() => f.tamper(newId("art"), "x")).toThrow(/not found/);
  });

  it("allows a retry only for a failed task with attempts left, and records the reason", async () => {
    const f = await boot({
      scripts: {
        a: [
          { kind: "fail", reason: "boom", retryable: false },
          { kind: "fail", reason: "boom again" },
        ],
      },
    });
    const missionId = await mission(f, await project(f));
    const crewId = await crew(f, missionId, { limits: { maxAttemptsPerTask: 2 } });
    const taskId = await task(f, missionId, "a: one", { crewId });
    const notFailed = await post(f, `/v1/tasks/${taskId}/retry`, {});
    expect(notFailed.status).toBe(409);
    expect(notFailed.body.error.message).toBe("task is pending (attempt 0 of 2)");
    await post(f, `/v1/missions/${missionId}/start`, {});
    const first = await until(f, (e) => e.type === "task.failed");
    expect(first.payload).toMatchObject({ reason: "boom", attempt: 1, retryable: false });
    expect((await post(f, `/v1/tasks/${taskId}/retry`, { reason: "try again" })).status).toBe(202);
    const retried = await until(f, (e) => e.type === "task.retried");
    expect(retried.payload).toEqual({
      from: "failed",
      to: "ready",
      attempt: 2,
      reason: "try again",
    });
    const second = await until(
      f,
      (e) => e.type === "task.failed" && (e.payload as { attempt: number }).attempt === 2,
    );
    // The default `retryable` is false once the crew's attempts are used up.
    expect(second.payload).toMatchObject({ reason: "boom again", retryable: false });
    const exhausted = await post(f, `/v1/tasks/${taskId}/retry`, {});
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.error.message).toBe("task is failed (attempt 2 of 2)");
    expect((await post(f, `/v1/tasks/${newId("tsk")}/retry`, {})).status).toBe(404);
    // Each attempt ran in its own session.
    const sessions = f
      .events()
      .filter((e) => e.type === "task.started")
      .map((e) => e.sessionId);
    expect(new Set(sessions).size).toBe(2);
  });

  it("a rejected approval leaves the task blocked and reports policy.denied; a decision is final", async () => {
    const f = await boot({
      scripts: { a: [{ kind: "approval", action: "git.push", reason: "needs a human" }] },
    });
    const projectId = await project(f);
    const missionId = await mission(f, projectId);
    const other = await mission(f, projectId);
    const taskId = await task(f, missionId, "a: one");
    await post(f, `/v1/missions/${missionId}/start`, {});
    const requested = await until(f, (e) => e.type === "approval.requested");
    await until(f, (e) => e.type === "task.blocked");
    expect(requested.payload).toMatchObject({ action: "git.push", reason: "needs a human" });
    const approvalId = (requested.payload as { approvalId: string }).approvalId;
    expect(f.approvals()).toMatchObject([
      { id: approvalId, status: "pending", taskId, reason: "needs a human" },
    ]);
    const listed = async (query: string) =>
      (await get(f, `/v1/approvals${query}`)).body.approvals.map((a: { id: string }) => a.id);
    expect(await listed(`?missionId=${missionId}`)).toEqual([approvalId]);
    expect(await listed(`?missionId=${other}`)).toEqual([]);
    expect(await listed("?status=approved")).toEqual([]);

    const decided = await post(f, `/v1/approvals/${approvalId}/decision`, {
      decision: "rejected",
      reason: "too risky",
    });
    expect(decided.status).toBe(202);
    const decision = f.events().find((e) => e.type === "approval.decided")!;
    expect(decision.payload).toEqual({
      approvalId,
      decision: "rejected",
      actor: "operator",
      reason: "too risky",
    });
    const denied = f.events().find((e) => e.type === "policy.denied")!;
    expect(denied.taskId).toBe(taskId);
    expect(denied.payload).toEqual({ action: "git.push", reason: "approval rejected" });
    expect(f.approvals()[0]).toMatchObject({ status: "rejected", actor: "operator" });
    expect(f.tasks()[0]).toMatchObject({ status: "blocked", blockedReason: "approval_required" });

    const again = await post(f, `/v1/approvals/${approvalId}/decision`, { decision: "approved" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("approval is rejected");
    expect(
      (await post(f, `/v1/approvals/${newId("apr")}/decision`, { decision: "approved" })).status,
    ).toBe(404);
  });

  it("an approved approval resumes the task in the same session", async () => {
    const f = await boot({ scripts: { a: [{ kind: "approval", action: "git.push" }] } });
    const missionId = await mission(f, await project(f));
    const taskId = await task(f, missionId, "a: one");
    await post(f, `/v1/missions/${missionId}/start`, {});
    const requested = await until(f, (e) => e.type === "approval.requested");
    expect(requested.payload).not.toHaveProperty("reason");
    const approvalId = (requested.payload as { approvalId: string }).approvalId;
    await until(f, (e) => e.type === "task.blocked");
    await post(f, `/v1/approvals/${approvalId}/decision`, { decision: "approved" });
    await until(f, (e) => e.type === "mission.completed");
    const started = f.events().filter((e) => e.type === "task.started" && e.taskId === taskId);
    expect(started).toHaveLength(2);
    expect(started[1]!.sessionId).toBe(started[0]!.sessionId);
    expect(started[1]!.payload).toMatchObject({ from: "blocked", to: "running" });
    expect(f.tasks()[0]).not.toHaveProperty("blockedReason");
  });

  it("records input and stop commands for known sessions only", async () => {
    const f = await boot({ scripts: { a: [{ kind: "approval", action: "git.push" }] } });
    const missionId = await mission(f, await project(f));
    await task(f, missionId, "a: one");
    await post(f, `/v1/missions/${missionId}/start`, {});
    const sessionId = (await until(f, (e) => e.type === "task.started")).sessionId as string;
    expect((await post(f, `/v1/sessions/${sessionId}/input`, { text: "carry on" })).status).toBe(
      202,
    );
    expect((await post(f, `/v1/sessions/${sessionId}/stop`, { mode: "force" })).status).toBe(202);
    expect(f.sessionCommands).toEqual([
      { sessionId, kind: "input", body: { text: "carry on" } },
      { sessionId, kind: "stop", body: { mode: "force" } },
    ]);
    const unknown = newId("ses");
    expect((await post(f, `/v1/sessions/${unknown}/input`, { text: "hi" })).status).toBe(404);
    expect((await post(f, `/v1/sessions/${unknown}/stop`, { mode: "soft" })).status).toBe(404);
    expect((await post(f, `/v1/sessions/${sessionId}/input`, { text: "" })).status).toBe(422);
    expect((await post(f, `/v1/sessions/${sessionId}/stop`, { mode: "now" })).status).toBe(422);
    expect(f.sessionCommands).toHaveLength(2);
  });
});

describe("createFakeMimir: event stream", () => {
  it("sends only the requested mission's events of the requested types", async () => {
    const f = await boot();
    const projectId = await project(f);
    const m1 = await mission(f, projectId);
    const m2 = await mission(f, projectId);
    const sse = await openSse(f, `?missionId=${m1}&types=task.created,mission.cancelled`);
    expect(sse.res.headers.get("content-type")).toContain("text/event-stream");
    await f.waitForSseClients(1);
    await task(f, m2, "other mission");
    await task(f, m1, "a: one");
    await post(f, `/v1/missions/${m1}/start`, {});
    await post(f, `/v1/missions/${m2}/cancel`, {});
    await post(f, `/v1/missions/${m1}/cancel`, {});
    const text = await sse.read((t) => t.includes("event: mission.cancelled"));
    sse.close();
    expect(text.startsWith("retry: 3000\n\n")).toBe(true);
    expect(sseTypes(text)).toEqual(["task.created", "mission.cancelled"]);
    const data = [...text.matchAll(/^data: (.+)$/gm)].map(
      (m) => JSON.parse(m[1] as string) as EventEnvelope,
    );
    expect(data.every((e) => e.missionId === m1)).toBe(true);
  });

  it("replays after a cursor given as Last-Event-ID or as a query parameter, with repeated types", async () => {
    const f = await boot();
    const missionId = await mission(f, await project(f));
    await task(f, missionId, "a: one");
    await post(f, `/v1/missions/${missionId}/start`, {});
    await until(f, (e) => e.type === "mission.completed");
    const all = f.events().map((e) => e.type);
    const done = (t: string) => t.includes("event: mission.completed");

    const byHeader = await openSse(f, "", { "last-event-id": f.cursorAt(2) });
    const afterTwo = await byHeader.read(done);
    byHeader.close();
    expect(sseTypes(afterTwo)).toEqual(all.slice(2));
    expect(afterTwo).toContain(`id: ${f.cursorAt(3)}\n`);

    const byQuery = await openSse(
      f,
      `?cursor=${f.cursorAt(0)}&types=mission.created&types=mission.completed`,
    );
    const filtered = await byQuery.read(done);
    byQuery.close();
    expect(sseTypes(filtered)).toEqual(["mission.created", "mission.completed"]);
  });

  it("without a cursor sends only what happens after the client connected", async () => {
    const f = await boot();
    const projectId = await project(f);
    await mission(f, projectId);
    const sse = await openSse(f, "");
    const later = await mission(f, projectId, "later");
    const text = await sse.read((t) => t.includes("event: mission.created"));
    sse.close();
    const data = [...text.matchAll(/^data: (.+)$/gm)].map(
      (m) => JSON.parse(m[1] as string) as EventEnvelope,
    );
    expect(data.map((e) => e.missionId)).toEqual([later]);
  });

  it("sends heartbeat comments while the stream is idle", async () => {
    const f = await boot({ heartbeatMs: 1 });
    const sse = await openSse(f, "");
    const text = await sse.read((t) => t.includes(": heartbeat\n\n"));
    sse.close();
    expect(text).toContain(": heartbeat\n\n");
    expect(sseTypes(text)).toEqual([]);
  });

  it("dropSseClients ends open streams, and waitForSseClients sees a reconnect", async () => {
    const f = await boot();
    const first = await openSse(f, "");
    await f.waitForSseClients(1);
    f.dropSseClients();
    // The server ended the response: the reader finishes although nothing matched.
    expect(await first.read(() => false)).toBe("retry: 3000\n\n");
    const waiting = f.waitForSseClients(1);
    const second = await openSse(f, "");
    await expect(waiting).resolves.toBeUndefined();
    second.close();
  });

  it("waitForSseClients gives up after five seconds without enough clients", async () => {
    const f = await boot();
    vi.useFakeTimers();
    const waiting = f.waitForSseClients(1);
    const outcome = expect(waiting).rejects.toThrow("timed out waiting for 1 SSE clients");
    await vi.advanceTimersByTimeAsync(5100);
    await outcome;
  });
});
