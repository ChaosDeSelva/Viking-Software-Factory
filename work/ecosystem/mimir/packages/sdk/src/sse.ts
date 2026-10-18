/** One dispatched Server-Sent Events message. */
export interface SseMessage {
  /** The last event id seen on this connection (per the SSE spec it persists across messages). */
  id: string | undefined;
  /** `event:` field, defaulting to `message`. */
  event: string;
  data: string;
}

export interface SseParserHooks {
  /** A `retry:` field with a valid integer. */
  onRetry?: (ms: number) => void;
  /** A block that set `id:` but carried no data (for example the server's opening position). */
  onId?: (id: string) => void;
  /** End of every block (blank line), dispatched or not; `hadId` tells whether it set `id:`. */
  onBlock?: (hadId: boolean) => void;
}

/**
 * Incremental SSE parser following the WHATWG event-stream rules: CRLF, LF and CR line endings,
 * comments, multi-line data, and blocks without data are ignored. Works on decoded text so it
 * has no dependency on Node or DOM stream types.
 */
export class SseParser {
  private buffer = "";
  private skipLeadingLf = false;
  private data: string[] = [];
  private event = "";
  private lastId: string | undefined;
  private blockId: string | undefined;

  constructor(
    private readonly onMessage: (message: SseMessage) => void,
    private readonly hooks: SseParserHooks = {},
  ) {}

  feed(chunk: string): void {
    let text = chunk;
    if (this.skipLeadingLf && text.startsWith("\n")) text = text.slice(1);
    this.skipLeadingLf = false;
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== "\n" && ch !== "\r") continue;
      this.line(this.buffer.slice(start, i));
      if (ch === "\r") {
        if (i + 1 === this.buffer.length) this.skipLeadingLf = true;
        else if (this.buffer[i + 1] === "\n") i++;
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.lastId = value;
          this.blockId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.hooks.onRetry?.(Number(value));
        break;
      default:
        break;
    }
  }

  private dispatch(): void {
    const blockId = this.blockId;
    this.blockId = undefined;
    const data = this.data;
    const event = this.event;
    this.data = [];
    this.event = "";
    this.hooks.onBlock?.(blockId !== undefined);
    if (data.length === 0) {
      if (blockId !== undefined) this.hooks.onId?.(blockId);
      return;
    }
    this.onMessage({
      id: this.lastId,
      event: event === "" ? "message" : event,
      data: data.join("\n"),
    });
  }
}
