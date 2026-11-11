import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FakeRuntime } from "@mimir/fake-runtime";
import { MimirError, type RuntimeAdapter, type RuntimeSessionSpec } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { argvFor } from "../templates.js";
import { CAPACITY_RETRY_MS, EVENT_OUTPUT_CAP, verificationFailureNote } from "./orchestrator.js";
import { writingRuntime } from "./test-agent-files.js";
import {
  FAST_TEST_COMMAND,
  createTask,
  harness,
  setupMission,
  type Harness,
  type HarnessOptions,
} from "./test-harness.js";
import type { VerificationResult, Verifier, VerifyInput } from "./verifier.js";

// Integration tests: real git worktrees and server boots (slow on a busy host).
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

/** The fake, with a hook that sees (and may refuse) every session launch. */
function launching(
  fake: FakeRuntime,
  onCreate: (spec: RuntimeSessionSpec) => void,
): RuntimeAdapter {
  const base = writingRuntime(fake, () => undefined);
  return {
    ...base,
    createSession: async (spec) => {
      onCreate(spec);
      return fake.createSession(spec);
    },
  };
}

/** Answers each verification from `results` in order (the last one repeats). */
class ScriptedVerifier implements Verifier {
  readonly inputs: VerifyInput[] = [];
  constructor(
    private readonly results: readonly ("pass" | "fail")[],
    private readonly failOutput = "running suite\n\u001b[31mFAIL\u001b[0m TestParse: want 3 got 4\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
  ) {}
  verify(input: VerifyInput): Promise<VerificationResult> {
    const outcome = this.results[Math.min(this.inputs.length, this.results.length - 1)];
    this.inputs.push(input);
    const passed = outcome === "pass";
    return Promise.resolve({
      source: "test-command",
      passed,
      checks: [
        {
          name: "test",
          command: ["make", "test"],
          passed,
          exitCode: passed ? 0 : 2,
          durationMs: 1,
          timedOut: false,
          output: passed ? "ok" : this.failOutput,
        },
      ],
    });
  }
}

const failures = (h: Harness, taskId: string) =>
  h
    .events(["task.failed"])
    .filter((e) => e.taskId === taskId)
    .map((e) => e.payload as { from: string; reason: string; attempt: number });

/** Ticks and advances until the task settles in `status` (bounded). */
async function until(h: Harness, taskId: string, status: string): Promise<void> {
  for (let i = 0; i < 40 && h.task(taskId).status !== status; i++) {
    await h.tick();
    await h.advance(1000);
  }
  expect(h.task(taskId).status).toBe(status);
}

