import { Writable } from "node:stream";
import { ApiErrorBodySchema, PROTOCOL_VERSION } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger } from "./logger.js";
import { AUTH, TOKEN, makeServer, type TestServer } from "./test-helpers.js";

const servers: TestServer[] = [];
const track = (s: TestServer) => (servers.push(s), s);
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe("health", () => {
  it("serves GET /v1/health without auth", async () => {
    const { app } = track(makeServer({ runtime: null }));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      integrity: { refusedRows: 0, firstRefusedAt: null },
    });
  });

  it("includes runtime health when a runtime is configured", async () => {
    const { app } = track(makeServer());
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.json()).toEqual({
      status: "ok",
      runtime: { ok: true },
      integrity: { refusedRows: 0, firstRefusedAt: null },
    });
  });
});

describe("auth", () => {
  it.each([
    ["no header", {}],
    ["wrong token", { authorization: "Bearer nope" }],
    ["wrong scheme", { authorization: `Basic ${TOKEN}` }],
    ["token prefix only", { authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
  ])("returns 401 unauthorized with %s", async (_name, headers) => {
    const { app } = track(makeServer());
    const res = await app.inject({ method: "GET", url: "/v1/capabilities", headers });
    expect(res.statusCode).toBe(401);
    const body = ApiErrorBodySchema.parse(res.json());
    expect(body.error.code).toBe("unauthorized");
  });

  it("accepts the bearer token", async () => {
    const { app } = track(makeServer());
    const res = await app.inject({ method: "GET", url: "/v1/capabilities", headers: AUTH });
    expect(res.statusCode).toBe(200);
  });
});

describe("capabilities", () => {
  it("reports server, protocol and runtime capabilities", async () => {
    const { app } = track(makeServer());
    const res = await app.inject({ method: "GET", url: "/v1/capabilities", headers: AUTH });
    expect(res.json()).toMatchObject({
      serverVersion: expect.any(String),
      protocolVersion: PROTOCOL_VERSION,
      runtime: { runtime: "fake" },
    });
  });

  it("reports runtime: null without a runtime", async () => {
    const { app } = track(makeServer({ runtime: null }));
    const res = await app.inject({ method: "GET", url: "/v1/capabilities", headers: AUTH });
    expect(res.json()).toMatchObject({ runtime: null });
  });
});

describe("error mapping", () => {
  it("maps unknown routes to 404 not_found", async () => {
    const { app } = track(makeServer());
    const res = await app.inject({ method: "GET", url: "/v1/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("not_found");
  });

  it("maps a ZodError to 422 validation_failed with details.issues", async () => {
    const { app } = track(makeServer());
    app.get("/v1/test-zod", () => z.object({ a: z.string() }).parse({ a: 1 }));
    const res = await app.inject({ method: "GET", url: "/v1/test-zod", headers: AUTH });
    expect(res.statusCode).toBe(422);
    const body = ApiErrorBodySchema.parse(res.json());
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toMatchObject({ issues: [{ path: ["a"] }] });
  });

  it("maps unknown errors to 500 internal without leaking the message or stack", async () => {
    const { app } = track(makeServer());
    app.get("/v1/test-boom", () => {
      throw new Error("secret detail at /home/x");
    });
    const res = await app.inject({ method: "GET", url: "/v1/test-boom", headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(res.body).not.toContain("secret");
  });

  it("maps malformed JSON bodies to 422 validation_failed", async () => {
    const { app } = track(makeServer());
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...AUTH, "idempotency-key": "k", "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(422);
    expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("validation_failed");
  });
});

describe("logging", () => {
  it("redacts the authorization header", async () => {
    let out = "";
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const { app } = track(makeServer({ logger: createLogger({ level: "info", stream: sink }) }));
    await app.inject({ method: "GET", url: "/v1/capabilities", headers: AUTH });
    expect(out).toContain("/v1/capabilities");
    expect(out).toContain("[Redacted]");
    expect(out).not.toContain(TOKEN);
  });
});
