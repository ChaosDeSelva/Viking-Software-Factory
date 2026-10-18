import {
  newId,
  type Crew,
  type Mission,
  type Task,
  type TaskStatus,
  type UsageSource,
} from "@mimir/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  T0,
  at,
  makeBudget,
  makeCrew,
  makeDep,
  makeMission,
  makeTask,
  makeUsage,
} from "./testing/fixtures.js";
import type { BudgetPolicy } from "./budget.js";
import type { Decision } from "./decisions.js";
import { leaseManager, type Lease } from "./lease.js";
import {
  ACTIVE_TASK_STATUSES,
  backoffMs,
  occupiesSlot,
  schedule,
  type ScheduleInput,
} from "./scheduler.js";
import { applyDecisions } from "./apply.js";
import {
  APPROVAL_REQUIRED,
  BUDGET_EXCEEDED,
  BUDGET_UNCERTAIN,
  POLICY_DENIED,
  UNKNOWN_AFTER_RESTART,
  taskMachine,
} from "./taskMachine.js";

const NOW = new Date(at(10 * 60_000));

function world(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    now: NOW,
    missions: [],
    crews: [],
    tasks: [],
    deps: [],
    leases: [],
    usage: [],
    budgets: [],
    agents: [],
    ...over,
  };
}

/** Mission + one crew + n tasks in the given statuses. */
function setup(
  statuses: TaskStatus[],
  crewOver: Partial<Crew> = {},
  missionOver: Partial<Mission> = {},
) {
  const mission = makeMission(missionOver);
  const crew = makeCrew(mission, crewOver);
  const tasks = statuses.map((status, i) =>
    makeTask({
      missionId: mission.id,
      status,
      createdAt: at(i),
      updatedAt: at(i),
      crewId: ACTIVE_TASK_STATUSES.has(status) ? crew.id : null,
    }),
  );
  return { mission, crew, tasks };
}

describe("backoffMs", () => {
  it.each([
    [0, 1000],
    [1, 2000],
    [3, 8000],
    [5, 32_000],
    [6, 60_000],
    [20, 60_000],
  ])("attempt %i -> %i", (attempt, ms) => expect(backoffMs(attempt)).toBe(ms));
});

