import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { fixture } from "./fixture.mjs";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
test("authenticated monitoring, operator actions, CSRF, replay and source failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-api-"));
  const source = await fixture();
  const app = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: dir,
      HEIMDALL_TOKEN: "test-token",
      MIMIR_URL: source.url,
      MIMIR_TOKEN: "fixture-token",
    },
    operatorCode: "operator-test",
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
  try {
    assert.equal((await call("snapshot")).status, 401);
    const login = await call("login", { token: "test-token" });
    cookie = login.headers.get("set-cookie").split(";")[0];
    await wait(200);
    const snap = await (await call("snapshot")).json();
    assert.equal(snap.mimir.tasks.length, 2);
    assert.equal(JSON.stringify(snap).includes("fixture-token"), false);
    const cmd = {
      action: "mission.pause",
      id: "msn_demo",
      reason: "Operator needs review",
      body: { expectedVersion: 1 },
    };
    const headers = { "idempotency-key": "command-key-123456789" };
    assert.equal((await call("commands", cmd, headers)).status, 403);
    assert.equal((await call("unlock", { code: "operator-test" })).status, 200);
    assert.equal(
      (
        await call("commands", cmd, {
          ...headers,
          origin: "http://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("commands", cmd, { ...headers, "x-heimdall-request": "" }))
        .status,
      403,
    );
    assert.equal((await call("commands", cmd, headers)).status, 200);
    assert.equal(source.data.missions[0].status, "paused");
    assert.equal((await call("commands", cmd, headers)).status, 200);
    assert.equal(source.requests.filter((r) => r.method === "POST").length, 1);
    assert.equal(
      (await call("commands", { ...cmd, reason: "different" }, headers)).status,
      409,
    );
    const emitted = source.emit();
    await wait(150);
    assert.equal(app.store.events()[0].eventId, emitted.id);
    assert.equal(app.store.cursor("mimir"), "c1");
    source.disconnect();
    await app.hub.refresh();
    assert.equal(app.hub.snapshot().sources.mimir.status, "disconnected");
    assert.equal(app.hub.snapshot().mimir.tasks.length, 2);
    source.reconnect();
    await wait(2300);
    assert.ok(source.requests.some((r) => r.headers["last-event-id"] === "c1"));
    await app.hub.refresh();
    assert.equal(app.hub.snapshot().sources.mimir.status, "connected");
    assert.equal(
      (
        await call(
          "commands",
          {
            action: "mission.cancel",
            id: "msn_demo",
            reason: "Test rejection",
          },
          { "idempotency-key": "rejection-key-123456" },
        )
      ).status,
      409,
    );
  } finally {
    await app.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integrated execution approvals preserve Sindri human pairing and ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-pair-"));
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
  try {
    cookie = (await call("login", { token: "test-token" })).headers
      .get("set-cookie")
      .split(";")[0];
    await wait(200);
    await call("unlock", { code: "operator-test" });
    const command = {
      action: "approval.decide",
      id: "apr_demo",
      reason: "Reviewed the evidence",
      body: { decision: "approved" },
    };
    assert.equal(
      (
        await call("commands", command, {
          "idempotency-key": "unpaired-key-1234567",
        })
      ).status,
      403,
    );
    const pairing = await call("pair", { code: "sindri-code" });
    assert.equal(pairing.status, 200);
    assert.equal((await pairing.text()).includes("sindri-human-secret"), false);
    assert.equal(
      (
        await call("commands", command, {
          "idempotency-key": "paired-key-123456789",
        })
      ).status,
      200,
    );
    assert.equal(source.data.approvals[0].status, "approved");
    assert.equal(
      source.requests.some((r) => r.path === "/v1/approvals/apr_demo/decision"),
      false,
    );
    const request = source.requests.find(
      (r) => r.path === "/v1/executions/exe_demo/approvals/apr_demo",
    );
    assert.equal(request.headers["x-sindri-approval"], "sindri-human-secret");
  } finally {
    await app.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preferences, notifications and connection replacement are authenticated and persistent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-settings-"));
  const source = await fixture();
  let app = await startHeimdall({
    env: { HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: dir, HEIMDALL_TOKEN: "test" },
    operatorCode: "operator",
  });
  let cookie = "";
  const call = (path, b) =>
    fetch(app.url + "/api/" + path, {
      method: b ? "POST" : "GET",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-heimdall-request": "1",
        "idempotency-key": crypto.randomUUID(),
      },
      ...(b ? { body: JSON.stringify(b) } : {}),
    });
  try {
    cookie = (await call("login", { token: "test" })).headers
      .get("set-cookie")
      .split(";")[0];
    const config = {
      source: "mimir",
      url: source.url,
      token: "fixture-token",
      action: "save",
    };
    assert.equal((await call("connections", config)).status, 403);
    await call("unlock", { code: "operator" });
    assert.equal(
      (await call("connections", { ...config, url: "http://example.com" }))
        .status,
      400,
    );
    assert.equal((await call("connections", config)).status, 200);
    await wait(250);
    assert.equal((await (await call("snapshot")).json()).mimir.tasks.length, 2);
    const prefs = {
      graphs: { msn_demo: { tsk_demo: { x: 123, y: 234 } } },
      desktopNotifications: true,
    };
    assert.equal((await call("preferences", prefs)).status, 200);
    await call("notifications/read", { id: "all" });
    assert.ok(
      (await (await call("snapshot")).json()).notifications.every(
        (n) => n.seen,
      ),
    );
    const exported = await (await call("config")).text();
    assert.ok(!exported.includes("fixture-token"));
    await app.close();
    app = await startHeimdall({
      env: {
        HEIMDALL_PORT: "0",
        HEIMDALL_DATA_DIR: dir,
        HEIMDALL_TOKEN: "test",
      },
      operatorCode: "operator",
    });
    cookie = (await call("login", { token: "test" })).headers
      .get("set-cookie")
      .split(";")[0];
    await wait(200);
    assert.equal(
      (await (await call("snapshot")).json()).preferences.graphs.msn_demo
        .tsk_demo.x,
      123,
    );
    await call("unlock", { code: "operator" });
    assert.equal(
      (await call("connections", { source: "mimir", action: "disconnect" }))
        .status,
      200,
    );
    await wait(200);
    assert.equal(
      (await (await call("snapshot")).json()).sources.mimir.status,
      "not configured",
    );
  } finally {
    await app.close();
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown ignores late connector notifications and closes storage safely", async () => {
  const source = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "heimdall-shutdown-"));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const app = await startHeimdall({ env: { HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: join(dir, String(attempt)), MIMIR_URL: source.url, MIMIR_TOKEN: "fixture-token" } });
      await app.close();
      await wait(200);
    }
  } finally { await source.close(); rmSync(dir, { recursive: true, force: true }); }
});
