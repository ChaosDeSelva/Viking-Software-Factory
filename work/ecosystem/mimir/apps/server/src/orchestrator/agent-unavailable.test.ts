import type { FakeRuntime } from "@mimir/fake-runtime";
import type { RuntimeAdapter, RuntimeSessionSpec } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writingRuntime } from "./test-agent-files.js";
import { FAST_TEST_COMMAND, createTask, harness, type Harness } from "./test-harness.js";
import type { VerificationResult, Verifier, VerifyInput } from "./verifier.js";

// Integration tests: real git worktrees and server boots (slow on a busy host).
vi.setConfig({ testTimeout: 120_000 });

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** Claude Code's answer when its plan's weekly limit is used up (resets 2026-11-16 23:00 UTC). */
const LIMIT = JSON.stringify({
  type: "assistant",
  error: "rate_limit",
  api_error_status: 429,
  api_error: "usage_limit_reached",
  api_error_params: { rate_limit_info: { status: "rejected", resetsAt: 1794870000 } },
  message: { model: "<synthetic>", content: [] },
});

/** The fake, where every `limited` agent's session says it hit its usage limit. */
function limitedRuntime(
  fake: FakeRuntime,
  limited: Set<string>,
  launches: RuntimeSessionSpec[],
): RuntimeAdapter {
  const base = writingRuntime(fake, () => undefined);
  const kinds = new Map<string, string>();
  return {
    ...base,
    createSession: async (spec) => {
      launches.push(spec);
      kinds.set(spec.sessionId, spec.agentKind);
      return fake.createSession(spec);
    },
    subscribe: (handler) =>
      base.subscribe((e) =>
        handler(
          e.kind === "session.output" && limited.has(kinds.get(e.sessionId) ?? "")
            ? { ...e, text: `${LIMIT}\n` }
            : e,
        ),
      ),
  };
}

async function mission(h: Harness, agentKinds: string[]) {
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
    limits: { maxAttemptsPerTask: 2 },
    members: agentKinds.map((agentKind) => ({ role: "implementer", agentKind })),
  });
  const taskId = await createTask(h, missionId, "Write the plan", "Write the plan");
  await h.post(`/v1/missions/${missionId}/start`);
  return { missionId, taskId };
}

async function settle(h: Harness, done: () => boolean) {
  for (let i = 0; i < 40 && !done(); i++) {
    await h.tick();
    await h.advance(1000);
  }
}

describe("an agent that cannot work (usage limit, login)", () => {
  it("parks the task without using an attempt or failing the mission, until the limit resets", async () => {
    const launches: RuntimeSessionSpec[] = [];
    const h = await harness({
      wrapRuntime: (fake) => limitedRuntime(fake, new Set(["claude"]), launches),
    });
    harnesses.push(h);
    const { missionId, taskId } = await mission(h, ["claude"]);
    await settle(h, () => h.task(taskId).status === "blocked");
    const task = h.task(taskId);
    expect(task).toMatchObject({
      status: "blocked",
      blockedReason: "agent_unavailable",
      blockedUntil: "2026-11-16T23:00:00.000Z",
      attempt: 0,
    });
    expect(h.events(["task.failed"]).filter((e) => e.taskId === taskId)).toEqual([]);
    expect(h.app.mimir.readModel.missions.get(missionId)?.status).toBe("active");
    // The only agent is still limited: nothing is launched again before the reset.
    const before = launches.length;
    await settle(h, () => false);
    expect(launches.length).toBe(before);
  });

  it("runs the task on the crew's other agent at once, as the same attempt", async () => {
    const launches: RuntimeSessionSpec[] = [];
    const h = await harness({
      wrapRuntime: (fake) => limitedRuntime(fake, new Set(["claude"]), launches),
    });
    harnesses.push(h);
    const { taskId } = await mission(h, ["claude", "codex"]);
    await settle(h, () => h.task(taskId).status === "completed");
    expect(h.task(taskId).status).toBe("completed");
    expect(launches.map((s) => s.agentKind)).toEqual(["claude", "codex"]);
    // The fallback is not an extra attempt.
    expect(h.task(taskId).attempt).toBe(0);
    expect(h.events(["task.blocked"]).map((e) => (e.payload as { reason: string }).reason)).toEqual(
      ["agent_unavailable"],
    );
  });
});

/** Fails verification for task titles in `failing` (while `failing` holds them), passes the rest. */
class TitleVerifier implements Verifier {
  constructor(
    private readonly h: () => Harness,
    readonly failing: Set<string>,
  ) {}
  verify(input: VerifyInput): Promise<VerificationResult> {
    const title = this.h().task(input.taskId).title;
    const passed = !this.failing.has(title);
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
          output: passed ? "ok" : "FAIL",
        },
      ],
    });
  }
}

describe("restarting an ended mission", () => {
  it("reruns only what did not finish, with fresh attempts, and leaves completed work alone", async () => {
    const launches: RuntimeSessionSpec[] = [];
    const ref: { h?: Harness } = {};
    const verifier = new TitleVerifier(() => ref.h!, new Set(["Write"]));
    const h = await harness({
      overrides: { verifier },
      wrapRuntime: (fake) => limitedRuntime(fake, new Set(), launches),
    });
    ref.h = h;
    harnesses.push(h);
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
      limits: { maxAttemptsPerTask: 1 },
      members: [{ role: "implementer", agentKind: "codex" }],
    });
    const research = await createTask(h, missionId, "Research", "Read the code");
    const write = await createTask(h, missionId, "Write", "Write the plan", [research]);
    await h.post(`/v1/missions/${missionId}/start`);
    const mission = () => h.app.mimir.readModel.missions.get(missionId)!;
    await settle(h, () => mission().status === "failed");
    expect(mission().status).toBe("failed");
    expect(h.task(research).status).toBe("completed");
    expect(h.task(write).status).toBe("failed");
    const researchRuns = launches.filter((s) => s.taskId === research).length;

    // Retrying a task of an ended mission is refused; reopening is the way back.
    expect((await h.post(`/v1/tasks/${write}/retry`)).status).toBe(409);
    verifier.failing.clear();
    const reopened = await h.post(`/v1/missions/${missionId}/reopen`, { reason: "limit reset" });
    expect(reopened.status).toBe(202);
    expect(mission().status).toBe("active");
    await settle(h, () => mission().status === "completed");
    expect(mission().status).toBe("completed");
    expect(h.task(write)).toMatchObject({ status: "completed", attempt: 1, maxAttempts: 2 });
    expect(launches.filter((s) => s.taskId === research).length).toBe(researchRuns);
    expect(
      h.events(["task.reopened"]).map((e) => [e.taskId, (e.payload as { to: string }).to]),
    ).toEqual([[write, "ready"]]);
  });
});
