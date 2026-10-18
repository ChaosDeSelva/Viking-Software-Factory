import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { openEventStore, type AppendInput } from "@mimir/core";
import { FakeRuntime, ManualClock } from "@mimir/fake-runtime";
import { newId, type MissionId, type Worktree } from "@mimir/protocol";
import { summarize, type BenchResult } from "@mimir/testing";
import { buildServer } from "../../src/index.js";
import type { WorktreePort } from "../../src/orchestrator/git-port.js";
import { BENCH_AUTH, BENCH_TOKEN, r3, tempDir, type Scenario } from "../harness.js";

const RUNNING = 20;
const PENDING = 40;
const USAGE = 2000;
const ITERATIONS = 500;
const T0 = Date.parse("2026-10-14T08:00:00.000Z");

/**
 * Worktrees without git: the tick never touches git, and 20 real worktrees would only measure
 * the setup. Paths point at an existing directory so nothing downstream trips over them.
 */
function stubWorktrees(dir: string): WorktreePort {
  const known = new Set<string>();
  return {
    plan: (input) => ({
      path: dir,
      branch: `mimir/${input.crewSlug}/${input.taskId}-${input.taskSlug}`,
    }),
    baseRefOf: () => "HEAD",
    checkpoint: () => Promise.resolve("0".repeat(40)),
    exportResult: () =>
      Promise.resolve({ baseSha: "0".repeat(40), resultCommit: "0".repeat(40), patch: "" }),
    dependencyBase: () => Promise.resolve(undefined),
    create(input) {
      const at = new Date().toISOString();
      const w: Worktree = {
        id: newId("wtr"),
        taskId: input.taskId,
        path: dir,
        branch: `mimir/${input.crewSlug}/${input.taskId}-${input.taskSlug}`,
        baseSha: "0".repeat(40) as Worktree["baseSha"],
        status: "active",
        createdAt: at,
        updatedAt: at,
        version: 0,
      };
      known.add(w.id);
      return Promise.resolve(w);
    },
    has: (id) => known.has(id),
    diff: () => Promise.reject(new Error("not in the bench")),
    changedFilesManifest: () => Promise.reject(new Error("not in the bench")),
    restore: () => Promise.resolve({ restored: 0, rejected: [] }),
  };
}

/**
 * The full orchestrator tick (Tperf follow-up after T12): approval expiry, ready promotion, lease
 * heartbeats for live sessions, `schedule()`, applying its decisions and budget checks, over a
 * mission with 20 running tasks (FakeRuntime sessions that stay `running`), 40 pending tasks in
 * a dependency chain, 2000 measured usage samples and a hard mission budget. The orchestrator
 * runs in the real server built by `buildServer`; only git is stubbed.
 */
