import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeRuntime } from "@mimir/fake-runtime";
import {
  newId,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
} from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.js";
import { writingRuntime } from "./test-agent-files.js";
import {
  createTask,
  harness,
  setupMission,
  type Harness,
  type HarnessOptions,
} from "./test-harness.js";
import type { Verifier } from "./verifier.js";

// Integration tests: real git worktrees and server boots (slow on a busy host).
vi.setConfig({ testTimeout: 120_000 });

const LONG_RUNNING = [{ afterMs: 100, state: "running" as const }];

const harnesses: Harness[] = [];
const track = async (opts?: HarnessOptions) => {
  const h = await harness(opts);
  harnesses.push(h);
  return h;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function waitFor(cond: () => boolean, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
}

function capturedLogger() {
  const lines: { msg?: string }[] = [];
  const logger = createLogger({
    level: "info",
    stream: { write: (line: string) => void lines.push(JSON.parse(line) as never) },
  });
  return { logger, messages: () => lines.map((l) => l.msg) };
}

/** The fake, with `createSession` held per call until the test settles it, and pushed events. */
class HeldRuntime implements RuntimeAdapter {
  handlers: ((e: RuntimeEvent) => void)[] = [];
  holds: { spec: RuntimeSessionSpec; settle: (err?: Error) => void }[] = [];
  hold = true;
  stopError: Error | null = null;
  constructor(readonly fake: FakeRuntime) {}
  capabilities = () => this.fake.capabilities();
  health = () => this.fake.health();
  listSessions = () => this.fake.listSessions();
  getSession = (id: string) => this.fake.getSession(id);
  sendInput = (id: string, input: { text?: string; keys?: string[] }) =>
    this.fake.sendInput(id, input);
  requestStop = (id: string, mode: "soft" | "force") =>
    this.stopError ? Promise.reject(this.stopError) : this.fake.requestStop(id, mode);
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
      await new Promise<void>((resolve, reject) =>
        this.holds.push({ spec, settle: (err) => (err ? reject(err) : resolve()) }),
      );
    }
    return this.fake.createSession(spec);
  }
}

