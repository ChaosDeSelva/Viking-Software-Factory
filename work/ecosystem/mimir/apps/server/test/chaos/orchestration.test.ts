import { chmodSync, mkdirSync } from "node:fs";
import { backoffMs } from "@mimir/core";
import { newId, type MissionId, type SessionId, type TaskId } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openSse, type SseConnection } from "@mimir/testing";
import { AUTH } from "../../src/test-helpers.js";
import {
  createTask,
  harness,
  setupMission,
  expectConsistentLog,
  type Harness,
  type Json,
  RecordingRuntime,
  T0,
} from "../orchestration-support.js";

const harnesses: Harness[] = [];
const track = (h: Harness) => (harnesses.push(h), h);
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

/** The task's current session id. */
const sessionOf = (h: Harness, taskId: string): string =>
  h.app.mimir.orchestrator.currentSession(taskId) as string;

describe("chaos (orchestrator): agent crash", () => {
  it("session.lost fails the task, retries only after backoff, and shares one attempt counter with verification retries", async () => {
    // Sessions run for 1 s, then complete (unless lost first).
    const h = track(
      await harness({
        script: [
          { afterMs: 100, state: "running" },
          { afterMs: 1000, state: "completed", exit: 0 },
        ],
      }),
    );
    const { missionId } = await setupMission(
      h,
      { maxAttemptsPerTask: 3 },
      { testCommand: ["false"] },
    );
    const t = await createTask(h, missionId, "T", "echo t");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 0 });

    // Attempt 0: the agent crashes.
    const first = sessionOf(h, t);
    h.fake.loseSession(first);
    await h.idle();
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
    const lost = h.events(["session.lost"]);
    expect(lost).toEqual([expect.objectContaining({ sessionId: first })]);
    expect(h.events(["task.failed"]).map((e) => e.payload)).toEqual([
      expect.objectContaining({ reason: "session_lost: lost", attempt: 0, retryable: true }),
    ]);

    // Backoff: no retry before backoffMs(0) has passed since the failure.
    await h.tick();
    h.clock.advance(backoffMs(0) - 1);
    await h.tick();
    expect(h.task(t).status).toBe("failed");
    expect(h.events(["task.retried"])).toEqual([]);
    h.clock.advance(1);
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "ready", attempt: 1 });
    expect(h.events(["task.retried"]).map((e) => e.payload)).toEqual([
      { from: "failed", to: "ready", attempt: 1 },
    ]);

    // Attempt 1: a new session in the same worktree; it completes but verification fails, which
    // starts attempt 2 on the same counter.
    await h.tick();
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
    expect(sessionOf(h, t)).not.toBe(first);
    expect(h.events(["git.worktree_created"])).toHaveLength(1);
    await h.advance(1200);
    expect(h.task(t)).toMatchObject({ status: "running", attempt: 2 });
    expect(h.events(["session.requested"])).toHaveLength(3);

    // Attempt 2 (the last of 3): the agent crashes again; no attempts left, so no retry ever.
    await h.advance(200);
    h.fake.loseSession(sessionOf(h, t));
    await h.idle();
    expect(h.task(t)).toMatchObject({ status: "failed", attempt: 2 });
    expect(h.events(["task.failed"]).at(-1)?.payload).toMatchObject({
      attempt: 2,
      retryable: false,
    });
    h.clock.advance(backoffMs(10));
    await h.tick();
    expect(h.events(["task.retried"])).toHaveLength(1);
    expect(h.events(["session.requested"])).toHaveLength(3);
    const mission = (await h.get(`/v1/missions/${missionId}`)).json as Json;
    expect(mission.mission.status).toBe("failed");
  }, 60_000);
});

