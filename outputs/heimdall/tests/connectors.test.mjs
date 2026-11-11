// The source transport and the hub, against small loopback servers that answer as each test needs.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, request, sseFrames, boundedText } from "../apps/server/connectors.mjs";
import { Store } from "../apps/server/storage.mjs";
import { send, stub, until } from "./support.mjs";

function temporaryStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "heimdall-hub-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

test("an unconfigured source is a 503 without any request", async () => {
  await assert.rejects(request(undefined, "/v1/snapshot"), { status: 503, message: "Source is not configured" });
});

test("source answers: JSON, plain text, and errors with their message, code and status", async (t) => {
  const source = await stub(t, (req, res) => {
    if (req.url === "/json") return send(res, 200, { ok: true });
    if (req.url === "/text") return send(res, 200, "plain words");
    if (req.url === "/coded")
      return send(res, 409, { error: { code: "invalid_state", message: "only drafts" } });
    if (req.url === "/flat") return send(res, 404, { message: "no such record" });
    send(res, 500, "<html>gateway broke</html>");
  });
  assert.deepEqual(await request(source.connection, "/json"), { ok: true });
  assert.deepEqual(await request(source.connection, "/text"), { message: "plain words" });
  await assert.rejects(request(source.connection, "/coded"), {
    status: 409,
    code: "invalid_state",
    message: "only drafts",
  });
  await assert.rejects(request(source.connection, "/flat"), { status: 404, message: "no such record" });
  await assert.rejects(request(source.connection, "/html"), {
    status: 500,
    message: "<html>gateway broke</html>",
  });
  const sent = source.requests[0].headers;
  assert.equal(sent.authorization, "Bearer stub-token");
  assert.equal(sent["content-type"], "application/json");
});