describe("schedule: dispatch", () => {
  it.each([
    // statuses, maxConcurrentTasks, expected dispatched indices
    [["ready"], 2, [0]],
    [["ready", "ready", "ready"], 2, [0, 1]],
    [["running", "ready", "ready"], 2, [1]],
    [["running", "blocked", "ready"], 2, []],
    [["leased", "verifying", "ready"], 2, []],
    [["leased", "verifying", "ready"], 3, [2]],
    [["pending", "completed", "ready"], 1, [2]],
    [["failed", "cancelled", "ready"], 1, [2]],
  ] as const)("%j with max %i dispatches %j", (statuses, max, want) => {
    const { mission, crew, tasks } = setup([...statuses], { limits: { maxConcurrentTasks: max } });
    const out = schedule(world({ missions: [mission], crews: [crew], tasks }));
    const dispatched = out.filter((d) => d.kind === "dispatch");
    expect(dispatched).toEqual(
      want.map((i) => ({ kind: "dispatch", taskId: tasks[i]!.id, crewId: crew.id })),
    );
  });

  it("orders tasks by createdAt then id regardless of input order", () => {
    const { mission, crew, tasks } = setup(["ready", "ready", "ready"], {
      limits: { maxConcurrentTasks: 2 },
    });
    const out = schedule(
      world({ missions: [mission], crews: [crew], tasks: [...tasks].reverse() }),
    );
    expect(out.map((d) => (d as { taskId: string }).taskId)).toEqual([tasks[0]!.id, tasks[1]!.id]);
  });

  it("missions are served in createdAt order and share nothing", () => {
    const m1 = makeMission({ createdAt: at(5) });
    const m2 = makeMission({ createdAt: at(1) });
    const c1 = makeCrew(m1, { limits: { maxConcurrentTasks: 1 } });
    const c2 = makeCrew(m2, { limits: { maxConcurrentTasks: 1 } });
    const t1 = makeTask({ missionId: m1.id, status: "ready" });
    const t2 = makeTask({ missionId: m2.id, status: "ready" });
    const out = schedule(world({ missions: [m1, m2], crews: [c1, c2], tasks: [t1, t2] }));
    expect(out).toEqual([
      { kind: "dispatch", taskId: t2.id, crewId: c2.id },
      { kind: "dispatch", taskId: t1.id, crewId: c1.id },
    ]);
  });

  it.each(["draft", "paused", "completed", "cancelled", "failed"] as const)(
    "%s mission gets no dispatches",
    (status) => {
      const { mission, crew, tasks } = setup(["ready"], {}, { status });
      expect(schedule(world({ missions: [mission], crews: [crew], tasks }))).toEqual([]);
    },
  );

  it.each(["stopped", "archived"] as const)("%s crew gets no dispatches", (status) => {
    const { mission, crew, tasks } = setup(["ready"], { status });
    expect(schedule(world({ missions: [mission], crews: [crew], tasks }))).toEqual([]);
  });

  it("a task pinned to a crew only goes to that crew", () => {
    const mission = makeMission();
    const a = makeCrew(mission, { createdAt: at(0), limits: { maxConcurrentTasks: 1 } });
    const b = makeCrew(mission, { createdAt: at(1), limits: { maxConcurrentTasks: 1 } });
    const t = makeTask({ missionId: mission.id, status: "ready", crewId: b.id });
    const out = schedule(world({ missions: [mission], crews: [a, b], tasks: [t] }));
    expect(out).toEqual([{ kind: "dispatch", taskId: t.id, crewId: b.id }]);
  });

  it("unpinned tasks spill over to the next crew with capacity", () => {
    const mission = makeMission();
    const a = makeCrew(mission, { createdAt: at(0), limits: { maxConcurrentTasks: 1 } });
    const b = makeCrew(mission, { createdAt: at(1), limits: { maxConcurrentTasks: 1 } });
    const ts = [0, 1, 2].map((i) =>
      makeTask({ missionId: mission.id, status: "ready", createdAt: at(i) }),
    );
    const out = schedule(world({ missions: [mission], crews: [a, b], tasks: ts }));
    expect(out).toEqual([
      { kind: "dispatch", taskId: ts[0]!.id, crewId: a.id },
      { kind: "dispatch", taskId: ts[1]!.id, crewId: b.id },
    ]);
  });

  it("default concurrency is 1 when the crew sets no limit", () => {
    const { mission, crew, tasks } = setup(["ready", "ready"], { limits: {} });
    expect(schedule(world({ missions: [mission], crews: [crew], tasks })).length).toBe(1);
  });

  it("a ready task that still holds a live lease is not dispatched again", () => {
    const { mission, crew, tasks } = setup(["ready"]);
    const lease: Lease = {
      taskId: tasks[0]!.id,
      crewId: crew.id,
      sessionId: null,
      heartbeatAt: T0,
      expiresAt: at(99 * 60_000),
    };
    expect(schedule(world({ missions: [mission], crews: [crew], tasks, leases: [lease] }))).toEqual(
      [],
    );
  });
});

