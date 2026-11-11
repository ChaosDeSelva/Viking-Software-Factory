import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeRuntime } from "@mimir/fake-runtime";
import { GitManager } from "@mimir/git";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionSpec,
} from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.js";
import { GitWorktreePort, type WorktreePort } from "./git-port.js";
import {
  createTask,
  harness,
  setupMission,
  type Harness,
  type HarnessOptions,
} from "./test-harness.js";
import type { VerificationResult, Verifier, VerifyInput } from "./verifier.js";

// Integration tests: real git worktrees and server boots (slow on a busy host).
vi.setConfig({ testTimeout: 120_000 });

const LONG_RUNNING = [{ afterMs: 100, state: "running" as const }];

const harnesses: Harness[] = [];
const dirs: string[] = [];
const track = async (opts?: HarnessOptions) => {
  const h = await harness(opts);
  harnesses.push(h);
  return h;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Polls (real time) until `cond` holds; git under load can take seconds per worktree. */
async function waitFor(cond: () => boolean, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
}

/** A logger whose structured lines a test can read. */
function capturedLogger() {
  const lines: { level: number; msg?: string; [k: string]: unknown }[] = [];
  const logger = createLogger({
    level: "info",
    stream: { write: (line: string) => void lines.push(JSON.parse(line) as never) },
  });
  return { logger, messages: () => lines.map((l) => l.msg) };
}

/** Delegates to the fake, and lets a test push runtime events of its own. */
class ControlledRuntime implements RuntimeAdapter {
  handlers: ((e: RuntimeEvent) => void)[] = [];
  constructor(readonly fake: FakeRuntime) {}
  capabilities = () => this.fake.capabilities();
  health = () => this.fake.health();
  createSession = (spec: RuntimeSessionSpec): Promise<RuntimeSession> =>
    this.fake.createSession(spec);
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
}

const at = () => new Date().toISOString();

/** Starts the mission and runs until the task's first session is running; returns its id. */
async function running(h: Harness, missionId: string, taskId: string): Promise<string> {
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(200);
  expect(h.task(taskId).status).toBe("running");
  return h.events(["session.requested"]).at(-1)!.sessionId!;
}

describe("runtime events", () => {
  it("fails a task once when the runtime reports its session lost; a repeated report is ignored", async () => {
    const h = await track({ script: LONG_RUNNING });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 1 });
    const t = await createTask(h, missionId, "T", "echo t");
    const s = await running(h, missionId, t);

    h.fake.loseSession(s);
    await h.idle();
    h.fake.loseSession(s);
    await h.idle();

    expect(h.events(["session.lost"]).map((e) => e.payload)).toEqual([{ reason: "lost" }]);
    expect(h.task(t).status).toBe("failed");
    expect(h.events(["task.failed"]).map((e) => e.payload)).toEqual([
      expect.objectContaining({ from: "running", reason: "session_lost: lost", retryable: false }),
    ]);
    // The session ended without measured usage: one unavailable sample.
    expect(h.events(["usage.recorded"]).map((e) => e.payload)).toEqual([
      { sample: expect.objectContaining({ source: "unavailable", tokens: null }) },
    ]);
  });

  it("resumes a runtime-blocked task before failing it when its session is lost", async () => {
    const h = await track({
      script: [
        { afterMs: 100, state: "running" },
        { afterMs: 1000, state: "blocked" },
      ],
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 1 });
    const t = await createTask(h, missionId, "T", "echo t");
    await running(h, missionId, t);
    await h.advance(1000);
    expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "blocked" });

    h.fake.loseSession(h.events(["session.requested"])[0]!.sessionId!);
    await h.idle();

    const path = h
      .events(["task.started", "task.failed"])
      .filter((e) => e.taskId === t)
      .map((e) => [e.type, (e.payload as { from: string }).from]);
    expect(path).toEqual([
      ["task.started", "leased"],
      ["task.started", "blocked"],
      ["task.failed", "running"],
    ]);
  });

  it("keeps a measured usage report from the exit instead of an unavailable sample", async () => {
    let rt: ControlledRuntime | null = null;
    const h = await track({
      script: LONG_RUNNING,
      wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    const s = await running(h, missionId, t);

    rt!.emit({
      kind: "session.exited",
      sessionId: s,
      exitCode: 0,
      usage: { tokens: 42, estimatedCost: 0.5 },
      observedAt: at(),
    });
    rt!.emit({ kind: "session.state_changed", sessionId: s, state: "completed", observedAt: at() });
    await h.idle();

    expect(h.task(t).status).toBe("completed");
    expect(h.events(["session.exited"]).map((e) => e.payload)).toEqual([{ exitCode: 0 }]);
    expect(h.events(["usage.recorded"]).map((e) => e.payload)).toEqual([
      {
        sample: expect.objectContaining({ source: "measured", tokens: 42, estimatedCost: 0.5 }),
      },
    ]);
  });

  it("ignores repeated states, events of finished or earlier sessions and unknown sessions", async () => {
    let rt: ControlledRuntime | null = null;
    const h = await track({
      script: LONG_RUNNING,
      wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    const first = await running(h, missionId, t);

    // The first attempt's session fails; the task is retried in a second session.
    rt!.emit({
      kind: "session.state_changed",
      sessionId: first,
      state: "failed",
      observedAt: at(),
    });
    await h.idle();
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    for (let i = 0; i < 10 && h.task(t).status !== "running"; i++) {
      await h.tick();
      await h.advance(30_000);
    }
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
    const second = h.events(["session.requested"]).at(-1)!.sessionId!;
    expect(second).not.toBe(first);
    const before = h.events().length;

    // Same state again, a state after a terminal one, and a session Mimir never started.
    rt!.emit({
      kind: "session.state_changed",
      sessionId: second,
      state: "running",
      observedAt: at(),
    });
    rt!.emit({
      kind: "session.state_changed",
      sessionId: first,
      state: "running",
      observedAt: at(),
    });
    rt!.emit({ kind: "session.output", sessionId: "ses_unknown", text: "x", observedAt: at() });
    await h.idle();
    expect(h.events().length).toBe(before);

    // The earlier session's loss is recorded, but it no longer drives the task.
    rt!.emit({ kind: "session.lost", sessionId: first, reason: "gone", observedAt: at() });
    await h.idle();
    expect(h.events(["session.lost"]).map((e) => e.sessionId)).toEqual([first]);
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
  });

  it("records a lost session's later states without letting them drive the retried task", async () => {
    let rt: ControlledRuntime | null = null;
    const h = await track({
      script: LONG_RUNNING,
      wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    const first = await running(h, missionId, t);
    rt!.emit({ kind: "session.lost", sessionId: first, reason: "gone", observedAt: at() });
    await h.idle();
    for (let i = 0; i < 10 && h.task(t).status !== "running"; i++) {
      await h.tick();
      await h.advance(30_000);
    }
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });

    // The lost session turns up again and completes: recorded, but the task's work is the
    // second session's, so the task is not sent to verification.
    rt!.emit({
      kind: "session.state_changed",
      sessionId: first,
      state: "completed",
      observedAt: at(),
    });
    await h.idle();
    expect(
      h
        .events(["session.state_changed"])
        .filter((e) => e.sessionId === first)
        .at(-1)?.payload,
    ).toMatchObject({ to: "completed" });
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
  });

  it("logs a runtime event it cannot record and goes on with the next ones", async () => {
    let rt: ControlledRuntime | null = null;
    const { logger, messages } = capturedLogger();
    const h = await track({
      script: LONG_RUNNING,
      overrides: { logger },
      wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    const s = await running(h, missionId, t);
    const before = h.events().length;

    // A state no protocol knows: refused before anything is appended.
    rt!.emit({
      kind: "session.state_changed",
      sessionId: s,
      state: "exploded" as never,
      observedAt: at(),
    });
    await h.idle();
    expect(h.events().length).toBe(before);
    expect(messages()).toContain("runtime event handling failed");

    rt!.emit({ kind: "session.state_changed", sessionId: s, state: "completed", observedAt: at() });
    await h.idle();
    expect(h.task(t).status).toBe("completed");
  });

  it("appends nothing for runtime events or ticks once stopped", async () => {
    let rt: ControlledRuntime | null = null;
    const h = await track({
      script: LONG_RUNNING,
      wrapRuntime: (fake) => (rt = new ControlledRuntime(fake)),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    const s = await running(h, missionId, t);
    const [handler] = rt!.handlers;
    const orchestrator = h.app.mimir.orchestrator;
    await h.app.close();
    const before = h.events().length;

    handler!({ kind: "session.state_changed", sessionId: s, state: "completed", observedAt: at() });
    await orchestrator.tick();
    await orchestrator.idle();

    expect(h.events().length).toBe(before);
    expect(h.task(t).status).toBe("running");
    await h.restart();
  });
});

/** A git port over a real `GitManager` whose `create` and `restore` a test can take over. */
function controlledGit() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-wt-")));
  dirs.push(root);
  const real = new GitWorktreePort(new GitManager({ worktreeRoot: root }));
  const control = {
    calls: 0,
    create: null as null | ((n: number) => Promise<void>),
    restore: null as null | (() => Promise<never>),
  };
  const port = Object.create(real) as WorktreePort;
  port.create = async (input) => {
    const n = control.calls++;
    await control.create?.(n);
    return real.create(input);
  };
  port.restore = (records) => control.restore?.() ?? real.restore(records);
  return { port, control };
}

describe("worktree creation and restore", () => {
  it("fails an attempt whose worktree cannot be created; the retry runs", async () => {
    const { port, control } = controlledGit();
    control.create = (n) => (n === 0 ? Promise.reject(new Error("disk full")) : Promise.resolve());
    const h = await track({ overrides: { git: port } });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    expect(h.events(["task.failed"])[0]?.payload).toMatchObject({
      from: "leased",
      reason: "worktree_failed: disk full",
      retryable: true,
    });
    expect(h.events(["session.requested"])).toHaveLength(0);

    for (let i = 0; i < 10 && h.task(t).status !== "completed"; i++) {
      await h.tick();
      await h.advance(1000);
    }
    expect(h.task(t)).toMatchObject({ status: "completed", attempt: 1 });
  });

  it("logs a launch that broke unexpectedly; the task's lease then runs out and it is retried", async () => {
    const { port } = controlledGit();
    let broken = false;
    const has = port.has.bind(port);
    port.has = (id) => {
      if (broken) throw new Error("worktree registry corrupted");
      return has(id);
    };
    const { logger, messages } = capturedLogger();
    let creates = 0;
    const h = await track({
      overrides: { git: port, logger },
      wrapRuntime: (fake) => ({
        ...new ControlledRuntime(fake),
        subscribe: (handler) => fake.subscribe(handler),
        createSession: (spec) =>
          ++creates === 1 ? Promise.reject(new Error("no pane")) : fake.createSession(spec),
      }),
    });
    const { missionId } = await setupMission(h, {
      maxAttemptsPerTask: 3,
      leaseSeconds: 1,
    } as never);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    // The first attempt fails after its worktree was made; the second breaks looking for it.
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    broken = true;
    for (let i = 0; i < 10 && h.task(t).status !== "leased"; i++) {
      await h.advance(30_000);
      await h.tick();
    }
    expect(messages()).toContain("background work failed");
    expect(h.task(t)).toMatchObject({ status: "leased", attempt: 1 });

    broken = false;
    h.clock.advance(1500);
    await h.tick();
    expect(h.events(["task.failed"]).at(-1)?.payload).toMatchObject({
      from: "leased",
      reason: "lease_expired",
    });
    for (let i = 0; i < 10 && h.task(t).status !== "completed"; i++) {
      await h.advance(30_000);
      await h.tick();
      await h.advance(1000);
    }
    expect(h.task(t)).toMatchObject({ status: "completed", attempt: 2 });
    expect(h.events(["git.worktree_created"])).toHaveLength(1);
  });

  it("a task without a worktree cannot be rechecked", async () => {
    const { port, control } = controlledGit();
    control.create = () => Promise.reject(new Error("disk full"));
    const h = await track({ overrides: { git: port } });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 1 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(t).status).toBe("failed");
    const res = await h.post(`/v1/tasks/${t}/verify`, {});
    expect(res.status).toBe(404);
    expect(res.json.error.message).toMatch(/worktree is unavailable/);
  });

  it("starts no session for, and does not fail, tasks cancelled while their worktree was made", async () => {
    const { port, control } = controlledGit();
    const releases: ((ok: boolean) => void)[] = [];
    control.create = () =>
      new Promise<void>((resolve, reject) =>
        releases.push((ok) => (ok ? resolve() : reject(new Error("interrupted")))),
      );
    const h = await track({ overrides: { git: port } });
    const { missionId } = await setupMission(h, { maxConcurrentTasks: 2 });
    const a = await createTask(h, missionId, "A", "echo a");
    const b = await createTask(h, missionId, "B", "echo b");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => releases.length === 2);

    expect((await h.post(`/v1/missions/${missionId}/cancel`, {})).status).toBe(202);
    releases[0]!(true);
    releases[1]!(false);
    await h.idle();

    expect([h.task(a).status, h.task(b).status]).toEqual(["cancelled", "cancelled"]);
    expect(h.events(["session.requested", "task.failed"])).toEqual([]);
    // The worktree that was made is still recorded: it exists on disk.
    expect(h.events(["git.worktree_created"])).toHaveLength(1);
  });

  it("parks a leased task whose launch was cut off by a restart, and gives its lease up once", async () => {
    const { port, control } = controlledGit();
    let release: ((ok: boolean) => void) | null = null;
    control.create = () =>
      new Promise<void>((resolve, reject) => {
        release = (ok) => (ok ? resolve() : reject(new Error("interrupted")));
      });
    const h = await track({ overrides: { git: port } });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    await waitFor(() => release !== null);
    expect(h.task(t).status).toBe("leased");

    await h.restart();
    expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "unknown_after_restart" });
    // The interrupted launch of the stopped server records nothing.
    (release as unknown as (ok: boolean) => void)(false);
    await h.idle();
    expect(h.events(["task.failed"])).toEqual([]);

    // Its lease runs out while it is parked: given up without a task transition, once.
    const before = h.events().length;
    await h.advance(24 * 60 * 60 * 1000);
    await h.tick();
    await h.tick();
    expect(h.events().length).toBe(before);
    expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "unknown_after_restart" });
  });

  it("boots when worktrees cannot be restored, and logs what was not restored", async () => {
    const { port, control } = controlledGit();
    const { logger, messages } = capturedLogger();
    const h = await track({ overrides: { git: port, logger } });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");

    control.restore = () => Promise.reject(new Error("git exploded"));
    await h.restart();
    expect(messages()).toContain("worktree restore failed");

    control.restore = null;
    const worktree = h.events(["git.worktree_created"])[0]!.payload as { path: string };
    rmSync(worktree.path, { recursive: true, force: true });
    await h.restart();
    expect(messages()).toContain("not every worktree was restored");
    expect((await h.get("/v1/health")).status).toBe(200);
  });
});