test("a source that redirects, stalls or is aborted is reported as such", async (t) => {
  const source = await stub(t, (req, res) => {
    if (req.url === "/redirect") return send(res, 302, "", { location: "http://127.0.0.1:1/" });
    // /stall never answers.
  });
  await assert.rejects(request(source.connection, "/redirect"), (e) => {
    assert.equal(e.status, 502);
    assert.match(e.message, /^Source is unreachable \(/);
    return true;
  });
  await assert.rejects(request(source.connection, "/stall", { signal: AbortSignal.timeout(50) }), {
    name: "TimeoutError",
    status: 504,
    message: "Source did not answer in time",
  });
  const controller = new AbortController();
  const pending = request(source.connection, "/stall", { signal: controller.signal });
  controller.abort();
  // A caller's own cancellation is not a source failure and passes through unchanged.
  await assert.rejects(pending, { name: "AbortError" });
});

test("a refused connection names the network error", async () => {
  const closed = createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((r) => closed.close(r));
  await assert.rejects(request({ url, token: "x" }, "/v1/snapshot"), {
    status: 502,
    message: "Source is unreachable (ECONNREFUSED)",
  });
  await assert.rejects(request({ url, token: "x" }, "/v1/snapshot", { timeoutMs: 5000 }), {
    code: "ECONNREFUSED",
  });
});

test("an oversized answer is refused as a gateway error on both transports", async (t) => {
  const big = Buffer.alloc(13 * 1024 * 1024, 32);
  const source = await stub(t, (req, res) => send(res, 200, big));
  await assert.rejects(request(source.connection, "/big"), {
    status: 502,
    message: "Response exceeds display limit",
  });
  await assert.rejects(request(source.connection, "/big", { timeoutMs: 20000 }), {
    status: 502,
    message: "Response exceeds display limit",
  });
});

test("the long-command transport sends method, headers and body, and reports its own time limit", async (t) => {
  const source = await stub(t, (req, res, body) => {
    if (req.url === "/stall") return;
    send(res, 201, { echoed: body ? JSON.parse(body) : null });
  });
  const answer = await request(source.connection, "/put", {
    method: "PUT",
    headers: { "idempotency-key": "k-1234567890123456" },
    body: JSON.stringify({ name: "ünïcode" }),
    timeoutMs: 5000,
  });
  assert.deepEqual(answer, { echoed: { name: "ünïcode" } });
  const seen = source.requests.at(-1);
  assert.equal(seen.method, "PUT");
  assert.equal(seen.headers["idempotency-key"], "k-1234567890123456");
  assert.equal(seen.headers["content-length"], String(Buffer.byteLength(JSON.stringify({ name: "ünïcode" }))));
  // Without a body nothing is announced, and the default method is GET.
  await request(source.connection, "/get", { timeoutMs: 5000 }).catch(() => {});
  assert.equal(source.requests.at(-1).method, "GET");
  assert.equal(source.requests.at(-1).headers["content-length"], undefined);
  await assert.rejects(request(source.connection, "/stall", { method: "POST", body: "{}", timeoutMs: 50 }), {
    name: "TimeoutError",
    message: "Source did not answer in time",
  });
});

test("a long-command answer cut off mid-body is an error, not a truncated success", async (t) => {
  const source = await stub(t, (req, res) => {
    res.writeHead(200, { "content-length": "100" });
    res.write('{"partial":');
    setImmediate(() => res.destroy());
  });
  await assert.rejects(request(source.connection, "/cut", { method: "POST", body: "{}", timeoutMs: 5000 }));
});

test("bounded reads and SSE frames stop at their limits", async () => {
  async function* chunks(...parts) {
    for (const p of parts) yield Buffer.from(p);
  }
  assert.equal(await boundedText({ body: chunks("ab", "cd") }, 4), "abcd");
  await assert.rejects(boundedText({ body: chunks("ab", "cde") }, 4), /exceeds display limit/);
  const frames = [];
  for await (const f of sseFrames(chunks("id: 7\r\nevent: gap\r\n\r\n", ": comment only\n\n"))) frames.push(f);
  assert.deepEqual(frames, [{ id: "7", type: "gap" }, {}]);
  await assert.rejects(async () => {
    for await (const f of sseFrames(chunks("data: " + "x".repeat(4 * 1024 * 1024 + 1)))) void f;
  }, /Event exceeds display limit/);
});

test("Mimir history is replayed page by page from the saved cursor, cleaned and stored", async (t) => {
  const store = temporaryStore(t);
  store.setCursor("mimir", "c 0");
  const pages = {
    "c 0": { events: [{ id: "e1", sequence: 1, streamId: "s", occurredAt: "t1", type: "task.output", missionId: "m", taskId: "tk", payload: { text: "token stub-token" } }], hasMore: true, lastCursor: "c1" },
    c1: { events: [{ id: "e2", sequence: 2, type: "task.done" }], hasMore: false },
  };
  const source = await stub(t, (req, res) => {
    const cursor = new URL(req.url, source.url).searchParams.get("cursor");
    send(res, 200, pages[cursor]);
  });
  let notified = 0;
  const hub = new Hub({ mimir: source.connection }, store, () => notified++);
  t.after(() => hub.stop());
  hub.state.sources.mimir = {};
  await hub.replayMimir();
  assert.deepEqual(
    source.requests.map((r) => r.path),
    ["/v1/events?limit=500&cursor=c%200", "/v1/events?limit=500&cursor=c1"],
  );
  const events = store.events();
  assert.deepEqual(events.map((e) => e.eventId), ["e2", "e1"]);
  assert.equal(events[1].payload.text, "token [redacted]");
  assert.equal(events[1].sourceSequence, 1);
  assert.equal(store.cursor("mimir"), "c1", "a page without a cursor keeps the last one");
  assert.equal(notified, 1);
  assert.equal(hub.state.sources.mimir.gap, undefined);
});

test("a failed history replay is reported as a gap; a stopped hub stops replaying", async (t) => {
  const store = temporaryStore(t);
  const source = await stub(t, (req, res) => send(res, 500, { message: "history unavailable" }));
  let notified = 0;
  const hub = new Hub({ mimir: source.connection }, store, () => notified++);
  hub.state.sources.mimir = {};
  await hub.replayMimir();
  assert.equal(hub.state.sources.mimir.gap, "History replay incomplete: history unavailable");
  assert.equal(notified, 1);
  source.handle = (req, res) => {
    hub.stop();
    send(res, 200, { events: [{ id: "late" }], hasMore: true, lastCursor: "c9" });
  };
  await hub.replayMimir();
  assert.deepEqual(store.events(), [], "nothing is stored after the stop");
  assert.equal(store.cursor("mimir"), undefined);
});

test("a refresh asked for while one runs is run once afterwards", async (t) => {
  const store = temporaryStore(t);
  let release,
    snapshots = 0;
  const source = await stub(t, async (req, res) => {
    snapshots++;
    if (snapshots === 1) await new Promise((r) => (release = r));
    send(res, 200, { missions: [], agents: [] });
  });
  const hub = new Hub({ mimir: source.connection }, store, () => {});
  t.after(() => hub.stop());
  const first = hub.refresh();
  await until(() => release, "the first snapshot request");
  await hub.refresh();
  await hub.refresh();
  assert.equal(snapshots, 1, "the second and third asks wait");
  release();
  await first;
  await until(() => snapshots === 2, "the queued refresh");
  await until(() => !hub.busy && !hub.refreshQueued, "the queued refresh to finish");
  assert.equal(snapshots, 2, "two asks during one refresh make one more");
});

test("Sindri records are gathered per project, and streams follow the executions that exist", async (t) => {
  const store = temporaryStore(t);
  let executions = ["exe_1", "exe_2"];
  const streams = [];
  const source = await stub(t, (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/v1/projects") return send(res, 200, { projects: [{ id: "p 1" }] });
    const list = /^\/v1\/(\w+)$/.exec(url.pathname);
    if (list) {
      assert.equal(url.searchParams.get("projectId"), "p 1");
      return send(res, 200, { [list[1]]: list[1] === "executions" ? executions.map((id) => ({ id })) : [{ id: list[1] + "_1" }] });
    }
    const one = /^\/v1\/executions\/([\w]+)$/.exec(url.pathname);
    if (one) return send(res, 200, { execution: { id: one[1], status: "running" }, tasks: [], gates: [] });
    // Event streams stay open until the hub lets go.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
    streams.push({ path: url.pathname, res });
  });
  const hub = new Hub({ sindri: source.connection }, store, () => {});
  t.after(() => hub.stop());
  await hub.refresh();
  assert.equal(hub.state.sources.sindri.status, "connected");
  assert.equal(hub.state.sources.mimir.status, "not configured");
  assert.deepEqual(hub.state.sindri.specs, [{ id: "specs_1" }]);
  assert.deepEqual(hub.state.sindri.executions.map((e) => e.execution.id), ["exe_1", "exe_2"]);
  assert.deepEqual([...hub.streams.keys()], ["sindri:exe_1", "sindri:exe_2"]);
  const second = hub.streams.get("sindri:exe_2");
  executions = ["exe_1"];
  await hub.refresh();
  assert.deepEqual([...hub.streams.keys()], ["sindri:exe_1"]);
  assert.equal(second.removed, true);
  assert.equal(second.controller?.signal.aborted ?? true, true);
});

test("a Sindri stream stores execution events, keeps cursors of others, and reconnects after a gap", async (t) => {
  const store = temporaryStore(t);
  let connects = 0;
  const source = await stub(t, (req, res) => {
    connects++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (connects === 1) {
      res.write('id: s1\nevent: execution.event\ndata: {"id":"ev1","type":"task.started","createdAt":"t"}\n\n');
      res.write("id: s2\nevent: heartbeat\n\n");
      res.write("event: gap\n\n");
    } else res.write(": second connection\n\n");
  });
  let notified = 0;
  const hub = new Hub({ sindri: source.connection }, store, () => notified++);
  t.after(() => hub.stop());
  hub.refresh = async () => {};
  hub.state.sources.sindri = {};
  hub.stream("sindri", "/v1/executions/exe_1/events", "sindri:exe_1", "exe_1");
  hub.stream("sindri", "/v1/executions/exe_1/events", "sindri:exe_1", "exe_1");
  await until(() => hub.state.sources.sindri.stream === "reconnecting", "the gap");
  const [event] = store.events();
  assert.equal(event.eventId, "ev1");
  assert.equal(event.executionId, "exe_1");
  assert.equal(event.timestamp, "t");
  assert.equal(event.sourceCursor, "s1");
  assert.equal(store.cursor("sindri:exe_1"), "s2", "a frame that is not an event still advances the cursor");
  assert.equal(hub.state.sources.sindri.streamError, "Stream interrupted; reconnecting from saved cursor");
  assert.ok(notified >= 2);
  await until(() => connects === 2, "the reconnect", 20000);
  assert.equal(source.requests[1].headers["last-event-id"], "s2");
  assert.equal(source.requests[0].headers["last-event-id"], undefined);
});

test("an expired cursor is reset and reconciled from the snapshot; other refusals reconnect", async (t) => {
  const store = temporaryStore(t);
  store.setCursor("mimir", "old");
  let answer = 410;
  const source = await stub(t, (req, res) => {
    if (req.url === "/v1/snapshot") return send(res, 200, { missions: [] });
    send(res, answer, "{}");
  });
  const hub = new Hub({ mimir: source.connection }, store, () => {});
  t.after(() => hub.stop());
  await hub.refresh();
  hub.stream("mimir", "/v1/events/stream", "mimir");
  await until(() => hub.state.sources.mimir.streamError === "Cursor expired", "the expired cursor");
  assert.equal(store.cursor("mimir"), "");
  assert.match(hub.state.sources.mimir.gap, /Source cursor expired/);
  assert.ok(source.requests.filter((r) => r.path === "/v1/snapshot").length >= 2, "the snapshot was read again");
  answer = 500;
  await until(() => hub.state.sources.mimir.streamError === "Event stream HTTP 500", "the next refusal", 20000);
});

test("a Mimir stream that ends is reconnected, and stopping the hub ends the wait at once", async (t) => {
  const store = temporaryStore(t);
  const source = await stub(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('id: m1\nevent: task.output\ndata: {"id":"me1","sequence":4,"payload":{"x":1}}\n\n');
  });
  const hub = new Hub({ mimir: source.connection }, store, () => {});
  hub.refresh = async () => {};
  hub.state.sources.mimir = {};
  hub.stream("mimir", "/v1/events/stream", "mimir");
  await until(() => hub.state.sources.mimir.streamError === "Event stream closed", "the closed stream");
  const [event] = store.events();
  assert.equal(event.type, "task.output");
  assert.equal(event.sourceSequence, 4);
  assert.deepEqual(event.payload, { x: 1 });
  assert.equal(store.cursor("mimir"), "m1");
  const entry = hub.streams.get("mimir");
  hub.stop();
  await until(() => entry.controller.signal.aborted, "the stop");
  hub.stream("mimir", "/v1/events/stream", "other");
  assert.equal(hub.streams.has("other"), false, "a stopped hub opens no stream");
});