describe("schedule: capacity counts leases (M1)", () => {
  it("a ready task holding a live lease takes a slot on the lease's crew", () => {
    const { mission, crew, tasks } = setup(["ready", "ready"], {
      limits: { maxConcurrentTasks: 1 },
    });
    const lease: Lease = {
      taskId: tasks[0]!.id,
      crewId: crew.id,
      sessionId: null,
      heartbeatAt: T0,
      expiresAt: at(99 * 60_000),
    };
    expect(schedule(world({ missions: [mission], crews: [crew], tasks, leases: [lease] }))).toEqual(
      [],
    );
  });

  it("budget-blocked tasks do not take a slot", () => {
    const { mission, crew, tasks } = setup(["ready"], { limits: { maxConcurrentTasks: 1 } });
    const parked = makeTask({
      missionId: mission.id,
      crewId: crew.id,
      status: "blocked",
      blockedReason: BUDGET_EXCEEDED,
    });
    expect(occupiesSlot(parked)).toBe(false);
    // no budgets at all: the parked task gets unblocked, the ready one dispatched
    expect(
      schedule(world({ missions: [mission], crews: [crew], tasks: [...tasks, parked] })),
    ).toEqual([
      { kind: "unblock", taskId: parked.id },
      { kind: "dispatch", taskId: tasks[0]!.id, crewId: crew.id },
    ]);
  });

  it.each([APPROVAL_REQUIRED, POLICY_DENIED])(
    "a task parked on %s before dispatch takes no slot and is never unblocked",
    (reason) => {
      const { mission, crew, tasks } = setup(["ready"], { limits: { maxConcurrentTasks: 1 } });
      const parked = makeTask({
        missionId: mission.id,
        crewId: crew.id,
        status: "blocked",
        blockedReason: reason,
      });
      expect(occupiesSlot(parked)).toBe(false);
      expect(
        schedule(world({ missions: [mission], crews: [crew], tasks: [...tasks, parked] })),
      ).toEqual([{ kind: "dispatch", taskId: tasks[0]!.id, crewId: crew.id }]);
    },
  );

  it("an uncertain (not exhausted) hard budget blocks with budget_uncertain", () => {
    const { mission, crew, tasks } = setup(["ready"]);
    const budget = {
      id: newId("bgt"),
      missionId: mission.id,
      crewId: null,
      limitTokens: 1000,
      limitCost: null,
      warnAtFraction: 0.8,
      createdAt: mission.createdAt,
      updatedAt: mission.createdAt,
      version: 0,
    };
    const usage = [
      {
        id: newId("usg"),
        agentId: newId("agt"),
        tokens: null,
        estimatedCost: null,
        source: "unavailable" as const,
        createdAt: mission.createdAt,
        updatedAt: mission.createdAt,
        version: 0,
      },
    ];
    const out = schedule(
      world({ missions: [mission], crews: [crew], tasks, budgets: [budget], usage }),
    );
    expect(out).toEqual([{ kind: "block", taskId: tasks[0]!.id, reason: "budget_uncertain" }]);
    expect(occupiesSlot({ status: "blocked", blockedReason: BUDGET_UNCERTAIN })).toBe(false);
  });

  it("a task blocked unknown_after_restart keeps its slot (its session may still be alive)", () => {
    expect(
      occupiesSlot(makeTask({ status: "blocked", blockedReason: UNKNOWN_AFTER_RESTART })),
    ).toBe(true);
  });
});

