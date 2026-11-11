import { randomUUID } from "node:crypto";
import type { AppendInput } from "@mimir/core";
import { FakeRuntime } from "@mimir/fake-runtime";
import { ApiErrorBodySchema, newId, type RuntimeAdapter } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIT_UNCLASSIFIED,
  RecordingRuntime,
  createTask,
  harness,
  setupMission,
  type Json,
} from "../../test/orchestration-support.js";
import type { BuildServerOptions } from "../index.js";
import { AUTH, eventInput, makeServer, tempGitRepo, type TestServer } from "../test-helpers.js";

const servers: TestServer[] = [];
let repo: ReturnType<typeof tempGitRepo>;
beforeEach(() => {
  repo = tempGitRepo();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  repo.cleanup();
});
const serve = (overrides: Partial<BuildServerOptions> = {}) => {
  const s = makeServer(overrides);
  servers.push(s);
  return s;
};

type Res = { status: number; json: Json };
const send = async (
  s: TestServer,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<Res> => {
  const res = await s.app.inject({
    method,
    url,
    headers: method === "POST" ? { ...AUTH, "idempotency-key": randomUUID() } : AUTH,
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json() as Json };
};
const get = (s: TestServer, url: string) => send(s, "GET", url);
const post = (s: TestServer, url: string, body?: unknown) => send(s, "POST", url, body);
const errorCode = (r: Res) => ApiErrorBodySchema.parse(r.json).error.code;

const at = (iso: string) => ({ occurredAt: iso, observedAt: iso });
/** Appends an event; ids are plain strings here (the store validates them at runtime). */
const append = (s: TestServer, input: Record<string, unknown>) =>
  s.store.append(eventInput(input as Partial<AppendInput>));

/** Project, mission (optionally with a budget), shell crew and one task, via the API. */
async function world(s: TestServer, budget?: Record<string, unknown>) {
  const project = (await post(s, "/v1/projects", { name: "p", repoPath: repo.repo })).json.project;
  const mission = (
    await post(s, "/v1/missions", {
      projectId: project.id,
      objective: "o",
      ...(budget ? { budget } : {}),
    })
  ).json.mission;
  const crew = (
    await post(s, "/v1/crews", {
      missionId: mission.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "shell" }],
    })
  ).json.crew;
  const task = (
    await post(s, "/v1/tasks", { missionId: mission.id, crewId: crew.id, title: "t", brief: "b" })
  ).json.task;
  return {
    projectId: project.id as string,
    missionId: mission.id as string,
    crewId: crew.id as string,
    taskId: task.id as string,
  };
}

/** A session for `taskId` in the read model (and an agent, once the task starts on it). */
function seedSession(
  s: TestServer,
  w: { missionId: string; crewId: string; taskId: string },
  opts: { iso?: string; start?: boolean } = {},
): { sessionId: string; agentId: string } {
  const sessionId = newId("ses");
  const agentId = newId("agt");
  const iso = opts.iso ?? new Date().toISOString();
  append(s, {
    ...at(iso),
    type: "session.requested",
    streamId: `session:${sessionId}`,
    sessionId,
    missionId: w.missionId,
    taskId: w.taskId,
    payload: { agentKind: "shell", crewId: w.crewId, taskId: w.taskId, workspaceLabel: "w" },
  });
  if (opts.start) {
    append(s, {
      ...at(iso),
      type: "task.started",
      streamId: `task:${w.taskId}`,
      missionId: w.missionId,
      taskId: w.taskId,
      payload: { from: "leased", to: "running", agentId, sessionId },
    });
  }
  return { sessionId, agentId };
}