test("artifacts are previewed only when their bytes match the recorded hash", async (t) => {
  const store = temporaryStore(t);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const files = {
    note: { bytes: Buffer.from("hello stub-token"), type: "text/plain" },
    pic: { bytes: png, type: "image/png" },
    raw: { bytes: Buffer.from("x"), type: undefined },
    gif: { bytes: Buffer.from("GIF8"), type: "image/gif" },
  };
  const sha = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");
  let tamper = false,
    missing = false;
  const source = await stub(t, (req, res) => {
    const [, id, content] = /^\/v1\/artifacts\/(\w+)(\/content)?$/.exec(req.url);
    const file = files[id];
    if (!content) return send(res, 200, { artifact: { id, hash: sha(file.bytes) } });
    if (missing) return send(res, 404, "{}");
    res.writeHead(200, file.type ? { "content-type": file.type } : {});
    res.end(tamper ? Buffer.from("changed") : file.bytes);
  });
  const hub = new Hub({ mimir: source.connection }, store, () => {});
  const note = await hub.artifact("note");
  assert.equal(note.content, "hello [redacted]");
  assert.equal(note.image, null);
  assert.equal(note.verifiedHash, sha(files.note.bytes));
  const pic = await hub.artifact("pic");
  assert.equal(pic.content, null);
  assert.equal(pic.image, "data:image/png;base64," + png.toString("base64"));
  const raw = await hub.artifact("raw");
  assert.equal(raw.content, "x");
  const gif = await hub.artifact("gif");
  assert.equal(gif.content, null, "an image type that is not shown inline is neither text nor image");
  assert.equal(gif.image, null);
  tamper = true;
  await assert.rejects(hub.artifact("note"), /Artifact hash mismatch/);
  tamper = false;
  missing = true;
  await assert.rejects(hub.artifact("note"), { status: 404, message: "Artifact unavailable (HTTP 404)" });
});