describe("schedule: budgets", () => {
  const agentId = newId("agt");
  const cases: Array<
    [
      string,
      (m: Mission, c: Crew) => Partial<BudgetPolicy>,
      number,
      UsageSource,
      "dispatch" | "block",
    ]
  > = [
    [
      "crew budget left",
      (_m, c) => ({ crewId: c.id, limitTokens: 100 }),
      50,
      "measured",
      "dispatch",
    ],
    [
      "crew budget exhausted",
      (_m, c) => ({ crewId: c.id, limitTokens: 100 }),
      100,
      "measured",
      "block",
    ],
    [
      "mission budget exhausted",
      (m) => ({ missionId: m.id, limitTokens: 100 }),
      150,
      "estimated",
      "block",
    ],
    ["project budget exhausted", () => ({ limitTokens: 10 }), 10, "measured", "block"],
    [
      "other mission's budget ignored",
      () => ({ missionId: newId("msn"), limitTokens: 1 }),
      50,
      "measured",
      "dispatch",
    ],
    [
      "soft budget exhausted still dispatches",
      (_m, c) => ({ crewId: c.id, limitTokens: 1, enforce: "soft" }),
      50,
      "measured",
      "dispatch",
    ],
    [
      "uncertain hard budget blocks by default",
      (_m, c) => ({ crewId: c.id, limitTokens: 100 }),
      1,
      "unavailable",
      "block",
    ],
    [
      "uncertain hard budget with onUnknown allow",
      (_m, c) => ({ crewId: c.id, limitTokens: 100, onUnknown: "allow" }),
      1,
      "unavailable",
      "dispatch",
    ],
  ];
  it.each(cases)("%s -> %s", (_n, budgetOf, tokens, source, want) => {
    const { mission, crew, tasks } = setup(["ready", "ready"]);
    const budgets = [{ ...makeBudget(), ...budgetOf(mission, crew) } as BudgetPolicy];
    const usage = [makeUsage({ agentId, tokens, source })];
    const out = schedule(
      world({
        missions: [mission],
        crews: [crew],
        tasks,
        budgets,
        usage,
        agents: [{ id: agentId, crewId: crew.id }],
      }),
    );
    expect(out.map((d) => d.kind)).toEqual([want, want]);
    if (want === "block") {
      // unknown usage that does not exhaust the budget is reported as uncertain (T12 fix I4)
      const reason = source === "unavailable" ? "budget_uncertain" : "budget_exceeded";
      expect(out[0]).toEqual({ kind: "block", taskId: tasks[0]!.id, reason });
    }
  });

  it("block is edge-triggered: once applied, the next pass is silent until budget returns", () => {
    const { mission, crew, tasks } = setup(["ready"]);
    const budget = makeBudget({ crewId: crew.id, limitTokens: 10 });
    const agents = [{ id: agentId, crewId: crew.id }];
    const usage = [makeUsage({ agentId, tokens: 10 })];
    const s0 = world({
      missions: [mission],
      crews: [crew],
      tasks,
      budgets: [budget],
      usage,
      agents,
    });
    const d0 = schedule(s0);
    expect(d0).toEqual([{ kind: "block", taskId: tasks[0]!.id, reason: "budget_exceeded" }]);
    const s1 = applyDecisions(s0, d0);
    expect(s1.tasks[0]).toMatchObject({ status: "blocked", blockedReason: BUDGET_EXCEEDED });
    expect(schedule(s1)).toEqual([]);
    // budget raised: unblock once, then dispatch on the following pass
    const s2 = { ...s1, budgets: [{ ...budget, limitTokens: 100 }] };
    const d2 = schedule(s2);
    expect(d2).toEqual([{ kind: "unblock", taskId: tasks[0]!.id }]);
    const s3 = applyDecisions(s2, d2);
    expect(s3.tasks[0]!.status).toBe("ready");
    expect(schedule(s3)).toEqual([{ kind: "dispatch", taskId: tasks[0]!.id, crewId: crew.id }]);
  });

  it("no block when one crew is over budget but another is merely at capacity (M2)", () => {
    const mission = makeMission();
    const a = makeCrew(mission, { createdAt: at(0), limits: { maxConcurrentTasks: 1 } });
    const b = makeCrew(mission, { createdAt: at(1), limits: { maxConcurrentTasks: 1 } });
    const busy = makeTask({ missionId: mission.id, status: "running", crewId: b.id });
    const t = makeTask({ missionId: mission.id, status: "ready", createdAt: at(5) });
    const out = schedule(
      world({
        missions: [mission],
        crews: [a, b],
        tasks: [busy, t],
        budgets: [makeBudget({ crewId: a.id, limitTokens: 0 })],
      }),
    );
    expect(out).toEqual([]);
  });

  it("usage without an agent map fails closed for crew budgets (M8)", () => {
    const { mission, crew, tasks } = setup(["ready"]);
    const out = schedule(
      world({
        missions: [mission],
        crews: [crew],
        tasks,
        budgets: [makeBudget({ crewId: crew.id, limitTokens: 1000 })],
        usage: [makeUsage({ tokens: 1 })],
        agents: [],
      }),
    );
    expect(out).toEqual([{ kind: "block", taskId: tasks[0]!.id, reason: "budget_uncertain" }]);
  });

  it("a crew blocked by budget does not stop a task spilling to an unblocked crew", () => {
    const mission = makeMission();
    const a = makeCrew(mission, { createdAt: at(0) });
    const b = makeCrew(mission, { createdAt: at(1) });
    const t = makeTask({ missionId: mission.id, status: "ready" });
    const out = schedule(
      world({
        missions: [mission],
        crews: [a, b],
        tasks: [t],
        budgets: [makeBudget({ crewId: a.id, limitTokens: 0 })],
      }),
    );
    expect(out).toEqual([{ kind: "dispatch", taskId: t.id, crewId: b.id }]);
  });
});

