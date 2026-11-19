import { createHash } from "node:crypto";
import type { DecisionLogBlockRequest, ProjectId } from "@mimir/protocol";
import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import { createFakeMimir, type FakeMimir } from "@sindri/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MimirClientFacade } from "./facade.js";
import { approvedPlan, planTask } from "./testing.js";

describe("decision log mission submissions", () => {
  let db: SqliteDatabase;
  let fake: FakeMimir;
  let client: MimirClientFacade;
  let projectId: ProjectId;
  const connect = () =>
    new MimirClientFacade({ db }).connect({ baseUrl: fake.url, token: fake.token });
  const plan = approvedPlan([planTask("implement")]);
  const uploads = (project: string) =>
    fake.requests
      .filter((r) => r.path === `/v1/projects/${project}/decision-log-blocks`)
      .map((r) => r.body as DecisionLogBlockRequest);
  const digest = (block: DecisionLogBlockRequest) =>
    createHash("sha256").update(JSON.stringify(block)).digest("hex");

  beforeEach(async () => {
    fake = await createFakeMimir();
    db = openDatabase(":memory:");
    client = connect();
    projectId = (await client.ensureProject("/test/app")).id;
  });
  afterEach(async () => {
    await fake?.close();
    db?.close();
  });

  it("sends a 64-byte reference for a multi-megabyte history and reuses stable prefixes after restart", async () => {
    const decisionLog = Array.from({ length: 100 }, (_, i) => ({
      id: `adr-${i}:accepted`,
      markdown: `Decision ${i}: ${'é🪓"\\'.repeat(3000)}`,
    }));
    expect(Buffer.byteLength(JSON.stringify(decisionLog))).toBeGreaterThan(2 * 1024 * 1024);
    const { missionId } = await client.createMissionFromPlan(plan, { projectId, decisionLog });
    const blocks = uploads(projectId);
    expect(blocks.length).toBeGreaterThan(10);
    let head: string | null = null;
    for (const block of blocks) {
      expect(Buffer.byteLength(JSON.stringify(block))).toBeLessThanOrEqual(128 * 1024);
      expect(block.previous).toBe(head);
      head = digest(block);
    }
    expect(blocks.flatMap((block) => block.entries)).toEqual(decisionLog);
    const { body } = fake.requests.find((r) => r.method === "POST" && r.path === "/v1/missions")!;
    expect(body).toMatchObject({ decisionLogRef: head });
    expect(body).not.toHaveProperty("decisionLog");
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1024);
    expect((await client.getMission(missionId)).mission.decisionLogRef).toBe(head);

    client = connect();
    fake.requests.length = 0;
    await client.createMissionFromPlan(plan, { projectId, decisionLog });
    expect(uploads(projectId)).toHaveLength(0);
    expect(fake.requests.some((r) => r.method === "POST")).toBe(false);

    decisionLog.push({ id: "next:accepted", markdown: "Store sortable timestamps." });
    await client.createMissionFromPlan(plan, { projectId, decisionLog, run: 2 });
    const added = uploads(projectId);
    expect(added).toHaveLength(1);
    expect(added[0]!.entries.at(-1)).toEqual(decisionLog.at(-1));
    expect([head, blocks.at(-1)!.previous]).toContain(added[0]!.previous);
  });

  it("resumes an interrupted submission and uploads identical blocks separately for each project", async () => {
    const decisionLog = [{ id: "shared:accepted", markdown: "Use UTC." }];
    fake.failNext("POST", "/v1/missions");
    await expect(client.createMissionFromPlan(plan, { projectId, decisionLog })).rejects.toThrow();
    expect(uploads(projectId)).toEqual([{ previous: null, entries: decisionLog }]);
    client = connect();
    fake.requests.length = 0;
    await client.createMissionFromPlan(plan, { projectId, decisionLog });
    expect(uploads(projectId)).toHaveLength(0);

    const other = (await client.ensureProject("/test/other")).id;
    const otherPlan = approvedPlan([planTask("implement")], { id: "other-plan" });
    await client.createMissionFromPlan(otherPlan, { projectId: other, decisionLog });
    expect(uploads(other)).toEqual([{ previous: null, entries: decisionLog }]);
    expect(uploads(projectId)).toHaveLength(0);
  });

  it.each(["prefix", "head"] as const)(
    "repairs cached receipts for a restored project's missing %s",
    async (missing) => {
      const entries = ["A", "B"].map((letter) => ({
        id: letter,
        markdown: letter.repeat(80 * 1024),
      }));
      const seed = approvedPlan([planTask("seed")], { id: "seed" });
      await client.createMissionFromPlan(seed, {
        projectId,
        decisionLog: missing === "head" ? entries : entries.slice(0, 1),
      });
      const other = (await client.ensureProject("/test/other")).id;
      const otherPlan = approvedPlan([planTask("other")], { id: "other" });
      await client.createMissionFromPlan(otherPlan, { projectId: other, decisionLog: entries });
      const { missionId } = await client.createMissionFromPlan(plan, {
        projectId,
        decisionLogAtVerification: true,
      });
      await client.start(missionId);
      await vi.waitFor(() =>
        expect(
          fake
            .events()
            .some((e) => e.missionId === missionId && e.type === "mission.decision_log_requested"),
        ).toBe(true),
      );
      fake.dropDecisionLogBlocks(projectId);
      fake.requests.length = 0;
      await client.pinDecisionLog(missionId, entries);
      expect(
        uploads(projectId)
          .slice(-2)
          .flatMap((block) => block.entries),
      ).toEqual(entries);
      const head = digest(uploads(projectId).at(-1)!);
      expect((await client.getMission(missionId)).mission).toMatchObject({
        decisionLogPinned: true,
        decisionLogRef: head,
      });
      await client.createMissionFromPlan(otherPlan, {
        projectId: other,
        decisionLog: entries,
        run: 2,
      });
      expect(uploads(other)).toHaveLength(0);
    },
  );

  it("does not submit a mission or remember an upload when Mimir returns the wrong digest", async () => {
    const faulty = new MimirClientFacade({
      db,
      fetch: (input, init) =>
        String(input).endsWith("/decision-log-blocks")
          ? Promise.resolve(Response.json({ digest: "0".repeat(64) }))
          : fetch(input, init),
    }).connect({ baseUrl: fake.url, token: fake.token });
    const decisionLog = [{ id: "accepted", markdown: "Document date formats." }];
    await expect(
      faulty.createMissionFromPlan(plan, { projectId, decisionLog }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(fake.creates.missions).toBe(0);
    await client.createMissionFromPlan(plan, { projectId, decisionLog });
    expect(uploads(projectId)).toHaveLength(1);
  });

  it("preserves oversized historical entries byte for byte across blocks and keeps smaller entries atomic", async () => {
    const historical = { id: "legacy", markdown: '🪓古い "line"\\\n\u0000'.repeat(22000) };
    const medium = { id: "medium", markdown: "x".repeat(150 * 1024) };
    const end = { id: "end", markdown: "A separate decision." };
    await client.createMissionFromPlan(plan, { projectId, decisionLog: [medium, historical, end] });
    const blocks = uploads(projectId);
    expect(
      blocks.filter((block) => block.entries.some((e) => e.id === historical.id)).length,
    ).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(Buffer.byteLength(JSON.stringify(block))).toBeLessThanOrEqual(256 * 1024);
    }
    const entries = blocks.flatMap((b) => b.entries);
    expect(entries[0]).toEqual(medium);
    expect(entries.at(-1)).toEqual(end);
    const fragments = entries.slice(1, -1);
    expect(fragments.every((part) => part.id === historical.id)).toBe(true);
    const restored = Buffer.concat(fragments.map((part) => Buffer.from(part.markdown)));
    expect(restored.equals(Buffer.from(historical.markdown))).toBe(true);
  });
});
