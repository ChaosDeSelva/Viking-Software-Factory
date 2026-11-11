// Heimdall's read routes, start-up configuration and stream lifetime.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeimdall } from "../apps/server/main.mjs";
import { send, setup, stub, until, wait } from "./support.mjs";

/** A Mimir that serves one agent with a runtime session, and whatever else the test adds. */
async function mimir(t, routes = {}) {
  return stub(t, (req, res) => {
    const path = req.url.split("?")[0];
    if (routes[path]) return routes[path](req, res);
    if (path === "/v1/snapshot")
      return send(res, 200, {
        missions: [],
        agents: [
          { id: "agt_live", status: "running", runtimeSessionId: "ses/1" },
          { id: "agt_idle", status: "idle" },
        ],
      });
    if (path === "/v1/events") return send(res, 200, { events: [], hasMore: false });
    if (path === "/v1/events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.write(": open\n\n");
    }
    send(res, 404, { error: { code: "not_found", message: "no route " + path } });
  });
}

test("agent telemetry combines session info and terminal, and reports the half that failed", async (t) => {
  const source = await mimir(t, {
    "/v1/sessions/ses%2F1": (req, res) => send(res, 200, { id: "ses/1", token: "secret" }),
    "/v1/sessions/ses%2F1/terminal": (req, res) => send(res, 503, { message: "runtime offline" }),
  });
  const { app, call, signIn } = await setup(t, { sources: [], env: { MIMIR_URL: source.url, MIMIR_TOKEN: "stub-token" } });
  await signIn();
  await until(() => app.hub.state.mimir.agents, "the snapshot");
  const answer = await call("agents/agt_live/telemetry");
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.deepEqual(body.info, { id: "ses/1", token: "[redacted]" });
  assert.equal(body.terminal, null);
  assert.deepEqual(body.errors, ["runtime offline"]);
  assert.equal(body.agent.id, "agt_live");
  assert.ok(Date.parse(body.capturedAt));
  assert.ok(source.requests.some((r) => r.path === "/v1/sessions/ses%2F1/terminal?lines=500"));
  for (const id of ["agt_idle", "agt_missing"]) {
    const missing = await call(`agents/${id}/telemetry`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).message, "Agent session is unavailable");
  }
});

test("fleet, harness and supervisor reads are relayed from Mimir and cleaned", async (t) => {
  const source = await mimir(t, {
    "/v1/fleet": (req, res) => send(res, 200, { workers: [{ id: "w1", apiKey: "k" }] }),
    "/v1/harnesses": (req, res) => send(res, 200, { harnesses: [{ name: "codex" }] }),
    "/v1/supervisors": (req, res) => send(res, 200, { supervisors: [{ id: "sup_1" }] }),
    "/v1/supervisors/sup_1": (req, res) => send(res, 200, { supervisor: { id: "sup_1", note: "Bearer abcdefghijklmnopqrstu" } }),
  });
  const { call, signIn } = await setup(t, { sources: [], env: { MIMIR_URL: source.url, MIMIR_TOKEN: "stub-token" } });
  await signIn();
  assert.deepEqual(await (await call("fleet")).json(), { workers: [{ id: "w1", apiKey: "[redacted]" }] });
  assert.deepEqual(await (await call("harnesses")).json(), { harnesses: [{ name: "codex" }] });
  assert.deepEqual(await (await call("supervisors")).json(), { supervisors: [{ id: "sup_1" }] });
  assert.deepEqual(await (await call("supervisors/sup_1")).json(), { supervisor: { id: "sup_1", note: "[redacted]" } });
  const missing = await call("supervisors/sup_2");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).message, "no route /v1/supervisors/sup_2");
  assert.equal((await call("supervisors/bad.id")).status, 404, "an ID outside the pattern is not forwarded");
  assert.ok(!source.requests.some((r) => r.path.includes("bad.id")));
});

test("Mimir reads without a Mimir connection say it is not configured", async (t) => {
  const { call, signIn } = await setup(t, { sources: [] });
  await signIn();
  for (const path of ["fleet", "harnesses", "supervisors", "supervisors/sup_1"]) {
    const answer = await call(path);
    assert.equal(answer.status, 503, path);
    assert.equal((await answer.json()).message, "Source is not configured");
  }
});

