import type { FakeRuntime } from "@mimir/fake-runtime";
import type { RuntimeAdapter } from "@mimir/protocol";
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

const passed: VerificationResult = {
  source: "test-command",
  passed: true,
  checks: [
    {
      name: "test",
      command: ["make", "test"],
      passed: true,
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      output: "ok",
    },
  ],
};

/** Passes every verification; while `hold` is set a verification only ends when it is aborted. */
class HoldingVerifier implements Verifier {
  readonly inputs: VerifyInput[] = [];
  hold = false;
  verify(input: VerifyInput): Promise<VerificationResult> {
    this.inputs.push(input);
    if (input.signal.aborted) return Promise.reject(new Error("aborted"));
    if (!this.hold) return Promise.resolve(passed);
    return new Promise((_, reject) =>
      input.signal.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  }
}

/** The fake, with a `reconcile` a test can make fail. */
function flakyReconcile(fake: FakeRuntime, state: { fail: boolean }): RuntimeAdapter {
  return {
    ...writingRuntime(fake, () => undefined),
    reconcile: () =>
      state.fail ? Promise.reject(new Error("runtime unreachable")) : fake.reconcile(),
  };
}

const artifactsOf = (h: Harness, taskId: string, kind: string) =>
  h
    .events(["artifact.recorded"])
    .filter((e) => e.taskId === taskId && (e.payload as { kind: string }).kind === kind);

describe("boot recovery of a task that was being verified", () => {
  it("verifies it again even when the runtime cannot be reconciled at boot", async () => {
    const verifier = new HoldingVerifier();
    const reconcile = { fail: false };
    const h = await track({
      overrides: { verifier },
      wrapRuntime: (fake) => flakyReconcile(fake, reconcile),
    });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    verifier.hold = true;
    await h.app.mimir.orchestrator.tick();
    // The session runs to completion; the verification then hangs until the server stops.
    for (let i = 0; i < 200 && verifier.inputs.length === 0; i++) {
      h.clock.advance(1000);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(h.task(t).status).toBe("verifying");
    expect(verifier.inputs).toHaveLength(1);

    verifier.hold = false;
    reconcile.fail = true; // the runtime is down while the server boots
    await h.restart();
    await h.idle();

    expect(verifier.inputs).toHaveLength(2);
    expect(h.task(t).status).toBe("completed");
  });

  it("runs one verification for a session that completed while the server was down", async () => {
    const verifier = new HoldingVerifier();
    const h = await track({ overrides: { verifier } });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    expect(h.task(t).status).toBe("running");

    await h.app.close();
    h.clock.advance(1000); // the session completes; nobody is subscribed
    await h.restart();
    await h.idle();

    expect(h.task(t).status).toBe("completed");
    expect(verifier.inputs).toHaveLength(1);
    expect(artifactsOf(h, t, "diff")).toHaveLength(1);
    expect(artifactsOf(h, t, "changed-files")).toHaveLength(1);
  });
});
