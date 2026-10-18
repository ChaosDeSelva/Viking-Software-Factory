import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "../apps/server/storage.mjs";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";
const dir = mkdtempSync(join(tmpdir(), "heimdall-stress-"));
let store = new Store(dir),
  app,
  source;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const start = performance.now();
  while (!fn()) {
    assert.ok(performance.now() - start < ms, "condition timed out");
    await wait(10);
  }
}
try {
  const start = performance.now();
  for (let i = 0; i < 25000; i++)
    store.event(
      "mimir",
      {
        eventId: "event-" + i,
        type: "task.output",
        taskId: "t" + (i % 1000),
        payload: { text: "test log ".repeat(30) },
      },
      String(i),
    );
  const count = store.db.prepare("SELECT count(*) n FROM events").get().n;
  assert.equal(count, 20000);
  assert.equal(store.cursor("mimir"), "24999");
  store.close();
  store = new Store(dir);
  assert.equal(store.cursor("mimir"), "24999");
  console.log(
    `PASS: 25,000 inserts, bounded 20,000 rows and restart persistence in ${Math.round(performance.now() - start)} ms.`,
  );
  store.close();
  store = null;
  source = await fixture();
  for (let i = 0; i < 1000; i++)
    source.data.tasks.push({
      ...source.data.tasks[0],
      id: "task_load_" + i,
      title: "Load task " + i,
    });
  app = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: join(dir, "live"),
      MIMIR_URL: source.url,
      MIMIR_TOKEN: "fixture-token",
    },
  });
  await until(() =>
    source.requests.some((r) => r.path?.startsWith("/v1/events/stream")),
  );
  let max = 0;
  for (let i = 0; i < 10; i++) {
    const at = performance.now();
    const e = source.emit();
    await until(() => app.store.events()[0]?.eventId === e.id);
    max = Math.max(max, performance.now() - at);
  }
  assert.ok(max < 1000);
  console.log(
    `PASS: 1,002-task snapshot; 10 live events reached the BFF cache within ${Math.ceil(max)} ms maximum.`,
  );
  for (let i = 0; i < 3; i++) {
    source.disconnect();
    await app.hub.refresh();
    assert.equal(app.hub.snapshot().sources.mimir.status, "disconnected");
    source.reconnect();
    await wait(2200);
    await app.hub.refresh();
    assert.equal(app.hub.snapshot().sources.mimir.status, "connected");
    const e = source.emit();
    await until(() => app.store.events()[0]?.eventId === e.id);
  }
  console.log(
    "PASS: three disconnect/reconnect cycles; resumed live events and reconciled snapshots. This is a short stress test, not a multi-day soak.",
  );
} finally {
  store?.close();
  await app?.close();
  await source?.close();
  rmSync(dir, { recursive: true, force: true });
}
