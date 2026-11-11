import type { SqliteDatabase } from "@sindri/knowledge";
import { openDeliveryTestDb } from "./test-db.test-helpers.js";
import { MimirClientFacade, MimirError } from "@sindri/mimir-client";
import { approvedPlan, planTask } from "@sindri/mimir-client/testing";
import type { Plan } from "@sindri/planner";
import { createFakeMimir, type FakeMimir, type TaskStep } from "@sindri/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeliveryLoop,
  type DeliveryLogger,
  type DeliveryNotice,
  type PermissionPolicy,
} from "./delivery-loop.js";

let fake: FakeMimir | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => {
  await fake?.close();
  db?.close();
  fake = undefined;
  db = undefined;
});

interface Harness {
  fake: FakeMimir;
  db: SqliteDatabase;
  loop: DeliveryLoop;
  notices: DeliveryNotice[];
  newLoop(): DeliveryLoop;
}

async function boot(
  scripts: Record<string, TaskStep[]> = {},
  permissionPolicy?: PermissionPolicy,
  stepDelayMs = 0,
  logger?: DeliveryLogger,
): Promise<Harness> {
  const f = (fake = await createFakeMimir({ stepDelayMs, scripts }));
  const d = (db = openDeliveryTestDb());
  const notices: DeliveryNotice[] = [];
  const newLoop = () => {
    const mimir = new MimirClientFacade({ db: d }).connect({ baseUrl: f.url, token: f.token });
    const loop = new DeliveryLoop({
      db: d,
      mimir,
      ...(permissionPolicy ? { permissionPolicy } : {}),
      logger: logger ?? { warn: () => undefined },
    });
    loop.on((n) => notices.push(n));
    return loop;
  };
  return { fake: f, db: d, loop: newLoop(), notices, newLoop };
}

async function execute(h: Harness, plan: Plan) {
  const mimir = new MimirClientFacade({ db: h.db }).connect({
    baseUrl: h.fake.url,
    token: h.fake.token,
  });
  const project = await mimir.ensureProject("/repos/app");
  return h.loop.createExecution(plan, { projectId: project.id });
}

const threeTasks = () =>
  approvedPlan([
    planTask("impl"),
    planTask("review", { role: "reviewer", dependsOn: ["impl"] }),
    planTask("docs", { role: "docs", dependsOn: ["review"] }),
  ]);

function eventIds(db: SqliteDatabase, executionId: string): string[] {
  return (
    db
      .prepare(
        "SELECT mimir_event_id FROM execution_events WHERE execution_id = ? AND source = 'mimir'",
      )
      .all(executionId) as { mimir_event_id: string }[]
  ).map((r) => r.mimir_event_id);
}

describe("DeliveryLoop", () => {
  it("creates an execution with one row per plan task mapped to Mimir task ids", async () => {
    const h = await boot();
    const exec = await execute(h, threeTasks());
    expect(exec.status).toBe("pending");
    expect(exec.planId).toBe("plan-1");
    expect(exec.mimirMissionId).toMatch(/^msn_/);
    const tasks = h.loop.tasks(exec.id);
    expect(tasks.map((t) => t.planTaskId).sort()).toEqual(["docs", "impl", "review"]);
    expect(tasks.every((t) => /^tsk_/.test(t.mimirTaskId) && t.attempts === 0)).toBe(true);
    // Idempotent: asking again for the same plan version returns the same execution.
    const again = await execute(h, threeTasks());
    expect(again.id).toBe(exec.id);
    expect(h.fake.creates.missions).toBe(1);
  });

  it("records each task's latest Mimir session id from event envelopes (agent deep links)", async () => {
    const h = await boot();
    const exec = await execute(h, threeTasks());
    await h.loop.run(exec.id);
    const tasks = h.loop.tasks(exec.id);
    expect(tasks.every((t) => typeof t.sessionId === "string" && /^ses/.test(t.sessionId))).toBe(
      true,
    );
    expect(new Set(tasks.map((t) => t.sessionId)).size).toBe(tasks.length);
  });

  it("runs a mission to verified_pending_review, collecting artifacts", async () => {
    const h = await boot();
    const exec = await execute(h, threeTasks());
    const result = await h.loop.run(exec.id);
    expect(result.status).toBe("verified_pending_review");
    const after = h.loop.get(exec.id)!;
    expect(after.startedAt).toBeTruthy();
    expect(after.finishedAt).toBeTruthy();
    expect(h.loop.tasks(exec.id).every((t) => t.status === "completed")).toBe(true);
    const artifacts = h.loop.artifacts(exec.id);
    expect(artifacts.map((a) => a.kind).sort()).toEqual([
      "changed-files",
      "changed-files",
      "changed-files",
      "diff",
      "diff",
      "diff",
      "test.output",
      "test.output",
      "test.output",
    ]);
    expect(artifacts.every((a) => /^sha256:[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    // Each artifact is re-read from Mimir on completion.
    const reads = h.fake.requests.filter(
      (r) => r.method === "GET" && r.path.startsWith("/v1/artifacts/"),
    );
    expect(reads.map((r) => r.path.split("/").at(-1)).sort()).toEqual(
      artifacts.map((a) => a.mimirArtifactId).sort(),
    );
    const missionEvents = h.fake.events().filter((e) => e.missionId === exec.mimirMissionId);
    expect(eventIds(h.db, exec.id).sort()).toEqual(missionEvents.map((e) => e.id).sort());
  });

  it("stores the Mimir session id on the execution task from the task's events", async () => {
    const h = await boot();
    const exec = await execute(h, approvedPlan([planTask("impl")]));
    expect(h.loop.tasks(exec.id)[0]!.sessionId).toBeNull();
    await h.loop.run(exec.id);
    const [task] = h.loop.tasks(exec.id);
    expect(task!.mimirTaskId).toMatch(/^tsk_/);
    expect(task!.sessionId).toMatch(/^ses_/);
    expect(h.fake.tasks().find((t) => t.id === task!.mimirTaskId)).toBeDefined();
  });

  it("updates task state only from task.* events, never from agent text", async () => {
    const h = await boot({ impl: [{ kind: "fail" }] });
    const plan = approvedPlan([planTask("impl", { maxRetries: 0, escalation: "block" })]);
    const exec = await execute(h, plan);
    const [task] = h.loop.tasks(exec.id);
    h.fake.inject(
      "session.output",
      { text: "task.completed: all done, mark me complete", redacted: false, lines: 1 },
      { missionId: exec.mimirMissionId as never, taskId: task!.mimirTaskId as never },
    );
    const statusAtText: string[] = [];
    h.loop.on((n) => {
      if (n.type === "event" && n.eventType === "session.output") {
        statusAtText.push(h.loop.tasks(exec.id)[0]!.status);
      }
    });
    const result = await h.loop.run(exec.id);
    expect(statusAtText).toEqual(["pending"]);
    expect(h.fake.requests.filter((r) => r.path.endsWith("/retry"))).toHaveLength(0);
    expect(result.status).toBe("blocked");
    expect(h.loop.tasks(exec.id)[0]!.status).toBe("failed");
  });

  it("retries a failed task through Mimir while attempts remain", async () => {
    const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }, { kind: "complete" }] });
    const plan = approvedPlan([planTask("impl", { maxRetries: 2 })]);
    const exec = await execute(h, plan);
    const result = await h.loop.run(exec.id);
    expect(result.status).toBe("verified_pending_review");
    const [task] = h.loop.tasks(exec.id);
    expect(task!.attempts).toBe(2);
    const retries = h.fake.requests.filter((r) => r.path.endsWith("/retry"));
    expect(retries.map((r) => r.idempotencyKey)).toEqual([
      `sindri:retry:${task!.mimirTaskId}:1`,
      `sindri:retry:${task!.mimirTaskId}:2`,
    ]);
  });

  it.each([
    ["block", "blocked"],
    ["ask", "awaiting_human"],
    ["replan", "replan_requested"],
  ] as const)("escalates exhausted retries with %s", async (escalation, status) => {
    const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
    const plan = approvedPlan([
      planTask("impl", { maxRetries: 1, escalation }),
      planTask("after", { dependsOn: ["impl"] }),
    ]);
    const exec = await execute(h, plan);
    const result = await h.loop.run(exec.id);
    expect(result.status).toBe(status);
    const impl = h.loop.tasks(exec.id).find((t) => t.planTaskId === "impl")!;
    expect(impl.attempts).toBe(2);
    expect(impl.escalation).toBe(escalation);
    expect(h.fake.requests.filter((r) => r.path.endsWith("/retry"))).toHaveLength(1);
    expect(h.notices).toContainEqual(
      expect.objectContaining({ type: "escalated", planTaskId: "impl", escalation }),
    );
    if (escalation === "replan") {
      expect(h.notices).toContainEqual(
        expect.objectContaining({
          type: "replan_requested",
          executionId: exec.id,
          planTaskId: "impl",
        }),
      );
    }
  });

  it("surfaces approvals to the inbox and never auto-approves", async () => {
    const h = await boot(
      { impl: [{ kind: "approval", action: "git.push" }] },
      { requireApproval: ["git.push"] },
    );
    const exec = await execute(h, approvedPlan([planTask("impl")]));
    const first = await h.loop.run(exec.id);
    expect(first.status).toBe("awaiting_human");
    const [approval] = h.loop.approvals(exec.id);
    expect(approval).toMatchObject({
      action: "git.push",
      status: "pending",
      disposition: "inbox",
      planTaskId: "impl",
    });
    expect(h.fake.approvals()[0]!.status).toBe("pending");
    expect(h.fake.requests.some((r) => r.path.includes("/approvals/"))).toBe(false);
    expect(h.notices).toContainEqual(
      expect.objectContaining({ type: "awaiting_human", approvalId: approval!.mimirApprovalId }),
    );
    // A human approves; the loop resumes to completion.
    await h.loop.decideApproval(exec.id, approval!.mimirApprovalId, "approved", "looks fine");
    const second = await h.loop.resume(exec.id);
    expect(second.status).toBe("verified_pending_review");
    expect(h.loop.approvals(exec.id)[0]!.status).toBe("approved");
  });

  it("treats actions outside requireApproval the same way: surfaced, not approved", async () => {
    const h = await boot({ impl: [{ kind: "approval", action: "shell.destructive" }] });
    const exec = await execute(h, approvedPlan([planTask("impl")]));
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    expect(h.fake.approvals()[0]!.status).toBe("pending");
  });

  it("rejects actions the policy denies and escalates the task", async () => {
    const h = await boot(
      { impl: [{ kind: "approval", action: "deploy.production" }] },
      { requireApproval: [], deny: ["deploy.production"] },
    );
    const exec = await execute(h, approvedPlan([planTask("impl", { escalation: "block" })]));
    const result = await h.loop.run(exec.id);
    expect(result.status).toBe("blocked");
    expect(h.fake.approvals()[0]!.status).toBe("rejected");
    expect(h.loop.approvals(exec.id)[0]).toMatchObject({
      disposition: "auto_rejected",
      status: "rejected",
    });
  });

  it("survives the stream being killed mid-way: no duplicate events, correct final state", async () => {
    const h = await boot({}, undefined, 2);
    const exec = await execute(h, threeTasks());
    let killed = false;
    h.loop.on((n) => {
      if (!killed && n.type === "event" && n.eventType === "task.completed") {
        killed = true;
        void h.fake.stop().then(() => h.fake.start());
      }
    });
    const result = await h.loop.run(exec.id);
    expect(killed).toBe(true);
    expect(result.status).toBe("verified_pending_review");
    const ids = eventIds(h.db, exec.id);
    expect(new Set(ids).size).toBe(ids.length);
    const missionEvents = h.fake.events().filter((e) => e.missionId === exec.mimirMissionId);
    expect(ids.sort()).toEqual(missionEvents.map((e) => e.id).sort());
  });

  it("resume(executionId) after a crash replays from the stored cursor without duplicates", async () => {
    const h = await boot({}, undefined, 2);
    const exec = await execute(h, threeTasks());
    const ac = new AbortController();
    h.loop.on((n) => {
      if (n.type === "event" && n.eventType === "task.completed") ac.abort();
    });
    const interrupted = await h.loop.run(exec.id, { signal: ac.signal });
    expect(interrupted.status).toBe("running");
    expect(interrupted.interrupted).toBe(true);
    const before = eventIds(h.db, exec.id).length;
    expect(before).toBeGreaterThan(0);
    // Simulate a stale cursor (e.g. a crash before the cursor reached disk): rewind to the start.
    h.db.prepare("UPDATE execution_cursors SET cursor = ?").run(h.fake.cursorAt(0));
    // Process restart: a new loop and facade on the same database.
    const loop2 = h.newLoop();
    const result = await loop2.resume(exec.id);
    expect(result.status).toBe("verified_pending_review");
    const ids = eventIds(h.db, exec.id);
    expect(new Set(ids).size).toBe(ids.length);
    const missionEvents = h.fake.events().filter((e) => e.missionId === exec.mimirMissionId);
    expect(ids.sort()).toEqual(missionEvents.map((e) => e.id).sort());
    expect(loop2.tasks(exec.id).every((t) => t.status === "completed")).toBe(true);
    expect(h.fake.requests.filter((r) => r.path.endsWith("/start"))).toHaveLength(2);
    expect(h.fake.creates.missions).toBe(1);
  });
});

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sindriEvents = (h: Harness, executionId: string) =>
  h.loop.events(executionId).filter((e) => e.source === "sindri");

