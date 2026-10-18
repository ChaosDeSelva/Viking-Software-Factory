import { afterEach, describe, expect, it } from "vitest";
import { MimirError, newId, type EventEnvelope } from "@mimir/protocol";
import { fakeMimirServer, type EventsPageShape, type FakeMimirServer } from "@mimir/testing";
import {
  createMimirClient,
  normalizePage,
  type FetchLike,
  type GapInfo,
  type MimirClient,
  type StreamOptions,
} from "../src/index.js";

let server: FakeMimirServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(
  shape: EventsPageShape = "nullWithLastCursor",
  fetchWrap?: (f: FetchLike) => FetchLike,
  serverOptions: { sseInitialId?: boolean } = {},
): Promise<{ s: FakeMimirServer; client: MimirClient }> {
  const s = await fakeMimirServer({ eventsPageShape: shape, ...serverOptions });
  server = s;
  const base: FetchLike = (input, init) => fetch(input, init);
  const client = createMimirClient({
    baseUrl: s.url,
    token: s.token,
    ...(fetchWrap ? { fetch: fetchWrap(base) } : {}),
  });
  return { s, client };
}

const fast: Partial<StreamOptions> = { backoff: { initialMs: 5, maxMs: 20 } };

const iter = (s: AsyncIterable<EventEnvelope>) => s[Symbol.asyncIterator]();

