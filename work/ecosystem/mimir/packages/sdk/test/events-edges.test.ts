import { MimirError, type EventEnvelope } from "@mimir/protocol";
import { fakeMimirServer, type FakeMimirServer } from "@mimir/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMimirClient,
  type FetchLike,
  type GapInfo,
  type ReconnectInfo,
} from "../src/index.js";

let server: FakeMimirServer;
beforeEach(async () => {
  server = await fakeMimirServer();
});
afterEach(async () => {
  await server.close();
});

const sse = (body: string): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
const iter = <T>(s: AsyncIterable<T>) => s[Symbol.asyncIterator]();
const block = (cursor: string, e: EventEnvelope) =>
  `id: ${cursor}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** A client whose fetch answers each stream request with the next scripted step. */
function scripted(steps: (() => Promise<Response>)[]) {
  let i = 0;
  const fetch: FetchLike = async () => {
    const step = steps[Math.min(i++, steps.length - 1)] as () => Promise<Response>;
    return step();
  };
  return createMimirClient({ baseUrl: "http://mimir.test", fetch });
}

describe("events.stream edge cases", () => {
  it("throws MimirError on an invalid envelope when no onInvalidEvent is given", async () => {
    const client = scripted([async () => sse(`id: MQ==\nevent: x\ndata: {"id":"evt_bogus"}\n\n`)]);
    const it = client.events.stream({ cursor: "MA==" })[Symbol.asyncIterator]();
    const e = await it.next().catch((c: unknown) => c);
    expect(e).toBeInstanceOf(MimirError);
    expect((e as MimirError).code).toBe("validation_failed");
  });

  it("reconnects after a failed fetch and passes non-JSON gap data through as text", async () => {
    const a = server.appendEvent({ type: "mission.created" });
    const reconnects: ReconnectInfo[] = [];
    const gaps: GapInfo[] = [];
    const client = scripted([
      () => Promise.reject(new TypeError("connect ECONNREFUSED")),
      async () => sse(`event: gap\ndata: not json\n\n${block(a.cursor, a.event)}`),
    ]);
    const ac = new AbortController();
    const it = iter(
      client.events.stream({
        cursor: "MA==",
        signal: ac.signal,
        backoff: { initialMs: 1, maxMs: 2 },
        onReconnect: (r) => reconnects.push(r),
        onGap: (g) => gaps.push(g),
      }),
    );
    expect((await it.next()).value).toEqual(a.event);
    ac.abort();
    expect(reconnects).toHaveLength(1);
    expect((reconnects[0]?.error as Error).message).toBe("fetch failed");
    expect(gaps).toEqual([{ reason: "unknown", data: "not json" }]);
  });

  it("forgets the oldest ids beyond dedupeWindow, so an old event can be delivered again", async () => {
    const a = server.appendEvent({ type: "mission.created" });
    const b = server.appendEvent({ type: "mission.created" });
    const client = scripted([
      async () =>
        sse(block(a.cursor, a.event) + block(b.cursor, b.event) + block(a.cursor, a.event)),
    ]);
    const ac = new AbortController();
    const it = iter(client.events.stream({ cursor: "MA==", dedupeWindow: 1, signal: ac.signal }));
    const ids = [];
    for (let n = 0; n < 3; n++) ids.push(((await it.next()).value as EventEnvelope).id);
    ac.abort();
    expect(ids).toEqual([a.event.id, b.event.id, a.event.id]);
  });
});

describe("events.stream reconnect without a position", () => {
  it("anchors on the snapshot before reconnecting after a response without a body", async () => {
    const urls: string[] = [];
    let streams = 0;
    const client = createMimirClient({
      baseUrl: server.url,
      token: server.token,
      fetch: (input, init) => {
        const url = new URL(input);
        urls.push(url.pathname + (url.searchParams.has("cursor") ? "?cursor" : ""));
        if (url.pathname === "/v1/events/stream" && streams++ === 0) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return fetch(input, init);
      },
    });
    const ac = new AbortController();
    const reconnects: ReconnectInfo[] = [];
    const it = iter(
      client.events.stream({
        signal: ac.signal,
        idleTimeoutMs: 0,
        backoff: { initialMs: 1, maxMs: 2 },
        onReconnect: (r) => reconnects.push(r),
      }),
    );
    const next = it.next();
    const deadline = Date.now() + 10_000;
    while (streams < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    const e = server.appendEvent({ type: "mission.created" });
    expect((await next).value).toEqual(e.event);
    ac.abort();
    expect((reconnects[0]?.error as Error).message).toBe("response has no body");
    expect(urls.slice(0, 3)).toEqual([
      "/v1/events/stream",
      "/v1/snapshot",
      "/v1/events/stream?cursor",
    ]);
  });
});

describe("abort signals", () => {
  it("are passed to fetch by list, replayAll, mutations and raw reads", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client = createMimirClient({
      baseUrl: server.url,
      token: server.token,
      fetch: (input, init) => {
        signals.push(init?.signal ?? undefined);
        return fetch(input, init);
      },
    });
    const ac = new AbortController();
    await client.events.list({}, { signal: ac.signal });
    await client.events.replayAll({ signal: ac.signal });
    await client.missions.start("msn_missing" as never, {}, { signal: ac.signal }).catch(() => 0);
    await client.artifacts.content("art_missing" as never, { signal: ac.signal }).catch(() => 0);
    expect(signals.length).toBeGreaterThanOrEqual(4);
    expect(signals.every((s) => s === ac.signal)).toBe(true);
  });
});

describe("artifacts.content", () => {
  it("defaults the content type when the server sends none", async () => {
    const client = createMimirClient({
      baseUrl: "http://mimir.test",
      fetch: async () => {
        const res = new Response(new Uint8Array([1, 2]), { headers: { "x-artifact-hash": "h1" } });
        res.headers.delete("content-type");
        return res;
      },
    });
    const c = await client.artifacts.content("art_1" as never);
    expect(c).toEqual({
      bytes: new Uint8Array([1, 2]),
      contentType: "application/octet-stream",
      hash: "h1",
    });
  });
});
