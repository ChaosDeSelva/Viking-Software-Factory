import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRuntime } from "@mimir/fake-runtime";
import { ApiErrorBodySchema, newId } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingRuntime, type Json } from "../../test/orchestration-support.js";
import { FleetRuntime } from "../fleet-runtime/adapter.js";
import type { BuildServerOptions } from "../index.js";
import { AUTH, eventInput, makeServer, tempGitRepo, type TestServer } from "../test-helpers.js";

const servers: TestServer[] = [];
const dirs: string[] = [];
let repo: ReturnType<typeof tempGitRepo>;
beforeEach(() => {
  repo = tempGitRepo();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  repo.cleanup();
});
const serve = (overrides: Partial<BuildServerOptions> = {}) => {
  const s = makeServer(overrides);
  servers.push(s);
  return s;
};

type Res = { status: number; json: Json };
const send = async (s: TestServer, method: "GET" | "POST", url: string, body?: unknown) => {
  const res = await s.app.inject({
    method,
    url,
    headers: method === "POST" ? { ...AUTH, "idempotency-key": randomUUID() } : AUTH,
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: res.json() as Json } satisfies Res;
};
const get = (s: TestServer, url: string) => send(s, "GET", url);
const post = (s: TestServer, url: string, body?: unknown) => send(s, "POST", url, body);
const errorCode = (r: Res) => ApiErrorBodySchema.parse(r.json).error.code;

describe("health", () => {
  it("is degraded without a runtime when the store refused corrupt rows", async () => {
    const s = serve({ runtime: null });
    const integrity = { refusedRows: 2, firstRefusedAt: "2026-01-01T00:00:00.000Z" };
    vi.spyOn(s.store, "integrity").mockReturnValue(integrity);
    const res = await s.app.inject({ url: "/v1/health" });
    expect(res.json()).toEqual({ status: "degraded", integrity });
  });

  it("is degraded with the error message when the runtime health check throws", async () => {
    const runtime = new RecordingRuntime(new FakeRuntime());
    const s = serve({ runtime });
    runtime.health = () => Promise.reject(new Error("socket gone"));
    expect((await s.app.inject({ url: "/v1/health" })).json()).toMatchObject({
      status: "degraded",
      runtime: { ok: false, detail: "socket gone" },
    });
    runtime.health = () => Promise.reject("not an Error");
    expect((await s.app.inject({ url: "/v1/health" })).json()).toMatchObject({
      status: "degraded",
      runtime: { ok: false, detail: "health check failed" },
    });
  });
});

describe("capabilities and harnesses", () => {
  it("503 runtime_unavailable when the runtime cannot report capabilities", async () => {
    const runtime = new RecordingRuntime(new FakeRuntime());
    runtime.capabilities = () => Promise.reject(new Error("down"));
    const s = serve({ runtime });
    const res = await get(s, "/v1/capabilities");
    expect(res.status).toBe(503);
    expect(errorCode(res)).toBe("runtime_unavailable");
    expect(JSON.stringify(res.json)).not.toContain("down");
  });

  it("lists the interactive harnesses without running them, behind the token", async () => {
    const s = serve();
    expect((await s.app.inject({ url: "/v1/harnesses" })).statusCode).toBe(401);
    const res = await get(s, "/v1/harnesses");
    expect(res.status).toBe(200);
    const harnesses = res.json["harnesses"] as { kind: string; version: unknown }[];
    expect(harnesses.length).toBeGreaterThan(0);
    expect(harnesses.map((h) => h.kind)).toContain("codex");
    // Versions are only probed on request (they would execute the CLI).
    expect(harnesses.every((h) => h.version === null)).toBe(true);
  });
});

describe("fleet routes", () => {
  it("501 capability_unavailable when the runtime is not a fleet", async () => {
    const s = serve();
    expect(errorCode(await get(s, "/v1/fleet"))).toBe("capability_unavailable");
    const drain = await post(s, "/v1/fleet/w1/drain", { draining: true });
    expect(errorCode(drain)).toBe("capability_unavailable");
  });

  it("lists workers and drains one; unknown worker 404; bad body 422", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mimir-fleet-route-"));
    dirs.push(dir);
    const fleet = new FleetRuntime(
      [{ id: "w1", identity: "w1", runtime: new FakeRuntime(), capacity: 2 }],
      join(dir, "fleet.json"),
    );
    const s = serve({ runtime: fleet });
    expect((await get(s, "/v1/fleet")).json["workers"]).toEqual([
      expect.objectContaining({ id: "w1", capacity: 2, draining: false }),
    ]);
    const drained = await post(s, "/v1/fleet/w1/drain", { draining: true });
    expect(drained).toEqual({ status: 200, json: { workerId: "w1", draining: true } });
    expect((await get(s, "/v1/fleet")).json["workers"][0]).toMatchObject({ draining: true });
    expect(errorCode(await post(s, "/v1/fleet/nope/drain", { draining: false }))).toBe("not_found");
    expect((await post(s, "/v1/fleet/w1/drain", { draining: "yes" })).status).toBe(422);
    expect((await post(s, "/v1/fleet/w1/drain", { draining: true, extra: 1 })).status).toBe(422);
  });
});