describe("schedule: expire and retry", () => {
  it.each([
    "blocked",
    "verifying",
    "completed",
    "cancelled",
    "failed",
    "ready",
    "pending",
  ] as const)("an expired lease on a %s task is released, not expired (I2)", (status) => {
    const mission = makeMission({ status: "paused" });
    const crew = makeCrew(mission);
    const t = makeTask({ missionId: mission.id, status, crewId: crew.id });
    const l: Lease = {
      taskId: t.id,
      crewId: crew.id,
      sessionId: null,
      heartbeatAt: T0,
      expiresAt: T0,
    };
    const input = world({ missions: [mission], crews: [crew], tasks: [t], leases: [l] });
    const out = schedule(input);
    expect(out).toEqual([
      { kind: "release_lease", taskId: t.id, reason: "expired", taskStatus: status },
    ]);
    const after = applyDecisions(input, out);
    expect(after.leases).toEqual([]);
    expect(after.tasks).toEqual([t]);
    expect(schedule(after)).toEqual([]);
  });

  it("an expired lease for an unknown task is released", () => {
    const taskId = newId("tsk");
    const l: Lease = {
      taskId,
      crewId: newId("crw"),
      sessionId: null,
      heartbeatAt: T0,
      expiresAt: T0,
    };
    expect(schedule(world({ leases: [l] }))).toEqual([
      { kind: "release_lease", taskId, reason: "expired", taskStatus: null },
    ]);
  });

  it("emits expire for leases at or past expiresAt, first, in expiry order", () => {
    const { mission, crew, tasks } = setup(["running", "leased", "running"]);
    const lease = (t: Task, exp: string): Lease => ({
      taskId: t.id,
      crewId: crew.id,
      sessionId: null,
      heartbeatAt: T0,
      expiresAt: exp,
    });
    const out = schedule(
      world({
        missions: [mission],
        crews: [crew],
        tasks,
        leases: [
          lease(tasks[0]!, NOW.toISOString()),
          lease(tasks[1]!, at(1)),
          lease(tasks[2]!, at(99 * 60_000)),
        ],
      }),
    );
    expect(out).toEqual([
      { kind: "expire", taskId: tasks[1]!.id },
      { kind: "expire", taskId: tasks[0]!.id },
    ]);
  });

  it("expires leases even for paused missions", () => {
    const { mission, crew, tasks } = setup(["running"], {}, { status: "paused" });
    const l: Lease = {
      taskId: tasks[0]!.id,
      crewId: crew.id,
      sessionId: null,
      heartbeatAt: T0,
      expiresAt: T0,
    };
    expect(schedule(world({ missions: [mission], crews: [crew], tasks, leases: [l] }))).toEqual([
      { kind: "expire", taskId: tasks[0]!.id },
    ]);
  });

  it.each([
    // attempt, maxAttempts, ms since failure, retry?
    [0, 3, 999, false],
    [0, 3, 1000, true],
    [1, 3, 1999, false],
    [1, 3, 2000, true],
    [2, 3, 1_000_000, false], // no attempts left
    [6, 10, 59_999, false],
    [6, 10, 60_000, true],
    [9, 20, 60_000, true], // capped
  ])("attempt %i/%i failed %ims ago -> retry=%s", (attempt, maxAttempts, ago, want) => {
    const mission = makeMission();
    const crew = makeCrew(mission);
    const failed = makeTask({
      missionId: mission.id,
      status: "failed",
      attempt,
      maxAttempts,
      updatedAt: new Date(NOW.getTime() - ago).toISOString(),
    });
    const other = makeTask({ missionId: mission.id, status: "running", crewId: crew.id });
    const out = schedule(world({ missions: [mission], crews: [crew], tasks: [failed, other] }));
    expect(out.filter((d) => d.kind === "retry")).toEqual(
      want ? [{ kind: "retry", taskId: failed.id }] : [],
    );
  });
});