test("cached events can be filtered through the query string", async (t) => {
  const { app, call, signIn } = await setup(t, { sources: [] });
  await signIn();
  app.store.event("mimir", { eventId: "e1", type: "task.output", missionId: "m1" });
  app.store.event("sindri:exe_1", { eventId: "e2", type: "execution.started", missionId: "m2" });
  const ids = async (query) =>
    (await (await call("events" + query)).json()).events.map((e) => e.eventId);
  assert.deepEqual(await ids(""), ["e2", "e1"]);
  assert.deepEqual(await ids("?source=sindri"), ["e2"]);
  assert.deepEqual(await ids("?type=task"), ["e1"]);
  assert.deepEqual(await ids("?missionId=m2"), ["e2"]);
  assert.deepEqual(await ids("?limit=1"), ["e2"]);
  assert.deepEqual(await ids("?limit=lots"), ["e2", "e1"], "an unreadable limit is the default");
});

test("routes that need the operator say so; commands need a reason and a key", async (t) => {
  const { call, signIn, operator, key } = await setup(t);
  await signIn();
  const pair = await call("pair", { code: "sindri-code" });
  assert.equal(pair.status, 403);
  assert.equal((await pair.json()).message, "Unlock operator controls first");
  const connection = await call("connections", { source: "mimir", action: "test" }, key());
  assert.equal(connection.status, 403);
  await operator();
  const command = { action: "mission.pause", id: "msn_demo" };
  for (const reason of [undefined, "   ", "x".repeat(2001), 5]) {
    const answer = await call("commands", { ...command, reason }, key());
    assert.equal(answer.status, 422);
    assert.equal((await answer.json()).message, "An audit reason is required");
  }
  for (const headers of [{}, { "idempotency-key": "short" }, { "idempotency-key": "bad key with spaces!!" }]) {
    const answer = await call("commands", { ...command, reason: "Review" }, headers);
    assert.equal(answer.status, 422);
    assert.equal((await answer.json()).message, "An idempotency key is required");
  }
  const unknown = await call("commands", { action: "repo.delete", id: "x", reason: "No" }, key());
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).message, "Unsupported operator action");
  assert.equal((await call("nothing-here")).status, 404);
});

test("a wrong pairing code is Sindri's refusal, and without Sindri pairing is not configured", async (t) => {
  const withSindri = await setup(t);
  await withSindri.operator({ pair: false });
  const wrong = await withSindri.call("pair", { code: "guess" });
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).message, "Bad pairing code");
  assert.equal((await (await withSindri.call("session")).json()).pairedSindri, false);
  const paired = await withSindri.call("pair", { code: "sindri-code" });
  assert.equal(paired.status, 200);
  const body = await paired.json();
  assert.equal(body.paired, true);
  assert.ok(Date.parse(body.expiresAt));
  const without = await setup(t, { sources: ["mimir"] });
  await without.operator({ pair: false });
  assert.equal((await without.call("pair", { code: "sindri-code" })).status, 503);
});

test("an expired session's stream is closed by the heartbeat; a live one is kept alive", async (t) => {
  const { call, signIn } = await setup(t, { sources: [], heartbeatMs: 30 });
  await signIn();
  const stream = await call("stream");
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(": heartbeat")) text += decoder.decode((await reader.read()).value);
  // Move the clock past the twelve-hour session lifetime.
  const now = Date.now;
  t.after(() => (Date.now = now));
  Date.now = () => now() + 13 * 3600000;
  let done = false;
  while (!done) done = (await reader.read()).done;
  Date.now = now;
  assert.equal((await call("session")).status, 200, "the clock is back; the session itself was never removed");
});

