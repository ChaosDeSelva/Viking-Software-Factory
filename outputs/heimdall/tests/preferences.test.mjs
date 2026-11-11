import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePreferences, attentionRecords, STAGES } from "../apps/server/preferences.mjs";
import { Store } from "../apps/server/storage.mjs";
import { isFinalExecution } from "../apps/web/src/features/profileForm.ts";

test("each preference is checked, and only known preferences are kept", () => {
  assert.deepEqual(
    validatePreferences({ theme: "light", desktopNotifications: false, stages: [...STAGES].reverse() }),
    { theme: "light", desktopNotifications: false, stages: [...STAGES].reverse() },
  );
  assert.deepEqual(validatePreferences({}), {});
  const refused = [
    [null, /must be an object/],
    [[], /must be an object/],
    ["dark", /must be an object/],
    [{ theme: "blue" }, /Invalid theme/],
    [{ desktopNotifications: "yes" }, /Invalid notification setting/],
    [{ stages: "Intake" }, /each stage exactly once/],
    [{ stages: STAGES.slice(1) }, /each stage exactly once/],
    [{ stages: [...STAGES.slice(1), STAGES[1]] }, /each stage exactly once/],
    [{ stages: [...STAGES.slice(1), "Shipping"] }, /each stage exactly once/],
    [{ graphs: null }, /Invalid graph layouts/],
    [{ graphs: [] }, /Invalid graph layouts/],
    [{ graphs: "x" }, /Invalid graph layouts/],
    [{ graphs: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ["g" + i, {}])) }, /Invalid graph layouts/],
    [{ graphs: { "bad id": {} } }, /Invalid graph$/],
    [{ graphs: { g: null } }, /Invalid graph$/],
    [{ graphs: { g: 5 } }, /Invalid graph$/],
    [{ graphs: { g: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => ["n" + i, { x: 0, y: 0 }])) } }, /Invalid graph$/],
    [{ graphs: { g: { "n/1": { x: 0, y: 0 } } } }, /Invalid node position/],
    [{ graphs: { g: { n: { x: "1", y: 0 } } } }, /Invalid node position/],
    [{ graphs: { g: { n: { x: 0, y: Infinity } } } }, /Invalid node position/],
    [{ graphs: { g: { n: { x: 100001, y: 0 } } } }, /Invalid node position/],
    [{ graphs: { g: { n: { x: 0, y: -100001 } } } }, /Invalid node position/],
    [{ layout: "grid" }, /Unknown preference/],
  ];
  for (const [value, message] of refused)
    assert.throws(() => validatePreferences(value), message, JSON.stringify(value)?.slice(0, 80));
});

test("graph positions keep only their coordinates", () => {
  assert.deepEqual(
    validatePreferences({ graphs: { "msn_1": { "tsk.a": { x: 1.5, y: -2, label: "<b>" } } } }),
    { graphs: { msn_1: { "tsk.a": { x: 1.5, y: -2 } } } },
  );
});