describe("schedule: mission outcome", () => {
  it.each([
    [["completed", "completed"], "mission_complete"],
    [["completed", "cancelled"], "mission_complete"],
    [["completed", "failed:exhausted"], "mission_failed"],
    [["cancelled"], "mission_failed"],
    [["completed", "running"], null],
    [["completed", "failed"], null], // retryable
    [[], null],
  ] as const)("%j -> %s", (statuses, want) => {
    const mission = makeMission();
    const tasks = statuses.map((s) =>
      s === "failed:exhausted"
        ? makeTask({ missionId: mission.id, status: "failed", attempt: 2, maxAttempts: 3 })
        : makeTask({ missionId: mission.id, status: s, updatedAt: NOW.toISOString() }),
    );
    const out = schedule(world({ missions: [mission], tasks }));
    const outcome = out.filter((d) => d.kind === "mission_complete" || d.kind === "mission_failed");
    expect(outcome).toEqual(want ? [{ kind: want, missionId: mission.id }] : []);
  });

  it("fails a mission whose remaining tasks depend on a dead task", () => {
    const mission = makeMission();
    const dead = makeTask({ missionId: mission.id, status: "cancelled" });
    const done = makeTask({ missionId: mission.id, status: "completed" });
    const waiting = makeTask({ missionId: mission.id, status: "pending" });
    const waiting2 = makeTask({ missionId: mission.id, status: "pending" });
    const deps = [makeDep(waiting.id, dead.id), makeDep(waiting2.id, waiting.id)];
    const out = schedule(
      world({ missions: [mission], tasks: [dead, done, waiting, waiting2], deps }),
    );
    expect(out).toEqual([{ kind: "mission_failed", missionId: mission.id }]);
  });

  it("does not fail while a pending task can still become ready", () => {
    const mission = makeMission();
    const up = makeTask({ missionId: mission.id, status: "running" });
    const dead = makeTask({ missionId: mission.id, status: "cancelled" });
    const waiting = makeTask({ missionId: mission.id, status: "pending" });
    const deps = [makeDep(waiting.id, up.id)];
    expect(schedule(world({ missions: [mission], tasks: [up, dead, waiting], deps }))).toEqual([]);
  });

  it("a task that fails verification with no attempts left resolves the mission as failed (I1)", () => {
    const mission = makeMission();
    const crew = makeCrew(mission);
    const done = makeTask({ missionId: mission.id, status: "completed" });
    const verifying = makeTask({
      missionId: mission.id,
      crewId: crew.id,
      status: "verifying",
      attempt: 2,
      maxAttempts: 3,
    });
    const failed = taskMachine.transition(verifying, { type: "verification_failed" });
    expect(failed.status).toBe("failed");
    const input = world({ missions: [mission], crews: [crew], tasks: [done, failed] });
    const out = schedule(input);
    expect(out).toEqual([{ kind: "mission_failed", missionId: mission.id }]);
    expect(applyDecisions(input, out).missions[0]!.status).toBe("failed");
  });

  it("paused missions are not completed by the scheduler", () => {
    const mission = makeMission({ status: "paused" });
    const tasks = [makeTask({ missionId: mission.id, status: "completed" })];
    expect(schedule(world({ missions: [mission], tasks }))).toEqual([]);
  });
});

// ---------------------------------------------------------------- properties

const STATUSES: TaskStatus[] = [
  "pending",
  "ready",
  "leased",
  "running",
  "verifying",
  "completed",
  "blocked",
  "failed",
  "cancelled",
];
const MISSION_STATUSES = ["draft", "active", "active", "active", "paused"] as const;