describe("DeliveryLoop fix round 1", () => {
  describe("I-2: resolving escalations and picking up human decisions", () => {
    const askPlan = () =>
      approvedPlan([planTask("impl", { maxRetries: 1, escalation: "ask" }), planTask("other")]);

    it("resume() reads events after awaiting_human, so a decision made elsewhere is picked up", async () => {
      const h = await boot({ impl: [{ kind: "approval", action: "git.push" }] });
      const exec = await execute(h, approvedPlan([planTask("impl")]));
      expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
      // The human decides in Mimir's UI, not through Sindri.
      const mimir = new MimirClientFacade({ db: h.db }).connect({
        baseUrl: h.fake.url,
        token: h.fake.token,
      });
      await mimir.decideApproval(h.fake.approvals()[0]!.id, "approved");
      await until(() => h.fake.events().some((e) => e.type === "mission.completed"));
      const result = await h.loop.resume(exec.id);
      expect(result.status).toBe("verified_pending_review");
      expect(h.loop.approvals(exec.id)[0]!.status).toBe("approved");
    });

    it("an ask escalation goes to the inbox and resume() alone stays awaiting_human", async () => {
      const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
      const exec = await execute(h, askPlan());
      expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
      expect(h.loop.inbox(exec.id)).toEqual([
        expect.objectContaining({ kind: "escalation", planTaskId: "impl", status: "open" }),
      ]);
      expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    });

    it("retry: a human grants another attempt and the loop runs to completion", async () => {
      const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }, { kind: "complete" }] });
      const exec = await execute(h, askPlan());
      expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
      const result = await h.loop.resolveEscalation(exec.id, "impl", {
        decision: "retry",
        actor: "jacob",
        reason: "flaky network",
      });
      expect(result.status).toBe("verified_pending_review");
      const impl = h.loop.tasks(exec.id).find((t) => t.planTaskId === "impl")!;
      expect(impl.escalation).toBeNull();
      expect(impl.status).toBe("completed");
      const keys = h.fake.requests
        .filter((r) => r.path.endsWith("/retry"))
        .map((r) => r.idempotencyKey);
      expect(keys).toEqual([
        `sindri:retry:${impl.mimirTaskId}:1`,
        `sindri:retry:${impl.mimirTaskId}:3`,
      ]);
      expect(sindriEvents(h, exec.id)).toContainEqual(
        expect.objectContaining({
          type: "escalation_resolved",
          payload: expect.objectContaining({
            planTaskId: "impl",
            decision: "retry",
            actor: "jacob",
          }),
        }),
      );
      expect(h.loop.inbox(exec.id)[0]!.status).toBe("resolved");
    });

    it("skip: the task and its dependants are skipped and the execution finishes", async () => {
      const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
      const plan = approvedPlan([
        planTask("impl", { maxRetries: 1, escalation: "ask" }),
        planTask("after", { dependsOn: ["impl"] }),
        planTask("other"),
      ]);
      const exec = await execute(h, plan);
      expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
      const result = await h.loop.resolveEscalation(exec.id, "impl", {
        decision: "skip",
        actor: "jacob",
        reason: "not needed",
      });
      expect(result.status).toBe("verified_pending_review");
      const byId = Object.fromEntries(h.loop.tasks(exec.id).map((t) => [t.planTaskId, t]));
      expect(byId.impl!.resolution).toBe("skipped");
      expect(byId.after!.resolution).toBe("skipped_dependency");
      expect(byId.other!.status).toBe("completed");
      // Mimir can never complete the mission now, so Sindri cancels it.
      expect(h.fake.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
      expect(h.loop.get(exec.id)!.finishedAt).toBeTruthy();
    });

    it("replan: the escalation becomes replan and replan_requested is emitted", async () => {
      const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
      const exec = await execute(h, askPlan());
      await h.loop.run(exec.id);
      const result = await h.loop.resolveEscalation(exec.id, "impl", {
        decision: "replan",
        actor: "jacob",
        reason: "wrong approach",
      });
      expect(result.status).toBe("replan_requested");
      expect(h.loop.tasks(exec.id).find((t) => t.planTaskId === "impl")!.escalation).toBe("replan");
      expect(h.notices).toContainEqual(
        expect.objectContaining({
          type: "replan_requested",
          executionId: exec.id,
          planTaskId: "impl",
        }),
      );
    });

    it("abort: the mission is cancelled and the execution ends cancelled", async () => {
      const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
      const exec = await execute(h, askPlan());
      await h.loop.run(exec.id);
      const result = await h.loop.resolveEscalation(exec.id, "impl", {
        decision: "abort",
        actor: "jacob",
        reason: "stop",
      });
      expect(result.status).toBe("cancelled");
      expect(h.fake.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
      expect(h.loop.get(exec.id)!.finishedAt).toBeTruthy();
      expect((await h.loop.resume(exec.id)).status).toBe("cancelled");
    });

    it("refuses to resolve a task that is not escalated", async () => {
      const h = await boot();
      const exec = await execute(h, askPlan());
      await expect(
        h.loop.resolveEscalation(exec.id, "impl", { decision: "skip", actor: "j", reason: "r" }),
      ).rejects.toThrow(/not escalated/);
    });
  });

  describe("I-3: executing a plan version again", () => {
    it("a finished execution is never reattached: a new mission runs to completion", async () => {
      const h = await boot();
      const plan = threeTasks();
      const first = await execute(h, plan);
      expect((await h.loop.run(first.id)).status).toBe("verified_pending_review");
      const second = await execute(h, plan);
      expect(second.id).not.toBe(first.id);
      expect(second.runNumber).toBe(2);
      expect(second.mimirMissionId).not.toBe(first.mimirMissionId);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      const result = await h.loop.run(second.id, { signal: ac.signal });
      clearTimeout(timer);
      expect(result).toEqual({ status: "verified_pending_review", interrupted: false });
      expect(h.fake.creates.missions).toBe(2);
    });

    it("dedupes events per execution and allows one execution per Mimir mission", async () => {
      const h = await boot();
      const exec = await execute(h, threeTasks());
      const insert = h.db.prepare(
        `INSERT INTO execution_events (id, execution_id, mimir_event_id, type, payload_json, occurred_at)
         VALUES (?, ?, ?, 't', '{}', 'now')`,
      );
      h.db
        .prepare(
          `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at)
           VALUES ('other', 'p', 1, 'msn_other', 'pending', '{}', 'now')`,
        )
        .run();
      insert.run("a", exec.id, "evt_X");
      insert.run("b", "other", "evt_X");
      expect(() => insert.run("c", exec.id, "evt_X")).toThrow(/UNIQUE/);
      expect(() =>
        h.db
          .prepare(
            `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at)
             VALUES ('dup', 'p', 2, ?, 'pending', '{}', 'now')`,
          )
          .run(exec.mimirMissionId),
      ).toThrow(/UNIQUE/);
    });
  });

  describe("I-4: budgets", () => {
    it("sends crews their token and cost budgets and records only what Mimir cannot enforce", async () => {
      const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
      const h = await boot({}, undefined, 0, {
        warn: (msg, fields) => warnings.push(fields ? { msg, fields } : { msg }),
      });
      const exec = await execute(h, approvedPlan([planTask("impl")]));
      const crew = h.fake.requests.find((r) => r.method === "POST" && r.path === "/v1/crews");
      expect(crew?.body).toMatchObject({
        budget: { limitTokens: 1000, enforce: "hard" },
      });
      expect(sindriEvents(h, exec.id).filter((e) => e.type === "budget_not_forwarded")).toEqual([]);
      const task = h.fake.requests.find((r) => r.method === "POST" && r.path === "/v1/tasks");
      expect(task?.body).toMatchObject({ timeoutMs: 1800000 });
      expect(warnings).toEqual([]);
    });

    it("budget.exceeded blocks the task with a reason and surfaces it to the inbox", async () => {
      const h = await boot({ impl: [{ kind: "approval", action: "git.push" }] });
      const exec = await execute(h, approvedPlan([planTask("impl")]));
      expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
      const [task] = h.loop.tasks(exec.id);
      h.fake.inject(
        "budget.exceeded",
        { budgetId: "bgt_01J0000000000000000000000A", unit: "tokens", used: 120, limit: 100 },
        { missionId: exec.mimirMissionId as never, taskId: task!.mimirTaskId as never },
      );
      expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
      const after = h.loop.tasks(exec.id)[0]!;
      expect(after.status).toBe("blocked");
      expect(after.blockedReason).toBe("budget_exceeded: tokens 120/100");
      expect(after.escalation).toBe("ask");
      expect(h.loop.inbox(exec.id)).toContainEqual(
        expect.objectContaining({ kind: "budget_exceeded", planTaskId: "impl", status: "open" }),
      );
      expect(h.notices).toContainEqual(
        expect.objectContaining({
          type: "inbox_item",
          kind: "budget_exceeded",
          planTaskId: "impl",
        }),
      );
    });
  });
});