describe("chaos (orchestrator): runtime disconnect", () => {
  it("a runtime.gap re-reconciles through the orchestrator: missed transitions and a missed loss are recorded once, a second gap adds nothing", async () => {
    const h = track(
      await harness({
        script: [
          { afterMs: 100, state: "running" },
          { afterMs: 500, state: "idle" },
          { afterMs: 2000, state: "completed", exit: 0 },
        ],
      }),
    );
    const { missionId } = await setupMission(h, { maxConcurrentTasks: 2, maxAttemptsPerTask: 2 });
    const a = await createTask(h, missionId, "A", "echo a");
    const b = await createTask(h, missionId, "B", "echo b");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    expect([h.task(a).status, h.task(b).status]).toEqual(["running", "running"]);
    const sa = sessionOf(h, a);
    const sb = sessionOf(h, b);

    // The runtime keeps going while Mimir misses its events: both go idle, then B is lost.
    h.fake.chaos({ dropNextEvents: 2 });
    await h.advance(400);
    h.fake.chaos({ dropNextEvents: 1 });
    h.fake.loseSession(sb);
    await h.idle();
    expect(h.app.mimir.readModel.sessions.get(sa)?.state).toBe("running");
    expect(h.events(["session.lost"])).toEqual([]);

    // The adapter reports the gap: the orchestrator reconciles.
    h.fake.chaos({ emitGap: true });
    await h.idle();
    expect(h.events(["recovery.reconciled"]).map((e) => e.payload)).toEqual([
      { sessions: 1, lostSessionIds: [sb], gap: true },
    ]);
    expect(h.app.mimir.readModel.sessions.get(sa)?.state).toBe("idle");
    expect(h.events(["session.lost"])).toEqual([
      expect.objectContaining({ sessionId: sb, provenance: "observed" }),
    ]);
    // a live gap fails the lost session's task (it is retried); it is not parked unknown
    expect(h.task(b)).toMatchObject({ status: "failed", attempt: 0 });
    expect(h.task(a).status).toBe("running");

    // A second gap with nothing new appends no session or task events.
    const before = h.events().length;
    h.fake.chaos({ emitGap: true });
    await h.idle();
    const added = h.events().slice(before);
    expect(added.map((e) => e.type)).toEqual(["recovery.reconciled"]);
    expect(added[0]?.payload).toEqual({ sessions: 1, lostSessionIds: [], gap: true });

    // A continues normally and completes; no session transition was recorded twice.
    await h.advance(2000);
    expect(h.task(a).status).toBe("completed");
    for (const sid of [sa, sb]) {
      const states = h
        .events(["session.state_changed"])
        .filter((e) => e.sessionId === sid)
        .map((e) => (e.payload as { to: string }).to);
      expect(new Set(states).size, `${sid}: ${states.join(",")}`).toBe(states.length);
    }
    const stateOf = (sid: string) =>
      h
        .events(["session.state_changed"])
        .filter((e) => e.sessionId === sid)
        .map((e) => (e.payload as { to: string }).to);
    expect(stateOf(sa)).toEqual(["running", "idle", "completed"]);
    expect(stateOf(sb)).toEqual(["running"]);
    expect(h.events(["session.lost"])).toHaveLength(1);
    expect(expectConsistentLog(h.events())).toEqual([]);
  }, 60_000);
});

