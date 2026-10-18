// worker_threads entry: opens its own connection on the shared DB file (bypassing the
// single-writer lock on purpose) and appends `count` events round-robin over `streams`.
import { register } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
register("./ts-hooks.mjs", import.meta.url);
const { EventStore } = await import("../event-store.ts");
const { openDatabase } = await import("../db.ts");

const { path, count, streams, worker, startAt } = workerData;
const store = new EventStore(openDatabase(path), undefined);
while (Date.now() < startAt) {
  // spin so both workers start appending at the same instant
}
const now = new Date().toISOString();
for (let i = 0; i < count; i++) {
  store.append({
    streamId: streams[i % streams.length],
    occurredAt: now,
    observedAt: now,
    type: "task.created",
    source: `worker-${worker}`,
    provenance: "observed",
    payload: { worker, i },
  });
}
store.close();
parentPort.postMessage("done");