describe("DeliveryLoop: runs that end outside the happy path", () => {
  const askPlan = (overrides: Partial<Plan> = {}) =>
    approvedPlan([planTask("impl", { maxRetries: 1, escalation: "ask" })], overrides);
  const failTwice = { impl: [{ kind: "fail" }, { kind: "fail" }] as TaskStep[] };

  /** Ends the mission in the fake without the loop knowing (as Mimir or another client would). */
  async function cancelInMimir(h: Harness, missionId: string) {
    const res = await fetch(`${h.fake.url}/v1/missions/${missionId}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${h.fake.token}`,
        "content-type": "application/json",
        "idempotency-key": "test:cancel-elsewhere",
      },
      body: "{}",
    });
    expect(res.status).toBe(202);
  }

  const failMission = (h: Harness, missionId: string) =>
    h.fake.inject(
      "mission.failed",
      { from: "active", to: "failed", reason: "task exhausted" },
      { missionId: missionId as never },
    );
  const cancels = (h: Harness) => h.fake.requests.filter((r) => r.path.endsWith("/cancel"));

  it("mission.failed with nothing awaiting a human ends the execution failed and closes its approvals", async () => {
    const h = await boot({ impl: [{ kind: "approval", action: "git.push" }] });
    const exec = await execute(h, approvedPlan([planTask("impl")]));
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    failMission(h, exec.mimirMissionId);
    expect(await h.loop.resume(exec.id)).toEqual({ status: "failed", interrupted: false });
    expect(h.loop.get(exec.id)!.finishedAt).toBeTruthy();
    expect(h.notices).toContainEqual(
      expect.objectContaining({ type: "status_changed", executionId: exec.id, to: "failed" }),
    );
    expect(h.loop.approvals(exec.id).map((a) => a.status)).toEqual(["expired"]);
    expect(h.loop.inbox(exec.id).filter((i) => i.status === "open")).toEqual([]);
  });

  it("mission.failed leaves an escalated execution waiting; skip then delivers the verified work", async () => {
    const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
    const plan = approvedPlan([
      planTask("other"),
      planTask("impl", { maxRetries: 1, escalation: "ask", dependsOn: ["other"] }),
      planTask("after", { dependsOn: ["impl"] }),
    ]);
    const exec = await execute(h, plan);
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    // Mimir fails the mission after the loop stopped reading on the escalation. A retry reads
    // that first: the mission is over, so another attempt is impossible and nothing changes.
    failMission(h, exec.mimirMissionId);
    await expect(
      h.loop.resolveEscalation(exec.id, "impl", { decision: "retry", actor: "j", reason: "r" }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(h.fake.requests.filter((r) => r.path.endsWith("/retry"))).toHaveLength(1);
    expect(await h.loop.resume(exec.id)).toEqual({ status: "awaiting_human", interrupted: false });
    expect(h.loop.get(exec.id)!.finishedAt).toBeNull();
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["open"]);
    await expect(
      h.loop.resolveEscalation(exec.id, "impl", { decision: "retry", actor: "j", reason: "r" }),
    ).rejects.toThrow(/mission has ended.*run the plan again/);
    expect(h.loop.get(exec.id)!.status).toBe("awaiting_human");
    expect(h.loop.tasks(exec.id).find((t) => t.planTaskId === "impl")!.escalation).toBe("ask");
    const result = await h.loop.resolveEscalation(exec.id, "impl", {
      decision: "skip",
      actor: "jacob",
      reason: "not needed",
    });
    expect(result).toEqual({ status: "verified_pending_review", interrupted: false });
    const byId = Object.fromEntries(h.loop.tasks(exec.id).map((t) => [t.planTaskId, t]));
    expect(byId.other!.status).toBe("completed");
    expect(byId.impl!.resolution).toBe("skipped");
    expect(byId.after!.resolution).toBe("skipped_dependency");
    expect(h.loop.get(exec.id)!.finishedAt).toBeTruthy();
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["resolved"]);
    // Known to be unnecessary: the mission already ended.
    expect(cancels(h)).toEqual([]);
  });

  it("an escalated execution that stored mission.failed can still be aborted, without a cancel", async () => {
    const h = await boot(failTwice);
    const exec = await execute(h, askPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    h.db
      .prepare(
        `INSERT INTO execution_events (id, execution_id, mimir_event_id, type, payload_json, occurred_at)
         VALUES ('exv_old', ?, 'evt_old_failed', 'mission.failed', '{}', 'then')`,
      )
      .run(exec.id);
    expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    const result = await h.loop.resolveEscalation(exec.id, "impl", {
      decision: "abort",
      actor: "jacob",
      reason: "stop",
    });
    expect(result.status).toBe("cancelled");
    expect(h.loop.get(exec.id)!.finishedAt).toBeTruthy();
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["resolved"]);
    expect(cancels(h)).toEqual([]);
  });

  it("replan still works after mission.failed and the revised plan supersedes the run", async () => {
    const h = await boot(failTwice);
    const old = await execute(h, askPlan());
    expect((await h.loop.run(old.id)).status).toBe("awaiting_human");
    failMission(h, old.mimirMissionId);
    const result = await h.loop.resolveEscalation(old.id, "impl", {
      decision: "replan",
      actor: "jacob",
      reason: "wrong approach",
    });
    expect(result.status).toBe("replan_requested");
    // Reading the failure afterwards does not end the run either.
    expect((await h.loop.resume(old.id)).status).toBe("replan_requested");
    const revised = await execute(
      h,
      approvedPlan([planTask("build")], { id: "plan-2", version: 2 }),
    );
    expect(revised.id).not.toBe(old.id);
    expect(h.loop.get(old.id)!.status).toBe("cancelled");
    expect(h.loop.inbox(old.id).filter((i) => i.status === "open")).toEqual([]);
  });

  it("abort succeeds when Mimir has already ended the mission", async () => {
    const h = await boot(failTwice);
    const exec = await execute(h, askPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    await cancelInMimir(h, exec.mimirMissionId);
    const result = await h.loop.resolveEscalation(exec.id, "impl", {
      decision: "abort",
      actor: "jacob",
      reason: "stop",
    });
    expect(result.status).toBe("cancelled");
    expect(h.loop.get(exec.id)!.finishedAt).toBeTruthy();
  });

  it("skipping the last open task finishes even when Mimir refuses the cancel as already ended", async () => {
    const h = await boot(failTwice);
    const mimir = new MimirClientFacade({ db: h.db }).connect({
      baseUrl: h.fake.url,
      token: h.fake.token,
    });
    let refused = 0;
    mimir.cancel = () => {
      refused++;
      return Promise.reject(new MimirError("invalid_transition", "mission is failed"));
    };
    const loop = new DeliveryLoop({ db: h.db, mimir, logger: { warn: () => undefined } });
    const exec = await execute(h, askPlan());
    expect((await loop.run(exec.id)).status).toBe("awaiting_human");
    const result = await loop.resolveEscalation(exec.id, "impl", {
      decision: "skip",
      actor: "jacob",
      reason: "not needed",
    });
    expect(refused).toBe(1);
    expect(result.status).toBe("verified_pending_review");
    // Any other refusal is still an error.
    mimir.cancel = () => Promise.reject(new MimirError("unauthorized", "no"));
    const second = await loop.createExecution(askPlan({ id: "plan-other", lineageId: "l2" }), {
      projectId: (await mimir.ensureProject("/repos/app")).id,
    });
    await expect(loop.cancelExecution(second.id, { actor: "j", reason: "r" })).rejects.toThrow();
    expect(loop.get(second.id)!.status).toBe("pending");
  });

  it("a run whose skip already cancelled the mission can still be cancelled with another reason", async () => {
    const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
    const mimir = new MimirClientFacade({ db: h.db }).connect({
      baseUrl: h.fake.url,
      token: h.fake.token,
    });
    const loop = new DeliveryLoop({ db: h.db, mimir, logger: { warn: () => undefined } });
    const exec = await execute(
      h,
      approvedPlan([planTask("impl", { maxRetries: 1, escalation: "ask" }), planTask("other")]),
    );
    expect((await loop.run(exec.id)).status).toBe("awaiting_human");
    // The skip cancels the mission, then reading the artifacts fails: the run stays open.
    const getArtifact = mimir.getArtifact.bind(mimir);
    mimir.getArtifact = () => Promise.reject(new MimirError("internal", "down"));
    await expect(
      loop.resolveEscalation(exec.id, "impl", { decision: "skip", actor: "j", reason: "x" }),
    ).rejects.toThrow();
    mimir.getArtifact = getArtifact;
    const cancelled = await loop.cancelExecution(exec.id, { actor: "j", reason: "give up" });
    expect(cancelled.status).toBe("cancelled");
  });

  it("cancelExecution cancels the mission, closes inbox items and approvals, and records why", async () => {
    const h = await boot({ impl: [{ kind: "approval", action: "git.push" }] });
    const exec = await execute(h, approvedPlan([planTask("impl")]));
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    const cancelled = await h.loop.cancelExecution(exec.id, {
      actor: "jacob",
      reason: "wrong plan",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.finishedAt).toBeTruthy();
    expect(h.fake.requests.some((r) => r.path.endsWith("/cancel"))).toBe(true);
    expect(h.loop.approvals(exec.id).map((a) => a.status)).toEqual(["expired"]);
    expect(h.loop.events(exec.id)).toContainEqual(
      expect.objectContaining({
        source: "sindri",
        type: "execution_cancelled",
        payload: { actor: "jacob", reason: "wrong plan", previousStatus: "awaiting_human" },
      }),
    );
    // Idempotent, also once Mimir reports the mission cancelled.
    expect((await h.loop.cancelExecution(exec.id, { actor: "j", reason: "again" })).status).toBe(
      "cancelled",
    );
    expect((await h.loop.resume(exec.id)).status).toBe("cancelled");
    expect(h.loop.events(exec.id).filter((e) => e.type === "execution_cancelled")).toHaveLength(1);
  });

  it("a revised plan in the same lineage closes the run that asked for a replan", async () => {
    const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
    const old = await execute(
      h,
      approvedPlan([planTask("impl", { maxRetries: 1, escalation: "replan" })]),
    );
    expect((await h.loop.run(old.id)).status).toBe("replan_requested");
    // A plan of another lineage leaves it alone.
    const unrelated = await execute(
      h,
      approvedPlan([planTask("build")], { id: "plan-x", lineageId: "lineage-x" }),
    );
    expect(h.loop.get(old.id)!.status).toBe("replan_requested");
    const revised = await execute(
      h,
      approvedPlan([planTask("build")], { id: "plan-2", version: 2 }),
    );
    expect(revised.id).not.toBe(old.id);
    expect(revised.id).not.toBe(unrelated.id);
    const closed = h.loop.get(old.id)!;
    expect(closed.status).toBe("cancelled");
    expect(closed.finishedAt).toBeTruthy();
    expect(h.loop.events(old.id)).toContainEqual(
      expect.objectContaining({
        type: "execution_cancelled",
        payload: expect.objectContaining({
          actor: "sindri",
          reason: "superseded by revised plan plan-2 (version 2)",
          previousStatus: "replan_requested",
        }),
      }),
    );
    expect(
      h.fake.requests.some((r) => r.path === `/v1/missions/${old.mimirMissionId}/cancel`),
    ).toBe(true);
    expect((await h.loop.run(revised.id)).status).toBe("verified_pending_review");
  });

  it("concurrent createExecution calls for one plan return the same execution", async () => {
    const h = await boot();
    const [a, b] = await Promise.all([execute(h, threeTasks()), execute(h, threeTasks())]);
    expect(a.id).toBe(b.id);
    expect(h.fake.creates.missions).toBe(1);
    expect((h.db.prepare("SELECT COUNT(*) AS n FROM executions").get() as { n: number }).n).toBe(1);
  });
});

