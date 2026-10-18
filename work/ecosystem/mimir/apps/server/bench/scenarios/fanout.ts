import { encodeCursor, decodeCursor, openEventStore } from "@mimir/core";
import { newId, type SessionId } from "@mimir/protocol";
import {
  heapUsedBytes,
  openBenchSse,
  summarize,
  type BenchResult,
  type BenchSseClient,
} from "@mimir/testing";
import { BENCH_AUTH, outputEvent, r3, sleep, startServer, type Scenario } from "../harness.js";

const FULL_CLIENTS = 50;
const FULL_EVENTS = 10_000;
/** Producer pacing: BURST events every TICK_MS (about 10k events/s). */
const BURST = 50;
const TICK_MS = 5;
const MB = 1024 * 1024;

/**
 * Scenario 2: SSE fan-out. 50 live clients, 10k events appended at about 10k events/s. Checks no
 * client is dropped or misses an event, bounds heap growth, and checks replay-from-cursor for a
 * late joiner that connects mid-run with a Last-Event-ID a quarter of the way in (so its replay
 * overlaps live delivery and exercises the replay -> live hand-over).
 */
export const fanout: Scenario = {
  name: "fanout",
  description: "50 SSE clients x 10k events, drops, heap growth, late-joiner replay",
  async run({ scale, log }) {
    const clientCount = Math.max(2, Math.round(FULL_CLIENTS * scale));
    const total = Math.max(200, Math.round(FULL_EVENTS * scale));
    const store = openEventStore(":memory:");
    const server = await startServer(store);
    const url = `${server.url}/v1/events/stream`;
    const name = "2 fan-out";
    try {
      const sentAt = new Map<string, number>();
      const e2eMs: number[] = [];
      const appendMs: number[] = [];
      const clients: BenchSseClient[] = [];
      // The last client to subscribe is notified last: its latency is the worst case.
      for (let i = 0; i < clientCount; i++) {
        const probe = i === clientCount - 1;
        clients.push(
          await openBenchSse(
            url,
            BENCH_AUTH,
            probe
              ? (msg, at) => {
                  if (msg.data === undefined || msg.event !== "session.output") return;
                  const sent = sentAt.get((JSON.parse(msg.data) as { id: string }).id);
                  if (sent !== undefined) e2eMs.push(at - sent);
                }
              : undefined,
          ),
        );
      }
      const heapBefore = heapUsedBytes();
      let heapPeak = heapBefore;
      const sampler = setInterval(() => {
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }, 20);

      const baseSeq = decodeCursor(store.latestCursor());
      const ids: string[] = [];
      const sessions = Array.from({ length: 20 }, () => newId("ses"));
      let late: BenchSseClient | undefined;
      const lateIds: string[] = [];
      const lateFrom = Math.floor(total / 4);
      log(`  fan-out: ${clientCount} clients, ${total} events`);
      const t0 = performance.now();
      while (ids.length < total) {
        for (let b = 0; b < BURST && ids.length < total; b++) {
          const sent = performance.now();
          const event = store.append(
            outputEvent(sessions[ids.length % 20] as SessionId, ids.length),
          );
          appendMs.push(performance.now() - sent);
          sentAt.set(event.id, sent);
          ids.push(event.id);
        }
        if (late === undefined && ids.length >= total / 2) {
          late = await openBenchSse(
            url,
            { ...BENCH_AUTH, "last-event-id": encodeCursor(baseSeq + lateFrom) },
            (msg) => {
              if (msg.data !== undefined && msg.event === "session.output") {
                lateIds.push((JSON.parse(msg.data) as { id: string }).id);
              }
            },
          );
        }
        await sleep(TICK_MS);
      }
      const produceMs = performance.now() - t0;
      await Promise.allSettled(clients.map((c) => c.waitForEvents(total, 30_000)));
      const deliverMs = performance.now() - t0;
      await late?.waitForEvents(total - lateFrom, 30_000).catch(() => undefined);
      clearInterval(sampler);
      const heapAfter = heapUsedBytes();

      const minDelivered = Math.min(...clients.map((c) => c.events));
      const dropped = clients.filter((c) => c.gaps > 0 || c.errors > 0).length;
      const finalCursor = encodeCursor(baseSeq + total);
      const wrongLastId = clients.filter((c) => c.lastId !== finalCursor).length;
      const expectedLate = ids.slice(lateFrom);
      let lateMismatches = Math.abs(expectedLate.length - lateIds.length);
      for (let i = 0; i < Math.min(expectedLate.length, lateIds.length); i++) {
        if (expectedLate[i] !== lateIds[i]) lateMismatches++;
      }
      const results: BenchResult[] = [
        { scenario: name, metric: "clients", value: clientCount, unit: "clients" },
        {
          scenario: name,
          metric: "produce rate",
          value: r3(total / (produceMs / 1000)),
          unit: "events/s",
        },
        { scenario: name, metric: "all clients caught up", value: r3(deliverMs), unit: "ms" },
        {
          scenario: name,
          metric: "fan-out deliveries",
          value: r3((total * clientCount) / (deliverMs / 1000)),
          unit: "events/s",
        },
        {
          scenario: name,
          metric: "append + fan-out notify p95",
          value: r3(summarize(appendMs).p95),
          unit: "ms",
        },
        {
          scenario: name,
          metric: "SSE e2e p95 (last-notified client)",
          value: r3(summarize(e2eMs).p95),
          unit: "ms",
          threshold: { op: "<", value: 1000, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "SSE e2e p99 (last-notified client)",
          value: r3(summarize(e2eMs).p99),
          unit: "ms",
        },
        {
          scenario: name,
          metric: "clients dropped (gap/error)",
          value: dropped,
          unit: "clients",
          threshold: { op: "==", value: 0, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "events missed (worst client)",
          value: total - minDelivered,
          unit: "events",
          threshold: { op: "==", value: 0, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "clients with wrong final id",
          value: wrongLastId,
          unit: "clients",
          threshold: { op: "==", value: 0, source: "guard" },
        },
        {
          scenario: name,
          metric: "heap delta (peak)",
          value: r3((heapPeak - heapBefore) / MB),
          unit: "MB",
          threshold: { op: "<", value: 200, source: "roadmap" },
        },
        {
          scenario: name,
          metric: "heap delta (settled, after GC)",
          value: r3((heapAfter - heapBefore) / MB),
          unit: "MB",
        },
        {
          scenario: name,
          metric: "late joiner replay mismatches",
          value: lateMismatches,
          unit: "events",
          threshold: { op: "==", value: 0, source: "roadmap" },
          note: `${expectedLate.length} expected`,
        },
      ];
      for (const c of clients) c.close();
      late?.close();
      return results;
    } finally {
      await server.close();
      store.close();
    }
  },
};
