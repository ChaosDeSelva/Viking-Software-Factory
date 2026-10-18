import type { EventEnvelope } from "@mimir/protocol";
import { spawnMimir, type MimirProcess } from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import { tempProject } from "../../src/orchestrator/test-harness.js";
import { expectConsistentLog, type Json } from "../orchestration-support.js";
import { bearer, fixture, readAllEvents, serverSpawn } from "./support.js";

const procs: MimirProcess[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) await p.kill("SIGKILL");
  for (const fn of cleanups.splice(0)) fn();
});
const track = (p: MimirProcess) => (procs.push(p), p);
const MISSION_SERVER = fixture("mission-server.ts");
const ENV = { MIMIR_RUNTIME: "fake", MIMIR_TICK_MS: "100" };

async function call(p: MimirProcess, method: string, url: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${p.url}${url}`, {
    method,
    headers: {
      ...bearer(p.token),
      ...(body !== undefined
        ? { "content-type": "application/json", "idempotency-key": `k-${Math.random()}` }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as Json;
  if (res.status >= 400) throw new Error(`${method} ${url} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function until<T>(what: string, fn: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const ofType = (events: EventEnvelope[], type: string) => events.filter((e) => e.type === type);

describe("chaos: SIGKILL mid-mission", () => {
  it("running tasks come back blocked unknown_after_restart; nothing auto-completes; no lost or duplicated events", async () => {
    const project = tempProject();
    cleanups.push(project.cleanup);
    const spawn = () =>
      spawnMimir({ ...serverSpawn(MISSION_SERVER, project.dataDir, ENV), readyTimeoutMs: 60_000 });

    // Run 1: a mission with three tasks on an agent crew; wait until all three run.
    const run1 = track(await spawn());
    const p = await call(run1, "POST", "/v1/projects", { name: "p", repoPath: project.repo });
    const m = await call(run1, "POST", "/v1/missions", {
      projectId: p.project.id,
      objective: "survive a crash",
      tasks: [
        { title: "one", brief: "do one" },
        { title: "two", brief: "do two" },
        { title: "three", brief: "do three" },
      ],
    });
    const missionId = m.mission.id as string;
    const taskIds = (m.tasks as Json[]).map((t) => t.id as string);
    await call(run1, "POST", "/v1/crews", {
      missionId,
      template: "solo",
      limits: { maxConcurrentTasks: 3, maxAttemptsPerTask: 3 },
      members: [{ role: "implementer", agentKind: "claude" }],
    });
    await call(run1, "POST", `/v1/missions/${missionId}/start`, {});
    await until("all tasks running", async () => {
      const r = await call(run1, "GET", `/v1/missions/${missionId}`);
      return (r.tasks as Json[]).every((t) => t.status === "running") ? true : null;
    });
    const beforeKill = await readAllEvents(run1.url, run1.token);
    const exit = await run1.kill("SIGKILL");
    expect(exit.signal).toBe("SIGKILL");
    const sessionIds = ofType(beforeKill.events, "task.started").map((e) => e.sessionId);
    expect(sessionIds).toHaveLength(3);

    // Run 2: restart on the same data dir. Recovery runs before the server listens.
    const run2 = track(await spawn());
    const after = await readAllEvents(run2.url, run2.token);
    // Every event stored before the kill is still there, unchanged and in the same order.
    expect(after.events.slice(0, beforeKill.events.length)).toEqual(beforeKill.events);
    expect(expectConsistentLog(after.events)).toEqual([]);
    const recovered = after.events.slice(beforeKill.events.length);
    // The kill may have cut off events appended after our read (e.g. output); recovery itself
    // only adds session.lost, recovery.* and task.blocked events.
    const allowed = new Set([
      "session.output",
      "session.state_changed",
      "session.lost",
      "recovery.unknown_marked",
      "recovery.reconciled",
      "task.blocked",
    ]);
    for (const e of recovered) expect(allowed.has(e.type), e.type).toBe(true);
    const r2 = await call(run2, "GET", `/v1/missions/${missionId}`);
    for (const t of r2.tasks as Json[]) {
      expect(t).toMatchObject({ status: "blocked", blockedReason: "unknown_after_restart" });
    }
    expect(
      ofType(after.events, "recovery.unknown_marked")
        .map((e) => e.taskId)
        .sort(),
    ).toEqual([...taskIds].sort());
    expect(
      ofType(after.events, "session.lost")
        .map((e) => e.sessionId)
        .sort(),
    ).toEqual([...sessionIds].sort());
    const reconciled = ofType(after.events, "recovery.reconciled");
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.payload).toMatchObject({ sessions: 0, gap: false });
    expect(r2.mission.status).toBe("active");

    // Ticks keep running: nothing is auto-completed, re-dispatched or re-verified.
    await new Promise((r) => setTimeout(r, 1500));
    const later = await readAllEvents(run2.url, run2.token);
    expect(later.events).toEqual(after.events);
    for (const type of ["task.verifying", "task.completed", "mission.completed"]) {
      expect(ofType(later.events, type)).toEqual([]);
    }
    expect(ofType(later.events, "session.requested")).toHaveLength(3);

    // Run 3: a second crash and restart adds no second unknown marking or session loss.
    await run2.kill("SIGKILL");
    const run3 = track(await spawn());
    const third = await readAllEvents(run3.url, run3.token);
    expect(third.events.slice(0, later.events.length)).toEqual(later.events);
    expect(expectConsistentLog(third.events)).toEqual([]);
    expect(ofType(third.events, "recovery.unknown_marked")).toHaveLength(3);
    expect(ofType(third.events, "session.lost")).toHaveLength(3);

    // The operator decides: a retry puts a task back to work on its next attempt.
    const first = taskIds[0] as string;
    await call(run3, "POST", `/v1/tasks/${first}/retry`, {});
    await until("retried task running", async () => {
      const r = await call(run3, "GET", `/v1/missions/${missionId}`);
      const t = (r.tasks as Json[]).find((x) => x.id === first);
      return t?.status === "running" ? t : null;
    });
    const r3 = await call(run3, "GET", `/v1/missions/${missionId}`);
    expect((r3.tasks as Json[]).find((x) => x.id === first)).toMatchObject({ attempt: 1 });
  }, 180_000);
});
