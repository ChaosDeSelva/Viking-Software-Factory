import { ApiErrorBodySchema, isMimirError } from "@mimir/protocol";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_REPLAYED_HEADER, idempotent } from "./idempotency.js";
import { AUTH, makeServer, type TestServer } from "./test-helpers.js";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A server with one extra idempotent POST route whose handler waits for `release`. */
function withGatedRoute() {
  const s = makeServer();
  servers.push(s);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let runs = 0;
  s.app.post(
    "/v1/test/idem",
    idempotent(s.app.mimir, "test.idem", async () => {
      runs += 1;
      await gate;
      return { status: 201, body: { ok: true } }; // no target: audited without one
    }),
  );
  const call = (key: string) =>
    s.app.inject({
      method: "POST",
      url: "/v1/test/idem",
      headers: { ...AUTH, "idempotency-key": key },
    });
  return { s, call, release, runs: () => runs };
}

describe("idempotent", () => {
  it("a repeated key while the first request still runs is 409, and the first completes once", async () => {
    const { s, call, release, runs } = withGatedRoute();
    const first = call("same");
    // Wait until the first request is inside its handler (its command is begun).
    while (runs() === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await call("same");
    expect(second.statusCode).toBe(409);
    const body = ApiErrorBodySchema.parse(second.json());
    expect(body.error.message).toMatch(/in progress/);
    release();
    expect((await first).statusCode).toBe(201);
    const replay = await call("same");
    expect(replay.statusCode).toBe(201);
    expect(replay.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe("true");
    expect(runs()).toBe(1);
    // One audited execution; a result without a target is recorded without one.
    const audited = s.store.audit.list().filter((a) => a.action === "test.idem");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ decision: "succeeded" });
    expect(audited[0]?.target ?? null).toBeNull();
  });

  it("replays ledger records written by other code (interrupted, malformed) safely", async () => {
    const { s, call, release } = withGatedRoute();
    release();
    const request = { params: {}, body: null };
    const record = (key: string) => {
      const begun = s.store.commands.begin(key, "test.idem", request);
      if (!("fresh" in begun)) throw new Error("expected a fresh command");
      return begun.fresh.id;
    };
    // An error record with a code and no message or details.
    s.store.commands.fail(record("bare"), { code: "conflict" });
    const bare = await call("bare");
    expect(bare.statusCode).toBe(409);
    expect(bare.json()).toEqual({ error: { code: "conflict", message: "conflict" } });
    // An error record with extra fields: they come back as details.
    s.store.commands.fail(record("detailed"), { code: "not_found", message: "gone", taskId: "t" });
    const detailed = await call("detailed");
    expect(detailed.statusCode).toBe(404);
    expect(detailed.json()).toEqual({
      error: { code: "not_found", message: "gone", details: { taskId: "t" } },
    });
    // Unreadable records are never replayed as success: they answer 409.
    s.store.commands.fail(record("unknown-code"), { code: "no_such_code" });
    expect((await call("unknown-code")).statusCode).toBe(409);
    s.store.commands.succeed(record("not-object"), "just a string");
    expect((await call("not-object")).statusCode).toBe(409);
  });

  const reply = () => {
    const sent: { status?: number; body?: unknown } = {};
    const r = {
      code(status: number) {
        sent.status = status;
        return r;
      },
      header() {
        return r;
      },
      send(body: unknown) {
        sent.body = body;
        return r;
      },
    };
    return { r: r as unknown as FastifyReply, sent };
  };

  it("refuses a request without a key even when called outside the guarded server", async () => {
    const s = makeServer();
    servers.push(s);
    const handler = idempotent(s.app.mimir, "test.unguarded", () => ({ status: 200, body: {} }));
    const err = await handler({ headers: {} } as FastifyRequest, reply().r).catch((e) => e);
    expect(isMimirError(err) && err.code).toBe("validation_failed");
    const blank = await handler(
      { headers: { "idempotency-key": "   " } } as unknown as FastifyRequest,
      reply().r,
    ).catch((e) => e);
    expect(isMimirError(blank) && blank.code).toBe("validation_failed");
  });

  it("uses the first of repeated key headers and records missing params/body as empty", async () => {
    const s = makeServer();
    servers.push(s);
    const handler = idempotent(s.app.mimir, "test.array", () => ({ status: 200, body: { n: 1 } }));
    const req = {
      headers: { "idempotency-key": [" first ", "second"] },
    } as unknown as FastifyRequest;
    const { r, sent } = reply();
    await handler(req, r);
    expect(sent).toEqual({ status: 200, body: { n: 1 } });
    const rec = s.store.commands.getByKey("first");
    expect(rec?.kind).toBe("test.array");
    expect(s.store.commands.getByKey("second")).toBeUndefined();
  });
});
