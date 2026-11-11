import type { FakeRuntime } from "@mimir/fake-runtime";
import { MimirError, newId, type RuntimeAdapter } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrRequest, PrRunner } from "./pr.js";
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

/** The fake, with `requestStop` answers a test chooses (undefined: the fake's own). */
function stopping(
  fake: FakeRuntime,
  answer: (mode: "soft" | "force", n: number) => Error | undefined,
): RuntimeAdapter {
  let n = 0;
  return {
    ...writingRuntime(fake, () => undefined),
    requestStop: (id, mode) => {
      const err = answer(mode, n++);
      return err ? Promise.reject(err) : fake.requestStop(id, mode);
    },
  };
}

async function runningSession(h: Harness, maxAttemptsPerTask = 1) {
  const { missionId } = await setupMission(h, { maxAttemptsPerTask });
  const t = await createTask(h, missionId, "T", "echo t");
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(200);
  expect(h.task(t).status).toBe("running");
  return { missionId, t, s: h.events(["session.requested"])[0]!.sessionId! };
}

const decide = (h: Harness, id: string, decision: "approved" | "rejected" = "approved") =>
  h.post(`/v1/approvals/${id}/decision`, { decision });

describe("stopping a session", () => {
  it("refuses a force stop that policy denies, and records the denial", async () => {
    const h = await track({
      script: LONG_RUNNING,
      policies: [{ id: "no-force", action: "runtime.force_stop", effect: "deny" }],
    });
    const { s } = await runningSession(h);
    const res = await h.post(`/v1/sessions/${s}/stop`, { mode: "force" });
    expect(res.status).toBe(403);
    expect(res.json.error.details).toMatchObject({ action: "runtime.force_stop" });
    expect(h.events(["policy.denied"]).map((e) => e.payload)).toEqual([
      expect.objectContaining({ action: "runtime.force_stop" }),
    ]);
    expect(h.events(["approval.requested"])).toEqual([]);
    expect((await h.fake.getSession(s))?.state).toBe("running");
  });

  it("asks for a force-stop approval when a soft stop cannot be confirmed", async () => {
    const h = await track({
      script: LONG_RUNNING,
      wrapRuntime: (fake) =>
        stopping(fake, (mode, n) =>
          mode === "soft"
            ? new MimirError("conflict", "stop not confirmed", { retryable: true })
            : n === 1
              ? new MimirError("internal", "tmux crashed")
              : undefined,
        ),
    });
    const { s } = await runningSession(h);
    const res = await h.post(`/v1/sessions/${s}/stop`, { mode: "soft" });
    expect(res.status).toBe(403);
    const approvalId = res.json.error.details.approvalId as string;
    const [requested] = h.events(["approval.requested"]);
    expect(requested?.payload).toMatchObject({
      approvalId,
      action: "runtime.force_stop",
      subject: `stop:${s}`,
    });
    expect((requested?.payload as { reason: string }).reason).toMatch(/soft stop unconfirmed/);

    // The approved force stop fails once; the approval stays usable for the next escalation.
    expect((await decide(h, approvalId)).status).toBe(500);
    expect((await h.post(`/v1/sessions/${s}/stop`, { mode: "soft" })).status).toBe(202);
    await h.idle();
    expect((await h.fake.getSession(s))?.state).toBe("stopped");
    expect(h.events(["approval.consumed"]).map((e) => e.payload)).toEqual([
      { approvalId, subject: `stop:${s}` },
    ]);
  });

  it("passes on a runtime error that is not an unconfirmed stop", async () => {
    const h = await track({
      script: LONG_RUNNING,
      wrapRuntime: (fake) =>
        stopping(fake, (_mode, n) =>
          n === 0
            ? new MimirError("conflict", "session is busy")
            : new MimirError("not_found", "no such pane"),
        ),
    });
    const { s } = await runningSession(h);
    expect((await h.post(`/v1/sessions/${s}/stop`, { mode: "soft" })).status).toBe(409);
    expect((await h.post(`/v1/sessions/${s}/stop`, { mode: "soft" })).status).toBe(404);
    expect(h.events(["approval.requested"])).toEqual([]);
  });

  it("keeps a force-stop approval usable when the stop failed, and consumes it on the retry", async () => {
    const h = await track({
      script: LONG_RUNNING,
      wrapRuntime: (fake) =>
        stopping(fake, (mode, n) =>
          mode === "force" && n === 0 ? new MimirError("internal", "tmux crashed") : undefined,
        ),
    });
    const { s } = await runningSession(h);
    const first = await h.post(`/v1/sessions/${s}/stop`, { mode: "force" });
    expect(first.status).toBe(403);
    const approvalId = first.json.error.details.approvalId as string;
    expect((await decide(h, approvalId)).status).toBe(500);
    expect(h.events(["approval.consumed"])).toEqual([]);

    expect((await h.post(`/v1/sessions/${s}/stop`, { mode: "force" })).status).toBe(202);
    await h.idle();
    expect((await h.fake.getSession(s))?.state).toBe("stopped");
    expect(h.events(["approval.consumed"]).map((e) => e.payload)).toEqual([
      { approvalId, subject: `stop:${s}` },
    ]);
    // Spent: the next force stop needs a new approval.
    expect((await h.post(`/v1/sessions/${s}/stop`, { mode: "force" })).status).toBe(403);
  });
});

