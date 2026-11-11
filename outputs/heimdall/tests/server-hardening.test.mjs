import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeimdall } from "../apps/server/main.mjs";
import { Store } from "../apps/server/storage.mjs";
import { setup, until, wait } from "./support.mjs";

const pause = {
  action: "mission.pause",
  id: "msn_demo",
  reason: "Operator needs review",
  body: { expectedVersion: 1 },
};

test("an empty access token or operator code in the environment never opens the door", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-empty-"));
  const app = await startHeimdall({
    env: { HEIMDALL_PORT: "0", HEIMDALL_DATA_DIR: dir, HEIMDALL_TOKEN: "" },
    operatorCode: "",
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (path, body, cookie = "") =>
    fetch(app.url + "/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-heimdall-request": "1", cookie },
      body: JSON.stringify(body),
    });
  assert.ok(app.token.length >= 16, "a random token replaces the empty one");
  assert.ok(app.operatorCode.length >= 8);
  assert.equal((await post("login", {})).status, 401);
  assert.equal((await post("login", { token: "" })).status, 401);
  const signedIn = await post("login", { token: app.token });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get("set-cookie").split(";")[0];
  assert.equal((await post("unlock", {}, cookie)).status, 403);
  assert.equal((await post("unlock", { code: "" }, cookie)).status, 403);
});

test("a token that is not text is a failed attempt, not a server error", async (t) => {
  const { call } = await setup(t, { sources: [] });
  for (const token of [123, ["test-token"], { a: 1 }, null]) {
    const answer = await call("login", { token });
    assert.equal(answer.status, 401);
    assert.equal((await answer.json()).message, "Invalid access token");
  }
  assert.equal((await call("login", { token: true })).status, 401);
  assert.equal((await call("login", { token: "test-token" })).status, 429, "five failures lock sign-in");
});

test("a request body that is not a JSON object is refused with a clear message", async (t) => {
  const { call, operator, key } = await setup(t, { sources: ["mimir"] });
  for (const text of ["null", "7", '"text"']) {
    const answer = await call("login", text);
    assert.equal(answer.status, 400);
    assert.equal((await answer.json()).message, "The request body must be a JSON object");
  }
  await operator();
  const answer = await call("commands", "null", key());
  assert.equal(answer.status, 400);
  assert.equal((await answer.json()).message, "The request body must be a JSON object");
});

test("a command that fails before it is sent does not leave its key in flight", async (t) => {
  const { app, call, operator, posts } = await setup(t);
  await operator();
  const headers = { "idempotency-key": "stuck-key-1234567890" };
  const audit = app.store.audit.bind(app.store);
  let fail = true;
  app.store.audit = (entry) => {
    if (fail && entry.outcome === "requested") throw Error("database is locked");
    audit(entry);
  };
  const first = await call("commands", pause, headers);
  assert.ok(first.status >= 400);
  assert.equal(posts("/v1/missions/msn_demo/pause"), 0);
  fail = false;
  const second = await call("commands", pause, headers);
  assert.equal(second.status, 200, "the same key can be sent again");
  assert.equal(posts("/v1/missions/msn_demo/pause"), 1);
});

test("Heimdall's own pairing refusal tells the browser that pairing is needed", async (t) => {
  const { source, call, operator, key } = await setup(t);
  await operator();
  assert.equal((await (await call("session")).json()).pairedSindri, true);
  // Saving a connection clears every pairing; the browser still believes it is paired.
  const saved = await call(
    "connections",
    { source: "mimir", url: source.url, token: "fixture-token", action: "save" },
    key(),
  );
  assert.equal(saved.status, 200);
  const refused = await call(
    "commands",
    { action: "spec.submit", id: "spc_1", reason: "Ready" },
    key(),
  );
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.code, "pairing_required");
  assert.match(body.message, /Pair with Sindri/);
});

