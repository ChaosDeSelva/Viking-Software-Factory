import { openSse, type SseConnection, type SseMessage } from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH, eventInput, makeServer, type TestServer } from "../../src/test-helpers.js";

const TOTAL = 10_000;
const BATCH = 250;

let server: TestServer | undefined;
const conns: SseConnection[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) c.close();
  await server?.close();
  server = undefined;
});

const dataFrames = (msgs: SseMessage[]) =>
  msgs.filter((m) => m.data !== undefined && m.event !== "gap");

describe("chaos: slow SSE consumer with 10k events", () => {
  it("drops only the slow client with a gap; the server stays responsive; the client replays from its cursor", async () => {
    server = makeServer({ sseMaxBufferBytes: 256 * 1024, sseDropGraceMs: 30_000 });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const store = server.store;

    const slow = await openSse(`${base}/v1/events/stream`, AUTH);
    const fast = await openSse(`${base}/v1/events/stream`, AUTH);
    conns.push(slow, fast);
    const start = await slow.next(2000); // id-only position frame
    expect(start.id).toBeDefined();
    slow.pause();

    // Probe responsiveness while 10k events are appended (in batches, yielding in between).
    const latencies: number[] = [];
    let producing = true;
    const probe = (async () => {
      while (producing) {
        const t0 = performance.now();
        const res = await fetch(`${base}/v1/health`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
        latencies.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    for (let i = 0; i < TOTAL; i += BATCH) {
      store.appendMany(
        Array.from({ length: BATCH }, (_, k) =>
          eventInput({
            streamId: `s-${(i + k) % 7}`,
            source: "chaos",
            sourceEventId: `e-${i + k}`,
            payload: { projectId: `prj_x`, objective: "x".repeat(200) },
          }),
        ),
      );
      await new Promise((r) => setImmediate(r));
    }
    producing = false;
    await probe;
    expect(latencies.length).toBeGreaterThan(0);
    expect(Math.max(...latencies)).toBeLessThan(1000);
    const authed = await fetch(`${base}/v1/events?limit=1`, { headers: AUTH });
    expect(authed.status).toBe(200);

    // The fast client got every event, in order, with no gap.
    const fastIds: string[] = [];
    while (fastIds.length < TOTAL) {
      const m = await fast.next(10_000);
      expect(m.event).not.toBe("gap");
      if (m.data !== undefined) {
        fastIds.push((JSON.parse(m.data) as { sourceEventId: string }).sourceEventId);
      }
    }
    expect(fastIds).toEqual(Array.from({ length: TOTAL }, (_, i) => `e-${i}`));

    // The slow client was cut off with a gap naming the last event it was sent.
    slow.resume();
    await slow.ended;
    const gap = slow.messages.at(-1);
    expect(gap?.event).toBe("gap");
    const info = JSON.parse(gap?.data ?? "{}") as { reason: string; lastEventId: string };
    expect(info.reason).toBe("slow_consumer");
    const delivered = dataFrames(slow.messages);
    expect(delivered.length).toBeLessThan(TOTAL);
    expect(delivered.at(-1)?.id ?? start.id).toBe(info.lastEventId);
    const got = delivered.map(
      (m) => (JSON.parse(m.data as string) as { sourceEventId: string }).sourceEventId,
    );

    // Replay from the gap cursor: the rest arrives once, in order.
    const replay = await openSse(`${base}/v1/events/stream`, {
      ...AUTH,
      "last-event-id": info.lastEventId,
    });
    conns.push(replay);
    while (got.length < TOTAL) {
      const m = await replay.next(10_000);
      expect(m.event).not.toBe("gap");
      if (m.data !== undefined) {
        got.push((JSON.parse(m.data) as { sourceEventId: string }).sourceEventId);
      }
    }
    expect(got).toEqual(Array.from({ length: TOTAL }, (_, i) => `e-${i}`));
    expect(store.subscriberCount()).toBeGreaterThanOrEqual(1);
  });
});
