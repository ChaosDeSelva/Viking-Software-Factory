import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH, TOKEN, makeServer, tempGitRepo, type TestServer } from "../../src/test-helpers.js";

let server: TestServer;
let repo: ReturnType<typeof tempGitRepo>;
beforeEach(() => {
  server = makeServer();
  repo = tempGitRepo();
});
afterEach(async () => {
  await server.close();
  repo.cleanup();
});

const ROUTES = [
  { method: "GET", url: "/v1/events" },
  { method: "GET", url: "/v1/events/stream" },
  { method: "GET", url: "/v1/snapshot" },
  { method: "GET", url: "/v1/projects" },
  { method: "GET", url: "/v1/capabilities" },
  { method: "POST", url: "/v1/projects" },
] as const;

const create = (headers: Record<string, string>) =>
  server.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { "content-type": "application/json", "idempotency-key": "k", ...headers },
    payload: { name: "p", repoPath: repo.repo },
  });

/** Nothing was executed: no command, no audit entry, no project. */
function expectNoSideEffects(): void {
  expect(server.store.commands.getByKey("k")).toBeFalsy();
  expect(server.store.audit.list()).toEqual([]);
  expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
}

describe("security: bearer token", () => {
  const BAD: [string, Record<string, string>][] = [
    ["missing", {}],
    ["wrong", { authorization: "Bearer not-the-token-0123456789" }],
    ["prefix of the real token", { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ["real token plus a suffix", { authorization: `Bearer ${TOKEN}x` }],
    ["wrong scheme", { authorization: `Basic ${TOKEN}` }],
    ["token without scheme", { authorization: TOKEN }],
    ["empty bearer", { authorization: "Bearer " }],
    ["token in the query string", {}],
  ];

  for (const [label, headers] of BAD) {
    it(`${label} → 401 on every protected route`, async () => {
      for (const r of ROUTES) {
        const url = label.includes("query") ? `${r.url}?token=${TOKEN}` : r.url;
        const res = await server.app.inject({
          method: r.method,
          url,
          headers: { "content-type": "application/json", "idempotency-key": "k", ...headers },
          ...(r.method === "POST" ? { payload: { name: "p", repoPath: repo.repo } } : {}),
        });
        expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
        expect(res.json()).toMatchObject({ error: { code: "unauthorized" } });
      }
      expectNoSideEffects();
    });
  }

  it("the token is never echoed in an error body", async () => {
    const res = await server.app.inject({
      url: "/v1/events",
      headers: { authorization: `Bearer ${TOKEN}x` },
    });
    expect(res.body).not.toContain(TOKEN);
  });
});

describe("security: Origin and Host spoofing", () => {
  const ORIGINS = [
    "http://evil.example",
    "http://localhost:80.evil.example",
    "http://localhost.evil.example:80",
    "https://localhost:80",
    "http://localhost:81",
    "null",
    "file://",
    "not a url",
  ];

  for (const origin of ORIGINS) {
    it(`Origin ${JSON.stringify(origin)} → 403 even with a valid token, nothing executed`, async () => {
      const res = await create({ ...AUTH, origin });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "policy_denied" } });
      const read = await server.app.inject({ url: "/v1/events", headers: { ...AUTH, origin } });
      expect(read.statusCode).toBe(403);
      expectNoSideEffects();
    });
  }

  it("a spoofed Host header → 403, with or without a matching Origin", async () => {
    for (const headers of [
      { host: "evil.example" },
      { host: "evil.example", origin: "http://evil.example" },
      { host: "127.0.0.1.evil.example:80" },
    ]) {
      const res = await create({ ...AUTH, ...headers });
      expect(res.statusCode).toBe(403);
    }
    expectNoSideEffects();
  });

  it("the server's own origin and the allowlisted dev origin are accepted", async () => {
    const own = await server.app.inject({
      url: "/v1/events",
      headers: { ...AUTH, origin: "http://localhost" },
    });
    expect(own.statusCode).toBe(200);
    const dev = await server.app.inject({
      url: "/v1/events",
      headers: { ...AUTH, origin: "http://localhost:5173" },
    });
    expect(dev.statusCode).toBe(200);
  });
});
