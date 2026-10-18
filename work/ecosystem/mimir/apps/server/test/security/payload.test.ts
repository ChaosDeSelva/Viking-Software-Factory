import { DEFAULT_MAX_PAYLOAD_BYTES } from "@mimir/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH,
  eventInput,
  makeServer,
  tempGitRepo,
  type TestServer,
} from "../../src/test-helpers.js";

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

const post = (payload: string, key = "k") =>
  server.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: { ...AUTH, "content-type": "application/json", "idempotency-key": key },
    payload,
  });

async function stillServing(): Promise<void> {
  const res = await server.app.inject({ url: "/v1/events", headers: AUTH });
  expect(res.statusCode).toBe(200);
}

describe("security: large and hostile payloads are bounded", () => {
  it("a 5 MiB request body is refused before any command runs", async () => {
    const body = JSON.stringify({ name: "x".repeat(5 * 1024 * 1024), repoPath: repo.repo });
    const res = await post(body);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body.length).toBeLessThan(4096);
    expect(server.store.commands.getByKey("k")).toBeFalsy();
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
    await stillServing();
  });

  it("deeply nested JSON is a client error, not a crash", async () => {
    const depth = 200_000;
    const res = await post(`{"name":${"[".repeat(depth)}${"]".repeat(depth)}}`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    await stillServing();
  });

  it("the body depth bound matches the ledger's: 63 levels pass the guard, 64 are 422", async () => {
    const nest = (d: number) => `${"[".repeat(d)}${"]".repeat(d)}`;
    const ok = await post(`{"name":"p","repoPath":"/nope","settings":{"a":${nest(61)}}}`, "d63");
    expect(ok.json()).toMatchObject({ error: { details: { reason: "not_found" } } });
    const deep = await post(`{"name":"p","repoPath":"/nope","settings":{"a":${nest(62)}}}`, "d64");
    expect(deep.statusCode).toBe(422);
    expect(deep.json()).toMatchObject({ error: { details: { maxDepth: 63 } } });
  });

  it("a 5 MiB event payload is stored truncated and served bounded", async () => {
    server.store.append(
      eventInput({
        type: "session.output",
        payload: { text: "y".repeat(5 * 1024 * 1024), redacted: false, lines: 1 },
      }),
    );
    const res = await server.app.inject({ url: "/v1/events", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeLessThan(DEFAULT_MAX_PAYLOAD_BYTES + 4096);
    const [event] = (res.json() as { events: { payload: unknown }[] }).events;
    expect(event?.payload).toMatchObject({ truncated: true, originalBytes: expect.any(Number) });
  });

  it("an oversized page limit is rejected (no unbounded reads)", async () => {
    for (const limit of ["100000", "1001", "0", "-1", "1e9"]) {
      const res = await server.app.inject({ url: `/v1/events?limit=${limit}`, headers: AUTH });
      expect(res.statusCode, limit).toBe(422);
    }
  });

  it("an oversized Idempotency-Key or header block is rejected", async () => {
    const longKey = await post(JSON.stringify({ name: "p", repoPath: repo.repo }), "k".repeat(256));
    expect(longKey.statusCode).toBe(422);
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.app.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/v1/events`, {
      headers: { ...AUTH, "x-filler": "z".repeat(64 * 1024) },
    });
    expect(res.status).toBe(431);
  });
});
