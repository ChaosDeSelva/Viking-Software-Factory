import { afterEach, describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  CreateMissionResponseSchema,
  CreateProjectResponseSchema,
  CreateTaskResponseSchema,
  EventEnvelopeSchema,
  IDEMPOTENCY_HEADER,
  generateOpenApi,
  RequestPrResponseSchema,
  newId,
} from "@mimir/protocol";
import { fakeMimirServer, type FakeMimirServer } from "./fake-mimir-server.js";

type Page = {
  events: unknown[];
  nextCursor: string | null;
  hasMore?: boolean;
  lastCursor?: string;
};
const page = async (res: Response) => (await res.json()) as Page;

let server: FakeMimirServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const auth = (s: FakeMimirServer) => ({ authorization: `Bearer ${s.token}` });

async function post(
  s: FakeMimirServer,
  path: string,
  body: unknown,
  key: string = crypto.randomUUID(),
) {
  return fetch(`${s.url}${path}`, {
    method: "POST",
    headers: { ...auth(s), "content-type": "application/json", [IDEMPOTENCY_HEADER]: key },
    body: JSON.stringify(body),
  });
}

async function readSse(res: Response, frames: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").filter((f) => f.includes("data: ")).length < frames) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

/** Reads until `marker` has been seen and the block after it is complete. */
async function readUntil(res: Response, marker: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!(text.includes(marker) && text.endsWith("\n\n"))) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

async function firstChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  return first;
}

