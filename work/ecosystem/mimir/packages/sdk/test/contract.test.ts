import {
  GetTaskResponseSchema,
  CrewSchedulingRequestSchema,
  CrewSchedulingResponseSchema,
  SessionObservationResponseSchema,
  VerifyTaskResponseSchema,
} from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalDecisionRequestSchema,
  CapabilitiesResponseSchema,
  CreateCrewResponseSchema,
  CreateMissionResponseSchema,
  CreateProjectResponseSchema,
  EventEnvelopeSchema,
  GetArtifactResponseSchema,
  GetMissionResponseSchema,
  HealthResponseSchema,
  ListApprovalsResponseSchema,
  ListCrewsResponseSchema,
  ListEventsResponseSchema,
  ListMissionsResponseSchema,
  ListProjectsResponseSchema,
  ListTasksResponseSchema,
  OperationAcceptedSchema,
  SnapshotResponseSchema,
  UsageResponseSchema,
  CancelMissionRequestSchema,
  CreateCrewRequestSchema,
  CreateMissionRequestSchema,
  CreateProjectRequestSchema,
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  IDEMPOTENCY_HEADER,
  MimirError,
  RequestPrRequestSchema,
  RequestPrResponseSchema,
  RetryTaskRequestSchema,
  SendInstructionRequestSchema,
  StartMissionRequestSchema,
  StopSessionRequestSchema,
  generateOpenApi,
  newId,
  type Mission,
  type Project,
} from "@mimir/protocol";
import { fakeMimirServer, type FakeMimirServer } from "@mimir/testing";
import { createMimirClient, type MimirClient } from "../src/index.js";

let server: FakeMimirServer;
let client: MimirClient;

beforeEach(async () => {
  server = await fakeMimirServer();
  client = createMimirClient({ baseUrl: server.url, token: server.token });
});
afterEach(async () => {
  await server.close();
});

