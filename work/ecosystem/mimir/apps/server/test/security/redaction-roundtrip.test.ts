import { openEventStore, redactPayload, type PayloadRedactor } from "@mimir/core";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../../src/test-helpers.js";

let server: TestServer | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const fn of cleanups.splice(0)) fn();
});

describe("security: redactor false positives (coordinator ruling on T14afix, Msec)", () => {
  it("'Deploy Bearer Service', 'sk-learn-…', model/maxTokens/cookieDomain round-trip unchanged", async () => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    server = makeServer({ runtime: null });
    const settings = {
      model: "claude-sonnet-4-5",
      maxTokens: "4096",
      cookieDomain: "example.com",
      experiment: "sk-learn-experiments-v2",
    };
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "fp" },
      payload: { name: "Deploy Bearer Service", repoPath: repo.repo, settings },
    });
    expect(res.statusCode).toBe(201);
    const listed = await server.app.inject({ url: "/v1/projects", headers: AUTH });
    const project = (listed.json() as { projects: { name: string; settings: unknown }[] })
      .projects[0]!;
    expect(project.name).toBe("Deploy Bearer Service");
    expect(project.settings).toEqual(settings);
  });

  it.each(["redis://:secret@h:6379", "user%3Apass@host", "https://user%3Apass@host/x"])(
    "a URL password with an empty user or encoded colon (%s) → 422, nothing stored (T14a N1)",
    async (remote) => {
      const repo = tempGitRepo();
      cleanups.push(repo.cleanup);
      server = makeServer({ runtime: null });
      const res = await server.app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "n1" },
        payload: { name: "p", repoPath: repo.repo, settings: { remote } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain(remote);
      expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
    },
  );
});

// Values under secret-looking names (`NPM_TOKEN`) or with `password=`-style text have no
// credential *shape*, yet the event log would store, serve and hand them to agents as
// `[REDACTED:…]`, silently rewriting the operator's settings.
describe("security: project fields the event log would rewrite are refused", () => {
  const post = (payload: Record<string, unknown>, key: string) =>
    server!.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": key },
      payload,
    });

  it.each([
    [
      "an env var with a secret-looking name",
      { agent: { env: { NPM_TOKEN: "abc123" } } },
      "settings.agent.env.NPM_TOKEN",
    ],
    [
      "password=… inside a value",
      { agent: { env: { JAVA_TOOL_OPTIONS: "-Dpassword=hunter2" } } },
      "settings.agent.env.JAVA_TOOL_OPTIONS",
    ],
    ["a secret-looking settings key", { deploy: { password: "x" } }, "settings.deploy.password"],
    ["a key that itself holds a secret", { "password=hunter2": "x" }, "settings"],
    [
      "a token in a test command argument",
      { testCommand: ["npm", "test", "--", "--token=abc123def456"] },
      "settings.testCommand[3]",
    ],
  ])(
    "%s → 422 naming the field, value not echoed, nothing stored",
    async (_label, settings, field) => {
      const repo = tempGitRepo();
      cleanups.push(repo.cleanup);
      server = makeServer({ runtime: null });
      const res = await post({ name: "p", repoPath: repo.repo, settings }, "rw");
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: { details: { reason: "credential_in_project_field" } },
      });
      expect(res.json().error.details.fields.map((f: { field: string }) => f.field)).toContain(
        field,
      );
      expect(res.body).not.toMatch(/abc123|hunter2/);
      expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
    },
  );

  it("PATCH refuses them too and leaves the stored settings as they were", async () => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    server = makeServer({ runtime: null });
    const created = await post({ name: "p", repoPath: repo.repo }, "c");
    const id = created.json().project.id as string;
    const res = await server.app.inject({
      method: "PATCH",
      url: `/v1/projects/${id}`,
      headers: { ...AUTH, "idempotency-key": "u" },
      payload: { settings: { agent: { env: { NPM_TOKEN: "abc123" } } } },
    });
    expect(res.statusCode).toBe(422);
    expect(server.app.mimir.readModel.projects.get(id)?.settings).toEqual({});
  });

  it("uses the store's redactor: a value matching an extra pattern is refused, not stored rewritten", async () => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    const payloadRedactor: PayloadRedactor = (p) => redactPayload(p, [/ACME-[0-9]{6}/]);
    server = makeServer(
      { runtime: null, payloadRedactor },
      openEventStore(":memory:", { payloadRedactor }),
    );
    const settings = { agent: { env: { LICENSE_ID: "ACME-123456" } } };
    const res = await post({ name: "p", repoPath: repo.repo, settings }, "x");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({
      reason: "credential_in_project_field",
      fields: [{ field: "settings.agent.env.LICENSE_ID", kind: "redacted" }],
    });
    expect(res.body).not.toContain("123456");
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
    const created = await post({ name: "p", repoPath: repo.repo }, "y");
    const id = created.json().project.id as string;
    const patched = await server.app.inject({
      method: "PATCH",
      url: `/v1/projects/${id}`,
      headers: { ...AUTH, "idempotency-key": "z" },
      payload: { settings },
    });
    expect(patched.statusCode).toBe(422);
    expect(server.app.mimir.readModel.projects.get(id)?.settings).toEqual({});
  });
});
