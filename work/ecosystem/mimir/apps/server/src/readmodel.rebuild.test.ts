import { afterEach, expect, it, vi } from "vitest";
import { createTask, harness, setupMission, type Harness } from "../test/orchestration-support.js";
import type { VerificationResult, Verifier } from "./orchestrator/verifier.js";
import { ReadModel } from "./readmodel.js";

// Integration: real git worktrees and a server boot (slow on a busy host).
vi.setConfig({ testTimeout: 180_000 });

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Fails the first verification of each task, passes the rest. */
class FailOnceVerifier implements Verifier {
  private readonly seen = new Set<string>();
  async verify(input: { taskId: string }): Promise<VerificationResult> {
    const passed = this.seen.has(input.taskId);
    this.seen.add(input.taskId);
    return {
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
          output: passed ? "ok" : "FAIL: expected 2, got 3",
        },
      ],
    };
  }
}

/** Everything the model projects, including what only accessors expose. */
function state(rm: ReadModel) {
  const maps = Object.fromEntries(
    Object.entries(rm)
      .filter(([, v]) => v instanceof Map)
      .map(([k, v]) => [k, [...(v as Map<string, unknown>).entries()].sort()]),
  );
  const tasks = [...rm.tasks.keys()].sort();
  return {
    maps,
    failures: tasks.map((t) => rm.verificationFailure(t)),
    specs: tasks.map((t) => rm.taskSpec(t)),
    snapshot: rm.snapshot(),
  };
}

it("a model rebuilt from the log equals the one kept current while the server ran", async () => {
  const h = await harness({ overrides: { verifier: new FailOnceVerifier() } });
  harnesses.push(h);
  const { projectId, missionId, crewId } = await setupMission(h, { maxAttemptsPerTask: 3 });
  const first = await createTask(h, missionId, "first", "echo one");
  const second = await createTask(h, missionId, "second", "echo two", [first]);
  await h.post(`/v1/crews/${crewId}/pause`);
  await h.post(`/v1/crews/${crewId}/resume`);
  await h.post(`/v1/missions/${missionId}/start`);
  for (let i = 0; i < 12 && h.task(second).status !== "completed"; i++) {
    await h.tick();
    await h.advance(1000);
  }
  expect(h.task(first).status).toBe("completed");
  expect(h.task(second).status).toBe("completed");
  const pr = await h.post(`/v1/tasks/${second}/pr`);
  expect(pr.json).toMatchObject({ status: "approval_required" });
  await h.post(`/v1/approvals/${pr.json.approvalId}/decision`, { decision: "rejected" });
  await h.app.inject({
    method: "PATCH",
    url: `/v1/projects/${projectId}`,
    headers: { authorization: "Bearer test-token-0123456789", "idempotency-key": h.key() },
    payload: { settings: { testCommand: ["cat", "package.json"], harnessRef: "v2" } },
  });
  // A failed verification was recorded on the way (and cleared by the pass after it).
  expect(h.events(["test.run_completed"]).length).toBeGreaterThanOrEqual(2);

  const live = state(h.app.mimir.readModel);
  const rebuilt = ReadModel.load(h.store);
  try {
    expect(state(rebuilt)).toEqual(live);
  } finally {
    rebuilt.detach();
  }
});
