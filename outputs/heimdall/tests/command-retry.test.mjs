import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { commandTimeout } from "../apps/server/commands.mjs";
import { Hub, request } from "../apps/server/connectors.mjs";
import { fixture } from "./fixture.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-retry-"));
  const source = await fixture();
  const app = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: dir,
      HEIMDALL_TOKEN: "test-token",
      MIMIR_URL: source.url,
      MIMIR_TOKEN: "fixture-token",
      SINDRI_URL: source.url,
      SINDRI_TOKEN: "fixture-token",
    },
    operatorCode: "operator-test",
    ...options,
  });
  t.after(async () => {
    await app.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let cookie = "";
  const call = (path, body, extra = {}) =>
    fetch(app.url + "/api/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-heimdall-request": "1",
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const signIn = async () => {
    cookie = (await call("login", { token: "test-token" })).headers
      .get("set-cookie")
      .split(";")[0];
  };
  const posts = (path) =>
    source.requests.filter((r) => r.method === "POST" && r.path === path).length;
  return { app, source, call, signIn, posts };
}
const pause = {
  action: "mission.pause",
  id: "msn_demo",
  reason: "Operator needs review",
  body: { expectedVersion: 1 },
};
const pausePath = "/v1/missions/msn_demo/pause";

test("long-running Sindri commands wait longer than Sindri's own 600 s limit", () => {
  for (const action of ["spec.draft", "plan.propose", "delivery.rework"])
    assert.ok(commandTimeout(action) >= 720000, action);
  for (const action of ["execution.create", "plan.revise"]) {
    assert.ok(commandTimeout(action) > 30000, action);
    assert.ok(commandTimeout(action) < commandTimeout("spec.draft"), action);
  }
  assert.equal(commandTimeout("task.verify"), 180000);
  assert.equal(commandTimeout("mission.pause"), 30000);
  assert.equal(commandTimeout("spec.approve"), 30000);
});

test("the command transport honours its own time limit and reports source errors with their code", async (t) => {
  const source = await fixture();
  t.after(() => source.close());
  const connection = { url: source.url, token: "fixture-token" };
  const post = (timeoutMs) =>
    request(connection, pausePath, { method: "POST", body: "{}", timeoutMs });
  source.intercept = async () => (await wait(400), false);
  await assert.rejects(post(100), { name: "TimeoutError" });
  assert.equal((await post(5000)).mission.id, "msn_demo");
  source.intercept = (req, res) => {
    res.writeHead(409);
    res.end('{"error":{"code":"idempotency_in_progress","message":"busy"}}');
    return true;
  };
  await assert.rejects(post(5000), {
    status: 409,
    code: "idempotency_in_progress",
    message: "busy",
  });
});

test("a timed-out command is not final: the same key is forwarded again", async (t) => {
  const { source, call, signIn, posts } = await setup(t, {
    commandTimeout: () => 300,
  });
  await signIn();
  await wait(200);
  await call("unlock", { code: "operator-test" });
  const headers = { "idempotency-key": "timeout-key-123456789" };
  let slow = true;
  source.intercept = async () => (slow && (await wait(900)), false);
  const [first, concurrent] = await Promise.all([
    call("commands", pause, headers),
    wait(100).then(() => call("commands", pause, headers)),
  ]);
  assert.equal(first.status, 504);
  const body = await first.json();
  assert.match(body.message, /may still be running/);
  assert.match(body.message, /Pipeline/);
  assert.equal(body.retryable, true);
  assert.equal(concurrent.status, 409, "one key is never in flight twice");
  assert.equal(posts(pausePath), 1);
  slow = false;
  assert.equal((await call("commands", pause, headers)).status, 200);
  assert.equal(posts(pausePath), 2, "the resend reached the source");
  assert.equal(
    source.requests.filter((r) => r.path === pausePath).at(-1).headers[
      "idempotency-key"
    ],
    "timeout-key-123456789",
  );
  assert.equal((await call("commands", pause, headers)).status, 200);
  assert.equal(posts(pausePath), 2, "a confirmed result is replayed locally");
});

test("5xx and in-progress answers are retried with the same key; a 4xx rejection stays final", async (t) => {
  const { source, call, signIn, posts } = await setup(t);
  await signIn();
  await wait(200);
  await call("unlock", { code: "operator-test" });
  const headers = { "idempotency-key": "failure-key-123456789" };
  source.intercept = (req, res) => {
    res.writeHead(500);
    res.end('{"error":{"code":"internal","message":"drafter crashed"}}');
    return true;
  };
  const failed = await call("commands", pause, headers);
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).retryable, true);
  source.intercept = (req, res) => {
    res.writeHead(409);
    res.end('{"error":{"code":"idempotency_in_progress","message":"busy"}}');
    return true;
  };
  const working = await call("commands", pause, headers);
  assert.equal(working.status, 409);
  assert.match((await working.json()).message, /still working/);
  source.intercept = null;
  assert.equal((await call("commands", pause, headers)).status, 200);
  assert.equal(posts(pausePath), 3);
  const cancel = { action: "mission.cancel", id: "msn_demo", reason: "Stop" };
  const rejected = { "idempotency-key": "rejected-key-12345678" };
  assert.equal((await call("commands", cancel, rejected)).status, 409);
  assert.equal((await call("commands", cancel, rejected)).status, 409);
  assert.equal(posts("/v1/missions/msn_demo/cancel"), 1);
});