/** A random, internally consistent world built from fixed id pools. */
const worldArb = fc
  .record({
    missions: fc.array(fc.record({ status: fc.constantFrom(...MISSION_STATUSES), t: fc.nat(3) }), {
      minLength: 1,
      maxLength: 3,
    }),
    crews: fc.array(
      fc.record({
        m: fc.nat(2),
        max: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
        status: fc.constantFrom("configured", "running", "running", "stopped"),
        t: fc.nat(3),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    tasks: fc.array(
      fc.record({
        m: fc.nat(2),
        c: fc.option(fc.nat(3), { nil: null }),
        status: fc.constantFrom(...STATUSES),
        attempt: fc.nat(3),
        max: fc.integer({ min: 1, max: 4 }),
        t: fc.nat(5),
        failedAgo: fc.nat(70_000),
        budgetBlocked: fc.boolean(),
      }),
      { maxLength: 12 },
    ),
    deps: fc.array(fc.tuple(fc.nat(11), fc.nat(11)), { maxLength: 10 }),
    leases: fc.array(fc.record({ i: fc.nat(11), exp: fc.integer({ min: -60_000, max: 60_000 }) }), {
      maxLength: 6,
    }),
    budgets: fc.array(
      fc.record({
        scope: fc.constantFrom("crew", "mission", "project"),
        i: fc.nat(3),
        limit: fc.nat(100),
        enforce: fc.constantFrom("hard", "soft"),
      }),
      { maxLength: 3 },
    ),
    usage: fc.array(
      fc.record({
        a: fc.nat(3),
        tokens: fc.nat(60),
        source: fc.constantFrom<UsageSource>("measured", "estimated", "unavailable"),
      }),
      { maxLength: 5 },
    ),
  })
  .map((r): ScheduleInput => {
    const missions = r.missions.map((m) => makeMission({ status: m.status, createdAt: at(m.t) }));
    const crews = r.crews.map((c) =>
      makeCrew(missions[c.m % missions.length]!, {
        status: c.status,
        createdAt: at(c.t),
        limits: c.max === undefined ? {} : { maxConcurrentTasks: c.max },
      }),
    );
    const tasks = r.tasks.map((t) => {
      const mission = missions[t.m % missions.length]!;
      const own = crews.filter((c) => c.missionId === mission.id);
      const crew = t.c === null || own.length === 0 ? null : own[t.c % own.length]!;
      return makeTask({
        missionId: mission.id,
        crewId: crew?.id ?? null,
        status: t.status,
        attempt: Math.min(t.attempt, t.max - 1),
        maxAttempts: t.max,
        createdAt: at(t.t),
        updatedAt: new Date(NOW.getTime() - t.failedAgo).toISOString(),
        ...(t.status === "blocked"
          ? { blockedReason: t.budgetBlocked ? BUDGET_EXCEEDED : "needs input" }
          : {}),
      });
    });
    const deps =
      tasks.length < 2
        ? []
        : r.deps
            .map(([a, b]) => [a % tasks.length, b % tasks.length] as const)
            .filter(([a, b]) => a > b)
            .map(([a, b]) => makeDep(tasks[a]!.id, tasks[b]!.id));
    const leases: Lease[] =
      tasks.length === 0
        ? []
        : [
            ...new Map(
              r.leases.map((l) => {
                const t = tasks[l.i % tasks.length]!;
                return [
                  t.id,
                  {
                    taskId: t.id,
                    crewId: crews[0]!.id,
                    sessionId: null,
                    heartbeatAt: T0,
                    expiresAt: new Date(NOW.getTime() + l.exp).toISOString(),
                  },
                ] as const;
              }),
            ).values(),
          ];
    const agents = crews.map((c) => ({ id: newId("agt"), crewId: c.id }));
    const budgets: BudgetPolicy[] = r.budgets.map((b) => ({
      ...makeBudget({
        limitTokens: b.limit,
        crewId: b.scope === "crew" ? crews[b.i % crews.length]!.id : null,
        missionId: b.scope === "mission" ? missions[b.i % missions.length]!.id : null,
      }),
      enforce: b.enforce,
    }));
    // index == agents.length is an agent the attribution map does not know
    const usage = r.usage.map((u) =>
      makeUsage({
        agentId: agents[u.a % (agents.length + 1)]?.id ?? newId("agt"),
        tokens: u.tokens,
        source: u.source,
      }),
    );
    return { now: NOW, missions, crews, tasks, deps, leases, usage, budgets, agents };
  });

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("schedule: properties", () => {
  const dispatches = (ds: Decision[]) =>
    ds.filter((d): d is Extract<Decision, { kind: "dispatch" }> => d.kind === "dispatch");

  it("never dispatches one task twice", () => {
    fc.assert(
      fc.property(worldArb, (input) => {
        const ids = dispatches(schedule(input)).map((d) => d.taskId);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      { numRuns: 500 },
    );
  });

  it("never pushes a crew over maxConcurrentTasks", () => {
    fc.assert(
      fc.property(worldArb, (input) => {
        const out = dispatches(schedule(input));
        for (const crew of input.crews) {
          const max = crew.limits.maxConcurrentTasks ?? 1;
          const live = input.leases.filter(
            (l) =>
              l.crewId === crew.id &&
              !leaseManager.isExpired(l, input.now) &&
              input.tasks.find((t) => t.id === l.taskId)?.status === "ready",
          ).length;
          const active =
            live + input.tasks.filter((t) => t.crewId === crew.id && occupiesSlot(t)).length;
          const added = out.filter((d) => d.crewId === crew.id).length;
          if (added > 0) expect(active + added).toBeLessThanOrEqual(max);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("only dispatches ready tasks of active missions to that mission's crews", () => {
    fc.assert(
      fc.property(worldArb, (input) => {
        for (const d of dispatches(schedule(input))) {
          const task = input.tasks.find((t) => t.id === d.taskId)!;
          const crew = input.crews.find((c) => c.id === d.crewId)!;
          const mission = input.missions.find((m) => m.id === task.missionId)!;
          expect(task.status).toBe("ready");
          expect(mission.status).toBe("active");
          expect(crew.missionId).toBe(mission.id);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("every decision applies as a legal transition, and decisions are edge-triggered", () => {
    fc.assert(
      fc.property(worldArb, (input) => {
        let state = input;
        const blockedOnce = new Set<string>();
        for (let pass = 0; pass < 4; pass++) {
          const out = schedule(state);
          // throws invalid_transition / lease conflict if any decision is illegal
          const next = applyDecisions(state, out);
          for (const d of out) {
            if (d.kind === "block") {
              // budgets and usage are fixed, so a task is blocked at most once
              expect(blockedOnce.has(d.taskId)).toBe(false);
              blockedOnce.add(d.taskId);
            }
            if (d.kind === "unblock") expect(blockedOnce.has(d.taskId)).toBe(false);
          }
          // the post-apply pass never repeats a block or a lease cleanup
          const again = schedule(next);
          const repeated = again.filter(
            (d) =>
              (d.kind === "block" || d.kind === "release_lease" || d.kind === "expire") &&
              out.some((o) => o.kind === d.kind && "taskId" in o && o.taskId === d.taskId),
          );
          expect(repeated).toEqual([]);
          state = next;
        }
      }),
      { numRuns: 400 },
    );
  });

  it("with a fixed clock, draining schedule/apply terminates", () => {
    fc.assert(
      fc.property(worldArb, (input) => {
        let state = input;
        let passes = 0;
        for (let out = schedule(state); out.length > 0; out = schedule(state)) {
          state = applyDecisions(state, out);
          passes++;
          expect(passes).toBeLessThan(50);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent and does not mutate its input", () => {
    fc.assert(
      fc.property(worldArb, (input) => {
        const snapshot = structuredClone(input);
        const first = schedule(input);
        expect(input).toEqual(snapshot);
        expect(schedule(input)).toEqual(first);
      }),
      { numRuns: 300 },
    );
  });

  it("is independent of input array order", () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 1, max: 1_000_000 }), (input, seed) => {
        const shuffledInput: ScheduleInput = {
          ...input,
          missions: shuffled(input.missions, seed),
          crews: shuffled(input.crews, seed + 1),
          tasks: shuffled(input.tasks, seed + 2),
          deps: shuffled(input.deps, seed + 3),
          leases: shuffled(input.leases, seed + 4),
          usage: shuffled(input.usage, seed + 5),
          budgets: shuffled(input.budgets, seed + 6),
        };
        expect(schedule(shuffledInput)).toEqual(schedule(input));
      }),
      { numRuns: 300 },
    );
  });
});

it("honors priority within dependency-ready tasks and paused crews", () => {
  const { mission, crew, tasks } = setup(["ready", "ready"], { limits: { maxConcurrentTasks: 1 } });
  tasks[1]!.priority = 90;
  expect(
    schedule(world({ missions: [mission], crews: [crew], tasks })).filter(
      (d) => d.kind === "dispatch",
    ),
  ).toEqual([{ kind: "dispatch", taskId: tasks[1]!.id, crewId: crew.id }]);
  expect(
    schedule(
      world({ missions: [mission], crews: [{ ...crew, schedulingPaused: true }], tasks }),
    ).filter((d) => d.kind === "dispatch"),
  ).toEqual([]);
});
