import { summarize, type BenchResult } from "@mimir/testing";
import { appendInBatches, mixedEvents, r3, tempFileStore, type Scenario } from "../harness.js";

const FULL_EVENTS = 100_000;
const PAGE = 500;
const EARLIEST_CALLS = 10_000;

/**
 * Scenario 3: a 100k-event file-backed log. Bulk append throughput, full `read` pagination
 * (unfiltered and filtered by stream) and the cost of `earliestCursor`, before and after pruning.
 */
export const storeScenario: Scenario = {
  name: "store",
  description: "100k events: append, read pagination throughput, earliestCursor cost",
  async run({ scale, log }) {
    const total = Math.max(1000, Math.round(FULL_EVENTS * scale));
    const { store, cleanup } = tempFileStore();
    const name = "3 store";
    try {
      const inputs = mixedEvents(total);
      log(`  store: appending ${total} events`);
      const appendMs = appendInBatches(store, inputs, 1000);

      const paginate = (filter: { streamId?: string }) => {
        const pageMs: number[] = [];
        let cursor: string | undefined;
        let events = 0;
        const t0 = performance.now();
        for (;;) {
          const p0 = performance.now();
          const page = store.read({ limit: PAGE, ...filter, ...(cursor ? { cursor } : {}) });
          pageMs.push(performance.now() - p0);
          events += page.events.length;
          if (!page.hasMore) break;
          cursor = page.lastCursor;
        }
        return { events, ms: performance.now() - t0, page: summarize(pageMs) };
      };
      const all = paginate({});
      const streamId = inputs[1]?.streamId as string;
      const one = paginate({ streamId });

      const earliest = (): number[] => {
        const out: number[] = [];
        for (let i = 0; i < EARLIEST_CALLS; i++) {
          const t0 = performance.now();
          store.earliestCursor();
          out.push((performance.now() - t0) * 1000);
        }
        return out;
      };
      const e1 = summarize(earliest());
      store.prune(store.read({ limit: Math.floor(total / 2) }).lastCursor);
      const e2 = summarize(earliest());

      const results: BenchResult[] = [
        {
          scenario: name,
          metric: "bulk append throughput",
          value: r3(total / (appendMs / 1000)),
          unit: "events/s",
          note: "batches of 1000",
        },
        {
          scenario: name,
          metric: "read pagination throughput",
          value: r3(all.events / (all.ms / 1000)),
          unit: "events/s",
          threshold: { op: ">", value: 20_000, source: "guard" },
          note: `limit ${PAGE}, ${all.events} events`,
        },
        {
          scenario: name,
          metric: "read page p95",
          value: r3(all.page.p95),
          unit: "ms",
          note: `limit ${PAGE}`,
        },
        {
          scenario: name,
          metric: "events read (all pages)",
          value: all.events,
          unit: "events",
          threshold: { op: "==", value: total, source: "guard" },
        },
        {
          scenario: name,
          metric: "stream-filtered read throughput",
          value: r3(one.events / (one.ms / 1000)),
          unit: "events/s",
          note: `${one.events} events`,
        },
        { scenario: name, metric: "earliestCursor p50", value: r3(e1.p50), unit: "us" },
        {
          scenario: name,
          metric: "earliestCursor p95",
          value: r3(e1.p95),
          unit: "us",
          threshold: { op: "<", value: 1000, source: "guard" },
        },
        {
          scenario: name,
          metric: "earliestCursor p95 after pruning half",
          value: r3(e2.p95),
          unit: "us",
          threshold: { op: "<", value: 1000, source: "guard" },
        },
      ];
      return results;
    } finally {
      cleanup();
    }
  },
};
