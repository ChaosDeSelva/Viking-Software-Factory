import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registeredRoutes } from "../../src/auth.js";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../../src/test-helpers.js";

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

const hex = (c: string) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`;

/** Concrete path for a route pattern (`:param` → a dummy segment). */
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z0-9_]+/g, "x");

/**
 * Every spelling of `path` that a router might decode or normalise back onto the route:
 * single and double percent-encoding of each character of the first two segments, encoded
 * slashes, and `..` / `.` segments (literal and encoded).
 */
function variants(path: string): string[] {
  const out = new Set<string>();
  const segs = path.split("/").slice(1);
  for (let s = 0; s < Math.min(segs.length, 2); s++) {
    const seg = segs[s] as string;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i] as string;
      if (!/[A-Za-z0-9]/.test(c)) continue;
      for (const enc of [hex(c), hex(c).toUpperCase(), `%25${hex(c).slice(1)}`]) {
        const copy = [...segs];
        copy[s] = seg.slice(0, i) + enc + seg.slice(i + 1);
        out.add(`/${copy.join("/")}`);
      }
    }
  }
  const rest = segs.slice(1).join("/");
  out.add(`/v1%2F${rest}`);
  out.add(`/v1%2f${rest}`);
  out.add(`/v1/health/../${rest}`);
  out.add(`/v1/health/%2e%2e/${rest}`);
  out.add(`/v1/health/%2E%2E/${rest}`);
  out.add(`/v1/health%2f..%2f${rest}`);
  out.add(`/v1/health/%252e%252e/${rest}`);
  out.add(`/v1/./${rest}`);
  out.add(`/x/../v1/${rest}`);
  out.add(`//v1/${rest}`);
  out.add(`/v1//${rest}`);
  out.add(`/V1/${rest}`);
  out.add(`/v1/health;/../${rest}`);
  return [...out];
}

describe("security: auth on the routed (decoded, normalised) path (audit C1)", () => {
  it("discovers every route, including the public health route", () => {
    const routes = registeredRoutes(server.app).map((r) => `${r.method} ${r.url}`);
    expect(routes).toContain("GET /v1/health");
    expect(routes).toContain("POST /v1/projects");
    expect(routes).toContain("GET /v1/events/stream");
  });

  it("the audit probes are 401 without a token and nothing executes", async () => {
    for (const url of [
      "/%761/projects",
      "/v%31/projects",
      "/v1/%70rojects",
      "/%761/snapshot",
      "/%761/events?limit=5",
      "/%761/events/stream",
      "/%25761/projects",
      "/v1/health/../projects",
      "/v1/health%2f..%2fprojects",
    ]) {
      const res = await server.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
    const post = await server.app.inject({
      method: "POST",
      url: "/%761/projects",
      headers: { "content-type": "application/json", "idempotency-key": "k" },
      payload: { name: "pwn", repoPath: repo.repo },
    });
    expect(post.statusCode).toBe(401);
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
    expect(server.store.commands.getByKey("k")).toBeFalsy();
  });

  it("every encoded / dot-segment variant of every protected route is 401 without a token", async () => {
    const routes = registeredRoutes(server.app).filter((r) => r.url !== "/v1/health");
    expect(routes.length).toBeGreaterThan(4);
    for (const r of routes) {
      for (const url of variants(concrete(r.url))) {
        const res = await server.app.inject({
          method: r.method,
          url,
          headers: { "content-type": "application/json", "idempotency-key": "k" },
          ...(r.method === "GET" || r.method === "HEAD" ? {} : { payload: {} }),
        });
        expect(res.statusCode, `${r.method} ${url}`).toBe(401);
      }
    }
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
    expect(server.store.commands.getByKey("k")).toBeFalsy();
  });

  it("denies by default: unknown paths need a token too (401 before 404)", async () => {
    for (const url of ["/", "/nope", "/v1/nope", "/v2/projects", "/%2e%2e/v1/projects"]) {
      const res = await server.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
    const withToken = await server.app.inject({ method: "GET", url: "/v1/nope", headers: AUTH });
    expect(withToken.statusCode).toBe(404);
  });

  it("the health route stays public under any spelling the router maps onto it", async () => {
    for (const url of ["/v1/health", "/%761/health", "/v1/h%65alth"]) {
      const res = await server.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("encoded spellings still work with a valid token (the router decodes them)", async () => {
    const res = await server.app.inject({ method: "GET", url: "/%761/projects", headers: AUTH });
    expect(res.statusCode).toBe(200);
  });

  it("idempotency guard: an encoded mutating path still needs Idempotency-Key (422)", async () => {
    for (const url of ["/%761/projects", "/v1/%70rojects", "/v%31/projects"]) {
      const res = await server.app.inject({
        method: "POST",
        url,
        headers: { ...AUTH, "content-type": "application/json" },
        payload: { name: "p", repoPath: repo.repo },
      });
      expect(res.statusCode, url).toBe(422);
      expect(res.json()).toMatchObject({
        error: { code: "validation_failed", message: "Idempotency-Key header is required" },
      });
    }
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
  });
});