test("an artifact larger than the preview limit is refused", async (t) => {
  const store = temporaryStore(t);
  const big = Buffer.alloc(12 * 1024 * 1024 + 1);
  const source = await stub(t, (req, res) =>
    req.url.endsWith("/content") ? send(res, 200, big) : send(res, 200, { artifact: { hash: "sha256:x" } }),
  );
  const hub = new Hub({ mimir: source.connection }, store, () => {});
  await assert.rejects(hub.artifact("big"), /Artifact exceeds 12 MB preview limit/);
});

test("a stopped hub neither refreshes nor handles the rest of a received chunk", async (t) => {
  const store = temporaryStore(t);
  const source = await stub(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Two events in one chunk: the hub is stopped while handling the first.
    res.write('id: 1\ndata: {"id":"one"}\n\nid: 2\ndata: {"id":"two"}\n\n');
  });
  const hub = new Hub({ mimir: source.connection }, store, () => hub.stop());
  hub.refresh = async () => {};
  hub.state.sources.mimir = {};
  hub.stream("mimir", "/v1/events/stream", "mimir");
  await until(() => hub.stopped, "the first event");
  await until(() => hub.streams.get("mimir").controller.signal.aborted, "the stream to end");
  assert.deepEqual(store.events().map((e) => e.eventId), ["one"]);
  assert.equal(hub.state.sources.mimir.streamError, undefined, "a stop is not reported as an error");
  const idle = new Hub({ mimir: source.connection }, store, () => {});
  idle.stop();
  await idle.refresh();
  assert.equal(idle.state.generatedAt, null);
  assert.equal(source.requests.filter((r) => r.path === "/v1/snapshot").length, 0);
});

