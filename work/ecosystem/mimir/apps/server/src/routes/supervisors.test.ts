import { afterEach, expect, it } from "vitest";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../test-helpers.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { SupervisorStore } from "../supervision/store.js";
const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
function server() {
  const s = makeServer();
  servers.push(s);
  return s.app;
}
const headers = () => ({ ...AUTH, "idempotency-key": randomUUID() });
it("requires authentication and audits supervisor registration and holds", async () => {
  const app = server();
  expect((await app.inject({ method: "GET", url: "/v1/supervisors" })).statusCode).toBe(401);
  const created = await app.inject({
    method: "POST",
    url: "/v1/supervisors",
    headers: headers(),
    payload: { id: "primary", parent: null },
  });
  expect(created.statusCode).toBe(201);
  const state = await app.inject({
    method: "POST",
    url: "/v1/supervisors/primary/state",
    headers: headers(),
    payload: { state: "held", reason: "Waiting for operator\nNo automatic restart" },
  });
  expect(state.statusCode).toBe(200);
  const detail = (
    await app.inject({ method: "GET", url: "/v1/supervisors/primary", headers: AUTH })
  ).json();
  expect(detail.supervisor.state).toBe("held");
  expect(detail.observations.map((e: { kind: string }) => e.kind)).toContain("state_changed");
});
it("rejects controls targeting unknown sessions and unknown message verbs", async () => {
  const app = server();
  await app.inject({
    method: "POST",
    url: "/v1/supervisors",
    headers: headers(),
    payload: { id: "primary" },
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/supervisors/primary/messages",
        headers: headers(),
        payload: { id: "m1", control: { kind: "input", sessionId: "missing", text: "hello" } },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/supervisors/primary/messages",
        headers: headers(),
        payload: {
          id: "m2",
          control: { kind: "shell", sessionId: "missing", text: "touch /tmp/x" },
        },
      })
    ).statusCode,
  ).toBe(422);
});
it("deduplicates registration and refuses changing an existing supervisor parent", async () => {
  const app = server();
  const key = headers();
  const req = {
    method: "POST" as const,
    url: "/v1/supervisors",
    headers: key,
    payload: { id: "primary" },
  };
  expect((await app.inject(req)).statusCode).toBe(201);
  expect((await app.inject(req)).statusCode).toBe(201);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/supervisors",
        headers: headers(),
        payload: { id: "child", parent: "primary" },
      })
    ).statusCode,
  ).toBe(201);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/supervisors",
        headers: headers(),
        payload: { id: "primary", parent: "child" },
      })
    ).statusCode,
  ).toBe(409);
});

it("configures bounded policy only against an existing mission and returns it for inspection", async () => {
  const app = server(),
    repo = tempGitRepo();
  try {
    await app.inject({
      method: "POST",
      url: "/v1/supervisors",
      headers: headers(),
      payload: { id: "bounded" },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/supervisors/bounded/policy",
      headers: headers(),
      payload: { missionId: "missing", agentKind: "codex", enabled: false },
    });
    expect(invalid.statusCode).toBe(404);
    const project = (
      await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: headers(),
        payload: { name: "policy-test", repoPath: repo.repo },
      })
    ).json().project;
    const mission = (
      await app.inject({
        method: "POST",
        url: "/v1/missions",
        headers: headers(),
        payload: { projectId: project.id, objective: "Observe existing work" },
      })
    ).json().mission;
    const policy = await app.inject({
      method: "POST",
      url: "/v1/supervisors/bounded/policy",
      headers: headers(),
      payload: {
        missionId: mission.id,
        agentKind: "codex",
        enabled: false,
        maxTurns: 3,
        intervalMs: 60000,
      },
    });
    expect(policy.statusCode).toBe(200);
    const detail = (
      await app.inject({ method: "GET", url: "/v1/supervisors/bounded", headers: AUTH })
    ).json();
    expect(detail.policy).toMatchObject({
      enabled: false,
      maxTurns: 3,
      turns: 0,
      missionId: mission.id,
    });
  } finally {
    repo.cleanup();
  }
});
it("lists supervisors, 404s an unknown one, and authorizes/resolves only messages in the right state", async () => {
  const app = server();
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: headers(), payload });
  expect((await post("/v1/supervisors", { id: "ops" })).statusCode).toBe(201);
  const list = await app.inject({ method: "GET", url: "/v1/supervisors", headers: AUTH });
  expect(list.json().supervisors.map((s: { id: string }) => s.id)).toEqual(["ops"]);
  expect(
    (await app.inject({ method: "GET", url: "/v1/supervisors/ghost", headers: AUTH })).statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ method: "GET", url: "/v1/supervisors/a%20b", headers: AUTH })).statusCode,
  ).toBe(422);
  // Nothing awaits approval or is uncertain: both answer 409 and change nothing.
  const authorize = await post("/v1/supervisors/ops/authorize", {
    messageId: "nope",
    approved: true,
    reason: "looked at it",
  });
  expect(authorize.statusCode).toBe(409);
  expect(
    (await post("/v1/supervisors/ops/authorize", { messageId: "m", approved: true })).statusCode,
  ).toBe(422);
  const resolve = await post("/v1/supervisors/ops/resolve", {
    messageId: "nope",
    outcome: "done",
    reason: "checked the session",
  });
  expect(resolve.statusCode).toBe(409);
  expect(
    (await post("/v1/supervisors/ops/resolve", { messageId: "m", outcome: "maybe", reason: "r" }))
      .statusCode,
  ).toBe(422);
  const detail = (
    await app.inject({ method: "GET", url: "/v1/supervisors/ops", headers: AUTH })
  ).json();
  expect(detail.messages).toEqual([]);
});
it("authorizes a parked proposal and resolves an uncertain message with operator evidence", async () => {
  const s = makeServer();
  servers.push(s);
  const app = s.app;
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: headers(), payload });
  expect((await post("/v1/supervisors", { id: "ops" })).statusCode).toBe(201);
  // A second handle on the server's supervisor db stands in for the brain's proposals.
  const sup = new SupervisorStore(join(dirname(app.mimir.artifacts.dir), "supervisors.sqlite"));
  try {
    sup.enqueue("proposal", "ops", "input", { sessionId: "s", text: "go on" }, true);
    sup.enqueue("unsure", "ops", "stop", { sessionId: "s", mode: "soft" }, true);
    (sup as unknown as { db: { prepare(q: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE inbox SET state='uncertain' WHERE id=?")
      .run("unsure");
    const authorized = await post("/v1/supervisors/ops/authorize", {
      messageId: "proposal",
      approved: false,
      reason: "wrong session",
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ authorized: false });
    const resolved = await post("/v1/supervisors/ops/resolve", {
      messageId: "unsure",
      outcome: "done",
      reason: "the session had already stopped",
    });
    expect(resolved.json()).toEqual({ resolved: true });
    const byId = new Map(sup.messages("ops").map((m) => [m.id, m]));
    expect(byId.get("proposal")).toMatchObject({ state: "failed", result: "wrong session" });
    expect(byId.get("unsure")).toMatchObject({
      state: "done",
      result: "the session had already stopped",
    });
  } finally {
    sup.close();
  }
});