describe("chaos (orchestrator): git failure", () => {
  it("a read-only worktree root fails the dispatch cleanly with a reason; the mission continues and the retry succeeds", async () => {
    let rt!: RecordingRuntime;
    const h = track(await harness({ wrapRuntime: (fake) => (rt = new RecordingRuntime(fake)) }));
    const root = `${h.dataDir}-worktrees`;
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o500);
    try {
      const { missionId } = await setupMission(h, { maxAttemptsPerTask: 2 });
      const t = await createTask(h, missionId, "T", "echo t");
      await h.post(`/v1/missions/${missionId}/start`);
      await h.tick();
      expect(h.task(t)).toMatchObject({ status: "failed", attempt: 0 });
      const failed = h.events(["task.failed"]);
      expect(failed).toHaveLength(1);
      expect((failed[0]?.payload as { reason: string }).reason).toMatch(/^worktree_failed: /);
      expect(failed[0]?.payload).toMatchObject({ retryable: true });
      // nothing reached the runtime, no worktree or session was recorded
      expect(rt.created).toEqual([]);
      expect(h.events(["git.worktree_created", "session.requested"])).toEqual([]);
      // the mission is still active and the server keeps answering
      const m = await h.get(`/v1/missions/${missionId}`);
      expect(m.status).toBe(200);
      expect((m.json as Json).mission.status).toBe("active");
      expect((await h.get("/v1/snapshot")).status).toBe(200);

      // The disk is fixed: the retry (after backoff) gets a worktree and completes the mission.
      chmodSync(root, 0o700);
      h.clock.advance(backoffMs(0));
      await h.tick();
      await h.tick();
      expect(h.task(t)).toMatchObject({ status: "running", attempt: 1 });
      expect(rt.created).toHaveLength(1);
      await h.advance(1500);
      expect(h.task(t).status).toBe("completed");
      await h.tick();
      expect((await h.get(`/v1/missions/${missionId}`)).json.mission.status).toBe("completed");
    } finally {
      chmodSync(root, 0o700);
    }
  }, 60_000);
});

describe("chaos (orchestrator): budget", () => {
  it("budget exceeded mid-run: budget.exceeded once, no new dispatch, the running task is not killed", async () => {
    let rt!: RecordingRuntime;
    const h = track(
      await harness({
        script: [
          { afterMs: 100, state: "running" },
          { afterMs: 3000, state: "completed", exit: 0 },
        ],
        wrapRuntime: (fake) => (rt = new RecordingRuntime(fake)),
      }),
    );
    // A hard mission budget; `unavailable` samples (the fake measures nothing) do not block.
    const { missionId } = await setupMission(
      h,
      { maxConcurrentTasks: 1 },
      {},
      {
        limitTokens: 1000,
        onUnknown: "allow",
      },
    );
    const a = await createTask(h, missionId, "A", "echo a");
    const b = await createTask(h, missionId, "B", "echo b");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    await h.advance(200);
    expect(h.task(a).status).toBe("running");
    expect(h.task(b).status).toBe("ready");
    expect(rt.created).toHaveLength(1);

    // A usage source reports 1500 measured tokens for A's agent while A runs.
    const at = new Date(T0 + h.clock.now()).toISOString();
    h.store.append({
      streamId: `session:${sessionOf(h, a)}`,
      type: "usage.recorded",
      source: "chaos-usage",
      provenance: "observed",
      occurredAt: at,
      observedAt: at,
      sessionId: sessionOf(h, a) as SessionId,
      taskId: a as TaskId,
      missionId: missionId as MissionId,
      payload: {
        sample: {
          id: newId("usg"),
          agentId: h.task(a).agentId,
          tokens: 1500,
          estimatedCost: null,
          source: "measured",
          createdAt: at,
          updatedAt: at,
          version: 0,
        },
      },
    });
    await h.tick();
    const exceeded = h.events(["budget.exceeded"]);
    expect(exceeded).toEqual([
      expect.objectContaining({
        missionId,
        payload: expect.objectContaining({ unit: "tokens", used: 1500, limit: 1000 }),
      }),
    ]);
    expect(h.task(b)).toMatchObject({ status: "blocked", blockedReason: "budget_exceeded" });
    // A keeps running (a budget stops new work, it does not kill sessions) and completes.
    expect(h.task(a).status).toBe("running");
    expect(rt.stops).toEqual([]);
    await h.advance(3000);
    expect(h.task(a).status).toBe("completed");
    for (let i = 0; i < 3; i++) {
      h.clock.advance(1000);
      await h.tick();
    }
    // A's slot is free, yet B is never dispatched; budget.exceeded was recorded once.
    expect(h.task(b)).toMatchObject({ status: "blocked", blockedReason: "budget_exceeded" });
    expect(rt.created).toHaveLength(1);
    expect(h.events(["session.requested"]).filter((e) => e.taskId === b)).toEqual([]);
    expect(h.events(["budget.exceeded"])).toHaveLength(1);
    expect((await h.get(`/v1/missions/${missionId}`)).json.mission.status).toBe("active");
  }, 60_000);
});