async function seedMission(): Promise<{ project: Project; mission: Mission }> {
  const { project } = await client.projects.create({ name: "p", repoPath: "/repo" });
  const { mission } = await client.missions.create({ projectId: project.id, objective: "ship" });
  return { project, mission };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createMimirClient: every OpenAPI operation", () => {
  it("has a client method for each operation, and each request/response validates", async () => {
    const { mission } = await seedMission();
    const { crew } = await client.crews.create({
      missionId: mission.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "claude" }],
    });
    const task = server.seedTask({ missionId: mission.id, crewId: crew.id, status: "failed" });
    const done = server.seedTask({ missionId: mission.id, crewId: crew.id, status: "completed" });
    const agent = server.seedAgent({ crewId: crew.id, taskId: task.id });
    const approval = server.seedApproval({ missionId: mission.id });
    const artifact = server.seedArtifact({ taskId: task.id }, "diff --git a b\n");
    server.seedUsageSample({ agentId: agent.id, tokens: 10, estimatedCost: 0.5 });
    const sessionId = agent.runtimeSessionId!;
    // A second mission that stays open: operations run in document order and cancel the first.
    const { mission: open } = await client.missions.create({
      projectId: mission.projectId,
      objective: "stays open",
    });

    const requestSchemas: Record<
      string,
      { safeParse(v: unknown): { success: boolean } } | undefined
    > = {
      "POST /v1/crews/{id}/pause": CrewSchedulingRequestSchema,
      "POST /v1/crews/{id}/resume": CrewSchedulingRequestSchema,
      "POST /v1/tasks/{id}/verify": RetryTaskRequestSchema,
      "POST /v1/projects": CreateProjectRequestSchema,
      "POST /v1/missions": CreateMissionRequestSchema,
      "POST /v1/missions/{id}/start": StartMissionRequestSchema,
      "POST /v1/missions/{id}/cancel": CancelMissionRequestSchema,
      "POST /v1/crews": CreateCrewRequestSchema,
      "POST /v1/tasks/{id}/retry": RetryTaskRequestSchema,
      "POST /v1/tasks/{id}/pr": RequestPrRequestSchema,
      "POST /v1/tasks": CreateTaskRequestSchema,
      "POST /v1/approvals/{id}/decision": ApprovalDecisionRequestSchema,
      "POST /v1/sessions/{id}/input": SendInstructionRequestSchema,
      "POST /v1/sessions/{id}/stop": StopSessionRequestSchema,
    };

    // One call per OpenAPI operation; each returns the parsed (schema-validated) response.
    const { crew: controlledCrew } = await client.crews.create({
      missionId: open.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const calls: Record<string, () => Promise<unknown>> = {
      "POST /v1/crews/{id}/pause": () => client.crews.pause(controlledCrew.id),
      "POST /v1/crews/{id}/resume": () => client.crews.resume(controlledCrew.id),
      "GET /v1/tasks/{id}": () => client.tasks.get(done.id),
      "POST /v1/tasks/{id}/verify": () => client.tasks.verify(done.id),
      "GET /v1/sessions/{id}": () => client.sessions.get(sessionId),
      "GET /v1/health": () => client.health(),
      "GET /v1/capabilities": () => client.capabilities(),
      "GET /v1/snapshot": () => client.snapshot(),
      "POST /v1/projects": () => client.projects.create({ name: "q", repoPath: "/q" }),
      "GET /v1/projects": () => client.projects.list(),
      "POST /v1/missions": () =>
        client.missions.create({ projectId: mission.projectId, objective: "again" }),
      "GET /v1/missions": () => client.missions.list({ projectId: mission.projectId }),
      "GET /v1/missions/{id}": () => client.missions.get(mission.id),
      "POST /v1/missions/{id}/start": () => client.missions.start(mission.id),
      "POST /v1/missions/{id}/cancel": () => client.missions.cancel(mission.id, { reason: "done" }),
      "POST /v1/crews": () =>
        client.crews.create({
          missionId: mission.id,
          template: "pair",
          members: [{ role: "reviewer", agentKind: "codex", name: "rev" }],
        }),
      "GET /v1/crews": () => client.crews.list({ missionId: mission.id }),
      "GET /v1/tasks": () => client.tasks.list({ missionId: mission.id, status: "failed" }),
      "POST /v1/tasks/{id}/retry": () => client.tasks.retry(task.id, { reason: "flaky" }),
      "POST /v1/tasks/{id}/pr": () => client.tasks.requestPr(done.id),
      "POST /v1/tasks": () =>
        client.tasks.create({ missionId: open.id, title: "more", brief: "do more" }),
      "GET /v1/approvals": () => client.approvals.list({ status: "pending" }),
      "POST /v1/approvals/{id}/decision": () =>
        client.approvals.decide(approval.id, { decision: "approved" }),
      "POST /v1/sessions/{id}/input": () => client.sessions.input(sessionId, { text: "continue" }),
      "POST /v1/sessions/{id}/stop": () => client.sessions.stop(sessionId, { mode: "soft" }),
      "GET /v1/events": () => client.events.list({ limit: 10 }),
      "GET /v1/events/stream": async () => {
        const ac = new AbortController();
        const stream = client.events.stream({ cursor: "MA==", signal: ac.signal });
        const it = stream[Symbol.asyncIterator]();
        const first = await it.next();
        ac.abort();
        await it.return?.();
        return first.value;
      },
      "GET /v1/artifacts/{id}": () => client.artifacts.get(artifact.id),
      "GET /v1/artifacts/{id}/content": () => client.artifacts.content(artifact.id),
      "GET /v1/usage": () => client.usage.get({ missionId: mission.id }),
    };

    // Independent op → protocol response schema map, so a client that parsed with the wrong
    // schema is caught (the client's own parse alone would be circular).
    const responseSchemas: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
      "POST /v1/crews/{id}/pause": CrewSchedulingResponseSchema,
      "POST /v1/crews/{id}/resume": CrewSchedulingResponseSchema,
      "GET /v1/tasks/{id}": GetTaskResponseSchema,
      "GET /v1/sessions/{id}": SessionObservationResponseSchema,
      "POST /v1/tasks/{id}/verify": VerifyTaskResponseSchema,
      "GET /v1/health": HealthResponseSchema,
      "GET /v1/capabilities": CapabilitiesResponseSchema,
      "GET /v1/snapshot": SnapshotResponseSchema,
      "POST /v1/projects": CreateProjectResponseSchema,
      "GET /v1/projects": ListProjectsResponseSchema,
      "POST /v1/missions": CreateMissionResponseSchema,
      "GET /v1/missions": ListMissionsResponseSchema,
      "GET /v1/missions/{id}": GetMissionResponseSchema,
      "POST /v1/missions/{id}/start": OperationAcceptedSchema,
      "POST /v1/missions/{id}/cancel": OperationAcceptedSchema,
      "POST /v1/crews": CreateCrewResponseSchema,
      "GET /v1/crews": ListCrewsResponseSchema,
      "GET /v1/tasks": ListTasksResponseSchema,
      "POST /v1/tasks/{id}/retry": OperationAcceptedSchema,
      "POST /v1/tasks/{id}/pr": RequestPrResponseSchema,
      "POST /v1/tasks": CreateTaskResponseSchema,
      "GET /v1/approvals": ListApprovalsResponseSchema,
      "POST /v1/approvals/{id}/decision": OperationAcceptedSchema,
      "POST /v1/sessions/{id}/input": OperationAcceptedSchema,
      "POST /v1/sessions/{id}/stop": OperationAcceptedSchema,
      "GET /v1/events": ListEventsResponseSchema,
      "GET /v1/events/stream": EventEnvelopeSchema,
      "GET /v1/artifacts/{id}": GetArtifactResponseSchema,
      // Raw content has no protocol schema: check the SDK's `ArtifactContent` shape.
      "GET /v1/artifacts/{id}/content": {
        safeParse: (v: unknown) => ({
          success:
            typeof v === "object" &&
            v !== null &&
            (v as { bytes?: unknown }).bytes instanceof Uint8Array &&
            typeof (v as { contentType?: unknown }).contentType === "string" &&
            typeof (v as { hash?: unknown }).hash === "string",
        }),
      },
      "GET /v1/usage": UsageResponseSchema,
    };

    const doc = generateOpenApi() as unknown as { paths: Record<string, Record<string, unknown>> };
    const operations = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect(Object.keys(calls).sort()).toEqual([...operations].sort());

    for (const op of operations) {
      const before = server.requests.length;
      const result = await calls[op]!();
      expect(result, op).toBeDefined();
      expect(responseSchemas[op]!.safeParse(result).success, op).toBe(true);
      const sent = server.requests.slice(before);
      const [method, path] = op.split(" ") as [string, string];
      const pattern = new RegExp(`^${path.replace("{id}", "[^/?]+")}(\\?|$)`);
      const req = sent.find((r) => r.method === method && pattern.test(r.url));
      expect(req, op).toBeDefined();
      if (path !== "/v1/health") expect(req!.headers.authorization).toBe(`Bearer ${server.token}`);
      const schema = requestSchemas[op];
      if (schema) {
        expect(schema.safeParse(req!.body).success, op).toBe(true);
        expect(req!.headers[IDEMPOTENCY_HEADER], op).toMatch(UUID);
      }
    }
  });

  it("sends query parameters, including types as a comma-separated list", async () => {
    const { mission } = await seedMission();
    await client.events.list({
      types: ["mission.created", "mission.started"],
      missionId: mission.id,
    });
    await client.tasks.list({ missionId: mission.id, status: "ready" });
    const urls = server.requests.map((r) => r.url);
    expect(urls).toContain(
      `/v1/events?types=mission.created%2Cmission.started&missionId=${mission.id}`,
    );
    expect(urls).toContain(`/v1/tasks?missionId=${mission.id}&status=ready`);
  });
});