/** Pulls `n` events from the iterator (with a timeout so a hang fails the test). */
async function take(
  it: AsyncIterator<EventEnvelope>,
  n: number,
  ms = 5_000,
): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  const deadline = Date.now() + ms;
  while (out.length < n) {
    const next = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timeout after ${out.length}/${n}`)),
          deadline - Date.now(),
        ),
      ),
    ]);
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

describe("normalizePage", () => {
  const ev = () => [] as unknown[];
  it("treats nextCursor null as the end, with or without hasMore/lastCursor", () => {
    expect(normalizePage({ events: ev(), nextCursor: null })).toMatchObject({
      hasMore: false,
      lastCursor: null,
    });
    expect(
      normalizePage({ events: ev(), nextCursor: null, hasMore: false, lastCursor: "Mw==" }),
    ).toMatchObject({ hasMore: false, nextCursor: null, lastCursor: "Mw==" });
  });
  it("tolerates a non-null nextCursor with hasMore false", () => {
    expect(normalizePage({ events: ev(), nextCursor: "Mw==", hasMore: false })).toEqual({
      events: [],
      nextCursor: "Mw==",
      hasMore: false,
      lastCursor: "Mw==",
    });
  });
  it("validates hasMore and lastCursor with the protocol schema", () => {
    expect(() => normalizePage({ events: [], nextCursor: null, lastCursor: 5 })).toThrow(
      MimirError,
    );
    expect(() => normalizePage({ events: [], nextCursor: "Mw==", hasMore: "no" })).toThrow(
      /does not match the protocol/,
    );
  });
  it("treats a non-null nextCursor without hasMore as more to come", () => {
    expect(normalizePage({ events: ev(), nextCursor: "Mw==" }).hasMore).toBe(true);
  });
});

describe("events.list and replayAll", () => {
  it.each<EventsPageShape>(["hasMore", "legacy", "nullWithLastCursor"])(
    "replayAll pages to the end with default limit 200 (%s)",
    async (shape) => {
      const { s, client } = await setup(shape);
      for (let i = 0; i < 450; i++) s.appendEvent({ type: "mission.created" });
      const pages: number[] = [];
      const result = await client.events.replayAll({ onPage: (p) => pages.push(p.events.length) });
      expect(pages).toEqual([200, 200, 50]);
      expect(result.events.map((e) => e.id)).toEqual(s.events().map((e) => e.event.id));
      const limits = s.requests
        .filter((r) => r.url.startsWith("/v1/events"))
        .map((r) => new URL(r.url, s.url).searchParams.get("limit"));
      expect(limits).toEqual(["200", "200", "200"]);
      // Never a stale position: lastCursor, a non-null nextCursor, or (legacy) snapshot().cursor.
      expect(result.cursor).toBe(s.latestCursor());
      const snapshots = s.requests.filter((r) => r.url === "/v1/snapshot").length;
      expect(snapshots).toBe(shape === "legacy" ? 1 : 0);
    },
  );

  it.each<EventsPageShape>(["hasMore", "legacy", "nullWithLastCursor"])(
    "replayAll on a single short page returns a usable, non-null cursor (%s)",
    async (shape) => {
      const { s, client } = await setup(shape);
      for (let i = 0; i < 3; i++) s.appendEvent({ type: "mission.created" });
      const r = await client.events.replayAll();
      expect(r.events).toHaveLength(3);
      expect(r.cursor).toBe(s.latestCursor());
      const empty = await client.events.replayAll({ from: r.cursor! });
      expect(empty).toEqual({ events: [], cursor: s.latestCursor() });
    },
  );

  it("replayAll then stream loses nothing appended in between", async () => {
    const { s, client } = await setup();
    s.appendEvent({ type: "mission.created" });
    const r = await client.events.replayAll();
    const between = s.appendEvent({ type: "mission.started" });
    const ac = new AbortController();
    const it = iter(client.events.stream({ cursor: r.cursor!, signal: ac.signal }));
    expect((await take(it, 1))[0]!.id).toBe(between.event.id);
    ac.abort();
  });

  it("replayAll stops when a page does not advance, even if it has events", async () => {
    const { s, client } = await setup("hasMore", (f) => async (input, init) => {
      const res = await f(input, init);
      if (new URL(input).pathname !== "/v1/events") return res;
      const body = (await res.json()) as Record<string, unknown>;
      return Response.json({ ...body, nextCursor: "MA==", hasMore: true });
    });
    s.appendEvent({ type: "mission.created" });
    const r = await client.events.replayAll({ from: "MA==" });
    expect(r.events).toHaveLength(1);
    expect(s.requests.filter((q) => q.url.startsWith("/v1/events")).length).toBe(1);
  });

  it("replayAll resumes from `from` and returns it when nothing is new", async () => {
    const { s, client } = await setup();
    for (let i = 0; i < 3; i++) s.appendEvent({ type: "mission.created" });
    const mid = s.events()[0]!.cursor;
    const r = await client.events.replayAll({ from: mid });
    expect(r.events).toHaveLength(2);
    expect(r.cursor).toBe(s.latestCursor());
    const again = await client.events.replayAll({ from: r.cursor! });
    expect(again).toEqual({ events: [], cursor: s.latestCursor() });
  });

  it("replayAll passes filters", async () => {
    const { s, client } = await setup();
    const missionId = newId("msn");
    s.appendEvent({ type: "mission.created", missionId });
    s.appendEvent({ type: "mission.created" });
    s.appendEvent({ type: "mission.started", missionId });
    const r = await client.events.replayAll({ missionId, types: ["mission.started"] });
    expect(r.events.map((e) => e.type)).toEqual(["mission.started"]);
  });

  it("replayAll surfaces cursor_expired", async () => {
    const { s, client } = await setup();
    const a = s.appendEvent({ type: "mission.created" });
    s.appendEvent({ type: "mission.created" });
    s.prune(s.latestCursor());
    await expect(client.events.replayAll({ from: a.cursor })).rejects.toMatchObject({
      code: "cursor_expired",
      status: 410,
    });
  });
});

describe("events.stream", () => {
  it("replays from a cursor then follows live events, exposing the resume cursor", async () => {
    const { s, client } = await setup();
    const a = s.appendEvent({ type: "mission.created" });
    const b = s.appendEvent({ type: "mission.created" });
    const ac = new AbortController();
    const stream = client.events.stream({ cursor: a.cursor, signal: ac.signal });
    const it = stream[Symbol.asyncIterator]();
    expect((await take(it, 1)).map((e) => e.id)).toEqual([b.event.id]);
    expect(stream.cursor).toBe(b.cursor);
    const c = s.appendEvent({ type: "mission.started" });
    expect((await take(it, 1)).map((e) => e.id)).toEqual([c.event.id]);
    expect(stream.cursor).toBe(c.cursor);
    ac.abort();
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(s.requests.at(-1)!.headers.authorization).toBe(`Bearer ${s.token}`);
  });

  it("without a cursor delivers only events appended after connecting", async () => {
    const { s, client } = await setup();
    s.appendEvent({ type: "mission.created" });
    const ac = new AbortController();
    const it = iter(client.events.stream({ signal: ac.signal }));
    const pending = take(it, 1);
    await s.waitForSseClients(1);
    const live = s.appendEvent({ type: "mission.started" });
    expect((await pending).map((e) => e.id)).toEqual([live.event.id]);
    ac.abort();
  });

  it("applies type and mission filters (sent to the server and enforced locally)", async () => {
    const { s, client } = await setup();
    const missionId = newId("msn");
    const ac = new AbortController();
    const it = iter(
      client.events.stream({
        cursor: "MA==",
        missionId,
        types: ["mission.started"],
        signal: ac.signal,
      }),
    );
    s.appendEvent({ type: "mission.started" });
    s.appendEvent({ type: "mission.created", missionId });
    const want = s.appendEvent({ type: "mission.started", missionId });
    expect((await take(it, 1)).map((e) => e.id)).toEqual([want.event.id]);
    const url = new URL(s.requests.at(-1)!.url, s.url);
    expect(url.searchParams.get("types")).toBe("mission.started");
    expect(url.searchParams.get("missionId")).toBe(missionId);
    ac.abort();
  });

  it("survives a server kill and restart on the same port with no duplicates and no gaps", async () => {
    const { s, client } = await setup();
    const reconnects: number[] = [];
    const ac = new AbortController();
    const it = iter(
      client.events.stream({
        cursor: "MA==",
        signal: ac.signal,
        ...fast,
        onReconnect: (r) => reconnects.push(r.attempt),
      }),
    );
    for (let i = 0; i < 3; i++) s.appendEvent({ type: "mission.created" });
    const before = await take(it, 3);

    await s.stop();
    for (let i = 0; i < 4; i++) s.appendEvent({ type: "mission.created" }); // while down
    await new Promise((r) => setTimeout(r, 50)); // let a few reconnects fail
    await s.start();
    const after = await take(it, 4);
    const live = s.appendEvent({ type: "mission.started" });
    const tail = await take(it, 1);
    ac.abort();

    const got = [...before, ...after, ...tail].map((e) => e.id);
    expect(got).toEqual(s.events().map((e) => e.event.id));
    expect(new Set(got).size).toBe(got.length);
    expect(tail[0]!.id).toBe(live.event.id);
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
    // The reconnect resumed from the last received cursor.
    const resumed = s.requests.filter((r) => r.url.startsWith("/v1/events/stream")).at(-1)!;
    expect(resumed.headers["last-event-id"]).toBe(s.events()[2]!.cursor);
  });

  it("de-duplicates by event id when a reconnect replays already-delivered events", async () => {
    // A proxy that forgets the resume position: every reconnect replays from the start.
    const { s, client } = await setup("hasMore", (f) => (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/v1/events/stream") {
        url.searchParams.set("cursor", "MA==");
        const headers = { ...(init?.headers as Record<string, string>) };
        delete headers["last-event-id"];
        return f(url.toString(), { ...init, headers });
      }
      return f(input, init);
    });
    const ac = new AbortController();
    const it = iter(client.events.stream({ cursor: "MA==", signal: ac.signal, ...fast }));
    for (let i = 0; i < 3; i++) s.appendEvent({ type: "mission.created" });
    const first = await take(it, 3);
    s.dropSseClients();
    const next = s.appendEvent({ type: "mission.started" });
    const second = await take(it, 1);
    ac.abort();
    expect(second.map((e) => e.id)).toEqual([next.event.id]);
    expect(first).toHaveLength(3);
  });

  it("calls onGap when the server signals a gap, then resumes", async () => {
    const { s, client } = await setup();
    const gaps: GapInfo[] = [];
    const ac = new AbortController();
    const it = iter(
      client.events.stream({
        cursor: "MA==",
        signal: ac.signal,
        onGap: (g) => gaps.push(g),
        ...fast,
      }),
    );
    const a = s.appendEvent({ type: "mission.created" });
    expect((await take(it, 1))[0]!.id).toBe(a.event.id);
    s.sendGap("slow_consumer");
    const b = s.appendEvent({ type: "mission.created" });
    expect((await take(it, 1))[0]!.id).toBe(b.event.id);
    ac.abort();
    expect(gaps).toEqual([
      {
        reason: "slow_consumer",
        lastEventId: a.cursor,
        data: { reason: "slow_consumer", lastEventId: a.cursor },
      },
    ]);
  });

  it("reports cursor_expired through onGap and throws MimirError", async () => {
    const { s, client } = await setup();
    const a = s.appendEvent({ type: "mission.created" });
    s.appendEvent({ type: "mission.created" });
    s.prune(s.latestCursor());
    const gaps: GapInfo[] = [];
    const stream = client.events.stream({ cursor: a.cursor, onGap: (g) => gaps.push(g), ...fast });
    const err: unknown = await stream[Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MimirError);
    expect(err).toMatchObject({ code: "cursor_expired" });
    expect(gaps.map((g) => g.reason)).toEqual(["cursor_expired"]);
  });

  it("does not retry an unauthorized stream", async () => {
    const { s } = await setup();
    const bad = createMimirClient({ baseUrl: s.url, token: "wrong" });
    const err: unknown = await iter(bad.events.stream(fast))
      .next()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unauthorized" });
    expect(s.requests.filter((r) => r.url.startsWith("/v1/events/stream"))).toHaveLength(1);
  });

  it("retries 5xx responses with backoff", async () => {
    let calls = 0;
    const { s, client } = await setup("hasMore", (f) => (input, init) => {
      if (new URL(input).pathname === "/v1/events/stream" && ++calls <= 2) {
        return Promise.resolve(
          Response.json({ error: { code: "runtime_unavailable", message: "x" } }, { status: 503 }),
        );
      }
      return f(input, init);
    });
    const delays: number[] = [];
    const ac = new AbortController();
    const it = iter(
      client.events.stream({
        cursor: "MA==",
        signal: ac.signal,
        backoff: { initialMs: 10, maxMs: 1000 },
        random: () => 0.999,
        onReconnect: (r) => delays.push(Math.round(r.delayMs)),
      }),
    );
    const a = s.appendEvent({ type: "mission.created" });
    expect((await take(it, 1))[0]!.id).toBe(a.event.id);
    ac.abort();
    expect(delays).toEqual([10, 20]);
  });

  it("reconnects when the connection goes idle", async () => {
    const { s, client } = await setup();
    const ac = new AbortController();
    const errors: unknown[] = [];
    const it = iter(
      client.events.stream({
        cursor: "MA==",
        signal: ac.signal,
        idleTimeoutMs: 50,
        ...fast,
        onReconnect: (r) => errors.push(r.error),
      }),
    );
    const pending = take(it, 1);
    await new Promise((r) => setTimeout(r, 150));
    s.appendEvent({ type: "mission.created" });
    expect(await pending).toHaveLength(1);
    ac.abort();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it.each([true, false])(
    "without a cursor, a drop before the first event still resumes from the start position (initial id: %s)",
    async (initialId) => {
      const { s, client } = await setup("nullWithLastCursor", undefined, {
        sseInitialId: initialId,
      });
      s.appendEvent({ type: "mission.created" }); // before connecting: not delivered
      const ac = new AbortController();
      const stream = client.events.stream({ signal: ac.signal, ...fast });
      const it = iter(stream);
      const pending = take(it, 2);
      await s.waitForSseClients(1);
      // Give the client time to read the opening block (and take a snapshot if it needs one).
      const deadline = Date.now() + 2_000;
      while (stream.cursor === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(stream.cursor).toBe(s.events()[0]!.cursor);
      await s.stop();
      const missed = s.appendEvent({ type: "mission.started" }); // while down
      await s.start();
      const live = s.appendEvent({ type: "mission.started" });
      expect((await pending).map((e) => e.id)).toEqual([missed.event.id, live.event.id]);
      ac.abort();
      const snapshots = s.requests.filter((r) => r.url === "/v1/snapshot").length;
      expect(snapshots).toBe(initialId ? 0 : 1);
    },
  );

  it("does not treat an error thrown by a callback as a network failure", async () => {
    const { s, client } = await setup();
    const reconnects: unknown[] = [];
    const stream = client.events.stream({
      cursor: "MA==",
      ...fast,
      onGap: () => {
        throw new TypeError("bug in onGap");
      },
      onReconnect: (r) => reconnects.push(r),
    });
    const it = iter(stream);
    s.appendEvent({ type: "mission.created" });
    await take(it, 1);
    s.sendGap();
    await expect(it.next()).rejects.toThrow("bug in onGap");
    expect(reconnects).toEqual([]);
  });

  it("onInvalidEvent skips an envelope that fails validation and keeps the stream alive", async () => {
    const { s } = await setup();
    const good = s.appendEvent({ type: "mission.created" });
    const body = [
      "retry: 3000\nid: MA==\n\n",
      `id: MQ==\nevent: project.created\ndata: {"id":"evt_bogus","type":"project.created"}\n\n`,
      `id: ${good.cursor}\nevent: mission.created\ndata: ${JSON.stringify(good.event)}\n\n`,
    ].join("");
    const c = createMimirClient({
      baseUrl: s.url,
      token: s.token,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const invalid: unknown[] = [];
    const stream = c.events.stream({
      cursor: "MA==",
      onInvalidEvent: (info) => invalid.push(info.id),
    });
    const it = iter(stream);
    expect((await take(it, 1))[0]!.id).toBe(good.event.id);
    expect(invalid).toEqual(["MQ=="]);
    expect(stream.cursor).toBe(good.cursor);
    await it.return?.();
  });

  it("reports connection status through onStatus", async () => {
    const { s, client } = await setup();
    const statuses: string[] = [];
    const ac = new AbortController();
    const it = iter(
      client.events.stream({
        cursor: "MA==",
        signal: ac.signal,
        ...fast,
        onStatus: (st) => statuses.push(st),
      }),
    );
    s.appendEvent({ type: "mission.created" });
    await take(it, 1);
    expect(statuses).toEqual(["connecting", "open"]);
    await s.stop();
    const deadline = Date.now() + 2_000;
    while (!statuses.includes("reconnecting") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await s.start();
    s.appendEvent({ type: "mission.created" });
    await take(it, 1);
    ac.abort();
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open", "closed"]);
  });

  it("can only be iterated once", async () => {
    const { client } = await setup();
    const stream = client.events.stream();
    stream[Symbol.asyncIterator]();
    expect(() => stream[Symbol.asyncIterator]()).toThrow(/once/);
  });
});
