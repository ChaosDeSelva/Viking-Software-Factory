import { openEventStore } from "@mimir/core";
import type { BenchResult } from "@mimir/testing";
import { ReadModel } from "../../src/readmodel.js";
import {
  appendInBatches,
  mixedEvents,
  r3,
  startServer,
  tempFileStore,
  timed,
  type Scenario,
} from "../harness.js";

const FULL_EVENTS = 100_000;

/**
 * Scenario 4: boot with a 100k-event log. Times reopening the store, folding the read model
 * alone, and the whole `buildServer` boot (read model fold, interrupted-command recovery,
 * projects) until the server listens.
 */
export const rebuild: Scenario = {
  name: "rebuild",
  description: "read-model rebuild from 100k events at boot",
  async run({ scale, log }) {
    const total = Math.max(1000, Math.round(FULL_EVENTS * scale));
    const seed = tempFileStore();
    const path = seed.path;
    appendInBatches(seed.store, mixedEvents(total), 1000);
    seed.store.close();
    log(`  rebuild: ${total} events on disk`);
    const name = "4 rebuild";
    try {
      const open = await timed(() => openEventStore(path));
      const store = open.value;
      try {
        const fold = await timed(() => ReadModel.load(store));
        fold.value.detach();
        const boot = await timed(() => startServer(store));
        await boot.value.close();
        const results: BenchResult[] = [
          { scenario: name, metric: "store open + migrate check", value: r3(open.ms), unit: "ms" },
          {
            scenario: name,
            metric: "read-model fold",
            value: r3(fold.ms),
            unit: "ms",
            note: `${total} events`,
          },
          {
            scenario: name,
            metric: "fold throughput",
            value: r3(total / (fold.ms / 1000)),
            unit: "events/s",
          },
          {
            scenario: name,
            metric: "server boot to listening",
            value: r3(boot.ms),
            unit: "ms",
            threshold: { op: "<", value: 10_000, source: "guard" },
          },
        ];
        return results;
      } finally {
        store.close();
      }
    } finally {
      seed.cleanup();
    }
  },
};
