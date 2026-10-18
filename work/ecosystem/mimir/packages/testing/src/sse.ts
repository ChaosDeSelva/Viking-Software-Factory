import { request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";

/** One Server-Sent Events message; a comment line (`: text`) yields `{ comment }`. */
export interface SseMessage {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Incremental `text/event-stream` parser (handles chunks split anywhere, LF or CRLF). */
export class SseParser {
  private buffer = "";
  private current: SseMessage = {};
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buffer.search(/\r?\n/)) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(this.buffer[nl] === "\r" ? nl + 2 : nl + 1);
      if (line === "") {
        if (this.data.length > 0) this.current.data = this.data.join("\n");
        if (Object.keys(this.current).length > 0) out.push(this.current);
        this.current = {};
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) {
        out.push({ comment: line.slice(1).trimStart() });
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.data.push(value);
      else if (field === "id" || field === "event") this.current[field] = value;
    }
    return out;
  }
}

export interface SseConnection {
  status: number;
  headers: IncomingHttpHeaders;
  /** Every message received so far, in order. */
  messages: SseMessage[];
  /** Resolves with the next unread message; rejects after `timeoutMs` or once the stream ended. */
  next(timeoutMs?: number): Promise<SseMessage>;
  /** Resolves when the server ends the response (or the socket closes). */
  ended: Promise<void>;
  /** Raw body text (useful for non-200 responses). */
  text(): string;
  /** Stops reading from the socket (lets the server's buffer fill). */
  pause(): void;
  resume(): void;
  close(): void;
}

/** Opens an SSE connection over a real socket. Resolves once response headers arrive. */
export function openSse(url: string, headers: Record<string, string> = {}): Promise<SseConnection> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { accept: "text/event-stream", ...headers } });
    req.on("error", reject);
    req.on("response", (res: IncomingMessage) => {
      res.setEncoding("utf8");
      const parser = new SseParser();
      const messages: SseMessage[] = [];
      let raw = "";
      let read = 0;
      let done = false;
      let wake: (() => void) | undefined;
      const ended = new Promise<void>((r) => {
        const finish = () => {
          done = true;
          wake?.();
          r();
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
        // A paused response may not emit 'close' when the server drops the connection.
        res.socket.once("close", finish);
      });
      res.on("data", (chunk: string) => {
        raw += chunk;
        messages.push(...parser.push(chunk));
        wake?.();
      });
      const next = async (timeoutMs = 2000): Promise<SseMessage> => {
        const deadline = Date.now() + timeoutMs;
        while (read >= messages.length) {
          if (done) throw new Error("SSE stream ended");
          const left = deadline - Date.now();
          if (left <= 0) throw new Error(`no SSE message within ${timeoutMs}ms`);
          await new Promise<void>((r) => {
            const t = setTimeout(r, left);
            wake = () => {
              clearTimeout(t);
              r();
            };
          });
          wake = undefined;
        }
        return messages[read++] as SseMessage;
      };
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        messages,
        next,
        ended,
        text: () => raw,
        pause: () => res.pause(),
        resume: () => res.resume(),
        close: () => {
          req.destroy();
        },
      });
    });
    req.end();
  });
}
