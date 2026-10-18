import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHarness, ORIGIN, TOKEN, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const newProject = (name = "demo") => ({ name, repoPath: h.repoDir });

describe("health and capabilities", () => {
  it("serves health without auth", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports capabilities with mimir and brokkr disabled", async () => {
    const res = await h.call({ method: "GET", url: "/v1/capabilities" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      serverVersion: expect.any(String),
      features: { mimir: false, brokkr: false },
    });
  });
});

describe("authentication", () => {
  it("requires a bearer token on /v1/* except health", async () => {
    const none = await h.app.inject({ method: "GET", url: "/v1/projects" });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    const wrong = await h.app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${"x".repeat(64)}` },
    });
    expect(wrong.statusCode).toBe(401);
    const shortTok = await h.app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: "Bearer t" },
    });
    expect(shortTok.statusCode).toBe(401);
    const basic = await h.app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Basic ${TOKEN}` },
    });
    expect(basic.statusCode).toBe(401);
    const ok = await h.call({ method: "GET", url: "/v1/projects" });
    expect(ok.statusCode).toBe(200);
  });

  it("returns the error envelope for unknown routes (after auth)", async () => {
    const res = await h.call({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("origin and host checks", () => {
  it("allows the web dev origin and rejects others with 403", async () => {
    const ok = await h.call({ method: "GET", url: "/v1/projects", headers: { origin: ORIGIN } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    const bad = await h.call({
      method: "GET",
      url: "/v1/projects",
      headers: { origin: "http://evil.example" },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("origin_forbidden");
  });

  it("answers CORS preflight for allowed origins only, without auth", async () => {
    const ok = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/projects",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-headers"]).toMatch(/idempotency-key/i);
    const bad = await h.app.inject({
      method: "OPTIONS",
      url: "/v1/projects",
      headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
    });
    expect(bad.statusCode).toBe(403);
  });

  it("rejects a non-loopback Host header (DNS rebinding)", async () => {
    const res = await h.call({
      method: "GET",
      url: "/v1/projects",
      headers: { host: "attacker.example:7800" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("host_forbidden");
  });
});

describe("idempotency", () => {
  it("requires Idempotency-Key on mutations", async () => {
    const res = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: newProject(),
      key: null,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it("replays the stored response for the same key and request", async () => {
    const first = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: newProject(),
      key: "abc",
    });
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    const again = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: newProject(),
      key: "abc",
    });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    const list = await h.call({ method: "GET", url: "/v1/projects" });
    expect(list.json().projects).toHaveLength(1);
  });

  it("returns 409 when a key is reused with a different request", async () => {
    await h.call({ method: "POST", url: "/v1/projects", payload: newProject("a"), key: "k1" });
    const res = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: newProject("b"),
      key: "k1",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("idempotency_mismatch");
  });

  it("replays stored 4xx responses too", async () => {
    const a = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "" },
      key: "bad",
    });
    expect(a.statusCode).toBe(422);
    const b = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "" },
      key: "bad",
    });
    expect(b.statusCode).toBe(422);
    expect(b.headers["idempotency-replayed"]).toBe("true");
  });
});

describe("idempotency reservations", () => {
  it("reports a still-pending key as in progress and clears stale reservations at startup", async () => {
    const { hashRequest } = await import("../idempotency.js");
    h.db
      .prepare(
        "INSERT INTO commands (idempotency_key, request_hash, method, url, state, created_at) VALUES ('stuck', ?, 'POST', '/v1/projects', 'pending', 'now')",
      )
      .run(hashRequest("POST", "/v1/projects", newProject()));
    const busy = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: newProject(),
      key: "stuck",
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe("idempotency_in_progress");
    const { buildServer } = await import("../app.js");
    const restarted = buildServer({ db: h.db, authToken: TOKEN });
    const ok = await restarted.inject({
      method: "POST",
      url: "/v1/projects",
      payload: newProject(),
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "stuck" },
    });
    expect(ok.statusCode).toBe(201);
    await restarted.close();
  });

  it("releases the key after a 5xx so a retry runs again", async () => {
    await h.close();
    let calls = 0;
    const { FakeProvider } = await import("@sindri/director");
    h = await makeHarness({
      providerFactory: () =>
        new FakeProvider(() => {
          calls++;
          return { error: new Error("boom") };
        }),
    });
    const p = (await h.call({ method: "POST", url: "/v1/projects", payload: newProject() })).json()
      .project.id;
    const payload = { projectId: p, request: "x" };
    const a = await h.call({ method: "POST", url: "/v1/director/draft", payload, key: "retry" });
    expect(a.statusCode).toBe(500);
    expect(a.json().error.message).toBe("internal error");
    const b = await h.call({ method: "POST", url: "/v1/director/draft", payload, key: "retry" });
    expect(b.statusCode).toBe(500);
    expect(b.headers["idempotency-replayed"]).toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("errors and logs", () => {
  it("maps malformed JSON to 422 with the envelope", async () => {
    const res = await h.call({
      method: "POST",
      url: "/v1/projects",
      payload: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_json");
  });

  it("validates bodies with a 422 and details", async () => {
    const res = await h.call({ method: "POST", url: "/v1/projects", payload: { name: 5 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: "validation_failed",
      details: expect.anything(),
    });
  });

  it("logs requests with the authorization header redacted", async () => {
    await h.call({
      method: "GET",
      url: "/v1/projects",
      headers: { "x-api-key": "sk-secret-value" },
    });
    const all = h.logs.join("");
    expect(all).toContain("/v1/projects");
    expect(all).toContain("[Redacted]");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("sk-secret-value");
  });
});