test("Sindri refusing the approval secret clears the pairing and is not cached", async (t) => {
  const { source, call, signIn, posts } = await setup(t);
  await signIn();
  await wait(200);
  await call("unlock", { code: "operator-test" });
  await call("pair", { code: "sindri-code" });
  assert.equal((await (await call("session")).json()).pairedSindri, true);
  const approve = {
    action: "approval.decide",
    id: "apr_demo",
    reason: "Reviewed the evidence",
    body: { decision: "approved" },
  };
  const path = "/v1/executions/exe_demo/approvals/apr_demo";
  const headers = { "idempotency-key": "stale-pair-key-1234567" };
  source.intercept = (req, res) => {
    res.writeHead(403);
    res.end(
      '{"error":{"code":"approval_required","message":"approvals need a valid approval secret"}}',
    );
    return true;
  };
  const refused = await call("commands", approve, headers);
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.code, "pairing_required");
  assert.match(body.message, /Pair again/);
  assert.equal((await (await call("session")).json()).pairedSindri, false);
  source.intercept = null;
  assert.equal((await call("commands", approve, headers)).status, 403);
  assert.equal(posts(path), 1, "unpaired sessions are stopped before Sindri");
  await call("pair", { code: "sindri-code" });
  assert.equal((await call("commands", approve, headers)).status, 200);
  assert.equal(posts(path), 2);
});

test("a successful sign-in or unlock resets the failed-attempt count", async (t) => {
  const { call, signIn } = await setup(t);
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 4; i++)
      assert.equal((await call("login", { token: "wrong" })).status, 401);
    assert.equal((await call("login", { token: "test-token" })).status, 200);
  }
  await signIn();
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 4; i++)
      assert.equal((await call("unlock", { code: "wrong" })).status, 403);
    assert.equal((await call("unlock", { code: "operator-test" })).status, 200);
  }
  for (let i = 0; i < 5; i++) await call("login", { token: "wrong" });
  assert.equal((await call("login", { token: "test-token" })).status, 429);
});

test("a failing refresh releases the hub so later refreshes still run", async () => {
  let fail = true,
    notified = 0;
  const store = {
    updateNotifications() {
      if (fail) throw Error("database is locked");
    },
  };
  const hub = new Hub({}, store, () => notified++);
  await hub.refresh();
  assert.equal(hub.busy, false);
  assert.equal(hub.refreshError, "database is locked");
  assert.equal(hub.state.generatedAt, null);
  fail = false;
  await hub.refresh();
  assert.equal(hub.refreshError, null);
  assert.ok(hub.state.generatedAt);
  assert.equal(notified, 1);
  hub.stop();
});