describe("sessions routes", () => {
  it("GET /v1/sessions/:id: 404 unknown; persisted view without a runtime session", async () => {
    const s = serve({ runtime: null });
    const w = await world(s);
    expect(errorCode(await get(s, `/v1/sessions/${newId("ses")}`))).toBe("not_found");
    expect((await get(s, "/v1/sessions/not-an-id")).status).toBe(422);
    const { sessionId } = seedSession(s, w);
    const res = await get(s, `/v1/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      session: null,
      available: false,
      observedAt: null,
      persisted: { id: sessionId, taskId: w.taskId, state: "requested" },
    });
  });

  it("GET /v1/sessions/:id reports the runtime's live session when it has one", async () => {
    const fake = new FakeRuntime();
    const s = serve({ runtime: fake });
    const w = await world(s);
    const { sessionId } = seedSession(s, w);
    await fake.createSession({
      sessionId,
      idempotencyKey: "k",
      crewId: w.crewId,
      taskId: w.taskId,
      agentKind: "shell",
      argv: ["true"],
      cwd: repo.repo,
      env: {},
      workspaceLabel: "w",
    } as Parameters<FakeRuntime["createSession"]>[0]);
    const res = await get(s, `/v1/sessions/${sessionId}`);
    expect(res.json).toMatchObject({ available: true, session: { sessionId } });
    expect(typeof res.json["observedAt"]).toBe("string");
  });

  it("input and stop: 404 for an unknown session; force stop needs an approval", async () => {
    const s = serve();
    const w = await world(s);
    const unknown = newId("ses");
    expect(errorCode(await post(s, `/v1/sessions/${unknown}/input`, { text: "hi" }))).toBe(
      "not_found",
    );
    expect(errorCode(await post(s, `/v1/sessions/${unknown}/stop`, { mode: "soft" }))).toBe(
      "not_found",
    );
    const { sessionId } = seedSession(s, w);
    const force = await post(s, `/v1/sessions/${sessionId}/stop`, { mode: "force" });
    expect(force.status).toBe(403);
    expect(force.json).toMatchObject({
      error: {
        code: "policy_denied",
        details: { action: "runtime.force_stop", approvalId: expect.stringMatching(/^apr_/) },
      },
    });
    expect(s.app.mimir.readModel.approvals.get(force.json.error.details.approvalId)).toMatchObject({
      action: "runtime.force_stop",
      status: "pending",
    });
  });

  it("force stop under a deny policy is refused with the policy's reason", async () => {
    const s = serve({
      policies: [{ id: "test#no-force", action: "runtime.force_stop", effect: "deny" }],
    });
    const w = await world(s);
    const { sessionId } = seedSession(s, w);
    const res = await post(s, `/v1/sessions/${sessionId}/stop`, { mode: "force" });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({
      error: { code: "policy_denied", details: { action: "runtime.force_stop" } },
    });
    expect(res.json.error.details.approvalId).toBeUndefined();
    expect(s.app.mimir.readModel.approvals.size).toBe(0);
  });

  it("terminal: 503 without a runtime, 501 when the runtime cannot read terminals", async () => {
    const none = serve({ runtime: null });
    const w1 = await world(none);
    const { sessionId: s1 } = seedSession(none, w1);
    const noRuntime = await get(none, `/v1/sessions/${s1}/terminal`);
    expect(errorCode(noRuntime)).toBe("runtime_unavailable");

    repo.cleanup();
    repo = tempGitRepo();
    const blind: RuntimeAdapter = new RecordingRuntime(new FakeRuntime());
    const s = serve({ runtime: blind });
    const w2 = await world(s);
    const { sessionId: s2 } = seedSession(s, w2);
    const res = await get(s, `/v1/sessions/${s2}/terminal?lines=10`);
    expect(errorCode(res)).toBe("capability_unavailable");
    expect(res.json.error.details).toEqual({ feature: "terminalRead" });
    expect((await get(s, `/v1/sessions/${s2}/terminal?lines=0`)).status).toBe(422);
    expect((await get(s, `/v1/sessions/${newId("ses")}/terminal`)).status).toBe(404);
  });
});

describe("tasks routes", () => {
  it("GET /v1/tasks/:id lists the task's dependencies, sessions, worktrees, artifacts, approvals", async () => {
    const s = serve();
    const w = await world(s);
    const second = (
      await post(s, "/v1/tasks", {
        missionId: w.missionId,
        crewId: w.crewId,
        title: "t2",
        brief: "b",
        dependsOn: [w.taskId],
      })
    ).json.task;
    const { sessionId } = seedSession(s, { ...w, taskId: second.id });
    const worktreeId = newId("wtr");
    append(s, {
      type: "git.worktree_created",
      streamId: `task:${second.id}`,
      taskId: second.id,
      missionId: w.missionId,
      payload: { worktreeId, path: "/tmp/wt", branch: "mimir/x", baseSha: "a".repeat(40) },
    });
    const artifactId = newId("art");
    append(s, {
      type: "artifact.recorded",
      streamId: `task:${second.id}`,
      taskId: second.id,
      payload: { artifactId, taskId: second.id, kind: "log", uri: "file:///x", hash: "sha256:0" },
    });
    const approvalId = newId("apr");
    append(s, {
      type: "approval.requested",
      streamId: `approval:${approvalId}`,
      taskId: second.id,
      missionId: w.missionId,
      payload: { approvalId, action: "pr.create", expiry: null },
    });
    const res = await get(s, `/v1/tasks/${second.id}`);
    expect(res.status).toBe(200);
    expect(res.json["dependencies"]).toEqual([
      expect.objectContaining({ taskId: second.id, dependsOnId: w.taskId }),
    ]);
    expect(res.json["sessions"].map((x: { id: string }) => x.id)).toEqual([sessionId]);
    expect(res.json["worktrees"].map((x: { id: string }) => x.id)).toEqual([worktreeId]);
    expect(res.json["artifacts"].map((x: { id: string }) => x.id)).toEqual([artifactId]);
    expect(res.json["approvals"].map((x: { id: string }) => x.id)).toEqual([approvalId]);
    // The first task has none of them.
    const first = await get(s, `/v1/tasks/${w.taskId}`);
    expect(first.json).toMatchObject({
      dependencies: [],
      sessions: [],
      worktrees: [],
      artifacts: [],
      approvals: [],
    });
    expect(errorCode(await get(s, `/v1/tasks/${newId("tsk")}`))).toBe("not_found");
  });

  it("GET /v1/tasks filters by mission, crew and status", async () => {
    const s = serve();
    const w = await world(s);
    const ids = async (q: string) =>
      (await get(s, `/v1/tasks${q}`)).json["tasks"].map((t: { id: string }) => t.id);
    expect(await ids(`?crewId=${w.crewId}`)).toEqual([w.taskId]);
    expect(await ids(`?crewId=${newId("crw")}`)).toEqual([]);
    expect(await ids(`?status=pending&missionId=${w.missionId}`)).toEqual([w.taskId]);
    expect(await ids(`?status=running`)).toEqual([]);
  });

  it("refuses new tasks on a terminal mission and stale expectedVersion on retry/verify", async () => {
    const s = serve();
    const w = await world(s);
    const retry = await post(s, `/v1/tasks/${w.taskId}/retry`, { expectedVersion: 99 });
    expect(retry.status).toBe(409);
    expect(retry.json.error.details).toEqual({ expectedVersion: 99, version: 0 });
    expect(errorCode(await post(s, `/v1/tasks/${w.taskId}/verify`, { expectedVersion: 99 }))).toBe(
      "conflict",
    );
    expect(errorCode(await post(s, `/v1/tasks/${newId("tsk")}/verify`, {}))).toBe("not_found");
    expect(errorCode(await post(s, `/v1/tasks/${newId("tsk")}/pr`, {}))).toBe("not_found");
    expect((await post(s, `/v1/missions/${w.missionId}/cancel`, {})).status).toBe(202);
    const late = await post(s, "/v1/tasks", { missionId: w.missionId, title: "late", brief: "b" });
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({
      error: { code: "invalid_transition", details: { status: "cancelled" } },
    });
  });
});

describe("usage and attention", () => {
  it("usage filters by agent, crew, mission and project and flags unmeasured samples", async () => {
    const s = serve();
    const w = await world(s);
    const { agentId } = seedSession(s, w, { start: true });
    const sample = (agent: string, tokens: number | null, cost: number | null) => {
      const id = newId("usg");
      const iso = new Date().toISOString();
      append(s, {
        type: "usage.recorded",
        streamId: `usage:${id}`,
        payload: {
          sample: {
            id,
            agentId: agent,
            tokens,
            estimatedCost: cost,
            source: "measured",
            createdAt: iso,
            updatedAt: iso,
            version: 0,
          },
        },
      });
      return id;
    };
    const mine = sample(agentId, 10, null);
    const stray = sample(newId("agt"), 5, 0.5);
    const usage = async (q: string) => (await get(s, `/v1/usage${q}`)).json;
    const ids = async (q: string) => (await usage(q))["samples"].map((x: { id: string }) => x.id);
    expect(await ids("")).toEqual([mine, stray]);
    expect(await ids(`?agentId=${agentId}`)).toEqual([mine]);
    expect(await ids(`?crewId=${w.crewId}`)).toEqual([mine]);
    expect(await ids(`?missionId=${w.missionId}`)).toEqual([mine]);
    expect(await ids(`?projectId=${w.projectId}`)).toEqual([mine]);
    expect(await ids(`?projectId=${newId("prj")}`)).toEqual([]);
    // A measured sample without a cost still makes the totals a lower bound.
    expect(await usage(`?agentId=${agentId}`)).toMatchObject({
      totals: { tokens: 10, estimatedCost: 0, samples: 1 },
      uncertain: true,
    });
    const strayOnly = await usage(
      `?agentId=${(await get(s, "/v1/usage")).json["samples"][1].agentId}`,
    );
    expect(strayOnly).toMatchObject({
      totals: { tokens: 5, estimatedCost: 0.5 },
      uncertain: false,
    });
    const nullTokens = sample(agentId, null, 1);
    expect(
      (await usage(`?agentId=${agentId}`))["samples"].map((x: { id: string }) => x.id),
    ).toEqual([mine, nullTokens]);
  });

  it("attention lists only pending approvals, long blocks, stuck live sessions and hit budgets", async () => {
    const s = serve({ attention: { blockedMs: 60_000, stuckMs: 60_000 } });
    const w = await world(s, { limitTokens: 1000, onUnknown: "allow" });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const decided = newId("apr");
    const pending = newId("apr");
    for (const approvalId of [decided, pending]) {
      append(s, {
        ...at(old),
        type: "approval.requested",
        streamId: `approval:${approvalId}`,
        payload: { approvalId, action: "pr.create", expiry: null },
      });
    }
    append(s, {
      type: "approval.decided",
      streamId: `approval:${decided}`,
      payload: { approvalId: decided, decision: "rejected", actor: "operator" },
    });
    // A long-blocked task (with reason), and a stuck running session next to a finished one.
    append(s, {
      ...at(old),
      type: "task.blocked",
      streamId: `task:${w.taskId}`,
      taskId: w.taskId,
      missionId: w.missionId,
      payload: { from: "pending", to: "blocked", reason: "waiting on review" },
    });
    const stuck = seedSession(s, w, { iso: old });
    append(s, {
      ...at(old),
      type: "session.state_changed",
      streamId: `session:${stuck.sessionId}`,
      sessionId: stuck.sessionId,
      payload: { from: "requested", to: "running" },
    });
    const done = seedSession(s, w, { iso: old });
    append(s, {
      ...at(old),
      type: "session.state_changed",
      streamId: `session:${done.sessionId}`,
      sessionId: done.sessionId,
      payload: { from: "running", to: "completed" },
    });
    seedSession(s, w); // requested just now: not stuck, not live
    const items = (await get(s, "/v1/attention")).json["items"] as { kind: string }[];
    expect(items.map((i) => i.kind).sort()).toEqual([
      "approval_pending",
      "blocked_too_long",
      "stuck",
    ]);
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "approval_pending", approvalId: pending }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "blocked_too_long",
        taskId: w.taskId,
        reason: "waiting on review",
      }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "stuck", sessionId: stuck.sessionId }),
    );
  });
});

describe("crews routes", () => {
  it("pause/resume: 404 unknown crew, 409 terminal mission or stale version, no-op when unchanged", async () => {
    const s = serve();
    const w = await world(s);
    expect(errorCode(await post(s, `/v1/crews/${newId("crw")}/pause`, {}))).toBe("not_found");
    expect(errorCode(await post(s, `/v1/crews/${w.crewId}/pause`, { expectedVersion: 7 }))).toBe(
      "conflict",
    );
    // Resuming a crew that is not paused appends nothing.
    const before = s.store.read({ limit: 100, types: ["crew.scheduling_changed"] }).events.length;
    const resumed = await post(s, `/v1/crews/${w.crewId}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.json["crew"]).toMatchObject({ id: w.crewId, version: 0 });
    expect(s.store.read({ limit: 100, types: ["crew.scheduling_changed"] }).events).toHaveLength(
      before,
    );
    const paused = await post(s, `/v1/crews/${w.crewId}/pause`, { expectedVersion: 0 });
    expect(paused.json["crew"]).toMatchObject({ schedulingPaused: true, version: 1 });
    await post(s, `/v1/missions/${w.missionId}/cancel`, {});
    expect(errorCode(await post(s, `/v1/crews/${w.crewId}/resume`))).toBe("invalid_transition");
    const late = await post(s, "/v1/crews", {
      missionId: w.missionId,
      template: "solo",
      members: [{ role: "implementer", agentKind: "shell" }],
    });
    expect(errorCode(late)).toBe("invalid_transition");
  });
});