describe("DeliveryLoop: bug sweep and edge cases", () => {
  const connect = (h: Harness) =>
    new MimirClientFacade({ db: h.db }).connect({ baseUrl: h.fake.url, token: h.fake.token });

  /** A loop over a real facade with some of its methods replaced. */
  function patchedLoop(
    h: Harness,
    patch: (real: MimirClientFacade) => Partial<MimirClientFacade>,
    options: Partial<ConstructorParameters<typeof DeliveryLoop>[0]> = {},
  ): DeliveryLoop {
    const mimir = connect(h);
    Object.assign(mimir, patch(connect(h)));
    const loop = new DeliveryLoop({
      db: h.db,
      mimir,
      logger: { warn: () => undefined },
      ...options,
    });
    loop.on((n) => h.notices.push(n));
    return loop;
  }

  const approvalPlan = () => approvedPlan([planTask("impl")]);
  const approvalScript = { impl: [{ kind: "approval", action: "git.push" }] as TaskStep[] };

  it("a mission cancelled in Mimir ends the execution cancelled and closes its approvals and inbox", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    // A mission-level budget alert: no task, so it only opens an inbox item.
    h.fake.inject(
      "budget.exceeded",
      { budgetId: "bgt_01J0000000000000000000000B", unit: "tokens", used: 9, limit: 5 },
      { missionId: exec.mimirMissionId as never },
    );
    expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    expect(h.loop.inbox(exec.id)).toEqual([
      expect.objectContaining({
        kind: "budget_exceeded",
        planTaskId: null,
        status: "open",
        detail: expect.objectContaining({ unit: "tokens", used: 9, limit: 5 }),
      }),
    ]);
    expect(h.loop.tasks(exec.id)[0]!.escalation).toBeNull();

    // Someone cancels the mission in Mimir, not through Sindri.
    await connect(h).cancel(exec.mimirMissionId, "cancelled in Mimir");
    expect(await h.loop.resume(exec.id)).toEqual({ status: "cancelled", interrupted: false });
    expect(h.loop.get(exec.id)!.finishedAt).toBeTruthy();
    // Nobody can act on them any more: they must not stay in the reviews inbox.
    expect(h.loop.approvals(exec.id).map((a) => a.status)).toEqual(["expired"]);
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["resolved"]);
    expect(h.notices).toContainEqual(
      expect.objectContaining({ type: "status_changed", executionId: exec.id, to: "cancelled" }),
    );
  });

  it("a mission that completes closes a mission-level budget alert nobody can act on any more", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    h.fake.inject(
      "budget.exceeded",
      { budgetId: "bgt_01J0000000000000000000000B", unit: "tokens", used: 9, limit: 5 },
      { missionId: exec.mimirMissionId as never },
    );
    expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    const approvalId = h.loop.approvals(exec.id)[0]!.mimirApprovalId;
    await h.loop.decideApproval(exec.id, approvalId, "approved");
    expect((await h.loop.resume(exec.id)).status).toBe("verified_pending_review");
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["resolved"]);
  });

  it("a human retry spends its own attempt number, so a later automatic retry is not refused as a replay", async () => {
    const h = await boot({
      impl: [
        { kind: "fail", reason: "verification_failed" },
        { kind: "fail", reason: "boom" },
        { kind: "complete" },
      ],
    });
    const enforced: string[] = [];
    const loop = patchedLoop(h, () => ({}), {
      verificationFailures: {
        enforce: (_executionId, planTaskId) => {
          enforced.push(planTaskId);
          return Promise.resolve({ action: "escalated", error: "verdict blocked" });
        },
      },
    });
    const plan = approvedPlan([planTask("impl", { maxRetries: 2, escalation: "ask" })]);
    const exec = await execute(h, plan);
    // The gate handler owns verification failures; it escalates without spending an attempt.
    expect((await loop.run(exec.id)).status).toBe("awaiting_human");
    expect(enforced).toEqual(["impl"]);
    const escalated = loop.tasks(exec.id)[0]!;
    expect(escalated).toMatchObject({
      attempts: 0,
      escalation: "ask",
      escalationReason: "verification failed; gate repair escalated: verdict blocked",
    });

    // The human grants a retry; the next (runtime) failure still has retry budget left, so the
    // loop retries it automatically and the task completes.
    const result = await loop.resolveEscalation(exec.id, "impl", {
      decision: "retry",
      actor: "jacob",
      reason: "try again",
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "verified_pending_review", interrupted: false });
    const keys = h.fake.requests
      .filter((r) => r.path.endsWith("/retry"))
      .map((r) => r.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(loop.tasks(exec.id)[0]).toMatchObject({ status: "completed", escalation: null });
  });

  it("escalates with Mimir's refusal when Mimir refuses the automatic retry", async () => {
    const h = await boot({ impl: [{ kind: "fail" }] });
    const exec = await execute(
      h,
      approvedPlan([planTask("impl", { maxRetries: 2, escalation: "block" })]),
    );
    h.fake.failNext("POST", "/v1/tasks/", 409);
    expect((await h.loop.run(exec.id)).status).toBe("blocked");
    const [task] = h.loop.tasks(exec.id);
    expect(task).toMatchObject({ attempts: 1, escalation: "block" });
    expect(task!.escalationReason).toMatch(/^retry refused by Mimir \(\w+\): /);
  });

  it("a retry that fails for a non-Mimir reason rejects the run and leaves the event unrecorded", async () => {
    const h = await boot({ impl: [{ kind: "fail" }] });
    const loop = patchedLoop(h, () => ({
      retry: () => Promise.reject(new Error("socket closed")),
    }));
    const exec = await execute(h, approvedPlan([planTask("impl", { maxRetries: 2 })]));
    await expect(loop.run(exec.id)).rejects.toThrow("socket closed");
    // Nothing was committed for the failed event, so the next run handles it again.
    expect(loop.events(exec.id).map((e) => e.type)).not.toContain("task.failed");
    expect(loop.tasks(exec.id)[0]!.attempts).toBe(0);
    expect(loop.get(exec.id)!.status).toBe("running");
  });

  it("on() returns an unsubscribe function", async () => {
    const h = await boot();
    const seen: DeliveryNotice[] = [];
    const off = h.loop.on((n) => seen.push(n));
    const exec = await execute(h, approvalPlan());
    off();
    await h.loop.run(exec.id);
    expect(seen).toEqual([]);
    expect(h.notices.length).toBeGreaterThan(0);
  });

  it("records and warns (console by default) about budgets Mimir cannot enforce", async () => {
    const h = await boot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const mimir = connect(h);
      const real = connect(h);
      Object.assign(mimir, {
        createMissionFromPlan: async (
          ...args: Parameters<MimirClientFacade["createMissionFromPlan"]>
        ) => ({
          ...(await real.createMissionFromPlan(...args)),
          unforwardedBudgets: [{ planTaskId: "impl", unit: "wallClockMinutes", value: 30 }],
        }),
      });
      const loop = new DeliveryLoop({ db: h.db, mimir });
      const project = await real.ensureProject("/repos/app");
      const exec = await loop.createExecution(approvalPlan(), { projectId: project.id });
      expect(loop.events(exec.id)).toEqual([
        expect.objectContaining({
          source: "sindri",
          mimirEventId: null,
          type: "budget_not_forwarded",
          payload: expect.objectContaining({
            tasks: [{ planTaskId: "impl", unit: "wallClockMinutes", value: 30 }],
          }),
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        "[sindri/delivery] wall-clock budgets are not enforced by Mimir",
        expect.objectContaining({ executionId: exec.id, planId: "plan-1", tasks: 1 }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("passes a rework's base commits to Mimir and omits them otherwise", async () => {
    const h = await boot();
    const mimir = connect(h);
    const project = await mimir.ensureProject("/repos/app");
    const base = "a".repeat(40);
    await h.loop.createExecution(approvalPlan(), { projectId: project.id, baseCommits: [base] });
    await h.loop.createExecution(approvedPlan([planTask("impl")], { id: "plan-2" }), {
      projectId: project.id,
      baseCommits: [],
    });
    const bodies = h.fake.requests
      .filter((r) => r.method === "POST" && r.path === "/v1/missions")
      .map((r) => r.body as { baseCommits?: string[] });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.baseCommits).toEqual([base]);
    expect(bodies[1]).not.toHaveProperty("baseCommits");
  });

  it("stores nothing when Mimir returns no task for a plan task", async () => {
    const h = await boot();
    const loop = patchedLoop(h, (real) => ({
      createMissionFromPlan: async (...args) => ({
        ...(await real.createMissionFromPlan(...args)),
        taskIdMap: {},
      }),
    }));
    const project = await connect(h).ensureProject("/repos/app");
    await expect(loop.createExecution(approvalPlan(), { projectId: project.id })).rejects.toThrow(
      "Mimir returned no task for plan task impl",
    );
    const count = (table: string) =>
      (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("executions")).toBe(0);
    expect(count("execution_tasks")).toBe(0);
  });

  it("get() is undefined and run() throws for an unknown execution", async () => {
    const h = await boot();
    expect(h.loop.get("exe_nope")).toBeUndefined();
    await expect(h.loop.run("exe_nope")).rejects.toThrow("unknown execution exe_nope");
  });

  it("decideApproval refuses an approval of another execution without asking Mimir", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    await h.loop.run(exec.id);
    await expect(h.loop.decideApproval(exec.id, "apr_unknown", "approved")).rejects.toThrow(
      `approval apr_unknown is not in execution ${exec.id}`,
    );
    expect(h.fake.requests.some((r) => r.path.includes("/approvals/"))).toBe(false);
  });

  it("a human rejection is recorded at once and escalates the task when Mimir reports it", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvedPlan([planTask("impl", { escalation: "block" })]));
    await h.loop.run(exec.id);
    const [approval] = h.loop.approvals(exec.id);
    await h.loop.decideApproval(exec.id, approval!.mimirApprovalId, "rejected", "too risky");
    expect(h.loop.approvals(exec.id)[0]).toMatchObject({ status: "rejected" });
    expect(h.loop.approvals(exec.id)[0]!.decidedAt).toBeTruthy();
    // Rejecting does not put the execution back to running by itself.
    expect(h.loop.get(exec.id)!.status).toBe("awaiting_human");
    expect((await h.loop.resume(exec.id)).status).toBe("blocked");
    expect(h.loop.tasks(exec.id)[0]).toMatchObject({
      escalation: "block",
      escalationReason: "approval rejected",
    });
  });

  it("approving the last approval keeps awaiting_human while an ask escalation is open", async () => {
    const h = await boot({
      impl: [{ kind: "fail" }, { kind: "fail" }],
      other: [{ kind: "approval", action: "git.push" }],
    });
    const exec = await execute(
      h,
      approvedPlan([planTask("impl", { maxRetries: 1, escalation: "ask" }), planTask("other")]),
    );
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    const [approval] = h.loop.approvals(exec.id);
    expect(approval).toMatchObject({ planTaskId: "other", status: "pending" });
    await h.loop.decideApproval(exec.id, approval!.mimirApprovalId, "approved");
    expect(h.loop.approvals(exec.id)[0]!.status).toBe("approved");
    expect(h.loop.get(exec.id)!.status).toBe("awaiting_human");
  });

  it("resolveEscalation refuses an unknown task and a finished execution", async () => {
    const h = await boot({ impl: [{ kind: "fail" }, { kind: "fail" }] });
    const exec = await execute(
      h,
      approvedPlan([planTask("impl", { maxRetries: 1, escalation: "ask" })]),
    );
    await h.loop.run(exec.id);
    const input = { decision: "skip", actor: "j", reason: "r" } as const;
    await expect(h.loop.resolveEscalation(exec.id, "ghost", input)).rejects.toThrow(
      `task ghost is not in execution ${exec.id}`,
    );
    await h.loop.cancelExecution(exec.id, { actor: "j", reason: "stop" });
    await expect(h.loop.resolveEscalation(exec.id, "impl", input)).rejects.toThrow(
      `execution ${exec.id} is cancelled`,
    );
    expect(h.loop.tasks(exec.id)[0]!.resolution).toBeNull();
  });

  it("cancelExecution leaves a run alone that ended while Mimir was being asked", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    const loop = patchedLoop(h, () => ({
      cancel: () => {
        h.db.prepare("UPDATE executions SET status = 'failed' WHERE id = ?").run(exec.id);
        return Promise.resolve();
      },
    }));
    await loop.run(exec.id);
    const out = await loop.cancelExecution(exec.id, { actor: "j", reason: "late" });
    expect(out.status).toBe("failed");
    expect(loop.events(exec.id).map((e) => e.type)).not.toContain("execution_cancelled");
    // The approval was not expired by a cancel that did not happen.
    expect(loop.approvals(exec.id).map((a) => a.status)).toEqual(["pending"]);
  });

  it("a mission.cancelled that arrives after Sindri itself ended the run changes nothing", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    await connect(h).cancel(exec.mimirMissionId, "cancelled by Sindri");
    // Sindri's own cancel finished the run while this loop was reading Mimir's backlog.
    const loop = patchedLoop(h, (real) => ({
      catchUp: async (...args: Parameters<MimirClientFacade["catchUp"]>) => {
        const backlog = await real.catchUp(...args);
        h.db
          .prepare(
            "UPDATE executions SET status = 'cancelled', finished_at = 'by-sindri' WHERE id = ?",
          )
          .run(exec.id);
        return backlog;
      },
    }));
    h.notices.length = 0;
    expect(await loop.resume(exec.id)).toEqual({ status: "cancelled", interrupted: false });
    expect(loop.events(exec.id).map((e) => e.type)).toContain("mission.cancelled");
    expect(loop.get(exec.id)!.finishedAt).toBe("by-sindri");
    expect(h.notices.filter((n) => n.type === "status_changed")).toEqual([]);
  });

  it("returns interrupted without following when the signal is already aborted", async () => {
    const h = await boot();
    const exec = await execute(h, approvalPlan());
    // No backlog yet, so the execution is not settled and the loop would have to follow.
    const loop = patchedLoop(h, () => ({
      catchUp: () => Promise.resolve({ events: [], cursor: null }),
    }));
    const ac = new AbortController();
    ac.abort();
    expect(await loop.run(exec.id, { signal: ac.signal })).toEqual({
      status: "running",
      interrupted: true,
    });
    expect(loop.events(exec.id)).toEqual([]);
    expect((await h.loop.resume(exec.id)).status).toBe("verified_pending_review");
  });

  it("events the stream replays after a stale cursor are not recorded twice", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    const before = eventIds(h.db, exec.id);
    expect(before.length).toBeGreaterThan(0);
    h.db.prepare("UPDATE execution_cursors SET cursor = ?").run(h.fake.cursorAt(0));
    await h.loop.decideApproval(exec.id, h.fake.approvals()[0]!.id, "approved");
    // No backlog read: the stream itself replays from the rewound cursor.
    const loop = patchedLoop(h, () => ({
      catchUp: () => Promise.resolve({ events: [], cursor: null }),
    }));
    expect((await loop.resume(exec.id)).status).toBe("verified_pending_review");
    const ids = eventIds(h.db, exec.id);
    expect(new Set(ids).size).toBe(ids.length);
    const missionEvents = h.fake.events().filter((e) => e.missionId === exec.mimirMissionId);
    expect(ids.sort()).toEqual(missionEvents.map((e) => e.id).sort());
    // Replayed events still advance the stored cursor.
    expect(connect(h).storedCursor(exec.mimirMissionId)).not.toBe(h.fake.cursorAt(0));
  });

  it("records approval and artifact events that belong to no plan task", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    const missionId = exec.mimirMissionId as never;
    h.fake.inject(
      "approval.requested",
      { approvalId: "apr_01J0000000000000000000000C", action: "pr.create", expiry: null },
      { missionId },
    );
    h.fake.inject(
      "artifact.recorded",
      {
        artifactId: "art_01J0000000000000000000000D",
        taskId: "tsk_01J0000000000000000000000E",
        kind: "review",
        uri: "file:///artifacts/review.json",
        hash: `sha256:${"c".repeat(64)}`,
      },
      { missionId },
    );
    expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    expect(h.loop.approvals(exec.id)).toContainEqual(
      expect.objectContaining({
        mimirApprovalId: "apr_01J0000000000000000000000C",
        planTaskId: null,
        action: "pr.create",
        reason: null,
        disposition: "inbox",
        status: "pending",
      }),
    );
    expect(h.notices).toContainEqual({
      type: "awaiting_human",
      executionId: exec.id,
      approvalId: "apr_01J0000000000000000000000C",
      action: "pr.create",
      planTaskId: null,
    });
    expect(h.loop.artifacts(exec.id)).toEqual([
      expect.objectContaining({
        mimirArtifactId: "art_01J0000000000000000000000D",
        planTaskId: null,
        kind: "review",
        sha256: `sha256:${"c".repeat(64)}`,
      }),
    ]);
  });

  it("marks an approval expired when Mimir reports approval.expired", async () => {
    const h = await boot(approvalScript);
    const exec = await execute(h, approvalPlan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    const approvalId = h.fake.approvals()[0]!.id;
    h.fake.inject("approval.expired", { approvalId }, { missionId: exec.mimirMissionId as never });
    // Mimir sends nothing else here, so the run is stopped once the event has been handled.
    const ac = new AbortController();
    const off = h.loop.on((n) => {
      if (n.type === "event" && n.eventType === "approval.expired") ac.abort();
    });
    const result = await h.loop.resume(exec.id, { signal: ac.signal });
    off();
    expect(result.interrupted).toBe(true);
    expect(h.loop.approvals(exec.id).map((a) => a.status)).toEqual(["expired"]);
  });

  it("treats a task whose dependency has no execution record as stuck", async () => {
    const h = await boot({ first: [{ kind: "approval", action: "git.push" }] });
    const exec = await execute(
      h,
      approvedPlan([planTask("first"), planTask("second", { dependsOn: ["first"] })]),
    );
    h.db
      .prepare("DELETE FROM execution_tasks WHERE execution_id = ? AND plan_task_id = 'first'")
      .run(exec.id);
    // `second` can never start: the run settles as blocked instead of following forever.
    expect(await h.loop.run(exec.id)).toEqual({ status: "blocked", interrupted: false });
    expect(h.loop.tasks(exec.id).map((t) => [t.planTaskId, t.status])).toEqual([
      ["second", "pending"],
    ]);
  });
});