test("static files: a directory or a missing file is not found, and nothing outside the web root is served", async (t) => {
  const web = mkdtempSync(join(tmpdir(), "heimdall-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Heimdall</title>");
  writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(web, "assets", "app.css"), "body{}");
  writeFileSync(join(web, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(web, "data.bin"), "bytes");
  const { app } = await setup(t, { sources: [], webDir: web });
  t.after(() => rmSync(web, { recursive: true, force: true }));
  const get = (path, init) => fetch(app.url + path, init);
  const types = {
    "/": "text/html",
    "/index.html": "text/html",
    "/assets/app.js": "text/javascript",
    "/assets/app.css": "text/css",
    "/icon.svg": "image/svg+xml",
    "/data.bin": "application/octet-stream",
  };
  for (const [path, type] of Object.entries(types)) {
    const answer = await get(path);
    assert.equal(answer.status, 200, path);
    assert.equal(answer.headers.get("content-type"), type, path);
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
    assert.match(answer.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  }
  assert.match(await (await get("/")).text(), /<title>Heimdall/);
  const directory = await get("/assets");
  assert.equal(directory.status, 404);
  assert.deepEqual(await directory.json(), { message: "Not found" });
  assert.equal((await get("/missing.js")).status, 404);
  assert.equal((await get("/..%2f..%2fetc%2fpasswd")).status, 404);
  assert.equal((await get("/%E0%A4%A")).status, 400, "malformed escapes are a bad request");
  assert.equal((await get("/", { method: "POST" })).status, 405);
});

test("a source answering an error with a JSON null body is still reported by its status", async (t) => {
  const { source, call, operator, key } = await setup(t);
  await operator();
  source.intercept = (req, res) => {
    res.writeHead(500);
    res.end("null");
    return true;
  };
  const failed = await call("commands", pause, key());
  assert.equal(failed.status, 500);
  const body = await failed.json();
  assert.equal(body.message, "Source returned HTTP 500");
  assert.equal(body.retryable, true);
});

test("an unreachable source is a gateway error with a readable message, not a bad request", async (t) => {
  const { app, source, call, signIn } = await setup(t, { sources: ["mimir"] });
  await signIn();
  await until(() => app.hub.state.generatedAt, "the first snapshot");
  await source.close();
  const answer = await call("fleet");
  assert.equal(answer.status, 502);
  assert.match((await answer.json()).message, /Source is unreachable/);
  await app.hub.refresh();
  assert.match(app.hub.snapshot().sources.mimir.error, /Source is unreachable/);
});

test("signing out ends that session's live stream at once", async (t) => {
  const { call, signIn } = await setup(t, { sources: [] });
  await signIn();
  const stream = await call("stream");
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /^event: snapshot/);
  assert.equal((await call("logout", {})).status, 200);
  // The heartbeat that would notice is 15 s away; the stream must close without it.
  let ended = false;
  const drained = (async () => {
    while (!(await reader.read()).done);
    ended = true;
  })();
  await Promise.race([drained, wait(5000)]);
  assert.equal(ended, true);
});

test("a stream whose first snapshot cannot be built is refused as JSON and does not take the process down", async (t) => {
  const { app, call, signIn } = await setup(t, { sources: [] });
  await signIn();
  const rejections = [];
  const record = (e) => rejections.push(e);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));
  const snapshot = app.hub.snapshot.bind(app.hub);
  app.hub.snapshot = () => {
    throw Error("database is locked");
  };
  const refused = await call("stream");
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { message: "database is locked" });
  app.hub.snapshot = snapshot;
  await wait(50);
  assert.deepEqual(rejections, []);
  assert.equal((await call("snapshot")).status, 200);
});

test("the session cookie is found among other cookies and is separate per instance", async (t) => {
  const first = await setup(t, { sources: [] });
  const second = await setup(t, { sources: [] });
  const a = await first.signIn();
  // Another local application's cookie whose name merely ends the same way.
  first.setCookie("other-heimdall=bogus; " + a);
  assert.equal((await first.call("session")).status, 200);
  // Browsers do not separate cookies by port: both instances' cookies go to both.
  const b = await second.signIn();
  const jar = new Map([a, b].map((c) => [c.slice(0, c.indexOf("=")), c]));
  const sent = [...jar.values()].join("; ");
  first.setCookie(sent);
  second.setCookie(sent);
  assert.equal((await first.call("session")).status, 200, "signing in to a second instance keeps the first");
  assert.equal((await second.call("session")).status, 200);
});