describe("launches that race with other changes", () => {
  it("a launch outlived by its lease never requests a session for the task's next attempt", async () => {
    let rt!: HeldRuntime;
    const h = await track({ wrapRuntime: (fake) => (rt = new HeldRuntime(fake)) });
    const { missionId } = await setupMission(h, {
      maxAttemptsPerTask: 3,
      leaseSeconds: 1,
    } as never);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => rt.holds.length === 1);
    // The first launch hangs in createSession; its lease runs out and the task is retried.
    h.clock.advance(1500);
    // Not `h.tick()`: it would wait for the held launch.
    await h.app.mimir.orchestrator.tick();
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    // Past the retry backoff, then no more clock: the second lease (1 s) must not run out while
    // its worktree is made on a slow host.
    for (let i = 0; i < 20 && h.task(t).status !== "leased"; i++) {
      h.clock.advance(5000);
      await h.app.mimir.orchestrator.tick();
    }
    await waitFor(() => rt.holds.length === 2);
    expect(h.task(t)).toMatchObject({ status: "leased", attempt: 1 });
    const requested = h.events(["session.requested"]).length;

    // The first launch's session finally exists: it belongs to no attempt and is stopped.
    rt.holds[0]!.settle();
    await waitFor(() => h.events(["session.started"]).length === 1);
    const orphan = h.events(["session.started"])[0]!.sessionId;
    await waitFor(() =>
      h
        .events(["session.state_changed"])
        .some((e) => e.sessionId === orphan && (e.payload as { to: string }).to === "stopping"),
    );
    expect(h.task(t)).toMatchObject({ status: "leased", attempt: 1 });
    expect(h.events(["session.requested"])).toHaveLength(requested);
    expect(h.events(["task.started"])).toEqual([]);
    rt.hold = false;
    rt.holds[1]!.settle();
    await h.idle();
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
  });

  it("records nothing when a session cannot be created after the server stopped", async () => {
    let rt!: HeldRuntime;
    const h = await track({ wrapRuntime: (fake) => (rt = new HeldRuntime(fake)) });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => rt.holds.length === 1);
    const closing = h.app.close();
    await new Promise((r) => setTimeout(r, 50));
    rt.holds[0]!.settle(new Error("runtime went away"));
    await closing;
    expect(h.events(["session.state_changed", "task.failed"])).toEqual([]);
    expect(h.task(t).status).toBe("leased");
    rt.hold = false;
    await h.restart();
  });

  it("logs a failed stop of a session created for a task that was cancelled meanwhile", async () => {
    let rt!: HeldRuntime;
    const { logger, messages } = capturedLogger();
    const h = await track({
      overrides: { logger },
      wrapRuntime: (fake) => (rt = new HeldRuntime(fake)),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => rt.holds.length === 1);
    expect((await h.post(`/v1/missions/${missionId}/cancel`, {})).status).toBe(202);
    rt.stopError = new Error("tmux server not running");
    rt.holds[0]!.settle();
    await h.idle();
    expect(h.task(t).status).toBe("cancelled");
    expect(h.events(["session.started"])).toHaveLength(1);
    expect(h.events(["task.started"])).toEqual([]);
    expect(messages()).toContain("stop of an orphaned session failed");
  });

  it("runs no verification for a task cancelled right after its session completed", async () => {
    let rt!: HeldRuntime;
    const calls: unknown[] = [];
    const verifier: Verifier = {
      verify: (input) => {
        calls.push(input);
        return Promise.resolve({ source: "test-command", passed: true, checks: [] });
      },
    };
    const h = await track({
      script: LONG_RUNNING,
      overrides: { verifier },
      wrapRuntime: (fake) => {
        rt = new HeldRuntime(fake);
        rt.hold = false;
        return rt;
      },
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    const s = h.events(["session.requested"])[0]!.sessionId!;
    // Both are queued before either runs: the completion first, then the cancellation.
    rt.emit({
      kind: "session.state_changed",
      sessionId: s,
      state: "completed",
      observedAt: new Date().toISOString(),
    });
    const cancelled = h.app.mimir.orchestrator.cancelMission(missionId);
    await cancelled;
    await h.idle();
    expect(h.task(t).status).toBe("cancelled");
    expect(calls).toEqual([]);
    expect(h.events(["artifact.recorded"])).toEqual([]);
  });

  it("a periodic reconcile leaves sessions being created and finished ones alone", async () => {
    let rt!: HeldRuntime;
    const h = await track({
      overrides: { reconcileEveryTicks: 1 },
      wrapRuntime: (fake) => (rt = new HeldRuntime(fake)),
    });
    const { missionId } = await setupMission(h, { maxConcurrentTasks: 1 });
    const a = await createTask(h, missionId, "A", "echo a");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => rt.holds.length === 1);
    await waitFor(() => h.events(["session.requested"]).length === 1);
    // Requested but not yet created: the runtime does not know it, and that is not a loss.
    await h.app.mimir.orchestrator.tick();
    await h.app.mimir.orchestrator.tick();
    expect(h.events(["session.lost", "recovery.reconciled"])).toEqual([]);

    rt.hold = false;
    rt.holds[0]!.settle();
    await h.idle();
    await h.advance(1000);
    await h.tick();
    expect(h.task(a).status).toBe("completed");
    // A finished session the runtime forgot is not lost either.
    h.fake.loseSession(h.events(["session.requested"])[0]!.sessionId!);
    await h.idle();
    const before = h.events(["session.lost"]).length;
    await h.tick();
    await h.tick();
    expect(h.events(["session.lost"])).toHaveLength(before);
    // Periodic passes that find nothing lost leave no summary.
    expect(h.events(["recovery.reconciled"])).toEqual([]);
  });
});

