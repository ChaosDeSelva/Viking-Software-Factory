import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FakeRuntime } from "@mimir/fake-runtime";
import { MimirError, type RuntimeAdapter, type RuntimeSessionSpec } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPACITY_RETRY_MS, verificationFailureNote } from "./orchestrator.js";
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
  constructor(private readonly results: readonly ("pass" | "fail")[]) {}
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
          output: passed
            ? "ok"
            : "running suite\n\u001b[31mFAIL\u001b[0m TestParse: want 3 got 4\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n",
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