/** Starts listening on an ephemeral loopback port (real sockets, real concurrency). */
async function listen(h: Harness): Promise<string> {
  await h.app.listen({ host: "127.0.0.1", port: 0 });
  const address = h.app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

const postJson = (base: string, url: string, key: string, body: unknown) =>
  fetch(`${base}${url}`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });

describe("chaos (orchestrator): concurrent operator commands", () => {
  it("concurrent decisions on one approval: exactly one wins, every other gets 409", async () => {
    let rt!: RecordingRuntime;
    const h = track(
      await harness({
        policies: [{ id: "t#d", action: "shell.destructive", effect: "require_approval" }],
        wrapRuntime: (fake) => (rt = new RecordingRuntime(fake)),
      }),
    );
    const { missionId } = await setupMission(h);
    const t = await createTask(h, missionId, "C", "rm -rf build");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    const [approval] = (await h.get("/v1/approvals?status=pending")).json.approvals as Json[];
    const base = await listen(h);
    // 10 decisions race, half approve and half reject, each under its own Idempotency-Key.
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const decision = i % 2 === 0 ? "approved" : "rejected";
        const res = await postJson(base, `/v1/approvals/${approval.id}/decision`, `d-${i}`, {
          decision,
        });
        return { decision, status: res.status, body: (await res.json()) as Json };
      }),
    );
    const winners = results.filter((r) => r.status === 202);
    expect(winners).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 202)) {
      expect(r).toMatchObject({ status: 409, body: { error: { code: "invalid_transition" } } });
    }
    const decided = h.events(["approval.decided"]);
    expect(decided).toHaveLength(1);
    const final = (await h.get("/v1/approvals")).json.approvals[0] as Json;
    expect(final.status).toBe(winners[0]?.decision);
    // The loser's decision changed nothing: the task follows the winner only.
    await h.tick();
    if (winners[0]?.decision === "approved") {
      expect(rt.created.filter((s) => s.taskId === t)).toHaveLength(1);
    } else {
      expect(rt.created).toEqual([]);
      expect(h.task(t)).toMatchObject({ status: "blocked", blockedReason: "policy_denied" });
    }
  }, 60_000);

  it("10 parallel POST /v1/missions with one Idempotency-Key create one mission", async () => {
    const h = track(await harness());
    const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
    const base = await listen(h);
    const body = {
      projectId: p.json.project.id,
      objective: "once",
      tasks: [{ title: "T", brief: "echo t" }],
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const res = await postJson(base, "/v1/missions", "mission-key", body);
        return {
          status: res.status,
          replayed: res.headers.get("idempotency-replayed"),
          body: (await res.json()) as Json,
        };
      }),
    );
    const executed = results.filter((r) => r.status === 201 && r.replayed === null);
    expect(executed).toHaveLength(1);
    const id = executed[0]?.body.mission.id as string;
    for (const r of results) {
      if (r.status === 201) expect(r.body.mission.id).toBe(id);
      else expect(r).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    }
    expect(h.app.mimir.readModel.missions.size).toBe(1);
    expect(h.events(["mission.created"])).toHaveLength(1);
    expect(h.events(["task.created"])).toHaveLength(1);
    const late = await postJson(base, "/v1/missions", "mission-key", body);
    expect(late.status).toBe(201);
    expect(late.headers.get("idempotency-replayed")).toBe("true");
    expect(((await late.json()) as Json).mission.id).toBe(id);
  }, 60_000);
});