describe("a verified result that cannot be frozen (A1)", () => {
  it("fails the attempt once and is retried, instead of staying in verifying", async () => {
    let nested: string | null = null;
    const h = await track({
      wrapRuntime: (fake) =>
        writingRuntime(fake, (cwd) => {
          if (nested !== null) return;
          // A repository inside the worktree: the checkpoint refuses it.
          nested = join(cwd, "vendor-copy");
          execFileSync("git", ["init", "-q", nested], { stdio: "ignore" });
        }),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 3 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    expect(failures(h, t)).toEqual([
      expect.objectContaining({ from: "verifying", attempt: 0, retryable: true }),
    ]);
    expect(failures(h, t)[0]!.reason).toMatch(/^checkpoint_failed: /);

    rmSync(nested!, { recursive: true, force: true });
    await until(h, t, "completed");
    // One attempt was used by the failure, not two.
    expect(h.task(t).attempt).toBe(1);
  });
});

describe("a launch that finds the runtime full (A3)", () => {
  it("waits in ready without using an attempt, then runs", async () => {
    let full = true;
    let launches = 0;
    const h = await track({
      wrapRuntime: (fake) =>
        launching(fake, () => {
          launches += 1;
          if (full)
            throw new MimirError("runtime_unavailable", "no worker has capacity", {
              reason: "capacity",
            });
        }),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 0, leaseExpiresAt: null });
    expect(launches).toBe(1);
    // Not a hot loop: nothing is launched again before the wait is over.
    await h.tick();
    await h.tick();
    expect(launches).toBe(1);
    // Far more refusals than the task has attempts.
    for (let i = 0; i < 5; i++) {
      await h.advance(CAPACITY_RETRY_MS * 2 ** i);
      await h.tick();
    }
    expect(launches).toBe(6);
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 0 });
    expect(failures(h, t)).toEqual([]);

    full = false;
    await h.advance(60_000);
    await until(h, t, "completed");
    expect(h.task(t).attempt).toBe(0);
    expect(failures(h, t)).toEqual([]);
  });

  it("clears the agent of a task whose lease was given back", async () => {
    const h = await track({
      wrapRuntime: (fake) =>
        launching(fake, () => {
          throw new MimirError("runtime_unavailable", "full", { reason: "capacity" });
        }),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.events(["task.leased"]).filter((e) => e.taskId === t)).toHaveLength(1);
    expect(h.task(t)).toMatchObject({ status: "ready", agentId: null });
    await h.restart();
    expect(h.task(t)).toMatchObject({ status: "ready", agentId: null });
  });

  it("fails the attempt as fleet_capacity_timeout once the refused launches exceed the wait", async () => {
    const h = await track({
      overrides: { capacityWaitMs: 5000 },
      wrapRuntime: (fake) =>
        launching(fake, () => {
          throw new MimirError("runtime_unavailable", "full", { reason: "capacity" });
        }),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 1 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick(); // refused at 0 s: waits 2 s
    await h.advance(2000);
    await h.tick(); // refused at 2 s: waits 4 s
    expect(h.task(t).status).toBe("ready");
    await h.advance(4000);
    await h.tick(); // refused at 6 s: longer than the 5 s allowed
    expect(failures(h, t)).toEqual([
      expect.objectContaining({ reason: "fleet_capacity_timeout", attempt: 0, retryable: false }),
    ]);
    await h.tick();
    expect(h.app.mimir.orchestrator.capacityWaiting()).toEqual([]);
  });

  it("still fails the attempt when no runtime can ever take the task", async () => {
    const h = await track({
      wrapRuntime: (fake) =>
        launching(fake, () => {
          throw new MimirError("runtime_unavailable", "no compatible worker");
        }),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(t).status).toBe("failed");
    expect(failures(h, t)[0]!.reason).toMatch(/^session_create_failed: /);
  });
});

describe("a runtime that reports it is full before a launch", () => {
  /** A runtime that can say it is full, like the fleet (`CapacityAware`). */
  const fleetLike = (fake: FakeRuntime, state: { full: boolean; launches: number }) => ({
    ...launching(fake, () => {
      state.launches += 1;
    }),
    atCapacity: () => state.full,
  });

  it("starts nothing and appends no event while a task waits, then runs it", async () => {
    const state = { full: true, launches: 0 };
    const h = await track({ wrapRuntime: (fake) => fleetLike(fake, state) });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    const waiting = h.events().length;
    for (let i = 0; i < 20; i++) {
      await h.advance(30_000);
      await h.tick();
    }
    expect(h.events()).toHaveLength(waiting);
    expect(h.events(["task.leased", "session.requested", "session.state_changed"])).toEqual([]);
    expect(h.app.mimir.readModel.sessions.size).toBe(0);
    expect(state.launches).toBe(0);
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 0, agentId: null });
    expect(h.app.mimir.orchestrator.capacityWaiting()).toEqual([t]);

    state.full = false;
    await until(h, t, "completed");
    expect(state.launches).toBe(1);
    expect(h.task(t).attempt).toBe(0);
    expect(failures(h, t)).toEqual([]);
    expect(h.app.mimir.orchestrator.capacityWaiting()).toEqual([]);
  });

  it("forgets the wait of tasks that stop waiting: mission paused or cancelled", async () => {
    const state = { full: true, launches: 0 };
    const h = await track({ wrapRuntime: (fake) => fleetLike(fake, state) });
    const { missionId } = await setupMission(h);
    const a = await createTask(h, missionId, "A", "echo a");
    const b = await createTask(h, missionId, "B", "echo b");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    const waits = () => h.app.mimir.orchestrator.capacityWaiting().sort();
    expect(waits()).toEqual([a, b].sort());
    expect((await h.post(`/v1/missions/${missionId}/pause`)).status).toBe(202);
    await h.tick();
    expect(waits()).toEqual([]);
    expect((await h.post(`/v1/missions/${missionId}/resume`)).status).toBe(202);
    await h.tick();
    expect(waits()).toEqual([a, b].sort());
    // Cancelling forgets them at once, without a tick.
    expect((await h.post(`/v1/missions/${missionId}/cancel`)).status).toBe(202);
    expect(waits()).toEqual([]);
    await h.tick();
    expect(waits()).toEqual([]);
    expect(state.launches).toBe(0);
  });

  it("waits for a busy fleet without limit by default: no attempt is spent", async () => {
    const state = { full: true, launches: 0 };
    const h = await track({ wrapRuntime: (fake) => fleetLike(fake, state) });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 1 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(6 * 60 * 60 * 1000);
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 0 });
    expect(failures(h, t)).toEqual([]);
  });

  it("fails the attempt as fleet_capacity_timeout after the total wait, then retries or gives up", async () => {
    const state = { full: true, launches: 0 };
    const WAIT = 30 * 60 * 1000;
    const h = await track({
      wrapRuntime: (fake) => fleetLike(fake, state),
      overrides: { capacityWaitMs: WAIT },
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(WAIT - 1000);
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 0 });
    expect(failures(h, t)).toEqual([]);
    await h.advance(1000);
    await h.tick();
    expect(failures(h, t)).toEqual([
      expect.objectContaining({ reason: "fleet_capacity_timeout", attempt: 0, retryable: true }),
    ]);
    // The normal retry path (after its backoff): the next attempt waits again, from zero.
    await h.advance(2000);
    await h.tick();
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 1 });
    await h.advance(WAIT);
    await h.tick();
    expect(failures(h, t)).toHaveLength(2);
    expect(failures(h, t)[1]).toMatchObject({
      reason: "fleet_capacity_timeout",
      attempt: 1,
      retryable: false,
    });
    await h.tick();
    expect(h.task(t).status).toBe("failed");
    expect(state.launches).toBe(0);
    expect(h.app.mimir.readModel.sessions.size).toBe(0);
    expect(h.app.mimir.orchestrator.capacityWaiting()).toEqual([]);
  });
});

