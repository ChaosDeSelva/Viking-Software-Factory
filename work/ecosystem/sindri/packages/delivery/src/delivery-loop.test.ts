import type { SqliteDatabase } from "@sindri/knowledge";
import { openDeliveryTestDb } from "./test-db.test-helpers.js";
import { MimirClientFacade } from "@sindri/mimir-client";
import { approvedPlan, planTask } from "@sindri/mimir-client/testing";
import type { Plan } from "@sindri/planner";
import { createFakeMimir, type FakeMimir, type TaskStep } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
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