test("a stream client that stops reading is dropped instead of buffering without limit", async (t) => {
  const { app, call, signIn, key } = await setup(t, { sources: [] });
  const cookie = await signIn();
  // Large cached events make every snapshot large.
  for (let i = 0; i < 4; i++)
    app.store.event("mimir", { eventId: "big" + i, payload: { text: "x".repeat(900 * 1024) } });
  let built = 0;
  const snapshot = app.hub.snapshot.bind(app.hub);
  app.hub.snapshot = () => (built++, snapshot());
  const port = new URL(app.url).port;
  const socket = connect(Number(port), "127.0.0.1");
  let closed = false,
    open = false;
  socket.on("close", () => (closed = true));
  socket.on("error", () => {});
  // Read the start of the stream, then never read while the snapshots pile up.
  socket.once("data", () => {
    socket.pause();
    open = true;
  });
  socket.write(`GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n\r\n`);
  t.after(() => socket.destroy());
  await until(() => open, "the stream to open");
  // Each broadcast queues another 3.6 MB snapshot behind the unread ones.
  for (let i = 0; i < 12; i++) {
    const before = built;
    await call("notifications/read", { id: "all" }, key());
    await until(() => built > before, "broadcast " + i);
  }
  // Reading now drains what was sent; a dropped client then sees its connection end.
  socket.on("data", () => {});
  socket.resume();
  await until(() => closed, "the slow client to be dropped");
  assert.equal((await call("snapshot")).status, 200, "other requests are unaffected");
});

test("saved connections override the environment, a saved null removes one, and token files are read", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "file-token\n");
  writeFileSync(
    join(dir, "connections.json"),
    JSON.stringify({ sindri: null, mimir: { url: "http://localhost:9/", token: 42 } }),
  );
  const app = await startHeimdall({
    env: {
      HEIMDALL_PORT: "0",
      HEIMDALL_DATA_DIR: dir,
      HEIMDALL_TOKEN: "test-token",
      MIMIR_URL: "http://127.0.0.1:7",
      MIMIR_TOKEN_FILE: tokenFile,
      SINDRI_URL: "http://127.0.0.1:8",
      SINDRI_TOKEN: "env-token",
    },
    operatorCode: "operator-test",
  });
  t.after(() => app.close());
  assert.deepEqual(Object.keys(app.hub.connections), ["mimir"]);
  assert.deepEqual(app.hub.connections.mimir, { url: "http://localhost:9", token: "42" });
  await assert.rejects(
    startHeimdall({ env: { HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: join(dir, "b"), SINDRI_URL: "http://127.0.0.1:8" } }),
    /SINDRI_TOKEN or SINDRI_TOKEN_FILE required/,
  );
  const second = await startHeimdall({
    env: { HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: join(dir, "c"), MIMIR_URL: "http://127.0.0.1:7", MIMIR_TOKEN_FILE: tokenFile },
  });
  t.after(() => second.close());
  assert.equal(second.hub.connections.mimir.token, "file-token");
  assert.equal(second.token.length, 32, "a random access token is made when none is set");
  await second.close();
  await second.close();
});

test("a port already in use is a start-up error", async (t) => {
  const { app } = await setup(t, { sources: [] });
  const dir = mkdtempSync(join(tmpdir(), "heimdall-port-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    startHeimdall({ env: { HEIMDALL_PORT: new URL(app.url).port, HEIMDALL_DATA_DIR: dir } }),
    { code: "EADDRINUSE" },
  );
});

test("HEIMDALL_WEB_DIR chooses the front end that is served", async (t) => {
  const web = mkdtempSync(join(tmpdir(), "heimdall-webdir-"));
  writeFileSync(join(web, "index.html"), "<title>From the environment</title>");
  const before = process.env.HEIMDALL_WEB_DIR;
  process.env.HEIMDALL_WEB_DIR = web;
  t.after(() => {
    if (before === undefined) delete process.env.HEIMDALL_WEB_DIR;
    else process.env.HEIMDALL_WEB_DIR = before;
    rmSync(web, { recursive: true, force: true });
  });
  const { app } = await setup(t, { sources: [] });
  assert.match(await (await fetch(app.url + "/")).text(), /From the environment/);
});

test("run directly, Heimdall prints how to sign in and stops cleanly on a signal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-cli-"));
  mkdirSync(join(dir, "data"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = fileURLToPath(new URL("../apps/server/main.mjs", import.meta.url));
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: join(dir, "data"), HEIMDALL_TOKEN: "cli-token", MIMIR_URL: "", SINDRI_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  await until(() => output.includes("Control+C"), "the start-up message");
  assert.match(output, /^Heimdall: http:\/\/127\.0\.0\.1:\d+\nAccess token: cli-token\nOperator code: [0-9a-f]{16}\n/);
  const url = /Heimdall: (\S+)/.exec(output)[1];
  assert.equal((await fetch(url + "/api/session")).status, 401);
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
});