describe("local delivery", () => {
  it("delivers a mission whose tasks depend on each other as one patch", async () => {
    const h = await track();
    const { missionId } = await setupMission(h);
    const a = await createTask(h, missionId, "A", "echo a");
    const b = await createTask(h, missionId, "B", "echo b", [a]);
    await h.post(`/v1/missions/${missionId}/start`);
    for (let i = 0; i < 20 && h.task(b).status !== "completed"; i++) {
      await h.tick();
      await h.advance(1000);
    }
    expect(h.task(b).status).toBe("completed");
    const asked = await h.post(`/v1/tasks/${b}/pr`, {});
    expect(
      (await h.post(`/v1/approvals/${asked.json.approvalId}/decision`, { decision: "approved" }))
        .status,
    ).toBe(202);
    const [delivery] = h
      .events(["artifact.recorded"])
      .filter((e) => (e.payload as { kind: string }).kind === "local_delivery");
    const id = (delivery!.payload as { artifactId: string }).artifactId;
    const content = (await h.get(`/v1/artifacts/${id}/content`)).json as unknown;
    expect(content).toMatchObject({ taskIds: [a, b], format: "git-patch" });
  });

  it("refuses to export a change that contains a credential", async () => {
    const secret = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const h = await track({
      wrapRuntime: (fake: FakeRuntime) =>
        writingRuntime(fake, (cwd) => writeFileSync(join(cwd, "config.env"), `KEY=${secret}\n`)),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");
    const asked = await h.post(`/v1/tasks/${t}/pr`, {});
    const res = await h.post(`/v1/approvals/${asked.json.approvalId}/decision`, {
      decision: "approved",
    });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toMatch(/credential-shaped content/);
    const kinds = h.events(["artifact.recorded"]).map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).not.toContain("local_delivery");
    expect(JSON.stringify(h.events())).not.toContain(secret);
  });
});

describe("operator requests on the wrong target", () => {
  it("refuses to recheck a task that is still being worked on", async () => {
    const h = await track({ script: LONG_RUNNING });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    expect(h.task(t).status).toBe("running");
    const res = await h.post(`/v1/tasks/${t}/verify`, {});
    expect(res.status).toBe(409);
    expect(res.json.error.message).toMatch(/requires a settled task/);
  });

  it("names what is missing: unknown task, mission or session, or no runtime", async () => {
    const h = await track({ script: LONG_RUNNING });
    const o = h.app.mimir.orchestrator;
    await expect(o.retryTask("tsk_01J0000000000000000000000A")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(o.startMission("msn_01J0000000000000000000000A")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(o.stopSession("ses_01J0000000000000000000000A", "soft")).rejects.toMatchObject({
      code: "not_found",
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    expect(h.task(t).status).toBe("running");
    const s = h.events(["session.requested"])[0]!.sessionId!;
    await h.restart({ runtime: null });
    const res = await h.post(`/v1/sessions/${s}/input`, { text: "hello" });
    expect(res.status).toBe(503);
    expect(h.events(["session.input"])).toEqual([]);
  });
});

describe("budgets", () => {
  it("releases a task parked on uncertain usage once the usage is measured", async () => {
    const h = await track();
    const p = await h.post("/v1/projects", {
      name: "p",
      repoPath: h.repo,
      settings: { testCommand: ["cat", "package.json"] },
    });
    const m = await h.post("/v1/missions", {
      projectId: p.json.project.id,
      objective: "o",
      budget: { limitTokens: 1000, onUnknown: "block" },
      tasks: [
        { title: "A", brief: "echo a" },
        { title: "B", brief: "echo b" },
      ],
    });
    await h.post("/v1/crews", {
      missionId: m.json.mission.id,
      template: "solo",
      limits: { maxConcurrentTasks: 1 },
      members: [{ role: "implementer", agentKind: "shell" }],
    });
    await h.post(`/v1/missions/${m.json.mission.id}/start`);
    await h.tick();
    await h.advance(1000);
    await h.tick();
    const b = m.json.tasks[1].id as string;
    expect(h.task(b)).toMatchObject({ status: "blocked", blockedReason: "budget_uncertain" });

    // A's usage, unavailable so far, is reported after all (e.g. imported from the provider).
    const [unavailable] = h.events(["usage.recorded"]);
    const sample = (unavailable!.payload as { sample: Record<string, unknown> }).sample;
    const at = new Date().toISOString();
    h.store.append({
      streamId: unavailable!.streamId,
      type: "usage.recorded",
      source: "test",
      provenance: "observed",
      occurredAt: at,
      observedAt: at,
      payload: {
        sample: { ...sample, tokens: 10, source: "measured", updatedAt: at, version: 1 },
      },
    });
    await h.tick();
    expect(
      h
        .events(["task.ready"])
        .filter((e) => e.taskId === b)
        .at(-1)?.payload,
    ).toMatchObject({
      from: "blocked",
    });
    for (let i = 0; i < 10 && h.task(b).status !== "completed"; i++) {
      await h.tick();
      await h.advance(1000);
    }
    expect(h.task(b).status).toBe("completed");
  });

  it("warns about a cost budget in cost, and has nothing to say about a budget without a limit", async () => {
    const h = await track();
    const { missionId, projectId } = await setupMission(
      h,
      {},
      {},
      { limitCost: 5, onUnknown: "allow" },
    );
    const unlimited = await h.post("/v1/missions", {
      projectId,
      objective: "no limit",
      budget: { onUnknown: "allow" },
    });
    expect(unlimited.status).toBe(201);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");
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
          agentId: h.task(t).agentId!,
          tokens: 900,
          estimatedCost: 4.5,
          source: "measured",
          createdAt: at,
          updatedAt: at,
          version: 0,
        },
      },
    });
    await h.tick();
    expect(
      h.events(["budget.warning", "budget.exceeded"]).map((e) => [e.missionId, e.payload]),
    ).toEqual([[missionId, expect.objectContaining({ unit: "cost", used: 4.5, limit: 5 })]]);
  });
});
