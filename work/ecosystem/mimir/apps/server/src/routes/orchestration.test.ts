import {
  CreateCrewResponseSchema,
  CreateMissionResponseSchema,
  CreateTaskResponseSchema,
  GetArtifactResponseSchema,
  GetMissionResponseSchema,
  ListApprovalsResponseSchema,
  ListCrewsResponseSchema,
  ListMissionsResponseSchema,
  ListTasksResponseSchema,
  OperationAcceptedSchema,
  RequestPrResponseSchema,
  SnapshotResponseSchema,
  UsageResponseSchema,
  newId,
  type RuntimeAdapter,
  type RuntimeEvent,
} from "@mimir/protocol";
import type { FakeRuntime } from "@mimir/fake-runtime";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTask,
  harness,
  setupMission,
  type Harness,
  type HarnessOptions,
} from "../orchestrator/test-harness.js";

// Integration tests: real git worktrees, npm verification and server boots (slow on a busy host).
vi.setConfig({ testTimeout: 120_000 });

const harnesses: Harness[] = [];
const track = async (opts?: HarnessOptions) => {
  const h = await harness(opts);
  harnesses.push(h);
  return h;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const LONG_RUNNING = [{ afterMs: 100, state: "running" as const }];

/** The fake plus a handle to push runtime events it cannot produce (runtimeStatus, terminal). */
function withInjector(fake: FakeRuntime) {
  const handlers: ((e: RuntimeEvent) => void)[] = [];
  const runtime: RuntimeAdapter & {
    inject(e: RuntimeEvent): void;
    readTerminal(id: string, lines?: number): Promise<string>;
  } = {
    capabilities: () => fake.capabilities(),
    health: () => fake.health(),
    createSession: (spec) => fake.createSession(spec),
    listSessions: () => fake.listSessions(),
    getSession: (id) => fake.getSession(id),
    sendInput: (id, input) => fake.sendInput(id, input),
    requestStop: (id, mode) => fake.requestStop(id, mode),
    reconcile: () => fake.reconcile(),
    dispose: () => fake.dispose(),
    async subscribe(handler) {
      handlers.push(handler);
      return fake.subscribe(handler);
    },
    inject(e) {
      for (const h of handlers) h(e);
    },
    readTerminal: (id, lines) =>
      Promise.resolve(
        `$ echo hi (${id}, ${lines ?? 200} lines)\nAPI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n`,
      ),
  };
  return runtime;
}

describe("protocol contract", () => {
  it("every response parses with its @mimir/protocol schema", async () => {
    const h = await track();
    const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
    const m = await h.post("/v1/missions", {
      projectId: p.json.project.id,
      objective: "o",
      tasks: [{ title: "A", brief: "echo a" }],
    });
    CreateMissionResponseSchema.parse(m.json);
    const missionId = m.json.mission.id as string;
    CreateCrewResponseSchema.parse(
      (
        await h.post("/v1/crews", {
          missionId,
          template: "solo",
          members: [{ role: "implementer", agentKind: "shell" }],
        })
      ).json,
    );
    CreateTaskResponseSchema.parse(
      (await h.post("/v1/tasks", { missionId, title: "B", brief: "echo b" })).json,
    );
    OperationAcceptedSchema.parse((await h.post(`/v1/missions/${missionId}/start`)).json);
    await h.tick();
    await h.advance(1000);
    ListMissionsResponseSchema.parse((await h.get("/v1/missions")).json);
    GetMissionResponseSchema.parse((await h.get(`/v1/missions/${missionId}`)).json);
    ListCrewsResponseSchema.parse((await h.get("/v1/crews")).json);
    ListTasksResponseSchema.parse((await h.get("/v1/tasks")).json);
    ListApprovalsResponseSchema.parse((await h.get("/v1/approvals")).json);
    UsageResponseSchema.parse((await h.get("/v1/usage")).json);
    SnapshotResponseSchema.parse((await h.get("/v1/snapshot")).json);
    const artifact = h.events(["artifact.recorded"])[0]!.payload as { artifactId: string };
    GetArtifactResponseSchema.parse((await h.get(`/v1/artifacts/${artifact.artifactId}`)).json);
  }, 120_000);
});

describe("missions", () => {
  it("creates a mission with its task DAG in one call", async () => {
    const h = await track();
    const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
    const a = newId("tsk");
    const res = await h.post("/v1/missions", {
      projectId: p.json.project.id,
      objective: "o",
      tasks: [
        { id: a, title: "A", brief: "echo a" },
        { title: "B", brief: "echo b", dependsOn: [a], acceptanceCriteria: ["b1", "b2"] },
        { title: "C", brief: "rm", argv: ["sh", "-c", "rm -rf build"] },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json.tasks.map((t: { title: string }) => t.title)).toEqual(["A", "B", "C"]);
    expect(res.json.tasks[0].id).toBe(a);
    expect(res.json.tasks[1]).toMatchObject({ acceptance: "b1\nb2", status: "pending" });
    const deps = (await h.get("/v1/snapshot")).json.taskDependencies;
    expect(deps).toEqual([
      expect.objectContaining({ taskId: res.json.tasks[1].id, dependsOnId: a }),
    ]);
    expect(h.app.mimir.readModel.taskSpec(res.json.tasks[2].id)).toEqual({
      brief: "rm",
      argv: ["sh", "-c", "rm -rf build"],
    });
  });

  it("rejects bad task DAGs atomically", async () => {
    const h = await track();
    const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
    const a = newId("tsk");
    const b = newId("tsk");
    const base = { projectId: p.json.project.id, objective: "o" };
    const cycle = await h.post("/v1/missions", {
      ...base,
      tasks: [
        { id: a, title: "A", brief: "x", dependsOn: [b] },
        { id: b, title: "B", brief: "x", dependsOn: [a] },
      ],
    });
    expect(cycle.status).toBe(422);
    expect(cycle.json.error.details).toMatchObject({ reason: "cycle" });
    const unknown = await h.post("/v1/missions", {
      ...base,
      tasks: [{ title: "A", brief: "x", dependsOn: [newId("tsk")] }],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.json.error.details).toMatchObject({ reason: "unknown_dependency" });
    const crew = await h.post("/v1/missions", {
      ...base,
      tasks: [{ title: "A", brief: "x", crewId: newId("crw") }],
    });
    expect(crew.status).toBe(422);
    const dup = await h.post("/v1/missions", {
      ...base,
      tasks: [
        { id: a, title: "A", brief: "x" },
        { id: a, title: "A2", brief: "x" },
      ],
    });
    expect(dup.status).toBe(409);
    // nothing was written by the failed requests
    expect(h.events(["mission.created", "task.created"])).toEqual([]);
    const noProject = await h.post("/v1/missions", { projectId: newId("prj"), objective: "o" });
    expect(noProject.status).toBe(422);
  });

  it("lists, gets, pauses, resumes and checks expectedVersion", async () => {
    const h = await track();
    const { missionId, projectId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    expect((await h.get(`/v1/missions?projectId=${projectId}`)).json.missions).toHaveLength(1);
    expect((await h.get(`/v1/missions?status=active`)).json.missions).toHaveLength(0);
    expect((await h.get(`/v1/missions/${newId("msn")}`)).status).toBe(404);
    const stale = await h.post(`/v1/missions/${missionId}/start`, { expectedVersion: 7 });
    expect(stale.status).toBe(409);
    expect((await h.post(`/v1/missions/${missionId}/start`, { expectedVersion: 0 })).status).toBe(
      202,
    );
    const paused = await h.post(`/v1/missions/${missionId}/pause`);
    expect(paused.json).toMatchObject({ mission: { status: "paused" } });
    await h.tick();
    expect(h.task(t).status).toBe("pending"); // paused missions do not dispatch
    expect((await h.post(`/v1/missions/${missionId}/resume`)).json.mission.status).toBe("active");
    await h.tick();
    expect(h.task(t).status).toBe("running");
    const again = await h.post(`/v1/missions/${missionId}/start`);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("invalid_transition");
  }, 120_000);

  it("cancel cancels unfinished tasks and stops their sessions", async () => {
    const h = await track({ script: LONG_RUNNING });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    const later = await createTask(h, missionId, "L", "echo l", [t]);
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    const res = await h.post(`/v1/missions/${missionId}/cancel`, { reason: "changed plans" });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ mission: { status: "cancelled" } });
    expect([h.task(t).status, h.task(later).status]).toEqual(["cancelled", "cancelled"]);
    await h.advance(100);
    const sessionId = h.events(["session.requested"])[0]!.sessionId!;
    expect(h.app.mimir.readModel.sessions.get(sessionId)?.state).toBe("stopped");
    expect(h.task(t).status).toBe("cancelled");
  }, 120_000);
});

describe("crews and tasks", () => {
  it("validates crews and lists them by mission", async () => {
    const h = await track();
    const { missionId } = await setupMission(h);
    const bad = await h.post("/v1/crews", {
      missionId,
      template: "x",
      members: [{ role: "implementer", agentKind: "unsupported-agent" }],
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.issues[0].path).toEqual(["members", 0, "agentKind"]);
    const noMission = await h.post("/v1/crews", {
      missionId: newId("msn"),
      template: "x",
      members: [{ role: "lead", agentKind: "claude" }],
    });
    expect(noMission.status).toBe(422);
    const ok = await h.post("/v1/crews", {
      missionId,
      template: "review pair",
      members: [
        { role: "implementer", agentKind: "claude", name: "builder" },
        { role: "reviewer", agentKind: "codex" },
      ],
      budget: { limitTokens: 1000, onUnknown: "allow" },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.members.map((m: { name: string }) => m.name)).toEqual(["builder", "reviewer-2"]);
    expect((await h.get(`/v1/crews?missionId=${missionId}`)).json.crews).toHaveLength(2);
    expect([...h.app.mimir.readModel.budgets.values()]).toEqual([
      expect.objectContaining({ crewId: ok.json.crew.id, missionId, limitTokens: 1000 }),
    ]);
  });

  it("POST /v1/tasks validates the mission, crew and dependencies; GET filters", async () => {
    const h = await track();
    const { missionId, crewId } = await setupMission(h);
    const a = await createTask(h, missionId, "A", "echo a");
    const pinned = await h.post("/v1/tasks", {
      missionId,
      crewId,
      title: "P",
      brief: "echo p",
      dependsOn: [a],
    });
    expect(pinned.status).toBe(201);
    expect(pinned.json.task).toMatchObject({ crewId, status: "pending" });
    expect(
      (await h.post("/v1/tasks", { missionId: newId("msn"), title: "x", brief: "x" })).status,
    ).toBe(422);
    expect(
      (await h.post("/v1/tasks", { missionId, title: "x", brief: "x", crewId: newId("crw") }))
        .status,
    ).toBe(422);
    expect((await h.get(`/v1/tasks?missionId=${missionId}`)).json.tasks).toHaveLength(2);
    expect((await h.get(`/v1/tasks?crewId=${crewId}`)).json.tasks).toHaveLength(1);
    expect((await h.get(`/v1/tasks?status=running`)).json.tasks).toHaveLength(0);
    const retry = await h.post(`/v1/tasks/${a}/retry`);
    expect(retry.status).toBe(409); // pending tasks cannot be retried
  });
});

describe("approvals", () => {
  it("exactly one of two decisions on the same approval wins", async () => {
    const h = await track({
      policies: [{ id: "t#1", action: "shell.destructive", effect: "require_approval" }],
    });
    const { missionId } = await setupMission(h);
    await createTask(h, missionId, "C", "rm -rf build");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    const [approval] = (await h.get("/v1/approvals?status=pending")).json.approvals;
    const [x, y] = await Promise.all([
      h.post(`/v1/approvals/${approval.id}/decision`, { decision: "approved" }),
      h.post(`/v1/approvals/${approval.id}/decision`, { decision: "rejected" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    expect(
      (await h.post(`/v1/approvals/${newId("apr")}/decision`, { decision: "approved" })).status,
    ).toBe(404);
  });

  it("approvals expire; an expired dispatch approval denies the task", async () => {
    const h = await track({
      policies: [{ id: "t#1", action: "shell.destructive", effect: "require_approval" }],
      overrides: { approvalTtlMs: 1000 },
    });
    const { missionId } = await setupMission(h);
    const c = await createTask(h, missionId, "C", "rm -rf build");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1500);
    await h.tick();
    expect(h.events(["approval.expired"])).toHaveLength(1);
    expect(h.task(c)).toMatchObject({ status: "blocked", blockedReason: "policy_denied" });
  });

  it("a trust prompt asks for approval and only sends the accept keys once approved", async () => {
    let rt!: ReturnType<typeof withInjector>;
    // the fake reports `blocked`; the injector adds the runtimeStatus HerdR derives for trust dialogs
    const h = await track({
      script: [{ afterMs: 100, state: "blocked" }],
      wrapRuntime: (f) => (rt = withInjector(f)),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    const sessionId = h.events(["session.requested"])[0]!.sessionId!;
    rt.inject({
      kind: "session.state_changed",
      sessionId,
      state: "blocked",
      runtimeStatus: "blocked:trust_prompt",
      observedAt: new Date().toISOString(),
      sourceEventId: "trust-1",
    });
    await h.idle();
    expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "blocked" });
    const [approval] = (await h.get("/v1/approvals?status=pending")).json.approvals;
    expect(approval).toMatchObject({ action: "runtime.accept_trust_prompt", taskId: t });
    expect(h.fake.inputs[sessionId]).toEqual([]); // never answered automatically
    await h.post(`/v1/approvals/${approval.id}/decision`, { decision: "approved" });
    await h.idle();
    expect(h.fake.inputs[sessionId]).toEqual([{ keys: ["enter"] }]);
    expect(h.task(t).status).toBe("running"); // the fake resumes on input
    expect(h.events(["session.input"])).toEqual([
      expect.objectContaining({ sessionId, provenance: "observed" }),
    ]);
  }, 120_000);
});

describe("sessions", () => {
  it("input is sent and logged as an observed, redacted session.input", async () => {
    const h = await track({ script: LONG_RUNNING });
    const { missionId } = await setupMission(h);
    await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    const sessionId = h.events(["session.requested"])[0]!.sessionId!;
    const res = await h.post(`/v1/sessions/${sessionId}/input`, {
      text: "use token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect(res.status).toBe(202);
    expect(h.fake.inputs[sessionId]?.[0]?.text).toContain("ghp_");
    const [input] = h.events(["session.input"]);
    expect(input?.payload).toMatchObject({ redacted: true });
    expect(JSON.stringify(input?.payload)).not.toContain("ghp_abcdefghij");
    expect((await h.post(`/v1/sessions/${newId("ses")}/input`, { text: "x" })).status).toBe(404);
  }, 120_000);

  it("soft stop stops the session; the task fails and is retried later", async () => {
    const h = await track({ script: LONG_RUNNING });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    const sessionId = h.events(["session.requested"])[0]!.sessionId!;
    expect((await h.post(`/v1/sessions/${sessionId}/stop`, { mode: "soft" })).status).toBe(202);
    await h.advance(100);
    expect(h.app.mimir.readModel.sessions.get(sessionId)?.state).toBe("stopped");
    expect(h.task(t)).toMatchObject({ status: "failed" });
    await h.advance(2000); // backoff
    await h.tick(); // retry: failed → ready
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 1 });
    await h.tick(); // dispatch
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
  }, 120_000);

  it("terminal: 501 when the runtime cannot read it, otherwise redacted text marked observed", async () => {
    // a runtime without terminal reads (the fake can read terminals since fix round 1)
    const h1 = await track({
      script: LONG_RUNNING,
      wrapRuntime: (f) => {
        const rt: Partial<ReturnType<typeof withInjector>> = { ...withInjector(f) };
        delete rt.readTerminal;
        return rt as RuntimeAdapter;
      },
    });
    const m1 = await setupMission(h1);
    await createTask(h1, m1.missionId, "T", "echo t");
    await h1.post(`/v1/missions/${m1.missionId}/start`);
    await h1.tick();
    const s1 = h1.events(["session.requested"])[0]!.sessionId!;
    expect((await h1.get(`/v1/sessions/${s1}/terminal`)).status).toBe(501);

    const h2 = await track({ script: LONG_RUNNING, wrapRuntime: withInjector });
    const m2 = await setupMission(h2);
    await createTask(h2, m2.missionId, "T", "echo t");
    await h2.post(`/v1/missions/${m2.missionId}/start`);
    await h2.tick();
    const s2 = h2.events(["session.requested"])[0]!.sessionId!;
    const res = await h2.get(`/v1/sessions/${s2}/terminal?lines=50`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ sessionId: s2, lines: 50, provenance: "observed" });
    expect(res.json.text).toContain("50 lines");
    expect(res.json.text).not.toContain("sk-abcdefghij");
    expect((await h2.get(`/v1/sessions/${s2}/terminal?lines=0`)).status).toBe(422);
  }, 120_000);

  it("a runtime gap reconciles: a session lost unseen fails its task (retryable)", async () => {
    const h = await track({ script: LONG_RUNNING });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    const sessionId = h.events(["session.requested"])[0]!.sessionId!;
    h.fake.chaos({ dropNextEvents: 1 });
    h.fake.loseSession(sessionId); // the session.lost event is dropped
    expect(h.task(t).status).toBe("running");
    h.fake.chaos({ emitGap: true });
    await h.idle();
    expect(h.task(t)).toMatchObject({ status: "failed" });
    expect(h.events(["recovery.reconciled"]).at(-1)?.payload).toMatchObject({
      gap: true,
      lostSessionIds: [sessionId],
    });
  }, 120_000);
});

describe("artifacts, PR delivery, usage, budgets and attention", () => {
  it("PR needs pr.create approval; without gh/remote it records a local_delivery artifact", async () => {
    const h = await track();
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    expect((await h.post(`/v1/tasks/${t}/pr`)).status).toBe(409); // not completed yet
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");
    const res = await h.post(`/v1/tasks/${t}/pr`);
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ status: "approval_required" });
    expect(
      h
        .events(["artifact.recorded"])
        .some((e) => (e.payload as { kind: string }).kind === "local_delivery"),
    ).toBe(false);
    await h.post(`/v1/approvals/${res.json.approvalId}/decision`, { decision: "approved" });
    const delivery = h
      .events(["artifact.recorded"])
      .find((e) => (e.payload as { kind: string }).kind === "local_delivery");
    expect(delivery).toBeDefined();
    const artifactId = (delivery!.payload as { artifactId: string }).artifactId;
    const meta = await h.get(`/v1/artifacts/${artifactId}`);
    expect(meta.json).toMatchObject({
      artifact: { id: artifactId, kind: "local_delivery", taskId: t },
    });
    expect(meta.json.bytes).toBeGreaterThan(0);
    const content = await h.app.inject({
      method: "GET",
      url: `/v1/artifacts/${artifactId}/content`,
      headers: { authorization: "Bearer test-token-0123456789" },
    });
    expect(content.headers["content-type"]).toBe("application/json");
    expect(content.headers["x-artifact-hash"]).toMatch(/^sha256:/);
    const body = JSON.parse(content.body);
    expect(body.resultCommit).toBe(h.task(t).resultCommit);
    expect(body.repoPath).toBe(h.repo);
    expect(body.apply).toContain("git apply --check");
    expect((await h.get(`/v1/artifacts/${newId("art")}`)).status).toBe(404);
    // the approval was consumed by that delivery: a second request asks again (review I1)
    expect((await h.post(`/v1/tasks/${t}/pr`)).json).toMatchObject({ status: "approval_required" });
  }, 120_000);

  it("POST /v1/tasks/:id/pr answers with the protocol RequestPrResponse and rejects body fields", async () => {
    const h = await track();
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");
    expect((await h.post(`/v1/tasks/${t}/pr`, { title: "x" })).status).toBe(422);
    const pending = await h.post(`/v1/tasks/${t}/pr`, {});
    expect(RequestPrResponseSchema.parse(pending.json)).toMatchObject({
      status: "approval_required",
    });
    await h.post(`/v1/approvals/${pending.json.approvalId}/decision`, { decision: "approved" });
    // the approval was consumed by that delivery: the next request asks again
    const again = await h.post(`/v1/tasks/${t}/pr`);
    expect(RequestPrResponseSchema.parse(again.json).status).toBe("approval_required");
  });

  it("POST /v1/tasks/:id/pr answers delivered when a project policy allows pr.create", async () => {
    const h = await track();
    const { missionId, projectId } = await setupMission(h);
    // a project-scoped rule is more specific than the default require_approval
    await h.restart({
      policies: [{ id: "test#pr", action: "pr.create", effect: "allow", scope: { projectId } }],
    });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");
    const res = await h.post(`/v1/tasks/${t}/pr`);
    expect(res.status).toBe(202);
    expect(RequestPrResponseSchema.parse(res.json)).toMatchObject({ status: "delivered" });
  });

  it("usage filters by crew and project", async () => {
    const h = await track();
    const { missionId, crewId, projectId } = await setupMission(h);
    await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect((await h.get(`/v1/usage?crewId=${crewId}`)).json.totals.samples).toBe(1);
    expect((await h.get(`/v1/usage?projectId=${projectId}`)).json.totals.samples).toBe(1);
    expect((await h.get(`/v1/usage?crewId=${newId("crw")}`)).json).toMatchObject({
      totals: { samples: 0 },
      uncertain: false,
    });
  }, 120_000);

  it("an exhausted hard budget blocks dispatch with budget.exceeded once; a warning fires once", async () => {
    const h = await track();
    const { missionId } = await setupMission(h, {}, {}, { limitTokens: 0, onUnknown: "allow" });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "budget_exceeded" });
    expect(h.events(["budget.exceeded"])).toHaveLength(1);
    expect(h.events(["task.blocked"])).toHaveLength(1);

    const attention = (await h.get("/v1/attention")).json.items;
    expect(attention.map((i: { kind: string }) => i.kind)).toContain("budget_exceeded");
  }, 120_000);

  it("a budget.warning fires once when measured usage reaches warnAtFraction", async () => {
    const h = await track();
    const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
    const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
    const missionId = m.json.mission.id as string;
    await h.post("/v1/crews", {
      missionId,
      template: "solo",
      members: [{ role: "implementer", agentKind: "shell" }],
      budget: { limitTokens: 100, enforce: "soft" },
    });
    await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    const { agentId } = h.events(["task.started"])[0]!.payload as { agentId: string };
    // adapter-reported (measured) usage for the crew's agent, as an event
    const at = new Date().toISOString();
    h.store.append({
      streamId: "usage-test",
      type: "usage.recorded",
      source: "test",
      provenance: "observed",
      occurredAt: at,
      observedAt: at,
      payload: {
        sample: {
          id: newId("usg"),
          agentId,
          tokens: 85,
          estimatedCost: null,
          source: "measured",
          createdAt: at,
          updatedAt: at,
          version: 0,
        },
      },
    });
    await h.tick();
    await h.tick();
    expect(h.events(["budget.warning"])).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ unit: "tokens", used: 85, limit: 100 }),
      }),
    ]);
    const attention = (await h.get("/v1/attention")).json.items;
    expect(attention.map((i: { kind: string }) => i.kind)).toContain("budget_warning");
  }, 120_000);

  it("attention lists pending approvals and tasks blocked too long", async () => {
    const h = await track({
      policies: [{ id: "t#1", action: "shell.destructive", effect: "require_approval" }],
      overrides: { attention: { blockedMs: 1000 } },
    });
    const { missionId } = await setupMission(h);
    const c = await createTask(h, missionId, "C", "rm -rf build");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    let items = (await h.get("/v1/attention")).json.items;
    expect(items).toEqual([
      expect.objectContaining({ kind: "approval_pending", action: "shell.destructive", taskId: c }),
    ]);
    await h.advance(2000);
    items = (await h.get("/v1/attention")).json.items;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "blocked_too_long",
          taskId: c,
          reason: "approval_required",
        }),
      ]),
    );
  }, 120_000);
});