test("only this instance's own host names are served, and oversized or empty bodies are handled", async (t) => {
  const { app, call } = await setup(t, { sources: [] });
  const port = Number(new URL(app.url).port);
  const status = (host) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/session", headers: { host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  // A rebound DNS name reaches the same socket with a foreign Host header.
  assert.equal(await status("attacker.example:" + port), 403);
  assert.equal(await status("127.0.0.1:" + (port + 1)), 403);
  assert.equal(await status("localhost:" + port), 401);
  const empty = await call("login", "");
  assert.equal(empty.status, 401, "an empty body is an empty object");
  const large = await call("login", JSON.stringify({ token: "x".repeat(600 * 1024) }));
  assert.equal(large.status, 413);
  assert.equal((await large.json()).message, "Request too large");
});

test("an artifact preview is relayed from Mimir once its hash is verified", async (t) => {
  const bytes = Buffer.from("report text");
  const hash = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const source = await mimir(t, {
    "/v1/artifacts/art_1": (req, res) => send(res, 200, { artifact: { id: "art_1", hash } }),
    "/v1/artifacts/art_1/content": (req, res) => send(res, 200, bytes, { "content-type": "text/plain" }),
  });
  const { call, signIn } = await setup(t, { sources: [], env: { MIMIR_URL: source.url, MIMIR_TOKEN: "stub-token" } });
  await signIn();
  const answer = await call("artifacts/art_1");
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.content, "report text");
  assert.equal(body.verifiedHash, hash);
  assert.equal((await call("artifacts/art_1", {})).status, 404, "only GET reads an artifact");
});

test("a connector notification after shutdown builds no snapshot from the closed store", async (t) => {
  const { app } = await setup(t, { sources: [] });
  let built = 0;
  const snapshot = app.hub.snapshot.bind(app.hub);
  app.hub.snapshot = () => (built++, snapshot());
  await app.close();
  app.hub.notify();
  await wait(300);
  assert.equal(built, 0);
});

test("an events cursor that is not a whole number is refused, not read as an empty page", async (t) => {
  const { app, call, signIn } = await setup(t, { sources: [] });
  await signIn();
  app.store.event("mimir", { eventId: "e1", type: "task.output" });
  for (const before of ["abc", "1.5", "-1", ""]) {
    const answer = await call("events?before=" + before);
    assert.equal(answer.status, 400, before);
    assert.match((await answer.json()).message, /before/);
  }
  const page = await (await call("events?before=999")).json();
  assert.deepEqual(
    page.events.map((e) => e.eventId),
    ["e1"],
  );
});

test("pairing fails when Sindri answers without an approval secret", async (t) => {
  const { source, call, operator } = await setup(t);
  await operator({ pair: false });
  source.intercept = (req, res) => {
    if (req.url !== "/v1/approval-session") return false;
    res.end(
      JSON.stringify({
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    return true;
  };
  const answer = await call("pair", { code: "sindri-code" });
  assert.equal(answer.status, 502);
  assert.match((await answer.json()).message, /approval secret/);
  assert.equal((await (await call("session")).json()).pairedSindri, false);
});

test("expired sessions are removed instead of kept for the life of the process", async (t) => {
  const { app, call, signIn, setCookie } = await setup(t, { sources: [] });
  const first = await signIn();
  await signIn();
  assert.equal(app.sessions.size, 2);
  const now = Date.now;
  t.after(() => (Date.now = now));
  Date.now = () => now() + 13 * 3600000;
  setCookie(first);
  assert.equal((await call("session")).status, 401);
  await signIn();
  Date.now = now;
  assert.equal(
    app.sessions.size,
    1,
    "both expired sessions are gone, the new one stays",
  );
  setCookie(first);
  assert.equal(
    (await call("session")).status,
    401,
    "an expired session does not come back",
  );
});