test("attention records cover each kind of problem and use the row's revision", () => {
  const state = {
    sources: {
      mimir: { status: "disconnected", lastSuccess: "2026-01-01" },
      sindri: { status: "disconnected" },
      other: { status: "connected" },
    },
    mimir: {
      agents: [
        { id: "a1", status: "lost", version: 3 },
        { id: "a2", status: "running" },
      ],
      tasks: [
        { id: "t1", title: "Build", status: "blocked", updatedAt: "u1" },
        { id: "t2", title: "Test", status: "running" },
      ],
      missions: [
        { id: "m1", objective: "Ship", status: "failed" },
        { id: "m2", objective: "Done", status: "completed" },
        { id: "m3", objective: "Live", status: "active" },
      ],
      approvals: [
        { id: "p1", action: "runtime.command", status: "pending" },
        { id: "p2", action: "x", status: "approved" },
      ],
    },
    sindri: {
      specs: [{ id: "s1", status: "review", version: 2 }, { id: "s2", status: "draft" }],
      plans: [{ id: "l1", status: "review" }],
      deliveries: [{ id: "d1" }],
      executions: [
        {
          execution: { id: "e1", status: "running" },
          gates: [
            { planTaskId: "build", passed: false, evaluatedAt: "g1" },
            { planTaskId: "ok", passed: true },
          ],
          tasks: [
            { planTaskId: "build", escalation: { reason: "stuck" } },
            { planTaskId: "fine" },
          ],
        },
        { execution: { id: "e2", status: "succeeded" } },
      ],
    },
  };
  const records = attentionRecords(state);
  const by = Object.fromEntries(records.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by), [
    "source:mimir",
    "source:sindri",
    "agent:a1",
    "task:t1",
    "mission:m1",
    "mission:m2",
    "approval:p1",
    "specs:s1",
    "plans:l1",
    "delivery:d1",
    "gate:e1:build",
    "escalation:e1:build",
  ]);
  assert.equal(by["source:mimir"].revision, "2026-01-01");
  assert.equal(by["source:sindri"].revision, "initial");
  assert.equal(by["agent:a1"].revision, "3");
  assert.equal(by["agent:a1"].title, "Agent a1 · lost");
  assert.equal(by["task:t1"].revision, "u1");
  assert.equal(by["task:t1"].title, "Build · blocked");
  assert.equal(by["mission:m1"].severity, "error");
  assert.equal(by["mission:m2"].severity, "success");
  assert.equal(by["approval:p1"].title, "Approval needed: runtime.command");
  assert.equal(by["approval:p1"].revision, "pending");
  assert.equal(by["specs:s1"].title, "Specification ready for review");
  assert.equal(by["plans:l1"].title, "Plan ready for review");
  assert.equal(by["delivery:d1"].revision, "1");
  assert.equal(by["gate:e1:build"].resourceId, "build");
  assert.equal(by["gate:e1:build"].revision, "g1");
  assert.equal(by["escalation:e1:build"].row.executionId, "e1");
  assert.equal(by["escalation:e1:build"].revision, JSON.stringify({ reason: "stuck" }));
  // A state with nothing loaded yet raises nothing.
  assert.deepEqual(attentionRecords({ mimir: {}, sindri: {} }), []);
});

test("an escalation on a run that has ended raises no operator-decision notification", () => {
  const run = (id, status) => ({
    execution: { id, status },
    tasks: [{ planTaskId: "build", escalation: { reason: "stuck" } }],
  });
  const ids = attentionRecords({
    mimir: {},
    sindri: {
      executions: [
        "running",
        "verified_pending_review",
        "cancelled",
        "failed",
        "delivered",
        "delivered_pending_merge",
      ].map((s) => run("e_" + s, s)),
    },
  })
    .filter((r) => r.kind === "escalation")
    .map((r) => r.id);
  // Sindri refuses to resolve these, and the attention list leaves them out too.
  assert.deepEqual(ids, ["escalation:e_running:build"]);
});

test("the server and the web app agree on which runs have ended", () => {
  const statuses = [
    "running",
    "queued",
    "verified_pending_review",
    "cancelled",
    "failed",
    "delivered",
    "delivered_pending_merge",
    "undelivered",
    undefined,
  ];
  const state = {
    mimir: {},
    sindri: {
      executions: statuses.map((s, i) => ({
        execution: { id: "e" + i, status: s },
        tasks: [{ planTaskId: "t", escalation: { reason: "stuck" } }],
      })),
    },
  };
  const raised = new Set(
    attentionRecords(state)
      .filter((r) => r.kind === "escalation")
      .map((r) => r.row.executionId),
  );
  for (const [i, s] of statuses.entries())
    assert.equal(raised.has("e" + i), !isFinalExecution(s), String(s));
});

test("a failed write leaves the event cache and the notifications as they were", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-rollback-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.event("mimir", { eventId: "a" }, "c1");
  // A cyclic event cannot be written; neither its row nor its cursor may remain.
  const cyclic = { eventId: "b" };
  cyclic.self = cyclic;
  assert.throws(() => store.event("mimir", cyclic, "c2"));
  assert.deepEqual(store.events().map((e) => e.eventId), ["a"]);
  assert.equal(store.cursor("mimir"), "c1");
  assert.equal(store.event("mimir", { eventId: "c" }), true, "the store still accepts writes");
  store.updateNotifications([{ id: "n1", revision: "1" }]);
  assert.throws(() => store.updateNotifications([{ id: "n2", revision: "1" }, cyclic]));
  assert.deepEqual(
    store.notifications().map((n) => [n.id, n.active]),
    [["n1", true]],
    "the half-written update was rolled back",
  );
});