describe("chaos (orchestrator): slow SSE consumer during a live mission", () => {
  it("10k session events: the server stays responsive, the slow client gets a gap and replays from its cursor", async () => {
    const OUTPUTS = 10_000;
    const h = track(
      await harness({
        script: [
          { afterMs: 100, state: "running" },
          ...Array.from({ length: OUTPUTS }, (_, i) => ({
            afterMs: 200 + Math.floor(i / 10),
            output: `line ${i} ${"x".repeat(200)}`,
          })),
          { afterMs: 1500, state: "completed" as const, exit: 0 },
        ],
        overrides: { sseMaxBufferBytes: 256 * 1024, sseDropGraceMs: 30_000 },
      }),
    );
    const base = await listen(h);
    const conns: SseConnection[] = [];
    try {
      const cursor = h.store.latestCursor();
      const slow = await openSse(`${base}/v1/events/stream?cursor=${cursor}`, AUTH);
      const fast = await openSse(`${base}/v1/events/stream?cursor=${cursor}`, AUTH);
      conns.push(slow, fast);
      slow.pause();

      const { missionId } = await setupMission(h);
      await createTask(h, missionId, "T", "echo t");
      await h.post(`/v1/missions/${missionId}/start`);
      await h.tick();

      // Drive the live mission (10k outputs) while probing the server's responsiveness.
      const latencies: number[] = [];
      let live = true;
      const probe = (async () => {
        while (live) {
          const t0 = performance.now();
          const res = await fetch(`${base}/v1/health`);
          expect(res.status).toBe(200);
          await res.arrayBuffer();
          latencies.push(performance.now() - t0);
          await new Promise((r) => setTimeout(r, 10));
        }
      })();
      // 10 ms of fake time = 100 outputs (about 45 KB of SSE frames) per step; real I/O runs
      // between steps, as it would between socket reads from a real runtime.
      for (let ms = 0; ms < 1600; ms += 10) {
        await h.advance(10);
        await new Promise((r) => setImmediate(r));
      }
      await h.tick();
      live = false;
      await probe;
      expect(h.events(["session.output"])).toHaveLength(OUTPUTS);
      expect((await h.get(`/v1/missions/${missionId}`)).json.mission.status).toBe("completed");
      expect(latencies.length).toBeGreaterThan(0);
      expect(Math.max(...latencies)).toBeLessThan(1000);

      const all = h.events().filter((e) => e.sequence > 0);
      const allIds = all.map((e) => e.id).slice(all.findIndex((e) => e.type === "project.created"));

      // The fast client saw everything, in order, with no gap.
      const fastIds: string[] = [];
      while (fastIds.length < allIds.length) {
        const msg = await fast.next(10_000);
        expect(msg.event).not.toBe("gap");
        if (msg.data !== undefined) fastIds.push((JSON.parse(msg.data) as { id: string }).id);
      }
      expect(fastIds).toEqual(allIds);

      // The slow client was cut off with a gap naming the last event it was sent...
      slow.resume();
      await slow.ended;
      const gap = slow.messages.at(-1);
      expect(gap?.event).toBe("gap");
      const info = JSON.parse(gap?.data ?? "{}") as { reason: string; lastEventId: string };
      expect(info.reason).toBe("slow_consumer");
      const got = slow.messages
        .filter((x) => x.data !== undefined && x.event !== "gap")
        .map((x) => (JSON.parse(x.data as string) as { id: string }).id);
      expect(got.length).toBeLessThan(allIds.length);
      // ...and replaying from that cursor delivers the rest exactly once, in order.
      const replay = await openSse(`${base}/v1/events/stream`, {
        ...AUTH,
        "last-event-id": info.lastEventId,
      });
      conns.push(replay);
      while (got.length < allIds.length) {
        const msg = await replay.next(10_000);
        expect(msg.event).not.toBe("gap");
        if (msg.data !== undefined) got.push((JSON.parse(msg.data) as { id: string }).id);
      }
      expect(got).toEqual(allIds);
    } finally {
      for (const c of conns) c.close();
    }
  }, 120_000);
});