describe("DeliveryLoop: a task parked on its crew budget escalates to a human", () => {
  const CREW = "crw_01J000000000000000000000RV";
  const BUDGET = "bgt_01J000000000000000000000RV";
  const at = "2026-11-11T04:13:13.870Z";
  /** The live shape: impl waits on an approval, review is parked on the reviewer crew budget. */
  const plan = () =>
    approvedPlan([
      planTask("impl"),
      planTask("review", { role: "reviewer", dependsOn: ["impl"], escalation: "block" }),
    ]);

  async function parkedRun() {
    const h = await boot({ impl: [{ kind: "approval", action: "git.push" }] });
    const exec = await execute(h, plan());
    expect((await h.loop.run(exec.id)).status).toBe("awaiting_human");
    const review = h.loop.tasks(exec.id).find((t) => t.planTaskId === "review")!;
    const missionId = exec.mimirMissionId as never;
    const budget = () => ({
      id: BUDGET,
      createdAt: at,
      updatedAt: at,
      version: 0,
      missionId,
      crewId: CREW,
      limitTokens: 300_000,
      limitCost: null,
      warnAtFraction: 0.8,
      enforce: "hard",
      onUnknown: "block",
    });
    const storeEvent = (type: string, payload: unknown) =>
      h.db
        .prepare(
          `INSERT INTO execution_events (id, execution_id, mimir_event_id, type, payload_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `exv_${type}_${Math.random()}`,
          exec.id,
          `evt_${Math.random()}`,
          type,
          JSON.stringify(payload),
          at,
        );
    const inject = {
      /** Mimir's `crew.created` for the reviewer crew, carrying its budget. */
      crew: () =>
        h.fake.inject(
          "crew.created",
          {
            crew: {
              id: CREW,
              createdAt: at,
              updatedAt: at,
              version: 0,
              missionId,
              template: "reviewer",
              status: "configured",
              limits: { maxConcurrentTasks: 1, maxAttemptsPerTask: 4 },
            },
            members: [],
            budget: budget(),
          },
          { missionId },
        ),
      blocked: (reason = "budget_exceeded", refs: { crewId?: string } = { crewId: CREW }) =>
        h.fake.inject("task.blocked", { from: "ready", to: "blocked", reason }, {
          missionId,
          taskId: review.mimirTaskId as never,
          ...refs,
        } as never),
      exceeded: (refs: { crewId?: string } = {}) =>
        h.fake.inject(
          "budget.exceeded",
          { budgetId: BUDGET, unit: "tokens", used: 338_679, limit: 300_000 },
          { missionId, ...refs } as never,
        ),
      /** Mimir's `budget.updated` raising the crew budget to version 1, stored as Mimir sent it. */
      // Stored directly: the vendored @mimir/protocol 0.2.0 predates `budget.updated`/`budgetVersion`.
      updated: () => storeEvent("budget.updated", { budget: { ...budget(), version: 1 } }),
      exceededAt: (budgetVersion: number) =>
        storeEvent("budget.exceeded", {
          budgetId: BUDGET,
          unit: "tokens",
          used: 401_000,
          limit: 400_000,
          budgetVersion,
        }),
      released: () =>
        h.fake.inject("task.ready", { from: "blocked", to: "ready" }, {
          missionId,
          taskId: review.mimirTaskId as never,
          crewId: CREW,
        } as never),
    };
    return { h, exec, inject, storeEvent, budget };
  }

  const reviewOf = (h: Harness, executionId: string) =>
    h.loop.tasks(executionId).find((t) => t.planTaskId === "review")!;

  it("escalates task.blocked budget_exceeded as ask with the crew budget's numbers (live order)", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    // As in the live run: the task is parked first, the crew budget event (no task) follows.
    inject.blocked();
    inject.exceeded();
    expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    const review = reviewOf(h, exec.id);
    expect(review).toMatchObject({
      status: "blocked",
      blockedReason: "budget_exceeded: tokens 338679/300000",
      // The plan says `block`, but only a human can raise a budget.
      escalation: "ask",
    });
    expect(review.escalationReason).toContain(
      `the crew budget is used up (tokens 338679 of 300000, budget ${BUDGET})`,
    );
    expect(review.escalationReason).toContain("Raise the crew budget in Mimir, then retry");
    // One actionable item, on the task, with the numbers; no task-less alert nobody can answer.
    expect(h.loop.inbox(exec.id)).toEqual([
      expect.objectContaining({
        kind: "budget_exceeded",
        planTaskId: "review",
        status: "open",
        detail: expect.objectContaining({
          reason: "budget_exceeded",
          crewId: CREW,
          budgetId: BUDGET,
          unit: "tokens",
          used: 338_679,
          limit: 300_000,
        }),
      }),
    ]);
    expect(h.notices).toContainEqual(
      expect.objectContaining({
        type: "escalated",
        planTaskId: "review",
        escalation: "ask",
        reason: review.escalationReason,
      }),
    );
  });

  it("finds the numbers when the budget event came first, and opens nothing for a crew with no parked task", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.exceeded({ crewId: CREW });
    expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    expect(h.loop.inbox(exec.id)).toEqual([]);
    expect(reviewOf(h, exec.id).escalation).toBeNull();
    inject.blocked();
    await h.loop.resume(exec.id);
    expect(reviewOf(h, exec.id)).toMatchObject({
      blockedReason: "budget_exceeded: tokens 338679/300000",
      escalation: "ask",
    });
    expect(h.loop.inbox(exec.id)).toHaveLength(1);
  });

  it("escalates budget_uncertain (usage not measurable) the same way", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.blocked("budget_uncertain");
    await h.loop.resume(exec.id);
    const review = reviewOf(h, exec.id);
    expect(review).toMatchObject({ blockedReason: "budget_uncertain", escalation: "ask" });
    expect(review.escalationReason).toContain("cannot measure the crew's usage");
  });

  it("gives budget_uncertain no numbers even after an earlier budget.exceeded", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.exceeded({ crewId: CREW });
    inject.blocked("budget_uncertain");
    await h.loop.resume(exec.id);
    const review = reviewOf(h, exec.id);
    expect(review.blockedReason).toBe("budget_uncertain");
    expect(review.escalationReason).toContain("cannot measure the crew's usage");
    expect(review.escalationReason).not.toContain("338679");
    expect(h.loop.inbox(exec.id)[0]!.detail).not.toHaveProperty("used");
  });

  it("ignores a budget.exceeded measured before the budget was raised", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.exceeded({ crewId: CREW });
    await h.loop.resume(exec.id);
    inject.updated();
    inject.blocked();
    await h.loop.resume(exec.id);
    expect(reviewOf(h, exec.id).blockedReason).toBe("budget_exceeded");
    expect(h.loop.inbox(exec.id)[0]!.detail).not.toHaveProperty("used");
  });

  it("uses a budget.exceeded measured against the current budget version", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.exceeded({ crewId: CREW });
    await h.loop.resume(exec.id);
    inject.updated();
    inject.exceededAt(1);
    inject.blocked();
    await h.loop.resume(exec.id);
    expect(reviewOf(h, exec.id).blockedReason).toBe("budget_exceeded: tokens 401000/400000");
  });

  it("Mimir's release resolves only the budget item, not another open item on the task", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.blocked();
    inject.exceeded();
    await h.loop.resume(exec.id);
    h.db
      .prepare(
        `INSERT INTO execution_inbox (id, execution_id, kind, plan_task_id, detail_json, status, created_at)
         VALUES ('exi_other', ?, 'escalation', 'review', '{}', 'open', ?)`,
      )
      .run(exec.id, at);
    inject.released();
    // Stopped once the release is handled: the run's end would close every open item.
    const ac = new AbortController();
    const off = h.loop.on((n) => {
      if (n.type === "event" && n.eventType === "task.ready") ac.abort();
    });
    await h.loop.resume(exec.id, { signal: ac.signal });
    off();
    expect(h.loop.inbox(exec.id).map((i) => [i.kind, i.status])).toEqual([
      ["budget_exceeded", "resolved"],
      ["escalation", "open"],
    ]);
  });

  it("retry waits for Mimir to release the task, then continues without spending an attempt", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.blocked();
    inject.exceeded();
    await h.loop.resume(exec.id);
    const retry = () =>
      h.loop.resolveEscalation(exec.id, "review", {
        decision: "retry",
        actor: "jacob",
        reason: "raised the reviewer budget",
      });
    // Not raised in Mimir yet: the task is still parked, so there is nothing to continue.
    await expect(retry()).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("Raise the crew budget in Mimir first"),
    });
    expect(reviewOf(h, exec.id).escalation).toBe("ask");

    // The operator raises the budget in Mimir, which returns the task to ready; impl is approved.
    inject.released();
    await h.loop.decideApproval(exec.id, h.loop.approvals(exec.id)[0]!.mimirApprovalId, "approved");
    expect((await retry()).status).toBe("verified_pending_review");
    expect(h.fake.requests.some((r) => r.path.endsWith("/retry"))).toBe(false);
    expect(reviewOf(h, exec.id)).toMatchObject({
      attempts: 0,
      escalation: null,
      blockedReason: null,
      status: "completed",
    });
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["resolved"]);
    expect(sindriEvents(h, exec.id)).toContainEqual(
      expect.objectContaining({
        type: "escalation_resolved",
        payload: expect.objectContaining({
          planTaskId: "review",
          decision: "retry",
          actor: "jacob",
        }),
      }),
    );
  });

  it("answers the escalation itself when Mimir releases the task (budget raised in Mimir)", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.blocked();
    inject.exceeded();
    await h.loop.resume(exec.id);
    inject.released();
    await h.loop.decideApproval(exec.id, h.loop.approvals(exec.id)[0]!.mimirApprovalId, "approved");
    expect((await h.loop.resume(exec.id)).status).toBe("verified_pending_review");
    expect(reviewOf(h, exec.id)).toMatchObject({ escalation: null, blockedReason: null });
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["resolved"]);
    expect(sindriEvents(h, exec.id)).toContainEqual(
      expect.objectContaining({
        type: "escalation_resolved",
        payload: expect.objectContaining({
          planTaskId: "review",
          decision: "retry",
          actor: "mimir",
        }),
      }),
    );
  });

  it("does not announce a budget_uncertain escalation again when the crew budget is reported", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.blocked("budget_uncertain");
    await h.loop.resume(exec.id);
    const escalated = () =>
      h.notices.filter((n) => n.type === "escalated" && n.planTaskId === "review");
    expect(escalated()).toHaveLength(1);
    inject.exceeded({ crewId: CREW });
    await h.loop.resume(exec.id);
    expect(escalated()).toHaveLength(1);
    expect(reviewOf(h, exec.id).blockedReason).toBe("budget_uncertain");
    expect(h.loop.inbox(exec.id)).toHaveLength(1);
  });

  it("escalates a parked task whose event names no crew, without numbers", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.crew();
    inject.exceeded({ crewId: CREW });
    inject.blocked("budget_exceeded", {});
    expect((await h.loop.resume(exec.id)).status).toBe("awaiting_human");
    expect(reviewOf(h, exec.id)).toMatchObject({
      blockedReason: "budget_exceeded",
      escalation: "ask",
    });
    expect(h.loop.inbox(exec.id)[0]!.detail).toMatchObject({ crewId: null });
    expect(h.loop.inbox(exec.id)[0]!.detail).not.toHaveProperty("used");
  });

  it("reads a crew budget without a version as version 0", async () => {
    const { h, exec, inject, storeEvent, budget } = await parkedRun();
    const unversioned: Record<string, unknown> = budget();
    delete unversioned["version"];
    storeEvent("crew.created", { crew: { id: CREW }, members: [], budget: unversioned });
    inject.exceeded({ crewId: CREW });
    inject.blocked();
    await h.loop.resume(exec.id);
    expect(reviewOf(h, exec.id).blockedReason).toBe("budget_exceeded: tokens 338679/300000");
  });

  it("abort works on a budget escalation as on any other", async () => {
    const { h, exec, inject } = await parkedRun();
    inject.blocked();
    await h.loop.resume(exec.id);
    const result = await h.loop.resolveEscalation(exec.id, "review", {
      decision: "abort",
      actor: "jacob",
      reason: "too expensive",
    });
    expect(result.status).toBe("cancelled");
    expect(h.loop.inbox(exec.id).map((i) => i.status)).toEqual(["resolved"]);
  });
});