export const tick: Scenario = {
  name: "tick",
  description: `full orchestrator tick with ${RUNNING} running tasks`,
  async run({ scale, log }) {
    const iterations = Math.max(20, Math.round(ITERATIONS * scale));
    const tmp = tempDir();
    const repo = join(realpathSync(tmp.dir), "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const clock = new ManualClock();
    const fake = new FakeRuntime({ clock, script: [{ afterMs: 100, state: "running" }] });
    const store = openEventStore(":memory:");
    const app = buildServer({
      store,
      ledger: store.commands,
      audit: store.audit,
      runtime: fake,
      authToken: BENCH_TOKEN,
      publicOrigins: ["http://localhost:80"],
      now: () => new Date(T0 + clock.now()),
      tickMs: 0,
      dataDir: join(tmp.dir, "data"),
      git: stubWorktrees(repo),
    });
    const post = async (url: string, body: unknown) => {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...BENCH_AUTH, "idempotency-key": newId("op") },
        payload: body as Record<string, unknown>,
      });
      if (res.statusCode >= 400) throw new Error(`${url}: ${res.statusCode} ${res.body}`);
      return res.json() as unknown;
    };
    try {
      await app.ready();
      const orch = app.mimir.orchestrator;
      const rm = app.mimir.readModel;
      const project = (await post("/v1/projects", { name: "bench", repoPath: repo })) as {
        project: { id: string };
      };
      const running = Array.from({ length: RUNNING }, () => newId("tsk"));
      const pending = Array.from({ length: PENDING }, () => newId("tsk"));
      const tasks = [
        ...running.map((id, i) => ({ id, title: `running ${i}`, brief: "work" })),
        // the chain hangs off a running task, so it stays pending
        ...pending.map((id, i) => ({
          id,
          title: `pending ${i}`,
          brief: "later",
          dependsOn: [i === 0 ? (running[0] as string) : (pending[i - 1] as string)],
        })),
      ];
      const mission = (await post("/v1/missions", {
        projectId: project.project.id,
        objective: "bench",
        budget: { limitTokens: 10_000_000, onUnknown: "allow" },
        tasks,
      })) as { mission: { id: string } };
      const missionId = mission.mission.id as MissionId;
      await post("/v1/crews", {
        missionId,
        template: "bench",
        limits: { maxConcurrentTasks: RUNNING },
        members: [{ role: "implementer", agentKind: "claude" }],
      });
      await post(`/v1/missions/${missionId}/start`, {});
      await orch.tick();
      await orch.idle();
      clock.advance(200);
      await orch.idle();
      const live = running.filter((id) => rm.tasks.get(id)?.status === "running").length;
      if (live !== RUNNING) throw new Error(`expected ${RUNNING} running tasks, got ${live}`);

      // 2000 measured usage samples, spread over the running agents.
      const agents = running.map((id) => rm.tasks.get(id)?.agentId as string);
      const at = new Date(T0 + clock.now()).toISOString();
      const usage: AppendInput[] = Array.from({ length: USAGE }, (_, i) => ({
        streamId: `usage-bench-${i % RUNNING}`,
        type: "usage.recorded",
        source: "bench",
        provenance: "observed",
        occurredAt: at,
        observedAt: at,
        missionId,
        payload: {
          sample: {
            id: newId("usg"),
            agentId: agents[i % RUNNING],
            tokens: 100,
            estimatedCost: 0.001,
            source: "measured",
            createdAt: at,
            updatedAt: at,
            version: 0,
          },
        },
      }));
      store.appendMany(usage);
      log(
        `  tick: ${RUNNING} running, ${PENDING} pending, ${rm.usageSamples.size} usage samples, ${iterations} ticks`,
      );

      const countEvents = (): number => {
        let n = 0;
        let cursor: string | undefined;
        for (;;) {
          const page = store.read({ limit: 1000, ...(cursor !== undefined ? { cursor } : {}) });
          n += page.events.length;
          if (page.nextCursor === null) return n;
          cursor = page.nextCursor;
        }
      };
      const eventsBefore = countEvents();
      const ms: number[] = [];
      for (let i = 0; i < iterations; i++) {
        clock.advance(100); // heartbeats renew the leases of live sessions
        const t0 = performance.now();
        await orch.tick();
        ms.push(performance.now() - t0);
      }
      await orch.idle();
      const stillRunning = running.filter((id) => rm.tasks.get(id)?.status === "running").length;
      const appended = countEvents() - eventsBefore;
      const s = summarize(ms);
      const name = "1 tick (orchestrator)";
      const results: BenchResult[] = [
        {
          scenario: name,
          metric: "tick p50",
          value: r3(s.p50),
          unit: "ms",
          note: `${RUNNING} running, ${PENDING} pending, ${USAGE} samples`,
        },
        {
          scenario: name,
          metric: "tick p95",
          value: r3(s.p95),
          unit: "ms",
          threshold: { op: "<", value: 100, source: "guard" },
        },
        { scenario: name, metric: "tick p99", value: r3(s.p99), unit: "ms" },
        {
          scenario: name,
          metric: "running tasks kept by heartbeats",
          value: stillRunning,
          unit: "tasks",
          threshold: { op: "==", value: RUNNING, source: "guard" },
        },
        {
          scenario: name,
          metric: "events appended by steady ticks",
          value: appended,
          unit: "events",
        },
      ];
      return results;
    } finally {
      await app.close();
      store.close();
      tmp.cleanup();
    }
  },
};