/** A pull-request runner that is available and fails its first `create`. */
class FlakyPr implements PrRunner {
  readonly requests: PrRequest[] = [];
  available(): Promise<boolean> {
    return Promise.resolve(true);
  }
  create(request: PrRequest): Promise<{ output: string }> {
    this.requests.push(request);
    return this.requests.length === 1
      ? Promise.reject(new Error("gh: not logged in"))
      : Promise.resolve({ output: "https://example.invalid/pr/1\n" });
  }
}

describe("delivering a completed task", () => {
  it("opens a pull request once approved, keeping the approval when the first try fails", async () => {
    const pr = new FlakyPr();
    const h = await track({ overrides: { prRunner: pr } });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "Add parser", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");

    const asked = await h.post(`/v1/tasks/${t}/pr`, {});
    expect(asked.json).toMatchObject({ status: "approval_required" });
    expect((await decide(h, asked.json.approvalId as string)).status).toBe(500);
    const delivered = await h.post(`/v1/tasks/${t}/pr`, {});
    expect(delivered.json).toMatchObject({ status: "delivered" });

    // No acceptance text: the title is the body.
    expect(pr.requests.map((r) => [r.title, r.body])).toEqual([
      ["Add parser", "Add parser"],
      ["Add parser", "Add parser"],
    ]);
    const kinds = h.events(["artifact.recorded"]).map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toContain("pr.created");
    expect(h.events(["approval.consumed"])).toHaveLength(1);
  });

  it("refuses a local delivery while another task of the mission has no verified result", async () => {
    const h = await track();
    const { missionId } = await setupMission(h);
    const a = await createTask(h, missionId, "A", "echo a");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(a).status).toBe("completed");
    await createTask(h, missionId, "B", "echo b");

    const asked = await h.post(`/v1/tasks/${a}/pr`, {});
    const res = await decide(h, asked.json.approvalId as string);
    expect(res.status).toBe(409);
    expect(res.json.error.message).toMatch(/every mission task to have a verified result/);
    const kinds = h.events(["artifact.recorded"]).map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).not.toContain("local_delivery");
  });

  it("cancels only the unfinished tasks of a mission", async () => {
    const h = await track();
    const { missionId } = await setupMission(h);
    const a = await createTask(h, missionId, "A", "echo a");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(a).status).toBe("completed");
    const b = await createTask(h, missionId, "B", "echo b");
    expect((await h.post(`/v1/missions/${missionId}/cancel`, {})).status).toBe(202);
    expect([h.task(a).status, h.task(b).status]).toEqual(["completed", "cancelled"]);
    expect(h.events(["task.cancelled"]).map((e) => e.taskId)).toEqual([b]);
  });
});

