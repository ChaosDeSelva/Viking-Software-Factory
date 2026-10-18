// Ported from spikes/herdr-spike/test/client.test.ts (same author, local work),
// extended with MimirError mapping and socket path resolution.
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { isMimirError } from "@mimir/protocol";
import {
  HerdrError,
  HerdrSocketClient,
  resolveSocketPath,
  toMimirError,
} from "../src/socket-client.js";

type Msg = { id: string; method: string; params: Record<string, unknown> };
type Handler = (sock: net.Socket, msg: Msg) => void;

const servers: net.Server[] = [];
const subs: { close(): void }[] = [];

function rawServer(onMessage: Handler): Promise<{ path: string; sockets: net.Socket[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-raw-"));
  const p = path.join(dir, "s.sock");
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onMessage(sock, JSON.parse(line) as Msg);
      }
    });
    sock.on("error", () => {});
  });
  servers.push(server);
  return new Promise((res) => server.listen(p, () => res({ path: p, sockets })));
}

async function rejection(p: Promise<unknown>): Promise<HerdrError> {
  try {
    await p;
  } catch (e) {
    return e as HerdrError;
  }
  throw new Error("expected a rejection");
}

const send = (s: net.Socket, obj: unknown) => s.write(JSON.stringify(obj) + "\n");

