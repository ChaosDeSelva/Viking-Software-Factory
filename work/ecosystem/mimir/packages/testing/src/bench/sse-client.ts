import { request, type IncomingMessage } from "node:http";
import { SseParser, type SseMessage } from "../sse.js";

/**
 * A lean SSE client for load benchmarks: unlike `openSse` it keeps no message list or raw body,
 * so fifty clients over ten thousand events do not distort heap measurements.
 */
export interface BenchSseClient {
  status: number;
  /** Messages with data and no `event: gap`/`event: error` type. */
  readonly events: number;
  /** `event: gap` messages (slow-consumer drops). */
  readonly gaps: number;
  /** `event: error` messages. */
  readonly errors: number;
  /** The last `id:` field seen. */
  readonly lastId: string | undefined;
  /** Resolves once `n` events arrived; rejects after `timeoutMs` or if the stream ends first. */
  waitForEvents(n: number, timeoutMs: number): Promise<void>;
  ended: Promise<void>;
  close(): void;
}

export function openBenchSse(
  url: string,
  headers: Record<string, string>,
  onMessage?: (msg: SseMessage, receivedAt: number) => void,
): Promise<BenchSseClient> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { accept: "text/event-stream", ...headers } });
    req.on("error", reject);
    req.on("response", (res: IncomingMessage) => {
      res.setEncoding("utf8");
      const parser = new SseParser();
      let events = 0;
      let gaps = 0;
      let errors = 0;
      let lastId: string | undefined;
      let done = false;
      const waiters = new Set<() => void>();
      const wake = () => {
        for (const w of [...waiters]) w();
      };
      const ended = new Promise<void>((r) => {
        const finish = () => {
          done = true;
          wake();
          r();
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
        res.socket.once("close", finish);
      });
      res.on("data", (chunk: string) => {
        const at = performance.now();
        for (const msg of parser.push(chunk)) {
          if (msg.id !== undefined) lastId = msg.id;
          if (msg.event === "gap") gaps += 1;
          else if (msg.event === "error") errors += 1;
          else if (msg.data !== undefined) events += 1;
          onMessage?.(msg, at);
        }
        wake();
      });
      const client: BenchSseClient = {
        status: res.statusCode ?? 0,
        get events() {
          return events;
        },
        get gaps() {
          return gaps;
        },
        get errors() {
          return errors;
        },
        get lastId() {
          return lastId;
        },
        waitForEvents: (n, timeoutMs) =>
          new Promise<void>((ok, fail) => {
            const check = () => {
              if (events >= n) {
                cleanup();
                ok();
              } else if (done) {
                cleanup();
                fail(new Error(`stream ended after ${events} of ${n} events`));
              }
            };
            const timer = setTimeout(() => {
              cleanup();
              fail(new Error(`timed out waiting for ${n} events (got ${events})`));
            }, timeoutMs);
            const cleanup = () => {
              clearTimeout(timer);
              waiters.delete(check);
            };
            waiters.add(check);
            check();
          }),
        ended,
        close: () => req.destroy(),
      };
      resolve(client);
    });
    req.end();
  });
}
