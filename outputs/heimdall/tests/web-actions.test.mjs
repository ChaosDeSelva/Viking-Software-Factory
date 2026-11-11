// Browser-side actions whose outcome depends on a save or a poll answer, without React.
import test from "node:test";
import assert from "node:assert/strict";
import { changeArchive } from "../apps/web/src/features/projectArchive.ts";
import { toggleDesktopAlerts } from "../apps/web/src/features/alerts.ts";
import { poller } from "../apps/web/src/features/poll.ts";

const project = { id: "p1", name: "demo-app", repoPath: "/repos/demo-app" };
function archiveContext(saved) {
  const calls = { saved: [], selectAll: 0, done: [] };
  return {
    calls,
    ctx: {
      archived: [],
      sindriProjects: [],
      allProjects: [project],
      filter: "p1",
      save: async (value) => (calls.saved.push(value), saved),
      selectAll: () => calls.selectAll++,
      done: (message) => calls.done.push(message),
    },
  };
}

test("a failed archive save reports no success, keeps the dialog and the selection", async () => {
  for (const archive of [true, false]) {
    const { calls, ctx } = archiveContext(false);
    assert.equal(await changeArchive(project, archive, ctx), false);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.selectAll, 0);
    assert.deepEqual(calls.done, []);
  }
});

test("a saved archive reports success and leaves an archived selection", async () => {
  const { calls, ctx } = archiveContext(true);
  ctx.filter = (
    await import("../apps/web/src/features/workflowState.ts")
  ).projectKey(project);
  assert.equal(await changeArchive(project, true, ctx), true);
  assert.deepEqual(calls.saved, [{ archivedProjects: ["p1"] }]);
  assert.equal(calls.selectAll, 1);
  assert.match(calls.done[0], /archived/);
});

test("turning desktop alerts off never needs the browser's permission", async () => {
  for (const request of [async () => "denied", null]) {
    const saved = [],
      warnings = [];
    let asked = 0;
    await toggleDesktopAlerts(
      true,
      request && (() => (asked++, request())),
      async (value) => saved.push(value),
      (message) => warnings.push(message),
    );
    assert.deepEqual(saved, [{ desktopNotifications: false }]);
    assert.deepEqual(warnings, []);
    assert.equal(asked, 0);
  }
});

test("turning desktop alerts on needs a granted permission", async () => {
  const run = async (request) => {
    const saved = [],
      warnings = [];
    await toggleDesktopAlerts(
      false,
      request,
      async (v) => saved.push(v),
      (m) => warnings.push(m),
    );
    return { saved, warnings };
  };
  assert.deepEqual((await run(async () => "granted")).saved, [
    { desktopNotifications: true },
  ]);
  const denied = await run(async () => "denied");
  assert.deepEqual(denied.saved, []);
  assert.match(denied.warnings[0], /not granted/);
  const missing = await run(null);
  assert.deepEqual(missing.saved, []);
  assert.match(missing.warnings[0], /unavailable/);
});

test("a slow poll answer never overwrites a newer one, and nothing arrives after stop", async () => {
  const pending = [];
  const applied = [];
  const poll = poller(
    () => new Promise((resolve) => pending.push(resolve)),
    (value) => applied.push(value),
    () => {},
  );
  poll.tick();
  poll.tick();
  assert.equal(pending.length, 1, "no second request while one is in flight");
  pending[0]("first");
  await new Promise((r) => setImmediate(r));
  poll.tick();
  assert.equal(pending.length, 2);
  poll.stop();
  pending[1]("late");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(applied, ["first"]);
});

test("a failed poll frees the poller for the next tick", async () => {
  let calls = 0;
  const errors = [];
  const poll = poller(
    async () => {
      calls++;
      throw Error("source down");
    },
    () => {},
    (e) => errors.push(e.message),
  );
  poll.tick();
  await new Promise((r) => setImmediate(r));
  poll.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.deepEqual(errors, ["source down", "source down"]);
});