test("a started hub refreshes on its own every few seconds until stopped", async (t) => {
  const store = temporaryStore(t);
  const source = await stub(t, (req, res) => {
    if (req.url === "/v1/projects") return send(res, 200, { projects: [] });
    send(res, 404, "{}");
  });
  const hub = new Hub({ sindri: source.connection }, store, () => {});
  t.after(() => hub.stop());
  await hub.start();
  await until(() => source.requests.length >= 2, "the periodic refresh");
  hub.stop();
  const seen = source.requests.length;
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(source.requests.length, seen, "no refresh after the stop");
});

// Mocked timers stop until() from ticking, so these poll on the event loop instead.
async function settle(check, what) {
  for (let i = 0; i < 200000; i++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw Error("Never saw " + what);
}

test("the hub refreshes every three seconds once started, and a failed refresh does not stop it", async (t) => {
  const store = temporaryStore(t);
  const source = await stub(t, (req, res) => send(res, 200, { projects: [] }));
  const rejections = [];
  const record = (e) => rejections.push(e);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));
  t.mock.timers.enable({ apis: ["setInterval"] });
  let broken = false;
  const hub = new Hub({ sindri: source.connection }, store, () => {
    if (broken) throw Error("listener failed");
  });
  t.after(() => hub.stop());
  await hub.start();
  const first = source.requests.length;
  assert.ok(first > 0, "start refreshes at once");
  broken = true;
  t.mock.timers.tick(3000);
  await settle(() => source.requests.length > first && !hub.busy, "the timed refresh");
  const second = source.requests.length;
  broken = false;
  t.mock.timers.tick(3000);
  await settle(() => source.requests.length > second, "the refresh after the failed one");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rejections, []);
});

