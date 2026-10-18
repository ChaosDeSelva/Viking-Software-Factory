import { PRIVILEGED_ACTIONS } from "@mimir/core";
import { ArtifactKindSchema } from "@mimir/protocol";
import { openSse } from "@mimir/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH } from "../test-helpers.js";
import { createTask, harness, setupMission, type Harness } from "./test-harness.js";

// Integration tests: real git worktrees, npm verification and server boots (slow on a busy host).
vi.setConfig({ testTimeout: 120_000 });

/** C's command is destructive; the operator lets that class of command through with approval. */
const DESTRUCTIVE_NEEDS_APPROVAL = [
  {
    id: "test#destructive",
    action: "shell.destructive" as const,
    effect: "require_approval" as const,
  },
];

const harnesses: Harness[] = [];
const track = (h: Harness) => (harnesses.push(h), h);
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

const typesFor = (h: Harness, taskId: string) =>
  h
    .events()
    .filter((e) => e.taskId === taskId)
    .map((e) => e.type);

describe("orchestration end to end (FakeRuntime, temp git repo, in-memory store)", () => {
  it("runs A, B (after A) and approval-gated C to a completed mission", async () => {
    const h = track(await harness({ policies: DESTRUCTIVE_NEEDS_APPROVAL }));
    // this one verifies with the server default, `npm test` (the repo's passing test script)
    const { missionId } = await setupMission(h, {}, { testCommand: ["npm", "test"] });
    const a = await createTask(h, missionId, "Task A", "echo A");
    const b = await createTask(h, missionId, "Task B", "echo B", [a]);
    const c = await createTask(h, missionId, "Task C", "rm -rf build");
    expect((await h.post(`/v1/missions/${missionId}/start`)).status).toBe(202);

    // tick 1: A dispatched; C would be dispatched in the same tick but its command needs approval
    await h.tick();
    expect(h.task(a)).toMatchObject({ status: "running", attempt: 0 });
    expect(h.task(c)).toMatchObject({ status: "blocked", blockedReason: "approval_required" });
    expect(h.task(b).status).toBe("pending");
    expect(typesFor(h, a)).toEqual([
      "task.created",
      "task.ready",
      "task.leased",
      "git.worktree_created",
      "session.requested",
      "session.started",
      "task.started",
    ]);
    const pending = (await h.get("/v1/approvals?status=pending")).json.approvals;
    expect(pending).toEqual([
      expect.objectContaining({ action: "shell.destructive", taskId: c, status: "pending" }),
    ]);
    // the gated task never got a lease, worktree or session
    expect(typesFor(h, c)).toEqual([
      "task.created",
      "task.ready",
      "approval.requested",
      "task.blocked",
    ]);

    // A's fake session runs, completes; verification runs `npm test` in A's worktree
    await h.advance(1000);
    expect(h.task(a).status).toBe("completed");
    const runs = h.events(["test.run_completed"]);
    expect(runs).toEqual([
      expect.objectContaining({
        taskId: a,
        payload: expect.objectContaining({ command: "npm test", passed: true, exitCode: 0 }),
      }),
    ]);
    expect(typesFor(h, a)).toContain("task.verifying");
    const kinds = h
      .events(["artifact.recorded"])
      .filter((e) => e.taskId === a)
      .map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toEqual(expect.arrayContaining(["diff", "changed-files", "test.output"]));
    for (const k of kinds) expect(ArtifactKindSchema.safeParse(k).success, k).toBe(true);

    // tick 2: B (A done) is dispatched
    await h.tick();
    expect(h.task(b).status).toBe("running");

    // approve C → C goes back to ready and is dispatched on the next tick
    const approvalId = pending[0].id as string;
    const decided = await h.post(`/v1/approvals/${approvalId}/decision`, { decision: "approved" });
    expect(decided.status).toBe(202);
    expect(decided.json).toMatchObject({ operationId: expect.stringMatching(/^op_/) });
    expect(h.task(c).status).toBe("ready");
    await h.tick();
    expect(h.task(c).status).toBe("running");

    await h.advance(1000);
    expect(h.task(b).status).toBe("completed");
    expect(h.task(c).status).toBe("completed");

    await h.tick();
    const mission = (await h.get(`/v1/missions/${missionId}`)).json;
    expect(mission.mission.status).toBe("completed");
    expect(mission.tasks.map((t: { status: string }) => t.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);

    // usage: one `unavailable` sample per session, so the UI can show missing data
    const snap = (await h.get("/v1/snapshot")).json;
    expect(snap.usage).toMatchObject({ samples: 3, bySource: { unavailable: 3, measured: 0 } });
    const usage = (await h.get(`/v1/usage?missionId=${missionId}`)).json;
    expect(usage).toMatchObject({
      totals: { samples: 3, bySource: { unavailable: 3 } },
      uncertain: true,
    });
    expect(usage.samples.every((s: { source: string }) => s.source === "unavailable")).toBe(true);
  }, 120_000);

  it("never runs more than maxConcurrentTasks at once", async () => {
    const h = track(await harness());
    const { missionId } = await setupMission(h, { maxConcurrentTasks: 1 });
    const one = await createTask(h, missionId, "one", "echo 1");
    const two = await createTask(h, missionId, "two", "echo 2");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect([h.task(one).status, h.task(two).status]).toEqual(["running", "ready"]);
    await h.tick();
    expect(h.task(two).status).toBe("ready");
    await h.advance(1000);
    expect(h.task(one).status).toBe("completed");
    await h.tick();
    expect(h.task(two).status).toBe("running");
  }, 120_000);

  it("a destructive command is denied by default policy: policy.denied and the task parks", async () => {
    const h = track(await harness());
    const { missionId } = await setupMission(h);
    const c = await createTask(h, missionId, "C", "rm -rf build");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.task(c)).toMatchObject({ status: "blocked", blockedReason: "policy_denied" });
    expect(h.events(["policy.denied"])).toEqual([
      expect.objectContaining({
        taskId: c,
        payload: expect.objectContaining({ action: "shell.destructive" }),
      }),
    ]);
    expect(h.events(["session.requested"])).toEqual([]);
  });

  it("rejecting a gated dispatch records policy.denied and keeps the task blocked", async () => {
    const h = track(await harness({ policies: DESTRUCTIVE_NEEDS_APPROVAL }));
    const { missionId } = await setupMission(h);
    const c = await createTask(h, missionId, "C", "rm -rf build");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    const [approval] = (await h.get("/v1/approvals")).json.approvals;
    const res = await h.post(`/v1/approvals/${approval.id}/decision`, {
      decision: "rejected",
      reason: "not today",
    });
    expect(res.status).toBe(202);
    expect(h.task(c)).toMatchObject({ status: "blocked", blockedReason: "policy_denied" });
    expect(h.events(["policy.denied"])).toHaveLength(1);
    await h.tick();
    expect(h.events(["session.requested"])).toEqual([]);
  });

  it("verification failure starts the next attempt in the same worktree, then fails the task", async () => {
    const h = track(await harness());
    const { missionId } = await setupMission(
      h,
      { maxAttemptsPerTask: 2 },
      // an allowlisted command (default allowlist: cat on worktree paths) that exits 1
      { testCommand: ["cat", "missing-file.txt"] },
    );
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(1000);
    // first verification failed with an attempt left: a new session on attempt 1
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
    expect(h.events(["git.worktree_created"])).toHaveLength(1);
    expect(h.events(["session.requested"])).toHaveLength(2);
    await h.advance(1000);
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 1 });
    const runs = h.events(["test.run_completed"]).map((e) => e.payload);
    expect(runs).toEqual([
      expect.objectContaining({ passed: false, exitCode: 1 }),
      expect.objectContaining({ passed: false, exitCode: 1 }),
    ]);
    await h.tick();
    expect((await h.get(`/v1/missions/${missionId}`)).json.mission.status).toBe("failed");
  }, 120_000);

  it("restart mid-run: a session lost while Mimir was down parks the task unknown_after_restart", async () => {
    const h = track(await harness({ script: [{ afterMs: 100, state: "running" }] }));
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo t");
    const keep = await createTask(h, missionId, "K", "echo k");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    expect(h.task(t).status).toBe("running");
    expect(h.task(keep).status).toBe("running");
    const sessions = h.events(["session.requested"]);
    const lostId = sessions.find((e) => e.taskId === t)!.sessionId!;

    await h.app.close();
    h.fake.loseSession(lostId); // nobody is subscribed: Mimir does not see this happen
    await h.restart();

    expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "unknown_after_restart" });
    expect(h.task(keep).status).toBe("running"); // its session is still there: re-bound
    expect(h.events(["recovery.unknown_marked"])).toEqual([
      expect.objectContaining({
        payload: { entityType: "task", entityId: t, reason: "unknown_after_restart" },
      }),
    ]);
    const reconciled = h.events(["recovery.reconciled"]);
    expect(reconciled.at(-1)?.payload).toMatchObject({ lostSessionIds: [lostId], gap: false });
    // never auto-completed, and no new dispatch for it
    await h.tick();
    expect(h.task(t).status).toBe("blocked");
    // an operator retry puts it back in the queue on its next attempt
    expect((await h.post(`/v1/tasks/${t}/retry`)).status).toBe(202);
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 1 });
  }, 120_000);

  it("force stop needs an approval of runtime.force_stop: 403 first, stopped once approved", async () => {
    expect(PRIVILEGED_ACTIONS).toContain("runtime.force_stop");
    const h = track(await harness({ script: [{ afterMs: 100, state: "running" }] }));
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "T", "echo long-running");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    const sessionId = h.events(["session.requested"])[0]!.sessionId!;

    const denied = await h.post(`/v1/sessions/${sessionId}/stop`, { mode: "force" });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatchObject({
      code: "policy_denied",
      details: { action: "runtime.force_stop", approvalId: expect.stringMatching(/^apr_/) },
    });
    expect(h.app.mimir.readModel.sessions.get(sessionId)?.state).toBe("running");

    const approvalId = denied.json.error.details.approvalId as string;
    const ok = await h.post(`/v1/approvals/${approvalId}/decision`, { decision: "approved" });
    expect(ok.status).toBe(202);
    await h.idle();
    expect(h.app.mimir.readModel.sessions.get(sessionId)?.state).toBe("stopped");
    expect(h.task(t).status).toBe("failed");
    // the approval was consumed by that stop: a repeated force stop asks again (review I1)
    const again = await h.post(`/v1/sessions/${sessionId}/stop`, { mode: "force" });
    expect(again.status).toBe(403);
    expect(again.json.error.details.approvalId).not.toBe(approvalId);
  }, 120_000);

  it("an SSE client sees the full ordered sequence for a task", async () => {
    const h = track(await harness());
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const address = h.app.server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const sse = await openSse(
      `http://127.0.0.1:${address.port}/v1/events/stream?cursor=${h.store.latestCursor()}`,
      AUTH,
    );
    try {
      const { missionId } = await setupMission(h);
      const a = await createTask(h, missionId, "A", "echo A");
      await h.post(`/v1/missions/${missionId}/start`);
      await h.tick();
      await h.advance(1000);
      await h.tick();
      const seen: { type: string; taskId?: string }[] = [];
      for (;;) {
        const msg = await sse.next(5000);
        if (msg.data === undefined) continue;
        const data = JSON.parse(msg.data) as { type: string; taskId?: string };
        seen.push(data);
        if (data.type === "mission.completed") break;
      }
      const forA = seen.filter((e) => e.taskId === a).map((e) => e.type);
      const order = [
        "task.created",
        "task.ready",
        "task.leased",
        "git.worktree_created",
        "session.requested",
        "session.started",
        "task.started",
        "session.state_changed",
        "task.verifying",
        "test.run_completed",
        "task.completed",
      ];
      // every step appears, in this order
      let i = 0;
      for (const type of forA) if (type === order[i]) i++;
      expect(i).toBe(order.length);
      expect(seen[0]?.type).toBe("project.created");
      expect(seen.map((e) => e.type)).toContain("crew.created");
      expect(seen.map((e) => e.type)).toContain("usage.recorded");
    } finally {
      sse.close();
    }
  }, 120_000);
});
