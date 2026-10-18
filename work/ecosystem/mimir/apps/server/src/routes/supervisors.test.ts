import { afterEach, expect, it } from "vitest";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../test-helpers.js";
import { randomUUID } from "node:crypto";
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
