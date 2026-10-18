import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import { createFakeMimir, type FakeMimir } from "@sindri/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MimirClientFacade } from "./facade.js";
import { approvedPlan, planTask } from "./testing.js";

let fake: FakeMimir | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => {
  await fake?.close();
  db?.close();
  fake = undefined;
  db = undefined;
});

async function boot() {
  fake = await createFakeMimir({ stepDelayMs: 0 });
  db = openDatabase(":memory:");
  const facade = new MimirClientFacade({ db }).connect({ baseUrl: fake.url, token: fake.token });
  const project = await facade.ensureProject("/repos/app");
  const mission = await facade.createMissionFromPlan(approvedPlan([planTask("impl")]), {
    projectId: project.id,
  });
  return { fake, facade, mission };
}

describe("MimirClientFacade writes used by quality and delivery (S6)", () => {
  it("createCrew and createTask go through the facade with the caller's idempotency key", async () => {
    const { fake, facade, mission } = await boot();
    const before = { ...fake.creates };
    const a = await facade.createCrew(
      { missionId: mission.missionId, role: "reviewer", agentKind: "claude" },
      "sindri:test:crew",
    );
    const b = await facade.createCrew(
      { missionId: mission.missionId, role: "reviewer", agentKind: "claude" },
      "sindri:test:crew",
    );
    expect(b.crewId).toBe(a.crewId);
    expect(fake.creates.crews).toBe(before.crews + 1);
    const task = await facade.createTask(
      {
        missionId: mission.missionId,
        crewId: a.crewId,
        title: "review-impl: review",
        brief: "x",
        acceptanceCriteria: ["a", "b"],
      },
      "sindri:test:task",
    );
    expect(fake.tasks().find((t) => t.id === task.id)?.crewId).toBe(a.crewId);
    expect(fake.requests.filter((r) => r.idempotencyKey === "sindri:test:task")).toHaveLength(1);
  });

  it("replayEnvelopes returns the mission's envelopes with source, provenance and task", async () => {
    const { facade, mission } = await boot();
    const envelopes = await facade.replayEnvelopes(mission.missionId);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes[0]).toEqual(
      expect.objectContaining({ source: expect.any(String), provenance: expect.any(String) }),
    );
  });

  it("artifactContent decodes the SDK's { bytes, contentType, hash } and checks the hash header", async () => {
    const { fake, facade, mission } = await boot();
    await facade.start(mission.missionId);
    await vi.waitFor(() => expect(fake.artifacts().length).toBeGreaterThan(0), { timeout: 5000 });
    const manifest = fake.artifacts().find((a) => a.kind === "changed-files")!;
    const text = await facade.artifactContent(manifest.id);
    expect(JSON.parse(text)).toMatchObject({ headSha: fake.headShaOf(manifest.taskId) });
    const raw = await facade.sdk.artifacts.content(manifest.id);
    expect(raw.bytes).toBeInstanceOf(Uint8Array);
    expect(raw.hash).toBe(manifest.hash);
  });

  it("artifactContent rejects bytes that do not match the recorded hash", async () => {
    const { fake, facade, mission } = await boot();
    await facade.start(mission.missionId);
    await vi.waitFor(() => expect(fake.artifacts().length).toBeGreaterThan(0), { timeout: 5000 });
    const manifest = fake.artifacts().find((a) => a.kind === "changed-files")!;
    fake.tamper(manifest.id, "{}");
    await expect(facade.artifactContent(manifest.id)).rejects.toMatchObject({
      code: "hash_mismatch",
    });
  });

  it.each(["approval_required", "delivered"] as const)("requestPr maps SDK %s", async (status) => {
    const { facade } = await boot();
    const request = vi
      .spyOn(facade.sdk.tasks, "requestPr")
      .mockResolvedValue(
        status === "approval_required"
          ? ({ status, taskId: "tsk_1", approvalId: "apr_1" } as never)
          : ({ status, taskId: "tsk_1" } as never),
      );
    await expect(facade.requestPr("tsk_1", "sindri:pr:x")).resolves.toEqual(
      status === "approval_required"
        ? { status: "awaiting_approval", approvalId: "apr_1" }
        : { status: "requested" },
    );
    expect(request).toHaveBeenCalledWith("tsk_1", { idempotencyKey: "sindri:pr:x" });
  });
});
