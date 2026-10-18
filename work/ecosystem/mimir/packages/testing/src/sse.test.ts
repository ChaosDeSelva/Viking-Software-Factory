import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SseParser, openSse } from "./sse.js";

describe("SseParser", () => {
  it("parses id/event/data fields, multi-line data and comments across chunk boundaries", () => {
    const p = new SseParser();
    const out = [
      ...p.push("id: 1\nevent: a\nda"),
      ...p.push('ta: {"x":1}\n\n: heartbeat\n\n'),
      ...p.push("data: line1\r\ndata: line2\r\n\r\n"),
    ];
    expect(out).toEqual([
      { id: "1", event: "a", data: '{"x":1}' },
      { comment: "heartbeat" },
      { data: "line1\nline2" },
    ]);
  });
});

describe("openSse", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it("collects messages from a real socket and reports the end", async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 7\nevent: hello\ndata: ${req.headers["last-event-id"] ?? "none"}\n\n`);
      setTimeout(() => res.end("event: bye\ndata: {}\n\n"), 20);
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const sse = await openSse(`http://127.0.0.1:${port}/`, { "last-event-id": "6" });
    expect(sse.status).toBe(200);
    expect(await sse.next()).toEqual({ id: "7", event: "hello", data: "6" });
    expect(await sse.next()).toEqual({ event: "bye", data: "{}" });
    await sse.ended;
    await expect(sse.next(50)).rejects.toThrow(/ended/);
  });
});