describe("fakeMimirServer", () => {
  it("serves health without a token and rejects other routes without one", async () => {
    server = await fakeMimirServer();
    expect(await (await fetch(`${server.url}/v1/health`)).json()).toEqual({ status: "ok" });
    const res = await fetch(`${server.url}/v1/projects`);
    expect(res.status).toBe(401);
    expect(ApiErrorBodySchema.parse(await res.json()).error.code).toBe("unauthorized");
  });

  it("implements every path and method in the OpenAPI document", async () => {
    server = await fakeMimirServer();
    const doc = generateOpenApi() as unknown as { paths: Record<string, Record<string, unknown>> };
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        const url = path.replace("{id}", "x");
        expect(server.handles(method.toUpperCase(), url), `${method} ${path}`).toBe(true);
      }
    }
  });

  it("validates bodies with protocol schemas (422 with issues)", async () => {
    server = await fakeMimirServer();
    const res = await post(server, "/v1/missions", { projectId: "nope", objective: "" });
    expect(res.status).toBe(422);
    const body = ApiErrorBodySchema.parse(await res.json());
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toMatchObject({ issues: expect.any(Array) });
  });

  it("requires the idempotency header and replays a repeated key", async () => {
    server = await fakeMimirServer();
    const missing = await fetch(`${server.url}/v1/projects`, {
      method: "POST",
      headers: { ...auth(server), "content-type": "application/json" },
      body: JSON.stringify({ name: "p", repoPath: "/r" }),
    });
    expect(missing.status).toBe(422);
    const first = await post(server, "/v1/projects", { name: "p", repoPath: "/r" }, "k1");
    const again = await post(server, "/v1/projects", { name: "p", repoPath: "/r" }, "k1");
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
    const mismatch = await post(server, "/v1/projects", { name: "q", repoPath: "/r" }, "k1");
    expect(mismatch.status).toBe(409);
    expect(ApiErrorBodySchema.parse(await mismatch.json()).error.code).toBe(
      "idempotency_replay_mismatch",
    );
  });

  it("creates a mission, emits an event and enforces transitions", async () => {
    server = await fakeMimirServer();
    const p = CreateProjectResponseSchema.parse(
      await (await post(server, "/v1/projects", { name: "p", repoPath: "/r" })).json(),
    );
    const created = await post(server, "/v1/missions", { projectId: p.project.id, objective: "o" });
    const { mission } = CreateMissionResponseSchema.parse(await created.json());
    expect(mission.status).toBe("draft");
    expect((await post(server, `/v1/missions/${mission.id}/start`, {})).status).toBe(202);
    expect((await post(server, `/v1/missions/${mission.id}/start`, {})).status).toBe(409);
    expect(server.events().map((e) => e.event.type)).toEqual([
      "mission.created",
      "mission.started",
    ]);
    const missing = await fetch(`${server.url}/v1/missions/${newId("msn")}`, {
      headers: auth(server),
    });
    expect(missing.status).toBe(404);
  });

  it("pages events like the real server by default: nextCursor null at the end plus lastCursor", async () => {
    server = await fakeMimirServer();
    for (let i = 0; i < 5; i++) server.appendEvent({ type: "mission.created" });
    const page1 = await page(
      await fetch(`${server.url}/v1/events?limit=3`, { headers: auth(server) }),
    );
    expect(page1.events).toHaveLength(3);
    expect(page1).toMatchObject({ hasMore: true, nextCursor: server.events()[2]!.cursor });
    expect(page1.lastCursor).toBe(page1.nextCursor);
    const page2 = await page(
      await fetch(`${server.url}/v1/events?limit=3&cursor=${page1.nextCursor}`, {
        headers: auth(server),
      }),
    );
    expect(page2.events).toHaveLength(2);
    expect(page2).toMatchObject({
      hasMore: false,
      nextCursor: null,
      lastCursor: server.latestCursor(),
    });
    const empty = await page(
      await fetch(`${server.url}/v1/events?cursor=${server.latestCursor()}`, {
        headers: auth(server),
      }),
    );
    expect(empty).toEqual({
      events: [],
      nextCursor: null,
      hasMore: false,
      lastCursor: server.latestCursor(),
    });
  });

  it("offers the older page shapes as opt-in variants", async () => {
    server = await fakeMimirServer({ eventsPageShape: "hasMore" });
    server.appendEvent({ type: "mission.created" });
    const hasMore = await page(await fetch(`${server.url}/v1/events`, { headers: auth(server) }));
    expect(hasMore).toMatchObject({ hasMore: false, nextCursor: server.latestCursor() });
    expect(hasMore.lastCursor).toBeUndefined();
    await server.close();

    server = await fakeMimirServer({ eventsPageShape: "legacy" });
    server.appendEvent({ type: "mission.created" });
    const legacy = await (await fetch(`${server.url}/v1/events`, { headers: auth(server) })).json();
    expect(legacy).toEqual({ events: [expect.any(Object)], nextCursor: null });
  });

  it("returns 410 cursor_expired below the pruned floor", async () => {
    server = await fakeMimirServer();
    const a = server.appendEvent({ type: "mission.created" });
    server.appendEvent({ type: "mission.created" });
    server.prune(server.latestCursor());
    const res = await fetch(`${server.url}/v1/events?cursor=${a.cursor}`, {
      headers: auth(server),
    });
    expect(res.status).toBe(410);
  });

  it("streams SSE from Last-Event-ID then live, with id = cursor", async () => {
    server = await fakeMimirServer();
    const a = server.appendEvent({ type: "mission.created" });
    const b = server.appendEvent({ type: "mission.created" });
    const res = await fetch(`${server.url}/v1/events/stream`, {
      headers: { ...auth(server), "last-event-id": a.cursor },
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const pending = readSse(res, 2);
    await server.waitForSseClients(1);
    const c = server.appendEvent({ type: "mission.created" });
    const text = await pending;
    expect(text).toContain(`id: ${b.cursor}\nevent: mission.created\ndata: `);
    expect(text).toContain(`id: ${c.cursor}\n`);
    expect(text).not.toContain(`id: ${a.cursor}\nevent:`);
    const data = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(EventEnvelopeSchema.parse(JSON.parse(data[0]!.slice(6))).id).toBe(b.event.id);
  });

  it("pins a cursor-less SSE stream with an id-only block carrying the start position", async () => {
    server = await fakeMimirServer();
    const a = server.appendEvent({ type: "mission.created" });
    const res = await fetch(`${server.url}/v1/events/stream`, { headers: auth(server) });
    expect(await readUntil(res, "\n\nid: ")).toBe(`retry: 3000\n\nid: ${a.cursor}\n\n`);
    const withCursor = await fetch(`${server.url}/v1/events/stream?cursor=${a.cursor}`, {
      headers: auth(server),
    });
    expect(await firstChunk(withCursor)).toBe("retry: 3000\n\n");
    await server.close();

    server = await fakeMimirServer({ sseInitialId: false });
    server.appendEvent({ type: "mission.created" });
    const res2 = await fetch(`${server.url}/v1/events/stream`, { headers: auth(server) });
    expect(await firstChunk(res2)).toBe("retry: 3000\n\n");
  });

  it("serves session terminal reads and the attention list (T12 routes)", async () => {
    server = await fakeMimirServer();
    const crewId = newId("crw");
    const agent = server.seedAgent({ crewId });
    const sessionId = agent.runtimeSessionId!;
    server.state.terminals.set(sessionId, "one\ntwo\nthree");
    const term = await fetch(`${server.url}/v1/sessions/${sessionId}/terminal?lines=2`, {
      headers: auth(server),
    });
    expect(term.status).toBe(200);
    expect(await term.json()).toMatchObject({ text: "two\nthree", provenance: "observed" });
    const unknown = await fetch(`${server.url}/v1/sessions/${newId("ses")}/terminal`, {
      headers: auth(server),
    });
    expect(unknown.status).toBe(404);
    const bad = await fetch(`${server.url}/v1/sessions/${sessionId}/terminal?lines=0`, {
      headers: auth(server),
    });
    expect(bad.status).toBe(422);

    const missionId = newId("msn");
    const approval = server.seedApproval({ missionId });
    const task = server.seedTask({
      missionId,
      status: "blocked",
      blockedReason: "budget_exceeded",
    });
    server.seedTask({ missionId, status: "running" });
    const res = await fetch(`${server.url}/v1/attention`, { headers: auth(server) });
    expect(await res.json()).toEqual({
      items: [
        expect.objectContaining({ kind: "approval", approvalId: approval.id, missionId }),
        expect.objectContaining({ kind: "blocked", taskId: task.id, missionId }),
      ],
    });
  });

  it("POST /v1/tasks adds a pending task to a mission, like the real server", async () => {
    server = await fakeMimirServer();
    const s = server;
    const project = CreateProjectResponseSchema.parse(
      await (await post(s, "/v1/projects", { name: "p", repoPath: "/r" })).json(),
    ).project;
    const mission = CreateMissionResponseSchema.parse(
      await (await post(s, "/v1/missions", { projectId: project.id, objective: "o" })).json(),
    ).mission;
    const dep = s.seedTask({ missionId: mission.id }); // a dependency target in the mission
    const res = await post(s, "/v1/tasks", {
      missionId: mission.id,
      title: "add tests",
      brief: "write the tests",
      acceptanceCriteria: ["green", "fast"],
      dependsOn: [dep.id],
    });
    expect(res.status).toBe(201);
    const { task } = CreateTaskResponseSchema.parse(await res.json());
    expect(task).toMatchObject({
      missionId: mission.id,
      crewId: null,
      title: "add tests",
      acceptance: "green\nfast",
      status: "pending",
      attempt: 0,
      version: 0,
    });
    expect(s.state.tasks.get(task.id)).toEqual(task);
    expect(s.events().map((e) => e.event)).toContainEqual(
      expect.objectContaining({
        type: "task.created",
        streamId: `task:${task.id}`,
        taskId: task.id,
        missionId: mission.id,
      }),
    );

    const clientId = newId("tsk");
    const pinned = await post(s, "/v1/tasks", {
      id: clientId,
      missionId: mission.id,
      title: "t",
      brief: "b",
    });
    expect(CreateTaskResponseSchema.parse(await pinned.json()).task.id).toBe(clientId);

    const code = async (body: unknown) => {
      const r = await post(s, "/v1/tasks", body);
      return [r.status, ApiErrorBodySchema.parse(await r.json()).error] as const;
    };
    const base = { missionId: mission.id, title: "t", brief: "b" };
    expect(await code({ ...base, missionId: newId("msn") })).toEqual([
      422,
      expect.objectContaining({
        code: "validation_failed",
        details: expect.objectContaining({ reason: "unknown_mission" }),
      }),
    ]);
    expect(await code({ ...base, crewId: newId("crw") })).toEqual([
      422,
      expect.objectContaining({ details: expect.objectContaining({ reason: "unknown_crew" }) }),
    ]);
    expect(await code({ ...base, dependsOn: [newId("tsk")] })).toEqual([
      422,
      expect.objectContaining({
        details: expect.objectContaining({ reason: "unknown_dependency" }),
      }),
    ]);
    expect(await code({ ...base, id: clientId })).toEqual([
      409,
      expect.objectContaining({ code: "conflict" }),
    ]);
    expect(await code({ ...base, brief: "" })).toEqual([
      422,
      expect.objectContaining({ code: "validation_failed" }),
    ]);
    await post(s, `/v1/missions/${mission.id}/cancel`, {});
    expect(await code(base)).toEqual([
      409,
      expect.objectContaining({ code: "invalid_transition" }),
    ]);
  });

  it("GET /v1/artifacts/:id/content serves seeded bytes with the kind's type and the hash", async () => {
    server = await fakeMimirServer();
    const s = server;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const png = s.seedArtifact(
      { taskId: newId("tsk"), kind: "screenshot.mobile", hash: "sha256:ab" },
      bytes,
    );
    const res = await fetch(`${s.url}/v1/artifacts/${png.id}/content`, { headers: auth(s) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-artifact-hash")).toBe("sha256:ab");
    expect(res.headers.get("content-length")).toBe("6");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    const text = s.seedArtifact({ taskId: newId("tsk"), kind: "review" }, "# ok\n");
    const t = await fetch(`${s.url}/v1/artifacts/${text.id}/content`, { headers: auth(s) });
    expect(t.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await t.text()).toBe("# ok\n");

    // Metadata without stored content (pruned) and unknown ids are 404 not_found.
    const bare = s.seedArtifact({ taskId: newId("tsk") });
    for (const id of [bare.id, newId("art")]) {
      const r = await fetch(`${s.url}/v1/artifacts/${id}/content`, { headers: auth(s) });
      expect(r.status).toBe(404);
      expect(ApiErrorBodySchema.parse(await r.json()).error.code).toBe("not_found");
    }
    const anon = await fetch(`${s.url}/v1/artifacts/${png.id}/content`);
    expect(anon.status).toBe(401);
  });

  it("stop() drops connections but keeps state; start() listens on the same port", async () => {
    server = await fakeMimirServer();
    server.appendEvent({ type: "mission.created" });
    const port = server.port;
    await server.stop();
    await expect(fetch(`${server.url}/v1/health`)).rejects.toThrow();
    await server.start();
    expect(server.port).toBe(port);
    expect(server.events()).toHaveLength(1);
  });
});

describe("POST /v1/tasks/:id/pr (T12b)", () => {
  it("asks for a pr.create approval, records a local_delivery on approval, then delivers", async () => {
    server = await fakeMimirServer();
    const s = server;
    const mission = newId("msn");
    const done = s.seedTask({ missionId: mission, status: "completed" });
    const first = await post(s, `/v1/tasks/${done.id}/pr`, {});
    expect(first.status).toBe(202);
    const body = RequestPrResponseSchema.parse(await first.json());
    if (body.status !== "approval_required") throw new Error(`unexpected ${body.status}`);
    expect(s.events().map((e) => e.event.type)).toContain("approval.requested");
    // a second request while pending reuses the pending approval
    const again = RequestPrResponseSchema.parse(
      await (await post(s, `/v1/tasks/${done.id}/pr`, {})).json(),
    );
    expect(again).toMatchObject({ status: "approval_required", approvalId: body.approvalId });
    await post(s, `/v1/approvals/${body.approvalId}/decision`, { decision: "approved" });
    expect([...s.state.artifacts.values()].map((a) => a.kind)).toContain("local_delivery");
    expect(s.events().map((e) => e.event.type)).toContain("approval.consumed");
    // the approval was consumed by that delivery: a new request asks again
    const next = RequestPrResponseSchema.parse(
      await (await post(s, `/v1/tasks/${done.id}/pr`, {})).json(),
    );
    expect(next.status).toBe("approval_required");
    expect(next).not.toMatchObject({ approvalId: body.approvalId });
  });

  it("prPolicy allow delivers at once", async () => {
    server = await fakeMimirServer({ prPolicy: "allow" });
    const done = server.seedTask({ missionId: newId("msn"), status: "completed" });
    const res = RequestPrResponseSchema.parse(
      await (await post(server, `/v1/tasks/${done.id}/pr`, {})).json(),
    );
    expect(res.status).toBe("delivered");
    expect([...server.state.artifacts.values()].map((a) => a.kind)).toContain("local_delivery");
  });

  it("409 for a task that is not completed, 404 for an unknown task, 422 for body fields", async () => {
    server = await fakeMimirServer();
    const s = server;
    const running = s.seedTask({ missionId: newId("msn"), status: "running" });
    expect((await post(s, `/v1/tasks/${running.id}/pr`, {})).status).toBe(409);
    expect((await post(s, `/v1/tasks/${newId("tsk")}/pr`, {})).status).toBe(404);
    expect((await post(s, `/v1/tasks/${running.id}/pr`, { title: "x" })).status).toBe(422);
  });
});