describe("artifact content over a real socket", () => {
  // Regression: the content is streamed, so the client has the whole (content-length) body
  // before the server ends the response; a close() in that window missed the socket and waited
  // for the 72 s keep-alive timeout.
  it("is served intact and close() right after does not hang", async () => {
    const s = serve();
    const content = "x".repeat(300_000);
    const stored = s.app.mimir.artifacts.write(content);
    append(s, {
      type: "artifact.recorded",
      streamId: "artifacts",
      payload: {
        artifactId: stored.id,
        taskId: newId("tsk"),
        kind: "log",
        uri: stored.uri,
        hash: stored.hash,
        bytes: stored.bytes,
      },
    });
    await s.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = s.app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${stored.id}/content`, {
      headers: AUTH,
    });
    expect(res.headers.get("x-artifact-hash")).toBe(stored.hash);
    expect(await res.text()).toBe(content);
    await s.app.close();
    expect(s.app.server.listening).toBe(false);
  });
});

describe("tasks routes on a settled task", () => {
  it("bodyless retry/verify/pr are parsed as empty; a pr.create deny policy refuses delivery", async () => {
    const h = await harness();
    try {
      const { missionId, projectId } = await setupMission(h);
      await h.restart({
        policies: [
          ADMIT_UNCLASSIFIED,
          { id: "test#no-pr", action: "pr.create", effect: "deny", scope: { projectId } },
        ],
      });
      const t = await createTask(h, missionId, "T", "echo t");
      await h.post(`/v1/missions/${missionId}/start`);
      for (let i = 0; i < 10 && h.task(t).status !== "completed"; i++) {
        await h.tick();
        await h.advance(1000);
      }
      expect(h.task(t).status).toBe("completed");
      const bare = (url: string) =>
        h.app.inject({
          method: "POST",
          url,
          headers: { ...AUTH, "idempotency-key": h.key() },
        });
      const pr = await bare(`/v1/tasks/${t}/pr`);
      expect(pr.statusCode).toBe(403);
      expect(pr.json()).toMatchObject({
        error: { code: "policy_denied", details: { action: "pr.create" } },
      });
      expect(h.events(["approval.requested"])).toEqual([]);
      // A completed task cannot be retried; the body-less request still reaches that check.
      expect((await bare(`/v1/tasks/${t}/retry`)).statusCode).toBe(409);
      const verify = await bare(`/v1/tasks/${t}/verify`);
      expect(verify.statusCode).toBe(200);
      expect(verify.json()).toMatchObject({ passed: true });
    } finally {
      await h.close();
    }
  }, 180_000);

  it("a task whose mission the model does not know is served with mission null", async () => {
    const s = serve();
    const taskId = newId("tsk");
    append(s, {
      type: "task.created",
      streamId: `task:${taskId}`,
      taskId,
      payload: {
        missionId: newId("msn"),
        crewId: null,
        title: "orphan",
        acceptance: "",
        dependsOn: [],
      },
    });
    const res = await get(s, `/v1/tasks/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ task: { id: taskId }, mission: null });
  });
});
