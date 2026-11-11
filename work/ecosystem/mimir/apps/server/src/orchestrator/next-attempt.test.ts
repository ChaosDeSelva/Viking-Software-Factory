import type { FakeRuntime } from "@mimir/fake-runtime";
import { newId, type RuntimeAdapter } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writingRuntime } from "./test-agent-files.js";
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

const harnesses: Harness[] = [];
const track = async (opts?: HarnessOptions) => {
  const h = await harness(opts);
  harnesses.push(h);
  return h;
};
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const result = (passed: boolean): VerificationResult => ({
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
      output: passed ? "ok" : "FAIL",
    },
  ],
});

/** Each verification waits until the test answers it (or the server aborts it). */
class GatedVerifier implements Verifier {
  readonly inputs: VerifyInput[] = [];
  private waiting: ((r: VerificationResult) => void)[] = [];
  verify(input: VerifyInput): Promise<VerificationResult> {
    this.inputs.push(input);
    return new Promise((resolve, reject) => {
      this.waiting.push(resolve);
      input.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }
  get pending(): number {
    return this.waiting.length;
  }
  answer(passed: boolean): void {
    const next = this.waiting.shift();
    if (!next) throw new Error("no verification is waiting");
    next(result(passed));
  }
}

/** The fake, counting the sessions it is asked to create. */
function counting(fake: FakeRuntime, launches: string[]): RuntimeAdapter {
  const base = writingRuntime(fake, () => undefined);
  return {
    ...base,
    createSession: (spec) => {
      launches.push(spec.sessionId);
      return fake.createSession(spec);
    },
  };
}

/** Starts the mission and runs its one task until its first verification waits for an answer. */
async function untilVerifying(h: Harness, verifier: GatedVerifier, missionId: string) {
  await h.post(`/v1/missions/${missionId}/start`);
  await h.app.mimir.orchestrator.tick();
  // `h.advance` would wait for the held verification: move the clock and poll instead.
  for (let i = 0; i < 400 && verifier.pending === 0; i++) {
    h.clock.advance(250);
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(verifier.pending).toBe(1);
}

/** Ticks and advances until the task is in `status` (bounded); answers held verifications. */
async function until(h: Harness, verifier: GatedVerifier, taskId: string, status: string) {
  for (let i = 0; i < 400 && h.task(taskId).status !== status; i++) {
    await h.app.mimir.orchestrator.tick();
    h.clock.advance(1000);
    await new Promise((r) => setTimeout(r, 25));
    if (verifier.pending > 0) verifier.answer(true);
  }
  expect(h.task(taskId).status).toBe(status);
}

describe("the next attempt after a failed verification is launched like any dispatch", () => {
  it("starts no session while the mission is paused; the attempt runs after resume", async () => {
    const verifier = new GatedVerifier();
    const launches: string[] = [];
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => counting(fake, launches),
    });
    const { missionId } = await setupMission(h, { maxAttemptsPerTask: 3 });
    const t = await createTask(h, missionId, "T", "echo t");
    await untilVerifying(h, verifier, missionId);
    expect(launches).toHaveLength(1);

    expect((await h.post(`/v1/missions/${missionId}/pause`)).status).toBe(202);
    verifier.answer(false);
    await h.idle();

    // The failed verification used its attempt; nothing new runs in a paused mission.
    expect(launches).toHaveLength(1);
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    expect(h.events(["task.failed"]).at(-1)?.payload).toMatchObject({
      from: "verifying",
      reason: "verification_failed",
      retryable: true,
    });
    for (let i = 0; i < 5; i++) {
      await h.tick();
      await h.advance(60_000);
    }
    expect(launches).toHaveLength(1);

    expect((await h.post(`/v1/missions/${missionId}/resume`)).status).toBe(202);
    await until(h, verifier, t, "completed");
    expect(launches).toHaveLength(2);
    expect(h.task(t).attempt).toBe(1);
  });

  it("starts no session for a crew whose scheduling is paused", async () => {
    const verifier = new GatedVerifier();
    const launches: string[] = [];
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => counting(fake, launches),
    });
    const { missionId, crewId } = await setupMission(h, { maxAttemptsPerTask: 3 });
    const t = await createTask(h, missionId, "T", "echo t");
    await untilVerifying(h, verifier, missionId);

    expect((await h.post(`/v1/crews/${crewId}/pause`)).status).toBe(200);
    verifier.answer(false);
    await h.idle();
    for (let i = 0; i < 5; i++) {
      await h.tick();
      await h.advance(60_000);
    }
    expect(launches).toHaveLength(1);
    expect(h.task(t).status).toBe("ready");

    expect((await h.post(`/v1/crews/${crewId}/resume`)).status).toBe(200);
    await until(h, verifier, t, "completed");
    expect(launches).toHaveLength(2);
  });

  it("starts no session once a hard budget is exhausted: the task is parked on the budget", async () => {
    const verifier = new GatedVerifier();
    const launches: string[] = [];
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => counting(fake, launches),
    });
    const { missionId } = await setupMission(
      h,
      { maxAttemptsPerTask: 3 },
      {},
      { limitTokens: 100, onUnknown: "allow" },
    );
    const t = await createTask(h, missionId, "T", "echo t");
    await untilVerifying(h, verifier, missionId);
    // The first attempt used more than the whole budget (measured usage, as an adapter reports it).
    const { agentId } = h.events(["task.started"])[0]!.payload as { agentId: string };
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
          tokens: 500,
          estimatedCost: null,
          source: "measured",
          createdAt: at,
          updatedAt: at,
          version: 0,
        },
      },
    });

    verifier.answer(false);
    await h.idle();
    for (let i = 0; i < 5; i++) {
      await h.tick();
      await h.advance(60_000);
    }
    expect(launches).toHaveLength(1);
    expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "budget_exceeded" });
  });

  it("still continues in place when nothing holds the task back", async () => {
    const verifier = new GatedVerifier();
    const launches: string[] = [];
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => counting(fake, launches),
    });
    const { missionId } = await setupMission(
      h,
      { maxAttemptsPerTask: 3 },
      {},
      { limitTokens: 100_000, onUnknown: "allow" },
    );
    const t = await createTask(h, missionId, "T", "echo t");
    await untilVerifying(h, verifier, missionId);
    verifier.answer(false);
    await h.idle();
    // verifying -> running on the next attempt, without going through failed/ready.
    expect(launches).toHaveLength(2);
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
    expect(h.events(["task.failed"])).toHaveLength(0);
  });
});
