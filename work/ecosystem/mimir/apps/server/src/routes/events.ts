import type { ServerResponse } from "node:http";
import { decodeCursor, encodeCursor, type EventStore, type ReadOptions } from "@mimir/core";
import {
  ListEventsQuerySchema,
  MimirError,
  type EventEnvelope,
  type EventType,
  type ListEventsResponse,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { parseWith, toMimirError } from "../errors.js";

/** `ListEventsResponse` with `hasMore` and `lastCursor` always set. */
export type EventsPage = ListEventsResponse & { hasMore: boolean; lastCursor: string };

/** Same filters as `GET /v1/events`, without paging. */
const StreamQuerySchema = ListEventsQuerySchema.omit({ limit: true });

/** Event filters shared by the replay and live phases of a stream. */
export interface EventFilter {
  streamId?: string;
  missionId?: string;
  types?: readonly EventType[];
}

function filterOf(q: {
  streamId?: string | undefined;
  missionId?: string | undefined;
  types?: EventType[] | undefined;
}): EventFilter {
  const f: EventFilter = {};
  if (q.streamId !== undefined) f.streamId = q.streamId;
  if (q.missionId !== undefined) f.missionId = q.missionId;
  if (q.types !== undefined && q.types.length > 0) f.types = q.types;
  return f;
}

function matches(f: EventFilter, e: EventEnvelope): boolean {
  return (
    (f.streamId === undefined || e.streamId === f.streamId) &&
    (f.missionId === undefined || e.missionId === f.missionId) &&
    (f.types === undefined || f.types.includes(e.type))
  );
}

/** Default time a dropped slow consumer gets to flush before its socket is destroyed. */
export const DEFAULT_SSE_DROP_GRACE_MS = 5_000;

/**
 * Validates `cursor` against what the store still holds and returns its global sequence.
 * Malformed → 422; ahead of the newest event (unknown to this server) or below the retained
 * minimum (events after it were pruned) → 410 `cursor_expired`.
 */
export function checkCursor(store: EventStore, cursor: string): number {
  const seq = decodeCursor(cursor);
  const latest = decodeCursor(store.latestCursor());
  if (seq > latest) {
    throw new MimirError("cursor_expired", "cursor is unknown to this server", {
      cursor,
      latestCursor: store.latestCursor(),
    });
  }
  const earliest = store.earliestCursor();
  if (earliest !== null && seq < decodeCursor(earliest)) {
    throw new MimirError("cursor_expired", "cursor is older than the retained event log", {
      cursor,
      earliestCursor: earliest,
      latestCursor: store.latestCursor(),
    });
  }
  return seq;
}

/** Global sequence of each event (the envelope does not carry it), via one store query. */
function sequencesOf(store: EventStore, events: EventEnvelope[]): number[] {
  const cursors = store.cursorsOf(events.map((e) => e.id));
  return events.map((e) => {
    const cursor = cursors.get(e.id);
    if (cursor === undefined) throw new MimirError("internal", `no cursor for event ${e.id}`);
    return decodeCursor(cursor);
  });
}

const frame = (event: EventEnvelope, cursor: string) =>
  `id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * One SSE client. Replays from `afterSeq`, then follows `store.subscribe`. Events are deduped by
 * global sequence, so the replay/live hand-over has no duplicate and no gap. A client whose
 * unsent buffer exceeds `maxBufferBytes` gets a final `event: gap` and is disconnected (its
 * socket is destroyed if it does not flush within `dropGraceMs`). Any failure ends the stream with
 * `event: error`; every exit path unsubscribes, clears the heartbeat and ends the socket.
 */
export interface SseOptions {
  heartbeatMs: number;
  maxBufferBytes: number;
  replayPageSize: number;
  dropGraceMs: number;
}

class SseClient {
  private lastSeq: number;
  private replaying = true;
  private queue: { event: EventEnvelope; seq: number }[] = [];
  private queuedBytes = 0;
  private closed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly store: EventStore,
    private readonly res: ServerResponse,
    afterSeq: number,
    private readonly opts: SseOptions,
    private readonly filter: EventFilter,
    onClose: () => void,
  ) {
    this.lastSeq = afterSeq;
    this.cleanups.push(onClose);
    res.on("close", () => this.cleanup());
    this.cleanups.push(
      store.subscribe((event, cursor) => {
        try {
          if (matches(this.filter, event)) this.onLive(event, decodeCursor(cursor));
        } catch (err) {
          this.fail(err);
        }
      }),
    );
    const timer = setInterval(() => this.write(": heartbeat\n\n"), opts.heartbeatMs);
    timer.unref();
    this.cleanups.push(() => clearInterval(timer));
  }

  async start(): Promise<void> {
    let cursor = encodeCursor(this.lastSeq);
    for (;;) {
      if (this.closed) return;
      const options: ReadOptions = { cursor, limit: this.opts.replayPageSize, ...this.filter };
      const page = this.store.read(options);
      const seqs = sequencesOf(this.store, page.events);
      for (const [i, event] of page.events.entries()) {
        this.send(event, seqs[i] as number);
        // Replay is paced by the socket instead of being dropped as a slow consumer.
        if (this.res.writableNeedDrain) await this.drained();
        if (this.closed) return;
      }
      if (!page.hasMore) break;
      cursor = page.lastCursor;
    }
    this.replaying = false;
    for (const { event, seq } of this.queue.splice(0)) this.send(event, seq);
    this.queuedBytes = 0;
  }

  /** Ends the stream with a final `event: error` (replay or delivery failed). */
  fail(err: unknown): void {
    if (this.closed) return;
    const e = toMimirError(err);
    this.res.end(`event: error\ndata: ${JSON.stringify({ code: e.code, message: e.message })}\n\n`);
    this.cleanup();
  }

  /** Ends the stream (server shutdown). */
  end(): void {
    if (!this.closed) this.res.end();
    this.cleanup();
  }

  private onLive(event: EventEnvelope, seq: number): void {
    if (this.closed) return;
    if (this.replaying) {
      this.queue.push({ event, seq });
      this.queuedBytes += JSON.stringify(event).length;
      if (this.queuedBytes > this.opts.maxBufferBytes) this.dropWithGap();
      return;
    }
    this.send(event, seq);
  }

  private send(event: EventEnvelope, seq: number): void {
    if (this.closed || seq <= this.lastSeq) return;
    this.write(frame(event, encodeCursor(seq)));
    this.lastSeq = seq;
    if (!this.replaying && this.res.writableLength > this.opts.maxBufferBytes) this.dropWithGap();
  }

  private drained(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.res.off("drain", done);
        this.res.off("close", done);
        resolve();
      };
      this.res.on("drain", done);
      this.res.on("close", done);
    });
  }

  private dropWithGap(): void {
    if (this.closed) return;
    const data = { reason: "slow_consumer", lastEventId: encodeCursor(this.lastSeq) };
    this.res.end(`event: gap\ndata: ${JSON.stringify(data)}\n\n`);
    this.cleanup();
    // A consumer that never reads would otherwise pin the buffered bytes indefinitely.
    // Close the connection after a grace period even if the bytes reached the kernel buffer.
    const socket = this.res.socket;
    if (socket) {
      const timer = setTimeout(() => socket.destroy(), this.opts.dropGraceMs);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
    }
  }

  private write(chunk: string): void {
    if (!this.closed) this.res.write(chunk);
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.cleanups.splice(0)) fn();
    this.queue = [];
  }
}

export function eventRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;
  const clients = new Set<SseClient>();
  app.addHook("preClose", async () => {
    for (const c of [...clients]) c.end();
  });

  app.get("/v1/events", (request): EventsPage => {
    const q = parseWith(ListEventsQuerySchema, request.query);
    if (q.cursor !== undefined) checkCursor(ctx.store, q.cursor);
    const options: ReadOptions = { limit: q.limit, ...filterOf(q) };
    if (q.cursor !== undefined) options.cursor = q.cursor;
    const page = ctx.store.read(options);
    return {
      events: page.events,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      lastCursor: page.lastCursor,
    };
  });

  app.get("/v1/events/stream", async (request, reply) => {
    const q = parseWith(StreamQuerySchema, request.query);
    const header = request.headers["last-event-id"];
    const lastEventId =
      typeof header === "string" && header.trim() !== "" ? header.trim() : undefined;
    const start = lastEventId ?? q.cursor;
    const afterSeq =
      start === undefined ? decodeCursor(ctx.store.latestCursor()) : checkCursor(ctx.store, start);

    reply.hijack();
    const res = reply.raw;
    let client: SseClient | undefined;
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 3000\n\n");
      // Without a client cursor, pin the start position at once (id-only block: no event is
      // dispatched, but EventSource/SDK record it as Last-Event-ID), so a drop before the first
      // event resumes without loss.
      if (start === undefined) res.write(`id: ${encodeCursor(afterSeq)}\n\n`);
      const created: SseClient = new SseClient(ctx.store, res, afterSeq, ctx.sse, filterOf(q), () =>
        clients.delete(created),
      );
      client = created;
      clients.add(created);
      await created.start();
    } catch (err) {
      request.log.warn({ err }, "SSE stream failed");
      if (client) client.fail(err);
      else res.destroy();
    }
  });
}
