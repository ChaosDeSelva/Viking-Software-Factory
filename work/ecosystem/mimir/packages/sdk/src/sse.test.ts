import { describe, expect, it } from "vitest";
import { SseParser, type SseMessage } from "./sse.js";

function parseAll(chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const p = new SseParser((m) => out.push(m));
  for (const c of chunks) p.feed(c);
  return out;
}

describe("SseParser", () => {
  it("parses id, event and data, dispatching on a blank line", () => {
    expect(parseAll(['id: c1\nevent: task.created\ndata: {"a":1}\n\n'])).toEqual([
      { id: "c1", event: "task.created", data: '{"a":1}' },
    ]);
  });

  it("handles frames split across chunks and CRLF / CR line endings", () => {
    const msgs = parseAll(["id: c", "1\r\nda", "ta: x\r", "\n\r\nid: c2\rdata: y\r\r"]);
    expect(msgs).toEqual([
      { id: "c1", event: "message", data: "x" },
      { id: "c2", event: "message", data: "y" },
    ]);
  });

  it("joins multi-line data with newlines and strips one leading space only", () => {
    expect(parseAll(["data:  a\ndata:b\n\n"])).toEqual([
      { id: undefined, event: "message", data: " a\nb" },
    ]);
  });

  it("ignores comments, unknown fields and blocks without data, and reports retry", () => {
    const retries: number[] = [];
    const out: SseMessage[] = [];
    const blocks: boolean[] = [];
    const p = new SseParser((m) => out.push(m), {
      onRetry: (ms) => retries.push(ms),
      onBlock: (hadId) => blocks.push(hadId),
    });
    p.feed(": heartbeat\n\nretry: 3000\n\nfoo: bar\n\nevent: gap\n\nid: x\n\n");
    expect(out).toEqual([]);
    expect(retries).toEqual([3000]);
    expect(blocks).toEqual([false, false, false, false, true]);
  });

  it("keeps the last event id across messages (per the SSE spec)", () => {
    const msgs = parseAll(["id: c1\ndata: a\n\ndata: b\n\n"]);
    expect(msgs.map((m) => m.id)).toEqual(["c1", "c1"]);
  });

  it("dispatches an event-only gap frame when it has data", () => {
    expect(parseAll(['event: gap\ndata: {"reason":"slow_consumer"}\n\n'])).toEqual([
      { id: undefined, event: "gap", data: '{"reason":"slow_consumer"}' },
    ]);
  });
});

describe("SseParser id-only blocks", () => {
  it("reports an id-only block (no data) through onId; blocks with data only dispatch", () => {
    const ids: string[] = [];
    const out: SseMessage[] = [];
    const p = new SseParser((m) => out.push(m), { onId: (id) => ids.push(id) });
    p.feed("retry: 3000\nid: c7\n\n");
    expect(out).toEqual([]);
    expect(ids).toEqual(["c7"]);
    p.feed("id: c8\ndata: x\n\n");
    expect(ids).toEqual(["c7"]);
    expect(out).toEqual([{ id: "c8", event: "message", data: "x" }]);
  });
});
