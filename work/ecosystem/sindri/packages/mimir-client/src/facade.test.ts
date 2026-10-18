import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import { createFakeMimir, type FakeMimir, type TaskStep } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MimirClientFacade, MimirClientError } from "./facade.js";
import { approvedPlan, planTask } from "./testing.js";

let fake: FakeMimir | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => {
  await fake?.close();
  db?.close();
  fake = undefined;
  db = undefined;
});

async function boot(scripts: Record<string, TaskStep[]> = {}) {
  fake = await createFakeMimir({ stepDelayMs: 0, scripts });
  db = openDatabase(":memory:");
  const facade = new MimirClientFacade({ db });
  facade.connect({ baseUrl: fake.url, token: fake.token });
  return { fake, db, facade };
}

const twoTaskPlan = () =>
  approvedPlan([planTask("impl"), planTask("review", { role: "reviewer", dependsOn: ["impl"] })]);

describe("MimirClientFacade", () => {
  it("refuses calls before connect", async () => {
    const facade = new MimirClientFacade({ db: (db = openDatabase(":memory:")) });
    await expect(facade.capabilities()).rejects.toBeInstanceOf(MimirClientError);
  });

  it("reads capabilities", async () => {
    const { facade } = await boot();
    expect((await facade.capabilities()).protocolVersion).toBe(1);
  });

  it("ensureProject creates once and then reuses the project for the same repo path", async () => {
    const { facade, fake } = await boot();
    const a = await facade.ensureProject("/repos/app", { defaultProfile: "x" });
    const b = await facade.ensureProject("/repos/app", { defaultProfile: "x" });
    expect(b.id).toBe(a.id);
    expect(a.name).toBe("app");
    expect(a.settings).toEqual({ defaultProfile: "x" });
    expect(fake.creates.projects).toBe(1);
  });

  it("creates a mission, a crew per (harness, role) and a task per plan task", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const plan = approvedPlan([
      planTask("impl-a"),
      planTask("impl-b"),
      planTask("review", { role: "reviewer", dependsOn: ["impl-a", "impl-b"] }),
    ]);
    const result = await facade.createMissionFromPlan(plan, { projectId: project.id });
    expect(Object.keys(result.taskIdMap).sort()).toEqual(["impl-a", "impl-b", "review"]);
    expect(Object.keys(result.crewIds).sort()).toEqual([
      "backend-node:implementer",
      "backend-node:reviewer",
    ]);
    expect(fake.creates).toMatchObject({ missions: 1, crews: 2, tasks: 3 });
    const tasks = fake.tasks();
    const review = tasks.find((t) => t.id === result.taskIdMap.review)!;
    expect(review.crewId).toBe(result.crewIds["backend-node:reviewer"]);
    const reviewCreate = fake.requests.find(
      (r) => r.path === "/v1/tasks" && r.idempotencyKey === "sindri:plan-1:1:review",
    );
    expect((reviewCreate!.body as { dependsOn: string[] }).dependsOn.sort()).toEqual(
      [result.taskIdMap["impl-a"], result.taskIdMap["impl-b"]].sort(),
    );
    const keys = fake.requests.filter((r) => r.method === "POST").map((r) => r.idempotencyKey);
    expect(keys).toContain("sindri:plan-1:1:@mission");
    expect(keys).toContain("sindri:plan-1:1:impl-a");
  });

  it("re-running after a crash mid-way creates nothing new", async () => {
    const { facade, fake, db } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const plan = approvedPlan([planTask("a"), planTask("b", { dependsOn: ["a"] }), planTask("c")]);
    // A task create "crashes" after the mission and crew exist: the server never answers it.
    fake.failNext("POST", "/v1/tasks");
    await facade.createMissionFromPlan(plan, { projectId: project.id }).catch(() => undefined);
    fake.requests.length = 0;
    // A fresh facade on the same database (process restart).
    const again = new MimirClientFacade({ db });
    again.connect({ baseUrl: fake.url, token: fake.token });
    const result = await again.createMissionFromPlan(plan, { projectId: project.id });
    expect(fake.creates).toMatchObject({ missions: 1, crews: 1, tasks: 3 });
    expect(Object.keys(result.taskIdMap)).toHaveLength(3);
    // Already-recorded submissions are not re-sent at all.
    expect(fake.requests.some((r) => r.path === "/v1/missions")).toBe(false);
    // Re-running a completed submission is a no-op.
    const third = await again.createMissionFromPlan(plan, { projectId: project.id });
    expect(third).toEqual(result);
    expect(fake.creates).toMatchObject({ missions: 1, crews: 1, tasks: 3 });
  });

  it("relies on Mimir idempotency when the local record is lost", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const plan = twoTaskPlan();
    const first = await facade.createMissionFromPlan(plan, { projectId: project.id });
    const other = new MimirClientFacade({ db: openDatabase(":memory:") });
    other.connect({ baseUrl: fake.url, token: fake.token });
    const second = await other.createMissionFromPlan(plan, { projectId: project.id });
    expect(second).toEqual(first);
    expect(fake.creates).toMatchObject({ missions: 1, crews: 2, tasks: 2 });
    // The mission already existed, so no "current" cursor is stored: following replays history.
    expect(other.storedCursor(first.missionId)).toBeNull();
    const ac = new AbortController();
    for await (const e of other.follow(first.missionId, { signal: ac.signal })) {
      expect(e.type).toBe("mission.created");
      break;
    }
    ac.abort();
  });

  it("a later run of the same plan version creates a new mission with its own keys", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const plan = twoTaskPlan();
    const first = await facade.createMissionFromPlan(plan, { projectId: project.id });
    const second = await facade.createMissionFromPlan(plan, { projectId: project.id, run: 2 });
    expect(second.missionId).not.toBe(first.missionId);
    expect(fake.creates).toMatchObject({ missions: 2, crews: 4, tasks: 4 });
    const keys = fake.requests.map((r) => r.idempotencyKey);
    expect(keys).toContain("sindri:plan-1:1#2:@mission");
    expect(keys).toContain("sindri:plan-1:1#2:impl");
  });

  it("catchUp returns the events after the stored cursor and the caught-up cursor", async () => {
    const { facade, fake } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const { missionId } = await facade.createMissionFromPlan(twoTaskPlan(), {
      projectId: project.id,
    });
    const first = await facade.catchUp(missionId);
    expect(first.events.map((e) => e.type)).toEqual([
      "mission.created",
      "task.created",
      "task.created",
    ]);
    expect(first.cursor).toBe(fake.latestCursor());
    facade.saveCursor(missionId, first.cursor!);
    expect((await facade.catchUp(missionId)).events).toEqual([]);
  });

  it("refuses unapproved plans", async () => {
    const { facade } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const plan = approvedPlan([planTask("a")], { status: "draft" });
    await expect(facade.createMissionFromPlan(plan, { projectId: project.id })).rejects.toThrow(
      /approved/,
    );
  });

  it("follows mission events with typed payloads and persists the cursor", async () => {
    const { facade, db } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const { missionId } = await facade.createMissionFromPlan(twoTaskPlan(), {
      projectId: project.id,
    });
    await facade.start(missionId);
    const seen: string[] = [];
    const ac = new AbortController();
    for await (const e of facade.follow(missionId, { signal: ac.signal })) {
      seen.push(e.id);
      if (e.type === "task.completed") break;
    }
    const stored = facade.storedCursor(missionId);
    expect(stored).toBeTruthy();
    expect(
      db.prepare("SELECT cursor FROM execution_cursors WHERE mission_id = ?").get(missionId),
    ).toEqual({ cursor: stored });
    // The cursor advances when the consumer asks for the next event (at-least-once): only the
    // event the consumer broke on can be delivered again.
    const rest: string[] = [];
    const types: string[] = [];
    for await (const e of facade.follow(missionId, { signal: ac.signal })) {
      rest.push(e.id);
      types.push(e.type);
      if (e.type === "mission.completed") break;
    }
    ac.abort();
    const repeated = rest.filter((id) => seen.includes(id));
    expect(repeated).toEqual([seen.at(-1)]);
    expect(types.at(-1)).toBe("mission.completed");
    expect(new Set([...seen, ...rest]).size).toBe(
      fake!.events().filter((e) => e.missionId === missionId).length,
    );
  });

  it("an explicitly saved cursor resumes exactly after the last processed event", async () => {
    const { facade } = await boot();
    const project = await facade.ensureProject("/repos/app");
    const { missionId } = await facade.createMissionFromPlan(twoTaskPlan(), {
      projectId: project.id,
    });
    await facade.start(missionId);
    const ac = new AbortController();
    const seen: string[] = [];
    const stream = facade.follow(missionId, { signal: ac.signal });
    for await (const e of stream) {
      seen.push(e.id);
      facade.saveCursor(missionId, stream.cursor!);
      if (e.type === "task.completed") break;
    }
    const rest: string[] = [];
    for await (const e of facade.follow(missionId, { signal: ac.signal })) {
      rest.push(e.id);
      if (e.type === "mission.completed") break;
    }
    ac.abort();
    expect(rest.filter((id) => seen.includes(id))).toEqual([]);
  });

  it("decides approvals, sends instructions, stops sessions, retries tasks and reads artifacts and usage", async () => {
    const { facade, fake } = await boot({
      impl: [{ kind: "approval", action: "shell.destructive" }, { kind: "fail" }],
    });
    const project = await facade.ensureProject("/repos/app");
    const plan = approvedPlan([planTask("impl", { maxRetries: 1 })]);
    const { missionId, taskIdMap } = await facade.createMissionFromPlan(plan, {
      projectId: project.id,
    });
    await facade.start(missionId);
    const ac = new AbortController();
    let sessionId: string | undefined;
    let artifactId: string | undefined;
    for await (const e of facade.follow(missionId, { signal: ac.signal })) {
      if (e.type === "task.started") sessionId = e.payload.sessionId;
      if (e.type === "approval.requested") {
        await facade.sendInstruction(sessionId!, "please continue");
        await facade.decideApproval(e.payload.approvalId, "approved", "ok by me");
      }
      if (e.type === "task.failed") await facade.retry(taskIdMap.impl!, { attempt: 1 });
      if (e.type === "artifact.recorded") artifactId = e.payload.artifactId;
      if (e.type === "mission.completed") break;
    }
    ac.abort();
    await facade.stop(sessionId!, "soft");
    expect(fake.sessionCommands.map((c) => c.kind)).toEqual(["input", "stop"]);
    expect(fake.approvals()[0]!.status).toBe("approved");
    const retry = fake.requests.find((r) => r.path.endsWith("/retry"));
    expect(retry!.idempotencyKey).toBe(`sindri:retry:${taskIdMap.impl}:1`);
    expect((await facade.getArtifact(artifactId!)).hash).toMatch(/^sha256:/);
    expect((await facade.getUsage(missionId)).totals.tokens).toBe(0);
  });
});