describe("approvals and artifacts", () => {
  it("lists approvals by mission and 404s a decision on an unknown approval", async () => {
    const s = serve();
    const m1 = newId("msn");
    const ids = [m1, newId("msn")].map((missionId) => {
      const approvalId = newId("apr");
      s.store.append(
        eventInput({
          type: "approval.requested",
          streamId: `approval:${approvalId}`,
          missionId,
          payload: { approvalId, action: "pr.create", expiry: null },
        }),
      );
      return approvalId;
    });
    const listed = await get(s, `/v1/approvals?missionId=${m1}&status=pending`);
    expect(listed.json["approvals"].map((a: { id: string }) => a.id)).toEqual([ids[0]]);
    const unknown = await post(s, `/v1/approvals/${newId("apr")}/decision`, {
      decision: "approved",
    });
    expect(errorCode(unknown)).toBe("not_found");
  });

  it("artifact metadata reports bytes null when the event did not carry a size", async () => {
    const s = serve();
    const artifactId = newId("art");
    s.store.append(
      eventInput({
        type: "artifact.recorded",
        streamId: "a",
        payload: { artifactId, taskId: newId("tsk"), kind: "log", uri: "file:///x", hash: "h" },
      }),
    );
    expect((await get(s, `/v1/artifacts/${artifactId}`)).json).toMatchObject({
      artifact: { id: artifactId },
      bytes: null,
    });
    // Its content was never stored: 404, not a crash.
    expect(errorCode(await get(s, `/v1/artifacts/${artifactId}/content`))).toBe("not_found");
  });
});

describe("missions", () => {
  const project = async (s: TestServer) =>
    (await post(s, "/v1/projects", { name: "p", repoPath: repo.repo })).json["project"]
      .id as string;

  it("stores budget fraction and task priority/verification/timeout as given", async () => {
    const s = serve({ runtimeReportsUsage: true });
    const projectId = await project(s);
    const res = await post(s, "/v1/missions", {
      projectId,
      objective: "o",
      // With a runtime that reports usage a hard budget needs no explicit onUnknown.
      budget: { limitCost: 5, warnAtFraction: 0.5 },
      tasks: [
        {
          title: "t",
          brief: "b",
          priority: 7,
          verification: { harnesses: ["unit"] },
          timeoutMs: 60_000,
        },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json["tasks"][0]).toMatchObject({
      priority: 7,
      verification: { harnesses: ["unit"] },
      timeoutMs: 60_000,
    });
    const budget = [...s.app.mimir.readModel.budgets.values()][0];
    expect(budget).toMatchObject({ limitCost: 5, limitTokens: null, warnAtFraction: 0.5 });
  });

  it("a hard cost budget without onUnknown is refused when the runtime reports no usage", async () => {
    const s = serve();
    const projectId = await project(s);
    const res = await post(s, "/v1/missions", {
      projectId,
      objective: "o",
      budget: { limitCost: 5 },
    });
    expect(res.status).toBe(422);
    expect(res.json["error"]["details"]["reason"]).toBe("budget_on_unknown_required");
  });

  it("transitions accept an absent body; a terminal mission can only be cancelled again", async () => {
    const s = serve();
    const projectId = await project(s);
    const missionId = (await post(s, "/v1/missions", { projectId, objective: "o" })).json["mission"]
      .id as string;
    // No body at all (not even {}): parsed as empty.
    const cancel = await s.app.inject({
      method: "POST",
      url: `/v1/missions/${missionId}/cancel`,
      headers: { ...AUTH, "idempotency-key": randomUUID() },
    });
    expect(cancel.statusCode).toBe(202);
    const start = await s.app.inject({
      method: "POST",
      url: `/v1/missions/${missionId}/start`,
      headers: { ...AUTH, "idempotency-key": randomUUID() },
    });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({
      error: { code: "invalid_transition", details: { status: "cancelled" } },
    });
  });
});

describe("list ordering", () => {
  it("lists missions by creation time, whatever order they were created in", async () => {
    // A clock that jumps back and forth: creation order is not time order.
    const base = Date.parse("2026-06-01T00:00:00.000Z");
    const offsets = [0, 5, -3, 2, -1];
    let call = 0;
    const s = serve({ now: () => new Date(base + (offsets[call++ % offsets.length] ?? 0) * 1000) });
    const projectId = (await post(s, "/v1/projects", { name: "p", repoPath: repo.repo })).json[
      "project"
    ].id as string;
    const created: { id: string; at: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const mission = (await post(s, "/v1/missions", { projectId, objective: `o${i}` })).json[
        "mission"
      ];
      created.push({ id: mission.id, at: mission.createdAt });
    }
    const byTime = [...created].sort((a, b) => a.at.localeCompare(b.at)).map((m) => m.id);
    expect(byTime).not.toEqual(created.map((m) => m.id));
    const listed = (await get(s, "/v1/missions")).json["missions"].map((m: { id: string }) => m.id);
    expect(listed).toEqual(byTime);
    const snapshot = (await get(s, "/v1/snapshot")).json["missions"].map(
      (m: { id: string }) => m.id,
    );
    expect(snapshot).toEqual(byTime);
  });

  it("lists tasks created in the same instant by id, not by creation order", async () => {
    const s = serve({ now: () => new Date("2026-06-01T00:00:00.000Z") });
    const projectId = (await post(s, "/v1/projects", { name: "p", repoPath: repo.repo })).json[
      "project"
    ].id as string;
    // Client-chosen ids: the second task created has the smaller id.
    const [small, big] = [newId("tsk"), newId("tsk")];
    const res = await post(s, "/v1/missions", {
      projectId,
      objective: "o",
      tasks: [
        { id: big, title: "first", brief: "b" },
        { id: small, title: "second", brief: "b" },
      ],
    });
    expect(res.status).toBe(201);
    const listed = (await get(s, "/v1/tasks")).json["tasks"].map((t: { id: string }) => t.id);
    expect(listed).toEqual([small, big]);
  });
});