/** Answers verifications from a queue a test controls; aborted ones are rejected. */
class QueuedVerifier implements Verifier {
  readonly inputs: VerifyInput[] = [];
  private waiting: { resolve: (r: VerificationResult) => void; reject: (e: Error) => void }[] = [];
  verify(input: VerifyInput): Promise<VerificationResult> {
    this.inputs.push(input);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiting.push(entry);
      input.signal.addEventListener("abort", () => {
        this.waiting = this.waiting.filter((w) => w !== entry);
        reject(new Error("aborted"));
      });
    });
  }
  get pending(): number {
    return this.waiting.length;
  }
  fail(): void {
    this.waiting.shift()!.resolve({ source: "test-command", passed: false, checks: [] });
  }
  crash(): void {
    this.waiting.shift()!.reject(new Error("verifier crashed"));
  }
}

describe("verification outcomes", () => {
  it("fails the task with the verifier's error when the verifier itself fails", async () => {
    const verifier = new QueuedVerifier();
    const h = await track({ overrides: { verifier } });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 1 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    for (let i = 0; i < 400 && verifier.pending === 0; i++) {
      h.clock.advance(250);
      await new Promise((r) => setTimeout(r, 25));
    }
    verifier.crash();
    await h.idle();
    expect(h.task(t).status).toBe("failed");
    expect(h.events(["task.failed"])[0]?.payload).toMatchObject({
      from: "verifying",
      reason: "verification_error: internal: verifier crashed",
    });
  });

  it("without a runtime after a restart, the next attempt cannot start and nothing is dispatched", async () => {
    const verifier = new QueuedVerifier();
    const h = await track({ overrides: { verifier } });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 3 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.app.mimir.orchestrator.tick();
    for (let i = 0; i < 400 && verifier.pending === 0; i++) {
      h.clock.advance(250);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h.task(t).status).toBe("verifying");

    await h.restart({ runtime: null });
    // The cut-off verification runs again; it fails, and no session can be created for the next
    // attempt: that costs the attempt once.
    await waitFor(() => verifier.inputs.length === 2);
    verifier.fail();
    await h.idle();
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    expect(h.events(["task.failed"]).at(-1)?.payload).toMatchObject({
      from: "verifying",
      reason: "session_create_failed: no runtime configured",
    });

    for (let i = 0; i < 3; i++) {
      await h.tick();
      await h.advance(1000);
    }
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 1 });
    expect(h.events(["task.leased"])).toHaveLength(1);
  });
});
