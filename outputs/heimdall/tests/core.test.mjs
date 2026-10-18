import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/storage.mjs";
import { sseFrames, localUrl, sanitizer } from "../apps/server/connectors.mjs";
import { commandRoute } from "../apps/server/commands.mjs";
test("SSE preserves split chunks, event IDs and multiline JSON", async () => {
  async function* body() {
    for (const t of [
      "id: c1\neve",
      'nt: task.started\ndata: {"id":\n',
      'data: "evt1"}\n\n: ping\n\n',
    ])
      yield Buffer.from(t);
  }
  const frames = [];
  for await (const f of sseFrames(body())) frames.push(f);
  assert.deepEqual(frames[0], {
    id: "c1",
    type: "task.started",
    data: { id: "evt1" },
  });
  assert.equal(frames.length, 2);
});
test("store deduplicates per source, persists separate cursors, and paginates", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-store-"));
  let s = new Store(dir);
  assert.equal(
    s.event("mimir", { eventId: "a", type: "task.started" }, "c1"),
    true,
  );
  assert.equal(s.event("mimir", { eventId: "a" }, "c1"), false);
  s.event("sindri:exec1", { eventId: "a" }, "s1");
  s.close();
  s = new Store(dir);
  assert.equal(s.events().length, 2);
  assert.equal(s.cursor("mimir"), "c1");
  assert.equal(s.cursor("sindri:exec1"), "s1");
  assert.equal(s.events({ limit: -1 }).length, 1);
  const top = s.events({ limit: 1 })[0];
  assert.equal(s.events({ before: top.cacheSequence }).length, 1);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
test("connections reject remote URLs, credentials, paths and protocols", () => {
  for (const u of [
    "https://example.com",
    "http://127.0.0.1.evil",
    "http://user:pw@127.0.0.1",
    "file:///tmp/a",
    "http://127.0.0.1/path",
  ])
    assert.throws(() => localUrl(u));
  assert.equal(localUrl("http://127.0.0.1:7700"), "http://127.0.0.1:7700");
});
test("secrets are removed from values and sensitive fields", () => {
  assert.deepEqual(
    sanitizer(["actualsecret"])({
      token: "abc",
      output: "prefix actualsecret suffix",
      nested: { approvalSecret: "xyz" },
    }),
    {
      token: "[redacted]",
      output: "prefix [redacted] suffix",
      nested: { approvalSecret: "[redacted]" },
    },
  );
});
test("commands are allowlisted and cannot redirect to arbitrary APIs", () => {
  assert.equal(
    commandRoute({ action: "mission.pause", id: "msn_abc" }).path,
    "/v1/missions/msn_abc/pause",
  );
  assert.throws(() => commandRoute({ action: "mission.delete", id: "abc" }));
  assert.throws(() =>
    commandRoute({ action: "mission.pause", id: "../settings" }),
  );
  assert.throws(() =>
    commandRoute({
      action: "session.stop",
      id: "ses_1",
      body: { mode: "force" },
    }),
  );
});

test("preferences validate layouts and notification revisions survive restart", async () => {
  const { validatePreferences, STAGES } =
    await import("../apps/server/preferences.mjs");
  assert.throws(() => validatePreferences({ stages: ["Intake"] }));
  assert.throws(() =>
    validatePreferences({ graphs: { m: { t: { x: Infinity, y: 0 } } } }),
  );
  const dir = mkdtempSync(join(tmpdir(), "heimdall-prefs-"));
  let store = new Store(dir);
  try {
    store.savePreferences(
      validatePreferences({
        stages: [...STAGES].reverse(),
        graphs: { m: { t: { x: 42, y: 88 } } },
      }),
    );
    const n = { id: "task:1", revision: "1", title: "Blocked" };
    store.updateNotifications([n]);
    store.markNotification(n.id);
    store.updateNotifications([n]);
    assert.equal(store.notifications()[0].seen, true);
    store.close();
    store = new Store(dir);
    assert.equal(store.preferences().graphs.m.t.x, 42);
    store.updateNotifications([{ ...n, revision: "2" }]);
    assert.equal(store.notifications()[0].seen, false);
    store.updateNotifications([]);
    assert.equal(store.notifications()[0].active, false);
    store.event(
      "mimir",
      { eventId: "a", type: "task.completed", missionId: "m1" },
      "a",
    );
    store.event(
      "sindri:e1",
      { eventId: "a", type: "approval.pending", missionId: "m2" },
      "a",
    );
    assert.equal(
      store.events({ source: "sindri", type: "approval", missionId: "m2" })
        .length,
      1,
    );
    assert.equal(store.events({ source: "mimir", type: "approval" }).length, 0);
    store.clearSource("sindri");
    assert.equal(store.events().length, 1);
    assert.equal(store.cursor("sindri:e1"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