describe("a session that cannot be created for a verification retry (A5)", () => {
  it("uses one attempt for the failed verification, not two", async () => {
    let refuse = 0;
    const verifier = new ScriptedVerifier(["fail", "pass"]);
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) =>
        launching(fake, () => {
          if (refuse > 0) {
            refuse -= 1;
            throw new Error("worker offline");
          }
        }),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    refuse = 1;
    await h.advance(1000);
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    expect(failures(h, t)).toEqual([
      expect.objectContaining({ from: "verifying", attempt: 0, retryable: true }),
    ]);
    expect(failures(h, t)[0]!.reason).toMatch(/^session_create_failed: /);
    // With two attempts allowed the second one still runs (it would not if two had been used).
    await until(h, t, "completed");
    expect(h.task(t).attempt).toBe(1);
  });
});

describe("the brief of an attempt after a failed verification (A7)", () => {
  it("tells an agent what failed, bounded and redacted; shell commands are left alone", async () => {
    const specs: RuntimeSessionSpec[] = [];
    const verifier = new ScriptedVerifier(["fail", "pass"]);
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => launching(fake, (spec) => specs.push(spec)),
    });
    const p = await h.post("/v1/projects", {
      name: "demo",
      repoPath: h.repo,
      settings: { testCommand: FAST_TEST_COMMAND },
    });
    const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
    const missionId = m.json.mission.id as string;
    await h.post("/v1/crews", {
      missionId,
      template: "solo",
      limits: { maxAttemptsPerTask: 3 },
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const t = await createTask(h, missionId, "T", "Make the parser accept trailing commas");
    await h.post(`/v1/missions/${missionId}/start`);
    await until(h, t, "completed");
    expect(specs).toHaveLength(2);
    const [first, second] = specs.map((s) => s.argv.at(-1)!);
    expect(first).toContain("Make the parser accept trailing commas");
    expect(first).not.toContain("failed verification");
    expect(second).toContain("Make the parser accept trailing commas");
    expect(second).toContain("The previous attempt failed verification");
    expect(second).toContain("`make test` exited 2");
    expect(second).toContain("TestParse: want 3 got 4");
    expect(second).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    // One argv word without control characters (some runtimes type it into a terminal).
    expect([...second!].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)).toBe(
      true,
    );
    expect(second!.length).toBeLessThan(first!.length + 2000);
    // After a restart the note is rebuilt from the stored events; a pass clears it.
    expect(h.app.mimir.readModel.verificationFailure(t)).toEqual([]);
  });

  it("quotes the end of a long output, where runners print the failure summary", async () => {
    const specs: RuntimeSessionSpec[] = [];
    const output = `${"compiling module\n".repeat(4000)}FAIL TestParse: want 3 got 4\nFAILED 1 of 212 tests\n`;
    expect(output.length).toBeGreaterThan(EVENT_OUTPUT_CAP * 4);
    const h = await track({
      overrides: { verifier: new ScriptedVerifier(["fail", "pass"], `first line\n${output}`) },
      wrapRuntime: (fake) => launching(fake, (spec) => specs.push(spec)),
    });
    const p = await h.post("/v1/projects", {
      name: "demo",
      repoPath: h.repo,
      settings: { testCommand: FAST_TEST_COMMAND },
    });
    const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
    const missionId = m.json.mission.id as string;
    await h.post("/v1/crews", {
      missionId,
      template: "solo",
      limits: { maxAttemptsPerTask: 3 },
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const t = await createTask(h, missionId, "T", "Fix the parser");
    await h.post(`/v1/missions/${missionId}/start`);
    await until(h, t, "completed");
    const stored = h
      .events(["test.run_completed"])
      .map((e) => (e.payload as { output: string }).output)[0]!;
    expect(stored.length).toBeLessThanOrEqual(EVENT_OUTPUT_CAP);
    expect(stored.startsWith("first line\n")).toBe(true);
    expect(stored).toMatch(/\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
    expect(stored.endsWith("FAILED 1 of 212 tests\n")).toBe(true);
    const brief = specs[1]!.argv.at(-1)!;
    expect(brief).toContain("FAIL TestParse: want 3 got 4 FAILED 1 of 212 tests");
    expect(brief).not.toContain("bytes omitted");
  });

  it("treats explicit argv equal to the plain template as a template task: sandbox overrides and the note", async () => {
    const specs: RuntimeSessionSpec[] = [];
    const h = await track({
      overrides: { verifier: new ScriptedVerifier(["fail", "pass"]) },
      wrapRuntime: (fake) => launching(fake, (spec) => specs.push(spec)),
    });
    const p = await h.post("/v1/projects", {
      name: "demo",
      repoPath: h.repo,
      settings: {
        testCommand: FAST_TEST_COMMAND,
        agent: { codexSandbox: { writableRoots: ["/var/cache/go-build"], networkAccess: true } },
      },
    });
    const m = await h.post("/v1/missions", { projectId: p.json.project.id, objective: "o" });
    const missionId = m.json.mission.id as string;
    const c = await h.post("/v1/crews", {
      missionId,
      template: "solo",
      limits: { maxAttemptsPerTask: 3 },
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const created = await h.post("/v1/tasks", {
      missionId,
      crewId: c.json.crew.id,
      title: "T",
      brief: "Fix it",
      argv: argvFor("codex", "implementer", "Fix it"),
    });
    expect(created.status).toBe(201);
    const t = created.json.task.id as string;
    await h.post(`/v1/missions/${missionId}/start`);
    await until(h, t, "completed");
    expect(h.events(["task.blocked", "approval.requested", "policy.denied"])).toEqual([]);
    expect(specs).toHaveLength(2);
    for (const spec of specs) {
      expect(spec.argv.slice(0, -1)).toEqual([
        "codex",
        "exec",
        "--sandbox",
        "workspace-write",
        "--json",
        "-c",
        'sandbox_workspace_write.writable_roots=["/var/cache/go-build"]',
        "-c",
        "sandbox_workspace_write.network_access=true",
      ]);
    }
    expect(specs[0]!.argv.at(-1)).not.toContain("failed verification");
    expect(specs[1]!.argv.at(-1)).toContain("The previous attempt failed verification");
  });

  it("is rebuilt after a restart and never changes a shell member's command", async () => {
    const specs: RuntimeSessionSpec[] = [];
    const h = await track({
      overrides: { verifier: new ScriptedVerifier(["fail"]) },
      wrapRuntime: (fake) => launching(fake, (spec) => specs.push(spec)),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await until(h, t, "failed");
    expect(specs.map((s) => s.argv)).toEqual([
      ["sh", "-c", "echo t"],
      ["sh", "-c", "echo t"],
    ]);
    const before = h.app.mimir.readModel.verificationFailure(t);
    expect(before).toEqual([expect.objectContaining({ command: "make test", exitCode: 2 })]);
    await h.restart();
    expect(h.app.mimir.readModel.verificationFailure(t)).toEqual(before);
  });

  it("bounds the note", () => {
    expect(verificationFailureNote([])).toBeUndefined();
    const note = verificationFailureNote([
      { command: "make test", exitCode: null, outputTail: "x\ty\r\nz" },
    ]);
    expect(note).toContain("`make test` was killed (timeout or signal)");
    expect(note).toContain("x y z");
  });
});

describe("project agent settings reach sessions and verification (Part B)", () => {
  it("passes env, PATH entries, Codex sandbox overrides and the verification time limit", async () => {
    const specs: RuntimeSessionSpec[] = [];
    const verifier = new ScriptedVerifier(["pass"]);
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => launching(fake, (spec) => specs.push(spec)),
    });
    const agent = {
      env: { GOCACHE: "/var/cache/go-build" },
      pathPrepend: ["/opt/mise/shims"],
      codexSandbox: { writableRoots: ["/var/cache/go-build"], networkAccess: true },
    };
    const p = await h.post("/v1/projects", {
      name: "demo",
      repoPath: h.repo,
      settings: { testCommand: FAST_TEST_COMMAND },
    });
    const projectId = p.json.project.id as string;
    // Settings change after creation; what is launched afterwards uses them.
    const patched = await h.app.inject({
      method: "PATCH",
      url: `/v1/projects/${projectId}`,
      headers: { authorization: "Bearer test-token-0123456789", "idempotency-key": h.key() },
      payload: {
        settings: { testCommand: FAST_TEST_COMMAND, agent, verificationTimeoutMs: 1_800_000 },
      },
    });
    expect(patched.statusCode).toBe(200);
    const m = await h.post("/v1/missions", { projectId, objective: "o" });
    const missionId = m.json.mission.id as string;
    await h.post("/v1/crews", {
      missionId,
      template: "solo",
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const t = await createTask(h, missionId, "T", "Fix it");
    await h.post(`/v1/missions/${missionId}/start`);
    await until(h, t, "completed");

    expect(specs).toHaveLength(1);
    expect(specs[0]!.agentEnv).toEqual({ env: agent.env, pathPrepend: agent.pathPrepend });
    expect(specs[0]!.env).toEqual({ MIMIR_TASK_ID: t, MIMIR_MISSION_ID: missionId });
    expect(specs[0]!.argv.slice(0, -1)).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "workspace-write",
      "--json",
      "-c",
      'sandbox_workspace_write.writable_roots=["/var/cache/go-build"]',
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
    expect(verifier.inputs).toHaveLength(1);
    expect(verifier.inputs[0]).toMatchObject({
      timeoutMs: 1_800_000,
      env: {
        GOCACHE: "/var/cache/go-build",
        PATH: `/opt/mise/shims:${process.env["PATH"] ?? ""}`,
      },
    });
  });

  it("adds nothing for a project without agent settings", async () => {
    const specs: RuntimeSessionSpec[] = [];
    const verifier = new ScriptedVerifier(["pass"]);
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => launching(fake, (spec) => specs.push(spec)),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await until(h, t, "completed");
    expect("agentEnv" in specs[0]!).toBe(false);
    expect("env" in verifier.inputs[0]!).toBe(false);
    expect("timeoutMs" in verifier.inputs[0]!).toBe(false);
  });
});