describe("GET /v1/artifacts/:id/content", () => {
  const record = (h: Harness, artifactId: string, kind: string, bytes: number) => {
    const at = new Date().toISOString();
    h.store.append({
      streamId: "artifact-test",
      type: "artifact.recorded",
      source: "test",
      provenance: "derived",
      occurredAt: at,
      observedAt: at,
      payload: {
        artifactId,
        taskId: newId("tsk"),
        kind,
        uri: `file:///x/${artifactId}`,
        hash: "sha256:00",
        bytes,
      },
    });
  };

  it("serves bytes with the kind's content type, requires auth, and caps the size", async () => {
    const h = await track({ overrides: { maxArtifactBytes: 10 } });
    const small = h.app.mimir.artifacts.write("--- a\n+++ b\n");
    record(h, small.id, "diff", small.bytes);
    const unauth = await h.app.inject({ method: "GET", url: `/v1/artifacts/${small.id}/content` });
    expect(unauth.statusCode).toBe(401);
    expect((await h.get(`/v1/artifacts/${small.id}/content`)).status).toBe(409); // 13 bytes > 10
    const tiny = h.app.mimir.artifacts.write("ok");
    record(h, tiny.id, "test.output", tiny.bytes);
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/artifacts/${tiny.id}/content`,
      headers: { authorization: "Bearer test-token-0123456789" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["content-length"]).toBe("2");
    expect(res.body).toBe("ok");
  });

  it("never follows a path outside MIMIR_DATA_DIR/artifacts (symlinked artifact file → 404)", async () => {
    const h = await track();
    const id = newId("art");
    const dir = h.app.mimir.artifacts.dir;
    mkdirSync(dir, { recursive: true });
    const outside = join(h.dataDir, "..", "secret.txt");
    writeFileSync(outside, "top secret");
    symlinkSync(outside, join(dir, id));
    record(h, id, "test.output", 10);
    const res = await h.get(`/v1/artifacts/${id}/content`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.json)).not.toContain("top secret");
  });
});

describe("Heimdall operator extensions", () => {
  it("pauses scheduling with version checks and idempotent replay", async () => {
    const h = await track();
    const { missionId, crewId } = await setupMission(h);
    const t = await createTask(h, missionId, "Task", "echo task");
    const key = h.key();
    const paused = await h.post(`/v1/crews/${crewId}/pause`, {}, key);
    expect(paused.status).toBe(200);
    expect(paused.json.crew.schedulingPaused).toBe(true);
    expect((await h.post(`/v1/crews/${crewId}/pause`, {}, key)).json).toEqual(paused.json);
    expect((await h.post(`/v1/crews/${crewId}/resume`, { expectedVersion: 0 })).status).toBe(409);
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(t).status).toBe("ready");
    await h.post(`/v1/crews/${crewId}/resume`, { expectedVersion: paused.json.crew.version });
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");
    const before = h.task(t);
    const count = (await h.fake.listSessions()).length;
    const checked = await h.post(`/v1/tasks/${t}/verify`, { expectedVersion: before.version });
    expect(checked.status).toBe(200);
    expect(checked.json.passed).toBe(true);
    expect(checked.json.artifactId).toBeTruthy();
    expect(h.task(t).status).toBe("completed");
    expect((await h.fake.listSessions()).length).toBe(count);
  });
});
