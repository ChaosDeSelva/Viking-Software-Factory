import { MimirError, type MissionId, type SessionId, type TaskId } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMimirClient } from "./client.js";
import { Http, errorFromResponse, randomKey } from "./http.js";

/** A fetch that records each URL as the platform would resolve it and answers `body`. */
function recorder(body: unknown = { ok: true }, init: ResponseInit = { status: 200 }) {
  const seen: string[] = [];
  const fetch = vi.fn(async (input: string) => {
    seen.push(new URL(input).pathname);
    return new Response(JSON.stringify(body), init);
  });
  return { seen, fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe("request paths built from ids", () => {
  it.each([".", "..", ""])(
    "rejects id %j instead of sending the request to another route",
    async (id) => {
      const { seen, fetch } = recorder();
      const client = createMimirClient({ baseUrl: "http://mimir.test", fetch });
      const calls = [
        () => client.tasks.retry(id as TaskId),
        () => client.missions.cancel(id as MissionId),
        () => client.sessions.stop(id as SessionId, { reason: "x" } as never),
        () => client.tasks.get(id as TaskId),
        () => client.artifacts.content(id as never),
      ];
      for (const call of calls) {
        const e = await call().then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(e).toBeInstanceOf(MimirError);
        expect((e as MimirError).code).toBe("validation_failed");
      }
      expect(seen).toEqual([]);
    },
  );

  it("keeps slashes, dots and query characters inside one segment", async () => {
    const { seen, fetch } = recorder();
    const client = createMimirClient({ baseUrl: "http://mimir.test/", fetch });
    await client.tasks.retry("../approvals/apr_1?x=1#y" as TaskId).catch(() => undefined);
    await client.tasks.retry("a..b" as TaskId).catch(() => undefined);
    expect(seen).toEqual([
      "/v1/tasks/..%2Fapprovals%2Fapr_1%3Fx%3D1%23y/retry",
      "/v1/tasks/a..b/retry",
    ]);
  });
});

describe("Http", () => {
  it("joins list query values with commas and skips undefined ones", () => {
    const http = new Http({ baseUrl: "http://mimir.test//" });
    expect(http.url("/v1/x", { a: ["p", "q"], b: undefined, c: 3, d: false })).toBe(
      "http://mimir.test/v1/x?a=p%2Cq&c=3&d=false",
    );
    expect(http.url("/v1/x", {})).toBe("http://mimir.test/v1/x");
  });

  it("asks a token function for the token on every request", async () => {
    let n = 0;
    const http = new Http({ baseUrl: "http://mimir.test", token: async () => `t${++n}` });
    expect(await http.headers()).toEqual({ authorization: "Bearer t1" });
    expect(await http.headers({ a: "b" })).toEqual({ a: "b", authorization: "Bearer t2" });
    expect(await new Http({ baseUrl: "http://x" }).headers()).toEqual({});
  });

  it("uses the global fetch when none is given", async () => {
    const { seen, fetch } = recorder({ status: "ok" });
    vi.stubGlobal("fetch", fetch);
    const http = new Http({ baseUrl: "http://mimir.test" });
    const res = await http.fetch("http://mimir.test/v1/health");
    expect(await res.json()).toEqual({ status: "ok" });
    expect(seen).toEqual(["/v1/health"]);
  });

  it("turns a 2xx body that is not JSON into an internal MimirError", async () => {
    const http = new Http({ baseUrl: "http://mimir.test" });
    const e = await http.json(new Response("<html>", { status: 200 })).catch((c: unknown) => c);
    expect(e).toBeInstanceOf(MimirError);
    expect((e as MimirError).code).toBe("internal");
    expect((e as MimirError).details).toEqual({ status: 200 });
  });
});

describe("randomKey", () => {
  it("builds a v4 UUID from getRandomValues when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (b: Uint8Array) => b.fill(0xff),
    });
    expect(randomKey()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("prefers crypto.randomUUID", () => {
    expect(randomKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("errorFromResponse", () => {
  it("keeps the server's code from an ApiErrorBody", async () => {
    const e = await errorFromResponse(
      new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), {
        status: 404,
      }),
    );
    expect(e.code).toBe("not_found");
    expect(e.message).toBe("nope");
  });

  it("reports the status and at most 500 characters of any other body", async () => {
    const e = await errorFromResponse(new Response("x".repeat(600), { status: 502 }));
    expect(e.code).toBe("internal");
    expect(e.details).toEqual({ status: 502, body: "x".repeat(500) });
  });

  it("tolerates a body that cannot be read", async () => {
    const res = new Response("", { status: 500 });
    vi.spyOn(res, "text").mockRejectedValue(new Error("stream broke"));
    const e = await errorFromResponse(res);
    expect(e.details).toEqual({ status: 500, body: "" });
  });
});