test("a source that never answers a stream, or goes quiet in one, is dropped after 45 seconds", async (t) => {
  const store = temporaryStore(t);
  const source = await stub(t, (req, res) => {
    // The first connection never sends headers; the second sends one frame and then nothing.
    if (source.requests.length === 1) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("id: q1\nevent: heartbeat\n\n");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hub = new Hub({ mimir: source.connection }, store, () => {});
  t.after(() => hub.stop());
  hub.refresh = async () => {};
  hub.state.sources.mimir = {};
  hub.stream("mimir", "/v1/events/stream", "mimir");
  await settle(() => source.requests.length === 1, "the first connection");
  t.mock.timers.tick(45000);
  await settle(() => hub.state.sources.mimir.stream === "reconnecting", "the silent connection dropped");
  assert.match(hub.state.sources.mimir.streamError, /abort/i);
  // The reconnect waits two seconds.
  t.mock.timers.tick(2000);
  await settle(() => hub.state.sources.mimir.stream === "connected", "the second connection's frame");
  assert.equal(store.cursor("mimir"), "q1");
  t.mock.timers.tick(45000);
  await settle(() => hub.state.sources.mimir.stream === "reconnecting", "the quiet connection dropped");
  assert.match(hub.state.sources.mimir.streamError, /abort/i);
});

test("a Mimir snapshot that is not an object marks Mimir disconnected and the rest still updates", async (t) => {
  const store = temporaryStore(t);
  let answer = "null";
  const source = await stub(t, (req, res) => send(res, 200, answer));
  let notified = 0;
  const hub = new Hub({ mimir: source.connection }, store, () => notified++);
  t.after(() => hub.stop());
  await hub.refresh();
  assert.equal(hub.state.sources.mimir.status, "disconnected");
  assert.match(hub.state.sources.mimir.error, /snapshot/);
  assert.ok(hub.state.generatedAt, "the refresh completed");
  assert.equal(notified, 1, "the browsers hear about it");
  assert.deepEqual(hub.state.mimir, {});
  answer = JSON.stringify({ missions: [], agents: [] });
  await hub.refresh();
  assert.equal(hub.state.sources.mimir.status, "connected");
});

test("a Mimir snapshot with a list field that is not a list keeps the last good snapshot", async (t) => {
  const store = temporaryStore(t);
  let answer = JSON.stringify({ missions: [{ id: "m1" }], tasks: [] });
  const source = await stub(t, (req, res) => send(res, 200, answer));
  const hub = new Hub({ mimir: source.connection }, store, () => {});
  t.after(() => hub.stop());
  await hub.refresh();
  assert.equal(hub.state.sources.mimir.status, "connected");
  assert.deepEqual(hub.state.mimir.agents, [], "a list an older Mimir omits reads as empty");
  answer = JSON.stringify({ missions: null, tasks: {} });
  await hub.refresh();
  assert.equal(hub.state.sources.mimir.status, "disconnected");
  assert.match(hub.state.sources.mimir.error, /missions is not a list/);
  assert.deepEqual(hub.state.mimir.missions, [{ id: "m1" }], "the last good snapshot stays");
  assert.ok(hub.state.generatedAt);
});