test("event search treats % and _ as text", () => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-like-"));
  const store = new Store(dir);
  try {
    store.event("mimir", { eventId: "a", type: "task.output", taskId: "tsk_1", payload: { text: "100% done" } });
    store.event("mimir", { eventId: "b", type: "task.output", taskId: "tskx1", payload: { text: "1000 done" } });
    assert.deepEqual(store.events({ search: "100%" }).map((e) => e.eventId), ["a"]);
    assert.deepEqual(store.events({ search: "tsk_1" }).map((e) => e.eventId), ["a"]);
    assert.deepEqual(store.events({ taskId: "tsk_1" }).map((e) => e.eventId), ["a"]);
    assert.deepEqual(store.events({ search: "done" }).map((e) => e.eventId), ["b", "a"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a connection test fails when the origin answers but is not that source", async (t) => {
  const { createServer } = await import("node:http");
  // Another local service: it answers 200, but with a page or with the other source's data.
  let answer = "<!doctype html><title>Something else</title>";
  const other = createServer((req, res) => res.end(answer));
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => other.close(r)));
  const url = `http://127.0.0.1:${other.address().port}`;
  const { call, operator, key } = await setup(t, { sources: ["mimir"] });
  await operator();
  for (const [source, body] of [
    ["sindri", "<!doctype html>"],
    ["mimir", "<!doctype html>"],
    ["sindri", '{"missions":[]}'],
    ["mimir", '{"projects":[]}'],
  ]) {
    answer = body;
    const tested = await call("connections", { source, url, token: "t", action: "save" }, key());
    assert.equal(tested.status, 502, source + " " + body);
    assert.match((await tested.json()).message, /Connection test failed/);
  }
  const config = await (await call("config")).json();
  assert.equal(config.connections.sindri, undefined, "nothing was saved");
  assert.notEqual(config.connections.mimir.url, url);
  answer = '{"projects":[]}';
  assert.equal((await call("connections", { source: "sindri", url, token: "t", action: "test" }, key())).status, 200);
});

test("a live update whose snapshot cannot be built does not crash the process", async (t) => {
  const { app, call, signIn, key } = await setup(t, { sources: [] });
  await signIn();
  const stream = await call("stream");
  const reader = stream.body.getReader();
  await reader.read();
  const crashes = [];
  const record = (e) => crashes.push(e);
  // Without a listener an exception in a timer ends the process.
  process.on("uncaughtException", record);
  t.after(() => process.off("uncaughtException", record));
  const snapshot = app.hub.snapshot.bind(app.hub);
  let broken = true,
    attempts = 0;
  app.hub.snapshot = () => {
    if (broken && ++attempts) throw Error("database is locked");
    return snapshot();
  };
  // Marking a notification read schedules a live update to every open stream.
  assert.equal((await call("notifications/read", { id: "all" }, key())).status, 200);
  await until(() => attempts > 0, "the scheduled update");
  await wait(20);
  assert.deepEqual(crashes.map((e) => e.message), []);
  broken = false;
  assert.equal((await call("notifications/read", { id: "all" }, key())).status, 200);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /^event: snapshot/, "the next update still reaches the stream");
  await reader.cancel();
});

test("a failure while recording a rejected command still releases its key", async (t) => {
  const { app, call, operator, key } = await setup(t);
  await operator();
  const headers = key();
  const audit = app.store.audit.bind(app.store);
  app.store.audit = (entry) => {
    if (entry.outcome === "failed") throw Error("database is locked");
    audit(entry);
  };
  // The fixture refuses cancelling with a 409: a final answer.
  const cancel = { ...pause, action: "mission.cancel" };
  const first = await call("commands", cancel, headers);
  assert.equal(first.status, 400);
  assert.equal((await first.json()).message, "database is locked");
  app.store.audit = audit;
  const again = await call("commands", cancel, headers);
  assert.equal(again.status, 409, "the stored rejection answers, not 'still waiting'");
  assert.equal((await again.json()).message, "Source rejected this action");
});

test("without a data directory Heimdall keeps its state in a private .heimdall beside where it started", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-cwd-"));
  const start = process.cwd();
  process.chdir(dir);
  let app;
  try {
    app = await startHeimdall({ env: { HEIMDALL_PORT: "0", HEIMDALL_TOKEN: "test-token" } });
  } finally {
    process.chdir(start);
  }
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const state = join(dir, ".heimdall");
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(existsSync(join(state, "heimdall.sqlite")), true);
});

test("a response that fails to serialise after its headers went out drops the connection, not the server", async (t) => {
  const { app, call, signIn } = await setup(t, { sources: [] });
  await signIn();
  const rejections = [];
  const record = (e) => rejections.push(e);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));
  const snapshot = app.hub.snapshot.bind(app.hub);
  // JSON.stringify runs after writeHead, and a BigInt cannot be serialised.
  app.hub.snapshot = () => ({ count: 1n });
  await assert.rejects(call("snapshot"));
  app.hub.snapshot = snapshot;
  await wait(50);
  assert.deepEqual(rejections, []);
  assert.equal((await call("snapshot")).status, 200);
});

test("a thrown value that is not an Error is answered with its text", async (t) => {
  const { app, call, signIn } = await setup(t, { sources: [] });
  await signIn();
  app.hub.snapshot = () => {
    throw "database is locked";
  };
  const answer = await call("snapshot");
  assert.equal(answer.status, 400);
  assert.deepEqual(await answer.json(), { message: "database is locked" });
});
