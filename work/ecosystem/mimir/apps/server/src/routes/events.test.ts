import type { AddressInfo } from "node:net";
import { encodeCursor } from "@mimir/core";
import { openSse, type SseConnection } from "@mimir/testing";
import {
  ApiErrorBodySchema,
  ListEventsResponseSchema,
  MimirError,
  newId,
  type EventEnvelope,
} from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH, TOKEN, eventInput, makeServer, type TestServer } from "../test-helpers.js";

const servers: TestServer[] = [];
const conns: SseConnection[] = [];
const track = (s: TestServer) => (servers.push(s), s);
afterEach(async () => {
  for (const c of conns.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

const list = (s: TestServer, query: string) =>
  s.app.inject({ method: "GET", url: `/v1/events${query}`, headers: AUTH });

describe("GET /v1/events", () => {
  it("paginates with nextCursor and ends with nextCursor null plus lastCursor", async () => {
    const s = track(makeServer());
    const appended = [1, 2, 3, 4, 5].map(() => s.store.append(eventInput()));
    const seen: EventEnvelope[] = [];
    const pages: {
      nextCursor: string | null;
      hasMore?: boolean | undefined;
      lastCursor?: string | undefined;
    }[] = [];
    let cursor: string | null = null;
    do {
      const res = await list(s, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.statusCode).toBe(200);
      const page = ListEventsResponseSchema.parse(res.json());
      seen.push(...page.events);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(pages.map((p) => [p.nextCursor, p.hasMore, p.lastCursor])).toEqual([
      [encodeCursor(2), true, encodeCursor(2)],
      [encodeCursor(4), true, encodeCursor(4)],
      [null, false, encodeCursor(5)],
    ]);
    expect(seen.map((e) => e.id)).toEqual(appended.map((e) => e.id));
    // A poller resumes from lastCursor and sees only newer events.
    const newer = s.store.append(eventInput());
    const resumed = await list(s, `?cursor=${encodeURIComponent(encodeCursor(5))}`);
    expect(resumed.json()).toMatchObject({
      events: [{ id: newer.id }],
      nextCursor: null,
      hasMore: false,
      lastCursor: encodeCursor(6),
    });
  });

  it("filters by types (comma-separated)", async () => {
    const s = track(makeServer());
    s.store.append(eventInput());
    const out = s.store.append(
      eventInput({ type: "session.lost", payload: { reason: "x" }, missionId: undefined }),
    );
    const res = await list(s, "?types=session.lost,approval.expired");
    expect(ListEventsResponseSchema.parse(res.json()).events.map((e) => e.id)).toEqual([out.id]);
  });

  it("rejects an invalid limit or type with 422 and a malformed cursor with 422", async () => {
    const s = track(makeServer());
    for (const q of ["?limit=0", "?limit=abc", "?types=bogus", "?cursor=%25%25"]) {
      const res = await list(s, q);
      expect(res.statusCode, q).toBe(422);
      expect(ApiErrorBodySchema.parse(res.json()).error.code).toBe("validation_failed");
    }
  });

  it("returns 410 cursor_expired below the retained minimum or beyond the newest event", async () => {
    const s = track(makeServer());
    [1, 2, 3].forEach(() => s.store.append(eventInput()));
    s.store.prune(encodeCursor(2));
    // Cursor 2 still works (event 3 is retained); cursor 1 would skip deleted event 2.
    expect((await list(s, `?cursor=${encodeCursor(2)}`)).statusCode).toBe(200);
    for (const c of [encodeCursor(1), encodeCursor(0), encodeCursor(99)]) {
      const res = await list(s, `?cursor=${encodeURIComponent(c)}`);
      expect(res.statusCode).toBe(410);
      const body = ApiErrorBodySchema.parse(res.json());
      expect(body.error.code).toBe("cursor_expired");
      expect(body.error.details).toMatchObject({ cursor: c, latestCursor: encodeCursor(3) });
    }
  });

  it("accepts the empty-store cursor", async () => {
    const s = track(makeServer());
    const res = await list(s, `?cursor=${encodeCursor(0)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      events: [],
      nextCursor: null,
      hasMore: false,
      lastCursor: encodeCursor(0),
    });
  });
});

async function listen(s: TestServer): Promise<string> {
  await s.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = s.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function sse(url: string, headers: Record<string, string> = AUTH): Promise<SseConnection> {
  const c = await openSse(url, headers);
  conns.push(c);
  return c;
}

describe("GET /v1/events/stream (SSE)", () => {
  it("requires the bearer token", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    const c = await sse(`${base}/v1/events/stream`, {});
    expect(c.status).toBe(401);
  });

  it("replays from Last-Event-ID then streams live events with no duplicate and no gap", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    const stored = [1, 2, 3].map(() => s.store.append(eventInput()));
    const c = await sse(`${base}/v1/events/stream`, {
      ...AUTH,
      "last-event-id": encodeCursor(1),
    });
    expect(c.status).toBe(200);
    expect(c.headers["content-type"]).toMatch(/text\/event-stream/);
    const replayed = [await c.next(), await c.next()];
    const live = s.store.append(eventInput({ type: "session.lost", payload: { reason: "r" } }));
    const next = await c.next();
    const all = [...replayed, next];
    expect(all.map((m) => m.id)).toEqual([encodeCursor(2), encodeCursor(3), encodeCursor(4)]);
    expect(all.map((m) => m.event)).toEqual(["mission.created", "mission.created", "session.lost"]);
    expect(all.map((m) => (JSON.parse(m.data as string) as EventEnvelope).id)).toEqual([
      stored[1]?.id,
      stored[2]?.id,
      live.id,
    ]);
    await expect(c.next(100)).rejects.toThrow(/no SSE message/);
  });

  it("has no duplicate or gap when live events arrive while a paced replay is in flight", async () => {
    const s = track(makeServer({ sseMaxBufferBytes: 64 * 1024 * 1024, sseReplayPageSize: 10 }));
    const base = await listen(s);
    const big = "y".repeat(100_000);
    const lost = () => eventInput({ type: "session.lost", payload: { reason: big } });
    for (let i = 0; i < 300; i++) s.store.append(lost());
    const c = await sse(`${base}/v1/events/stream?cursor=${encodeCursor(0)}`);
    c.pause(); // the replay now waits for 'drain' part-way through
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 20; i++) s.store.append(lost());
    c.resume();
    const ids: string[] = [];
    for (let i = 0; i < 320; i++) ids.push((await c.next(5000)).id as string);
    expect(ids).toEqual(Array.from({ length: 320 }, (_, i) => encodeCursor(i + 1)));
    await expect(c.next(100)).rejects.toThrow(/no SSE message/);
  });

  it("honours ?cursor= and, without a cursor, streams only new events", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    s.store.append(eventInput());
    const fromCursor = await sse(`${base}/v1/events/stream?cursor=${encodeCursor(0)}`);
    expect((await fromCursor.next()).id).toBe(encodeCursor(1));
    const liveOnly = await sse(`${base}/v1/events/stream`);
    expect(await liveOnly.next()).toEqual({ id: encodeCursor(1) }); // initial position frame
    s.store.append(eventInput());
    expect((await liveOnly.next()).id).toBe(encodeCursor(2));
    expect((await fromCursor.next()).id).toBe(encodeCursor(2));
  });

  it("sends an id-only frame with the latest cursor on connect when no cursor was given", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    [1, 2].forEach(() => s.store.append(eventInput()));
    const c = await sse(`${base}/v1/events/stream`);
    const first = await c.next();
    expect(first).toEqual({ id: encodeCursor(2) }); // no event, no data: only sets Last-Event-ID
    c.close();
    // An event appended while disconnected is not lost: resuming from that id replays it.
    const missed = s.store.append(eventInput());
    const again = await sse(`${base}/v1/events/stream`, {
      ...AUTH,
      "last-event-id": first.id as string,
    });
    const next = await again.next();
    expect(next.id).toBe(encodeCursor(3));
    expect((JSON.parse(next.data as string) as EventEnvelope).id).toBe(missed.id);
  });

  it("sends no position frame when resuming from a cursor", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    s.store.append(eventInput());
    const c = await sse(`${base}/v1/events/stream?cursor=${encodeCursor(1)}`);
    await expect(c.next(100)).rejects.toThrow(/no SSE message/);
  });

  it("returns 410 for an expired cursor before opening the stream", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    const c = await sse(`${base}/v1/events/stream`, { ...AUTH, "last-event-id": encodeCursor(5) });
    expect(c.status).toBe(410);
    await c.ended;
    expect(JSON.parse(c.text())).toMatchObject({ error: { code: "cursor_expired" } });
  });

  it("sends heartbeat comments", async () => {
    const s = track(makeServer({ sseHeartbeatMs: 30 }));
    const base = await listen(s);
    const c = await sse(`${base}/v1/events/stream`);
    expect(await c.next(1000)).toEqual({ id: encodeCursor(0) });
    expect(await c.next(1000)).toEqual({ comment: "heartbeat" });
  });

  it("drops a slow consumer with a final gap event", async () => {
    const s = track(makeServer({ sseMaxBufferBytes: 64 * 1024 }));
    const base = await listen(s);
    const c = await sse(`${base}/v1/events/stream`);
    c.pause();
    const big = "x".repeat(100_000);
    for (let i = 0; i < 200; i++) {
      s.store.append(eventInput({ type: "session.lost", payload: { reason: big } }));
    }
    c.resume();
    await c.ended;
    const last = c.messages[c.messages.length - 1];
    expect(last).toMatchObject({ event: "gap" });
    expect(JSON.parse(last?.data as string)).toMatchObject({ reason: "slow_consumer" });
    expect(c.messages.length).toBeLessThan(201);
  });

  it("drops a slow consumer that never reads and destroys its socket after the grace period", async () => {
    const s = track(makeServer({ sseMaxBufferBytes: 64 * 1024, sseDropGraceMs: 100 }));
    const base = await listen(s);
    const before = s.store.subscriberCount();
    const c = await sse(`${base}/v1/events/stream`);
    c.pause();
    const big = "x".repeat(100_000);
    for (let i = 0; i < 200; i++) {
      s.store.append(eventInput({ type: "session.lost", payload: { reason: big } }));
    }
    await c.ended; // never resumed: only the server-side destroy can end it
    expect(s.store.subscriberCount()).toBe(before);
  });

  it.each([
    ["types", "types=session.lost"],
    ["missionId", "missionId=MISSION"],
    ["streamId", "streamId=wanted"],
  ])("applies the %s filter to both replay and live events", async (_name, query) => {
    const s = track(makeServer());
    const base = await listen(s);
    const missionId = newId("msn");
    const matching = () =>
      eventInput({ type: "session.lost", payload: { reason: "m" }, missionId, streamId: "wanted" });
    const other = () => eventInput({ streamId: "other" });
    s.store.append(other());
    const replayed = s.store.append(matching());
    s.store.append(other());
    const q = query.replace("MISSION", missionId);
    const c = await sse(`${base}/v1/events/stream?cursor=${encodeCursor(0)}&${q}`);
    expect(c.status).toBe(200);
    const first = await c.next();
    expect(first.id).toBe(encodeCursor(2));
    expect((JSON.parse(first.data as string) as EventEnvelope).id).toBe(replayed.id);
    s.store.append(other());
    const live = s.store.append(matching());
    const next = await c.next();
    expect(next.id).toBe(encodeCursor(5));
    expect((JSON.parse(next.data as string) as EventEnvelope).id).toBe(live.id);
    await expect(c.next(100)).rejects.toThrow(/no SSE message/);
  });

  it("rejects invalid stream filters with 422", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    const c = await sse(`${base}/v1/events/stream?types=bogus`);
    expect(c.status).toBe(422);
  });

  it("removes its store subscription when the client disconnects", async () => {
    const s = track(makeServer());
    const base = await listen(s);
    const before = s.store.subscriberCount();
    const c = await sse(`${base}/v1/events/stream`);
    await waitFor(() => s.store.subscriberCount() === before + 1);
    c.close();
    await waitFor(() => s.store.subscriberCount() === before);
  });

  it("closes the stream and cleans up when replay throws after the headers were sent", async () => {
    const s = track(makeServer({ sseHeartbeatMs: 20 }));
    const base = await listen(s);
    s.store.append(eventInput());
    const before = s.store.subscriberCount();
    const spy = vi.spyOn(s.store, "read").mockImplementationOnce(() => {
      throw new MimirError("cursor_expired", "pruned during replay");
    });
    const c = await sse(`${base}/v1/events/stream?cursor=${encodeCursor(0)}`);
    expect(c.status).toBe(200);
    await c.ended;
    expect(c.messages.at(-1)).toMatchObject({ event: "error" });
    expect(JSON.parse(c.messages.at(-1)?.data as string)).toMatchObject({ code: "cursor_expired" });
    expect(s.store.subscriberCount()).toBe(before);
    // No heartbeat timer keeps writing: nothing arrives after the end.
    const count = c.messages.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(c.messages.length).toBe(count);
    spy.mockRestore();
  });

  it("ends open streams when the server closes", async () => {
    const s = makeServer();
    const base = await listen(s);
    const c = await sse(`${base}/v1/events/stream`);
    await s.close();
    await c.ended;
    expect(TOKEN).toBeTruthy();
  });
});