afterEach(async () => {
  for (const s of subs.splice(0)) s.close();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

describe("request framing (fact 1: one request per connection)", () => {
  it("writes one newline-terminated JSON request with id, method, params", async () => {
    const seen: Msg[] = [];
    const { path: p } = await rawServer((s, m) => {
      seen.push(m);
      send(s, { id: m.id, result: { type: "pong", version: "0.9.4", protocol: 22 } });
    });
    const r = await new HerdrSocketClient(p).request("ping", {});
    expect(r).toEqual({ type: "pong", version: "0.9.4", protocol: 22 });
    expect(seen).toEqual([{ id: expect.any(String), method: "ping", params: {} }]);
  });

  it("reassembles a response split across chunks", async () => {
    const { path: p } = await rawServer((s, m) => {
      const line = JSON.stringify({ id: m.id, result: { v: m.method } }) + "\n";
      s.write(line.slice(0, 7));
      setTimeout(() => s.end(line.slice(7)), 20);
    });
    await expect(new HerdrSocketClient(p).request("a", {})).resolves.toEqual({ v: "a" });
  });

  it("opens a fresh connection for every request", async () => {
    const { path: p, sockets } = await rawServer((s, m) => {
      s.end(JSON.stringify({ id: m.id, result: { n: m.params.n } }) + "\n");
    });
    const c = new HerdrSocketClient(p);
    expect(await c.request("x", { n: 1 })).toEqual({ n: 1 });
    expect(await c.request("x", { n: 2 })).toEqual({ n: 2 });
    expect(sockets).toHaveLength(2);
  });

  it("resolves concurrent requests to their own responses even when answered out of order", async () => {
    const { path: p } = await rawServer((s, m) => {
      const delay = { one: 60, two: 30, three: 0 }[m.method as "one"];
      setTimeout(
        () => s.end(JSON.stringify({ id: m.id, result: { method: m.method } }) + "\n"),
        delay,
      );
    });
    const c = new HerdrSocketClient(p);
    const results = await Promise.all([c.request("one"), c.request("two"), c.request("three")]);
    expect(results.map((r) => (r as { method: string }).method)).toEqual(["one", "two", "three"]);
  });

  it("ignores lines with unknown ids and malformed lines", async () => {
    const { path: p } = await rawServer((s, m) => {
      s.write("not json\n");
      send(s, { id: "bogus", result: {} });
      send(s, { id: m.id, result: { ok: true } });
    });
    await expect(new HerdrSocketClient(p).request("x", {})).resolves.toEqual({ ok: true });
  });
});

describe("errors", () => {
  it("rejects with HerdrError carrying code, message, method", async () => {
    const { path: p } = await rawServer((s, m) => {
      send(s, { id: m.id, error: { code: "pane_not_found", message: "no such pane" } });
    });
    const err = await rejection(new HerdrSocketClient(p).request("pane.get", { pane_id: "w9:p9" }));
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("pane_not_found");
    expect(err.message).toContain("no such pane");
    expect(err.method).toBe("pane.get");
  });

  it("times out a request with code 'timeout'", async () => {
    const { path: p } = await rawServer(() => {});
    const err = await rejection(new HerdrSocketClient(p).request("ping", {}, { timeoutMs: 50 }));
    expect(err.code).toBe("timeout");
  });

  it("rejects with 'connection_closed' when the server hangs up", async () => {
    const { path: p } = await rawServer((s) => s.end());
    const err = await rejection(new HerdrSocketClient(p).request("ping", {}, { timeoutMs: 1000 }));
    expect(err.code).toBe("connection_closed");
  });

  it("fails to connect to a missing socket with code 'connect_failed' (ENOENT)", async () => {
    const err = await rejection(
      new HerdrSocketClient("/nonexistent/herdr.sock", { connectTimeoutMs: 200 }).request(
        "ping",
        {},
      ),
    );
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("connect_failed");
    expect(err.message).toContain("ENOENT");
  });
});

describe("toMimirError", () => {
  const cases: [string, string, boolean | undefined][] = [
    ["not_found", "not_found", undefined],
    ["pane_not_found", "not_found", undefined],
    ["agent_not_found", "not_found", undefined],
    ["invalid_request", "validation_failed", undefined],
    ["invalid_params", "validation_failed", undefined],
    ["agent_pane_busy", "conflict", true],
    ["agent_not_ready", "conflict", true],
    ["timeout", "runtime_unavailable", undefined],
    ["unknown_method", "capability_unavailable", undefined],
    ["protocol_mismatch", "capability_unavailable", undefined],
    ["connect_failed", "runtime_unavailable", undefined],
    ["connection_closed", "runtime_unavailable", undefined],
    ["something_new", "internal", undefined],
  ];
  it.each(cases)("maps %s -> %s", (herdrCode, mimirCode, retryable) => {
    const e = toMimirError(new HerdrError(herdrCode, "msg", "pane.read"));
    expect(isMimirError(e)).toBe(true);
    expect(e.code).toBe(mimirCode);
    const details = e.details as { herdrCode: string; method?: string; retryable?: boolean };
    expect(details.herdrCode).toBe(herdrCode);
    expect(details.method).toBe("pane.read");
    if (retryable !== undefined) expect(details.retryable).toBe(retryable);
  });

  it("passes a MimirError through unchanged and wraps unknown throwables as internal", () => {
    const m = toMimirError(new HerdrError("pane_not_found", "x"));
    expect(toMimirError(m)).toBe(m);
    expect(toMimirError(new Error("boom")).code).toBe("internal");
  });
});

describe("subscribe (facts 2, 4)", () => {
  it("sends events.subscribe on its own connection, acks, and delivers pushed events", async () => {
    const seen: Msg[] = [];
    const { path: p } = await rawServer((s, m) => {
      seen.push(m);
      send(s, { id: m.id, result: { type: "subscription_started" } });
      send(s, {
        event: "pane_created",
        data: { type: "pane_created", pane: { pane_id: "w1:p1" } },
      });
      send(s, {
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p1", agent_status: "idle" },
      });
    });
    const events: { event: string }[] = [];
    const sub = await new HerdrSocketClient(p).subscribe(
      ["pane.created", { type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      (e) => events.push(e),
    );
    subs.push(sub);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen[0]?.method).toBe("events.subscribe");
    expect(seen[0]?.params).toEqual({
      subscriptions: [
        { type: "pane.created" },
        { type: "pane.agent_status_changed", pane_id: "w1:p1" },
      ],
    });
    expect(events.map((e) => e.event)).toEqual(["pane_created", "pane.agent_status_changed"]);
  });

  it("rejects when the subscribe request itself errors", async () => {
    const { path: p } = await rawServer((s, m) => {
      send(s, { id: m.id, error: { code: "invalid_request", message: "missing field `pane_id`" } });
      s.end();
    });
    const err = await rejection(
      new HerdrSocketClient(p).subscribe(["pane.created"], () => {}, { ackTimeoutMs: 500 }),
    );
    expect(err).toBeInstanceOf(HerdrError);
    expect(err.code).toBe("invalid_request");
  });

  it("times out waiting for the ack", async () => {
    const { path: p } = await rawServer(() => {});
    const err = await rejection(
      new HerdrSocketClient(p).subscribe(["pane.created"], () => {}, { ackTimeoutMs: 50 }),
    );
    expect(err.code).toBe("timeout");
  });

  it("reports an events_lost line followed by close as reason 'error'", async () => {
    const { path: p } = await rawServer((s, m) => {
      send(s, { id: m.id, result: { type: "subscription_started" } });
      setTimeout(() => {
        send(s, { id: m.id, error: { code: "events_lost", message: "fell behind" } });
        s.end();
      }, 10);
    });
    const sub = await new HerdrSocketClient(p).subscribe(["pane.created"], () => {});
    subs.push(sub);
    const closed = await sub.closed;
    expect(closed.reason).toBe("error");
    expect(closed.error?.code).toBe("events_lost");
  });

  it("reports a plain EOF as reason 'eof'", async () => {
    const { path: p } = await rawServer((s, m) => {
      send(s, { id: m.id, result: { type: "subscription_started" } });
      setTimeout(() => s.end(), 10);
    });
    const sub = await new HerdrSocketClient(p).subscribe(["pane.created"], () => {});
    subs.push(sub);
    expect(await sub.closed).toEqual({ reason: "eof" });
  });

  it("reports client close as 'closed_by_client'", async () => {
    const { path: p } = await rawServer((s, m) =>
      send(s, { id: m.id, result: { type: "subscription_started" } }),
    );
    const sub = await new HerdrSocketClient(p).subscribe(["pane.created"], () => {});
    sub.close();
    expect((await sub.closed).reason).toBe("closed_by_client");
  });
});

describe("resolveSocketPath", () => {
  const home = "/home/u";
  it("prefers an explicit socket path", () => {
    expect(
      resolveSocketPath({
        socketPath: "/x.sock",
        sessionName: "a",
        env: { HERDR_SOCKET_PATH: "/e.sock" },
        home,
      }),
    ).toBe("/x.sock");
  });
  it("uses an explicit sessionName before the environment", () => {
    expect(
      resolveSocketPath({ sessionName: "mimir", env: { HERDR_SOCKET_PATH: "/e.sock" }, home }),
    ).toBe("/home/u/.config/herdr/sessions/mimir/herdr.sock");
  });
  it("then HERDR_SOCKET_PATH, then HERDR_SESSION, then the default socket", () => {
    expect(
      resolveSocketPath({ env: { HERDR_SOCKET_PATH: "/e.sock", HERDR_SESSION: "s" }, home }),
    ).toBe("/e.sock");
    expect(resolveSocketPath({ env: { HERDR_SESSION: "s" }, home })).toBe(
      "/home/u/.config/herdr/sessions/s/herdr.sock",
    );
    expect(resolveSocketPath({ env: {}, home })).toBe("/home/u/.config/herdr/herdr.sock");
  });
  it("maps the session name 'default' to the default socket", () => {
    expect(resolveSocketPath({ sessionName: "default", env: {}, home })).toBe(
      "/home/u/.config/herdr/herdr.sock",
    );
  });
  it("rejects session names that would escape the sessions directory", () => {
    expect(() => resolveSocketPath({ sessionName: "../x", env: {}, home })).toThrow();
  });
});

describe("hardening (audit M4)", () => {
  it("fails a request whose response line exceeds maxLineBytes", async () => {
    const { path: p } = await rawServer((sock) => {
      sock.write("x".repeat(4096)); // no newline, ever
    });
    const client = new HerdrSocketClient(p, { maxLineBytes: 1024, requestTimeoutMs: 2_000 });
    await expect(client.request("ping")).rejects.toMatchObject({ code: "line_too_long" });
  });

  it("ends a subscription with reason 'error' (line_too_long) on an oversized pushed line", async () => {
    const { path: p } = await rawServer((sock, msg) => {
      sock.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
      setTimeout(() => sock.write("y".repeat(4096)), 10);
    });
    const client = new HerdrSocketClient(p, { maxLineBytes: 1024 });
    const sub = await client.subscribe(["pane.created"], () => {});
    subs.push(sub);
    const info = await sub.closed;
    expect(info.reason).toBe("error");
    expect(info.error?.code).toBe("line_too_long");
  });

  it("refuses a socket whose directory is writable by group or others", async () => {
    const { path: p } = await rawServer((sock, msg) => {
      sock.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
    });
    const client = new HerdrSocketClient(p);
    await expect(client.request("ping")).resolves.toEqual({ ok: true });
    fs.chmodSync(path.dirname(p), 0o777);
    const err = await client.request("ping").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err).toMatchObject({ code: "socket_untrusted" });
    expect(toMimirError(err).code).toBe("runtime_unavailable");
  });

  it("refuses a path that is not a socket (e.g. a planted regular file or symlink)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-file-"));
    const file = path.join(dir, "herdr.sock");
    fs.writeFileSync(file, "");
    await expect(new HerdrSocketClient(file).request("ping")).rejects.toMatchObject({
      code: "socket_untrusted",
    });
    const { path: real } = await rawServer(() => {});
    const link = path.join(dir, "link.sock");
    fs.symlinkSync(real, link);
    await expect(new HerdrSocketClient(link).request("ping")).rejects.toMatchObject({
      code: "socket_untrusted",
    });
  });
});
