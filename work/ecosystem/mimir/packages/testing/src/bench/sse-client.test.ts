import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { openBenchSse } from "./sse-client.js";

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function serve(handler: (res: ServerResponse, headers: Record<string, unknown>) => void) {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    handler(res, req.headers);
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/`;
}

describe("openBenchSse", () => {
  it("counts events, tracks the last id and records gaps without keeping bodies", async () => {
    const url = await serve((res) => {
      res.write("retry: 3000\n\n: heartbeat\n\n");
      res.write('id: 1\nevent: a\ndata: {"id":"e1"}\n\n');
      res.write('id: 2\nevent: a\ndata: {"id":"e2"}\n\n');
      res.end('event: gap\ndata: {"reason":"slow_consumer"}\n\n');
    });
    const seen: string[] = [];
    const c = await openBenchSse(url, { authorization: "x" }, (msg) => {
      if (msg.data !== undefined) seen.push(msg.data);
    });
    await c.ended;
    expect(c.status).toBe(200);
    expect(c.events).toBe(2);
    expect(c.gaps).toBe(1);
    expect(c.lastId).toBe("2");
    expect(seen).toEqual(['{"id":"e1"}', '{"id":"e2"}', '{"reason":"slow_consumer"}']);
  });

  it("waitForEvents resolves once n events arrived and rejects on timeout", async () => {
    let out: ServerResponse | undefined;
    const url = await serve((res) => {
      out = res;
    });
    const c = await openBenchSse(url, {});
    const waiting = c.waitForEvents(2, 2000);
    out?.write("id: 1\ndata: {}\n\n");
    out?.write("id: 2\ndata: {}\n\n");
    await expect(waiting).resolves.toBeUndefined();
    await expect(c.waitForEvents(3, 50)).rejects.toThrow(/3 events/);
    c.close();
    await c.ended;
  });

  it("counts error events apart and rejects a waiter once the stream ends short", async () => {
    let out: ServerResponse | undefined;
    const url = await serve((res) => {
      out = res;
    });
    const c = await openBenchSse(url, {});
    const waiting = c.waitForEvents(2, 10_000);
    out?.write("data: {}\n\n");
    out?.end('event: error\ndata: {"code":"internal"}\n\n');
    await expect(waiting).rejects.toThrow("stream ended after 1 of 2 events");
    await c.ended;
    expect({ events: c.events, errors: c.errors, gaps: c.gaps }).toEqual({
      events: 1,
      errors: 1,
      gaps: 0,
    });
    await expect(c.waitForEvents(5, 10_000)).rejects.toThrow(/stream ended/);
  });

  it("sends the given headers", async () => {
    let got: Record<string, unknown> = {};
    const url = await serve((res, headers) => {
      got = headers;
      res.end();
    });
    const c = await openBenchSse(url, { "last-event-id": "42" });
    await c.ended;
    expect(got["last-event-id"]).toBe("42");
    expect(got["accept"]).toBe("text/event-stream");
  });
});
