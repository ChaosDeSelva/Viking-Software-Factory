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
