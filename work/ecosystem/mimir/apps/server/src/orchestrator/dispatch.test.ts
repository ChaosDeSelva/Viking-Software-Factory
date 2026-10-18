import type { FakeRuntime } from "@mimir/fake-runtime";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionSpec,
} from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask, harness, setupMission, type Harness } from "./test-harness.js";

// Integration tests: real git worktrees, npm verification and server boots (slow on a busy host).
vi.setConfig({ testTimeout: 120_000 });

/** Polls (real time) until `cond` holds; git under load can take seconds per worktree. */
async function waitFor(cond: () => boolean, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
}

const harnesses: Harness[] = [];
const track = (h: Harness) => (harnesses.push(h), h);
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Delegates to the fake, but lets a test hold createSession and push its own events. */
class ControlledRuntime implements RuntimeAdapter {
  handlers: ((e: RuntimeEvent) => void)[] = [];
  holds: { spec: RuntimeSessionSpec; release: () => void }[] = [];
  hold = false;
  /** Events emitted for a session before createSession resolves. */
  early: ((sessionId: string, at: string) => RuntimeEvent[]) | null = null;

  constructor(readonly fake: FakeRuntime) {}
  capabilities = () => this.fake.capabilities();
  health = () => this.fake.health();
  listSessions = () => this.fake.listSessions();
  getSession = (id: string) => this.fake.getSession(id);
  sendInput = (id: string, input: { text?: string; keys?: string[] }) =>
    this.fake.sendInput(id, input);
  requestStop = (id: string, mode: "soft" | "force") => this.fake.requestStop(id, mode);
  reconcile = () => this.fake.reconcile();
  dispose = () => this.fake.dispose();
  async subscribe(handler: (e: RuntimeEvent) => void) {
    this.handlers.push(handler);
    const sub = await this.fake.subscribe(handler);
    return {
      close: () => {
        this.handlers = this.handlers.filter((h) => h !== handler);
        sub.close();
      },
    };
  }
  emit(e: RuntimeEvent) {
    for (const h of [...this.handlers]) h(e);
  }
  async createSession(spec: RuntimeSessionSpec): Promise<RuntimeSession> {
    if (this.hold) {
      await new Promise<void>((release) => this.holds.push({ spec, release }));
    }
    const session = await this.fake.createSession(spec);
    for (const e of this.early?.(spec.sessionId, new Date(0).toISOString()) ?? []) this.emit(e);
    return session;
  }
}

describe("dispatch does not hold the orchestrator queue", () => {
  it("a slow createSession lets other dispatches, ticks and routes proceed", async () => {
    let rt!: ControlledRuntime;
    const h = track(await harness({ wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)) }));
    const { missionId } = await setupMission(h, { maxConcurrentTasks: 2 });
    const a = await createTask(h, missionId, "A", "echo a");
    const b = await createTask(h, missionId, "B", "echo b");
    await h.post(`/v1/missions/${missionId}/start`);
    rt.hold = true;
    await h.app.mimir.orchestrator.tick();
    // wait until both sessions are being created (worktrees are made off the queue too)
    await waitFor(() => rt.holds.length >= 2);
    expect(rt.holds.map((x) => x.spec.taskId).sort()).toEqual([a, b].sort());
    expect([h.task(a).status, h.task(b).status]).toEqual(["leased", "leased"]);
    // the queue is free: a route that goes through the orchestrator completes
    const paused = await h.post(`/v1/missions/${missionId}/pause`);
    expect(paused.status).toBe(202);
    for (const x of rt.holds) x.release();
    await h.idle();
    expect([h.task(a).status, h.task(b).status]).toEqual(["running", "running"]);
  }, 120_000);

  it("runtime events that arrive before createSession returns still drive the task", async () => {
    let rt!: ControlledRuntime;
    const h = track(
      await harness({
        script: [],
        wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)),
      }),
    );
    rt.early = (sessionId, at) => [
      {
        kind: "session.state_changed",
        sessionId,
        state: "running",
        observedAt: at,
        sourceEventId: "e1",
      },
      {
        kind: "session.state_changed",
        sessionId,
        state: "completed",
        observedAt: at,
        sourceEventId: "e2",
      },
    ];
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(t).status).toBe("completed");
    const session = [...h.app.mimir.readModel.sessions.values()][0];
    expect(session?.state).toBe("completed");
  }, 120_000);

  it("a mission cancelled while a session is being created stops that session", async () => {
    let rt!: ControlledRuntime;
    const h = track(await harness({ wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)) }));
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    rt.hold = true;
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => rt.holds.length >= 1);
    expect((await h.post(`/v1/missions/${missionId}/cancel`, { reason: "nope" })).status).toBe(202);
    expect(h.task(t).status).toBe("cancelled");
    rt.holds[0]?.release();
    await h.idle();
    await h.advance(100);
    expect(h.task(t).status).toBe("cancelled");
    const sessionId = h.events(["session.requested"])[0]?.sessionId as string;
    expect((await h.fake.getSession(sessionId))?.state).toMatch(/stopp/);
  }, 120_000);

  it("a lease expires when the runtime never confirms the session; the late session is stopped", async () => {
    let rt!: ControlledRuntime;
    const h = track(await harness({ wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)) }));
    const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
    const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
    const missionId = m.json.mission.id as string;
    await h.post("/v1/crews", {
      missionId,
      template: "solo",
      limits: { leaseSeconds: 1, maxAttemptsPerTask: 3 },
      members: [{ role: "implementer", agentKind: "shell" }],
    });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    rt.hold = true;
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => rt.holds.length >= 1);
    h.clock.advance(1500);
    await h.app.mimir.orchestrator.tick();
    await h.app.mimir.orchestrator.tick();
    expect(h.task(t)).toMatchObject({ status: "failed" });
    expect(h.events(["task.failed"])).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ reason: "lease_expired" }) }),
    ]);
    rt.holds[0]?.release();
    await h.idle();
    await h.advance(100);
    const sessionId = h.events(["session.requested"])[0]?.sessionId as string;
    expect((await h.fake.getSession(sessionId))?.state).toMatch(/stopp/);
    expect(h.events(["task.started"])).toEqual([]);
  }, 120_000);
});