/** Passes every verification; while `hold` is set one only ends when aborted (then it passes). */
class HoldingVerifier implements Verifier {
  readonly inputs: VerifyInput[] = [];
  hold = false;
  verify(input: VerifyInput): Promise<VerificationResult> {
    this.inputs.push(input);
    const passed: VerificationResult = { source: "test-command", passed: true, checks: [] };
    if (!this.hold) return Promise.resolve(passed);
    return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(passed)));
  }
}

describe("rechecking a settled task", () => {
  it("allows one recheck at a time and reports one cut off by a shutdown", async () => {
    const verifier = new HoldingVerifier();
    const h = await track({ overrides: { verifier } });
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    expect(h.task(t).status).toBe("completed");

    verifier.hold = true;
    const orchestrator = h.app.mimir.orchestrator;
    const first = orchestrator.recheckVerification(t);
    const until = Date.now() + 60_000;
    while (verifier.inputs.length < 2 && Date.now() < until)
      await new Promise((r) => setTimeout(r, 25));
    expect(verifier.inputs).toHaveLength(2);
    const second = await h.post(`/v1/tasks/${t}/verify`, {});
    expect(second.status).toBe(409);
    expect(second.json.error.message).toMatch(/already running/);

    await h.app.close();
    await expect(first).rejects.toThrow("recheck interrupted");
    await h.restart();
  });

  it("gates an unclassified test command: approval per recheck, and a deny rule wins", async () => {
    const h = await track();
    // An older store's project: today's API refuses a test command that is not allowlisted.
    const at = new Date().toISOString();
    const projectId = newId("prj");
    h.store.append({
      streamId: `project:${projectId}`,
      type: "project.created",
      source: "test",
      provenance: "derived",
      occurredAt: at,
      observedAt: at,
      payload: {
        project: {
          id: projectId,
          name: "legacy",
          repoPath: h.repo,
          settings: { testCommand: ["sh", "-c", "exit 0"] },
          createdAt: at,
          updatedAt: at,
          version: 0,
        },
      },
    });
    const m = await h.post("/v1/missions", {
      projectId,
      objective: "o",
      tasks: [{ title: "T", brief: "echo t" }],
    });
    await h.post("/v1/crews", {
      missionId: m.json.mission.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "shell" }],
    });
    const t = m.json.tasks[0].id as string;
    await h.post(`/v1/missions/${m.json.mission.id}/start`);
    await h.tick();
    await h.advance(1000);
    // The verification itself needed an approval first.
    const verify = h.events(["approval.requested"])[0]!.payload as { approvalId: string };
    await decide(h, verify.approvalId);
    await h.idle();
    expect(h.task(t).status).toBe("completed");

    const asked = await h.post(`/v1/tasks/${t}/verify`, {});
    expect(asked.status).toBe(403);
    expect(asked.json.error.message).toMatch(/requires command approval/);
    expect((await h.post(`/v1/tasks/${t}/verify`, {})).status).toBe(403);
    const rechecks = h
      .events(["approval.requested"])
      .map((e) => e.payload as { approvalId: string; subject: string })
      .filter((p) => p.subject.startsWith("recheck:"));
    expect(rechecks).toHaveLength(1); // the pending one is reused

    await decide(h, rechecks[0]!.approvalId);
    await h.idle();
    expect(h.task(t).status).toBe("completed");
    const checked = await h.post(`/v1/tasks/${t}/verify`, {});
    expect(checked.status).toBe(200);
    expect(checked.json.passed).toBe(true);
    expect(
      h
        .events(["approval.consumed"])
        .map((e) => (e.payload as { subject: string }).subject)
        .filter((s) => s.startsWith("recheck:")),
    ).toHaveLength(1);

    await h.restart({
      policies: [{ id: "no-shell", action: "shell.unclassified", effect: "deny" }],
    });
    const denied = await h.post(`/v1/tasks/${t}/verify`, {});
    expect(denied.status).toBe(403);
    expect(denied.json.error.message).not.toMatch(/requires command approval/);
  });
});
