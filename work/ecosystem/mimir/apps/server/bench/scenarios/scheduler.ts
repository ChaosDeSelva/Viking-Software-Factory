import { schedule, type BudgetPolicy, type Lease, type ScheduleInput } from "@mimir/core";
import { newId, type Crew, type Mission, type Task, type UsageSample } from "@mimir/protocol";
import { summarize, type BenchResult } from "@mimir/testing";
import { r3, type Scenario } from "../harness.js";

const RUNNING = 20;
const PENDING = 40;
const USAGE = 2000;
const ITERATIONS = 2000;

/**
 * Scheduler decision cost: the pure `schedule()` from `@mimir/core` (the decision half of an
 * orchestrator tick) over a mission with 20 running tasks, 40 pending tasks in a dependency
 * chain, leases, 2000 usage samples and budgets. The orchestrator's I/O half (T12) is not on
 * main, so the full tick is not measured here.
 */
export const scheduler: Scenario = {
  name: "scheduler",
  description: "core schedule() with 20 running tasks (orchestrator tick not on main)",
  run({ scale }) {
    const iterations = Math.max(100, Math.round(ITERATIONS * scale));
    const input = world();
    const ms: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      schedule(input);
      ms.push(performance.now() - t0);
    }
    const s = summarize(ms);
    const name = "1 scheduler (decision only)";
    const results: BenchResult[] = [
      {
        scenario: name,
        metric: "schedule() p50",
        value: r3(s.p50),
        unit: "ms",
        note: `${RUNNING} running`,
      },
      {
        scenario: name,
        metric: "schedule() p95",
        value: r3(s.p95),
        unit: "ms",
        threshold: { op: "<", value: 50, source: "guard" },
      },
      { scenario: name, metric: "schedule() p99", value: r3(s.p99), unit: "ms" },
    ];
    return Promise.resolve(results);
  },
};

function world(): ScheduleInput {
  const now = new Date();
  const iso = now.toISOString();
  const base = { createdAt: iso, updatedAt: iso, version: 0 };
  const mission: Mission = {
    ...base,
    id: newId("msn"),
    projectId: newId("prj"),
    objective: "bench",
    status: "active",
  };
  const crew: Crew = {
    ...base,
    id: newId("crw"),
    missionId: mission.id,
    template: "default",
    status: "running",
    limits: { maxConcurrentTasks: RUNNING },
  };
  const agents = Array.from({ length: RUNNING }, () => ({ id: newId("agt"), crewId: crew.id }));
  const expires = new Date(now.getTime() + 300_000).toISOString();
  const task = (status: Task["status"], i: number): Task => ({
    ...base,
    createdAt: new Date(now.getTime() - 100_000 + i).toISOString(),
    id: newId("tsk"),
    missionId: mission.id,
    crewId: status === "running" ? crew.id : null,
    title: `task ${i}`,
    acceptance: "",
    status,
    attempt: status === "running" ? 1 : 0,
    maxAttempts: 3,
    agentId: status === "running" ? (agents[i]?.id ?? null) : null,
    leaseExpiresAt: status === "running" ? expires : null,
  });
  const running = Array.from({ length: RUNNING }, (_, i) => task("running", i));
  const pending = Array.from({ length: PENDING }, (_, i) => task("pending", RUNNING + i));
  const deps = pending
    .slice(1)
    .map((t, i) => ({ taskId: t.id, dependsOnId: (pending[i] as Task).id }));
  const leases: Lease[] = running.map((t) => ({
    taskId: t.id,
    sessionId: newId("ses"),
    crewId: crew.id,
    expiresAt: expires,
    heartbeatAt: iso,
  }));
  const usage: UsageSample[] = Array.from({ length: USAGE }, (_, i) => ({
    ...base,
    id: newId("usg"),
    agentId: (agents[i % RUNNING] as { id: UsageSample["agentId"] }).id,
    tokens: 100,
    estimatedCost: 0.001,
    source: "measured",
  }));
  const budgets: BudgetPolicy[] = [
    {
      ...base,
      id: newId("bgt"),
      missionId: mission.id,
      crewId: null,
      limitTokens: 10_000_000,
      limitCost: null,
      warnAtFraction: 0.8,
    },
    {
      ...base,
      id: newId("bgt"),
      missionId: null,
      crewId: crew.id,
      limitTokens: 10_000_000,
      limitCost: null,
      warnAtFraction: 0.8,
    },
  ];
  return {
    now,
    missions: [mission],
    crews: [crew],
    tasks: [...running, ...pending],
    deps,
    leases,
    usage,
    budgets,
    agents,
  };
}