describe("T12 routes not yet in the OpenAPI document", () => {
  it("sessions.terminal reads the last lines of a session", async () => {
    const { mission } = await seedMission();
    const { crew } = await client.crews.create({
      missionId: mission.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "claude" }],
    });
    const agent = server.seedAgent({ crewId: crew.id });
    const sessionId = agent.runtimeSessionId!;
    server.state.terminals.set(sessionId, "a\nb\nc");
    const read = await client.sessions.terminal(sessionId, { lines: 2 });
    expect(read).toMatchObject({ text: "b\nc", provenance: "observed" });
    expect(server.requests.at(-1)!.url).toBe(`/v1/sessions/${sessionId}/terminal?lines=2`);
    expect((await client.sessions.terminal(sessionId)).text).toBe("a\nb\nc");
    await expect(client.sessions.terminal(newId("ses"))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("attention.list returns the items needing a human", async () => {
    const approval = server.seedApproval();
    const { items } = await client.attention.list();
    expect(items).toEqual([expect.objectContaining({ kind: "approval", approvalId: approval.id })]);
  });

  it("rejects a malformed terminal or attention body", async () => {
    const c = createMimirClient({
      baseUrl: "http://mimir.invalid",
      token: "t",
      fetch: async (input) =>
        Response.json(input.includes("attention") ? { items: [{ id: 1 }] } : { text: 5 }),
    });
    await expect(c.attention.list()).rejects.toMatchObject({ code: "validation_failed" });
    await expect(c.sessions.terminal(newId("ses"))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("tasks.create and artifacts.content", () => {
  it("tasks.create posts the request and returns the created task", async () => {
    const { mission } = await seedMission();
    const id = newId("tsk");
    const { task } = await client.tasks.create(
      { id, missionId: mission.id, title: "t", brief: "b", acceptanceCriteria: ["a"] },
      { idempotencyKey: "create-1" },
    );
    expect(task).toMatchObject({ id, missionId: mission.id, status: "pending", acceptance: "a" });
    const req = server.requests.at(-1)!;
    expect(req).toMatchObject({ method: "POST", url: "/v1/tasks" });
    expect(req.body).toEqual({
      id,
      missionId: mission.id,
      title: "t",
      brief: "b",
      acceptanceCriteria: ["a"],
    });
    expect(req.headers[IDEMPOTENCY_HEADER]).toBe("create-1");
    await expect(
      client.tasks.create({ missionId: newId("msn"), title: "t", brief: "b" }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("artifacts.content returns the exact bytes, content type and hash", async () => {
    const bytes = new Uint8Array([0, 1, 2, 0xfe, 0xff]);
    const art = server.seedArtifact(
      { taskId: newId("tsk"), kind: "screenshot", hash: "sha256:feed" },
      bytes,
    );
    const got = await client.artifacts.content(art.id);
    expect(got).toEqual({ bytes, contentType: "image/png", hash: "sha256:feed" });
    expect(got.bytes).toBeInstanceOf(Uint8Array);
    const req = server.requests.at(-1)!;
    expect(req.url).toBe(`/v1/artifacts/${art.id}/content`);
    expect(req.headers.authorization).toBe(`Bearer ${server.token}`);
    expect(req.headers.accept).toBe("*/*");
  });

  it("artifacts.content maps 404 and other error bodies to MimirError", async () => {
    const bare = server.seedArtifact({ taskId: newId("tsk") });
    await expect(client.artifacts.content(bare.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(client.artifacts.content(newId("art"))).rejects.toMatchObject({
      code: "not_found",
    });
    const c = createMimirClient({
      baseUrl: "http://mimir.invalid",
      token: "t",
      fetch: async () =>
        Response.json(
          { error: { code: "conflict", message: "too big", details: { reason: "too_large" } } },
          { status: 409 },
        ),
    });
    await expect(c.artifacts.content(newId("art"))).rejects.toMatchObject({
      code: "conflict",
      details: { reason: "too_large" },
    });
  });

  it("artifacts.content rejects a response without the artifact hash header", async () => {
    const c = createMimirClient({
      baseUrl: "http://mimir.invalid",
      token: "t",
      fetch: async () => new Response("x", { headers: { "content-type": "text/plain" } }),
    });
    await expect(c.artifacts.content(newId("art"))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("tasks.requestPr", () => {
  it("returns approval_required with the approval id; approval delivers and is consumed", async () => {
    const { mission } = await seedMission();
    const done = server.seedTask({ missionId: mission.id, status: "completed" });
    const first = await client.tasks.requestPr(done.id, { idempotencyKey: "pr-1" });
    expect(first).toMatchObject({ status: "approval_required" });
    if (first.status !== "approval_required") throw new Error("unreachable");
    const req = server.requests.at(-1)!;
    expect(req).toMatchObject({ method: "POST", url: `/v1/tasks/${done.id}/pr` });
    expect(req.body).toEqual({});
    expect(req.headers[IDEMPOTENCY_HEADER]).toBe("pr-1");
    expect(server.state.approvals.get(first.approvalId)).toMatchObject({
      action: "pr.create",
      status: "pending",
      taskId: done.id,
    });
    // same key replays the original answer
    expect(await client.tasks.requestPr(done.id, { idempotencyKey: "pr-1" })).toEqual(first);
    await client.approvals.decide(first.approvalId, { decision: "approved" });
    // delivery consumed the approval; a new request asks again
    const second = await client.tasks.requestPr(done.id, { idempotencyKey: "pr-2" });
    expect(second).toMatchObject({ status: "approval_required" });
  });

  it("returns delivered when the server's policy allows pr.create", async () => {
    const allowing = await fakeMimirServer({ prPolicy: "allow" });
    try {
      const c = createMimirClient({ baseUrl: allowing.url, token: allowing.token });
      const done = allowing.seedTask({ missionId: newId("msn"), status: "completed" });
      expect(await c.tasks.requestPr(done.id)).toMatchObject({ status: "delivered" });
    } finally {
      await allowing.close();
    }
  });

  it("maps a task that is not completed to invalid_transition and an unknown task to not_found", async () => {
    const { mission } = await seedMission();
    const running = server.seedTask({ missionId: mission.id, status: "running" });
    await expect(client.tasks.requestPr(running.id)).rejects.toMatchObject({
      code: "invalid_transition",
    });
    await expect(client.tasks.requestPr(newId("tsk"))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects a malformed reply (approval_required without approvalId)", async () => {
    const c = createMimirClient({
      baseUrl: "http://mimir.invalid",
      token: "t",
      fetch: async () =>
        Response.json(
          { operationId: newId("op"), commandId: newId("cmd"), status: "approval_required" },
          { status: 202 },
        ),
    });
    await expect(c.tasks.requestPr(newId("tsk"))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("idempotency", () => {
  it("uses a caller-provided key, and a replay returns the same result", async () => {
    const body = { name: "p", repoPath: "/r" };
    const a = await client.projects.create(body, { idempotencyKey: "k-1" });
    const b = await client.projects.create(body, { idempotencyKey: "k-1" });
    expect(b).toEqual(a);
    expect(server.state.projects.size).toBe(1);
    expect(server.requests.at(-1)!.headers[IDEMPOTENCY_HEADER]).toBe("k-1");
  });

  it("uses idempotencyKeyFactory when no key is passed", async () => {
    let n = 0;
    const c = createMimirClient({
      baseUrl: server.url,
      token: server.token,
      idempotencyKeyFactory: () => `key-${++n}`,
    });
    await c.projects.create({ name: "p", repoPath: "/r" });
    await c.projects.create({ name: "p", repoPath: "/r" });
    expect(server.requests.map((r) => r.headers[IDEMPOTENCY_HEADER])).toEqual(["key-1", "key-2"]);
    expect(server.state.projects.size).toBe(2);
  });

  it("generates a fresh key per mutation by default", async () => {
    await client.projects.create({ name: "p", repoPath: "/r" });
    await client.projects.create({ name: "p", repoPath: "/r" });
    const keys = server.requests.map((r) => r.headers[IDEMPOTENCY_HEADER]);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toMatch(UUID);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("errors", () => {
  const expectMimirError = async (p: Promise<unknown>, code: string, status: number) => {
    const err: unknown = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MimirError);
    expect(err).toMatchObject({ code, status });
    return err as MimirError;
  };

  it("maps the server's error body to MimirError with its code", async () => {
    await expectMimirError(client.missions.get(newId("msn")), "not_found", 404);
    const { mission } = await seedMission();
    await client.missions.start(mission.id);
    await expectMimirError(client.missions.start(mission.id), "invalid_transition", 409);
    const bad = client.missions.create({ projectId: "nope", objective: "" } as never);
    const err = await expectMimirError(bad, "validation_failed", 422);
    expect(err.details).toMatchObject({ issues: expect.any(Array) });
    await client.projects.create({ name: "x", repoPath: "/r" }, { idempotencyKey: "same" });
    await expectMimirError(
      client.projects.create({ name: "y", repoPath: "/r" }, { idempotencyKey: "same" }),
      "idempotency_replay_mismatch",
      409,
    );
  });

  it("rejects a bad token with unauthorized", async () => {
    const c = createMimirClient({ baseUrl: server.url, token: "wrong" });
    await expectMimirError(c.projects.list(), "unauthorized", 401);
    expect(await c.health()).toEqual({ status: "ok" });
  });

  it("accepts a trailing slash in baseUrl and a token provider function", async () => {
    const c = createMimirClient({ baseUrl: `${server.url}/`, token: async () => server.token });
    expect(await c.projects.list()).toEqual({ projects: [] });
  });

  it("turns non-JSON errors into internal with the HTTP status in details", async () => {
    const c = createMimirClient({
      baseUrl: "http://mimir.invalid",
      token: "t",
      fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    const err = await expectMimirError(c.capabilities(), "internal", 500);
    expect(err.details).toMatchObject({ status: 502 });
  });

  it("rejects a response that does not match the protocol schema", async () => {
    const c = createMimirClient({
      baseUrl: "http://mimir.invalid",
      token: "t",
      fetch: async () => Response.json({ projects: [{ id: "nope" }] }),
    });
    const err = await expectMimirError(c.projects.list(), "validation_failed", 422);
    expect(err.message).toMatch(/response/i);
  });
});

describe("inspection and scheduling controls", () => {
  it("pauses scheduling idempotently, rejects stale versions and preserves live sessions", async () => {
    const { mission } = await seedMission();
    const { crew } = await client.crews.create({
      missionId: mission.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const agent = server.seedAgent({ crewId: crew.id });
    const paused = await client.crews.pause(
      crew.id,
      { expectedVersion: crew.version },
      { idempotencyKey: "pause-once" },
    );
    expect(paused.crew.schedulingPaused).toBe(true);
    expect(
      await client.crews.pause(
        crew.id,
        { expectedVersion: crew.version },
        { idempotencyKey: "pause-once" },
      ),
    ).toEqual(paused);
    expect(server.state.agents.get(agent.id)?.status).toBe("running");
    await expect(
      client.crews.resume(crew.id, { expectedVersion: crew.version }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await client.crews.resume(crew.id, { expectedVersion: paused.crew.version })).crew
        .schedulingPaused,
    ).toBe(false);
    await client.missions.cancel(mission.id);
    await expect(client.crews.pause(crew.id)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("returns task evidence and keeps fixture verification separate from acceptance", async () => {
    const { mission } = await seedMission();
    const task = server.seedTask({ missionId: mission.id, status: "completed" });
    await expect(
      client.tasks.verify(task.id, { expectedVersion: task.version + 1 }),
    ).rejects.toMatchObject({ code: "conflict" });
    const result = await client.tasks.verify(task.id);
    expect(result.passed).toBe(false);
    const detail = await client.tasks.get(task.id);
    expect(detail.task.status).toBe("completed");
    expect(detail.artifacts.map((a) => a.id)).toContain(result.artifactId);
    expect(
      new TextDecoder().decode(
        (
          await client.artifacts.content(
            result.artifactId as Parameters<typeof client.artifacts.content>[0],
          )
        ).bytes,
      ),
    ).toContain("Fake server does not execute verification");
    const active = server.seedTask({ missionId: mission.id, status: "running" });
    await expect(client.tasks.verify(active.id)).rejects.toMatchObject({
      code: "invalid_transition",
    });
    await expect(client.tasks.get(newId("tsk"))).rejects.toMatchObject({ code: "not_found" });
    await expect(client.sessions.get(newId("ses"))).rejects.toMatchObject({ code: "not_found" });
  });
});
