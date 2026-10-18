import {
  EventEnvelopeSchema,
  ListEventsResponseSchema,
  MimirError,
  SnapshotResponseSchema,
  toValidationIssues,
  type EventEnvelope,
  type EventType,
  type ListEventsQueryInput,
  type MissionId,
  type ValidationIssue,
} from "@mimir/protocol";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff.js";
import { errorFromResponse, parseResponse, type Http, type RequestOptions } from "./http.js";
import { SseParser, type SseMessage } from "./sse.js";

/** Default page size for `GET /v1/events` paging (the server's default too). */
export const DEFAULT_EVENTS_PAGE_LIMIT = 200;

/**
 * One page of `GET /v1/events`, normalized across server versions:
 * - `{events, nextCursor: null}` on the final page (protocol `ListEventsResponse`), optionally
 *   with `hasMore` and `lastCursor`;
 * - `{events, nextCursor: <last event's cursor>, hasMore: false}` on the final page.
 */
export interface EventsPage {
  events: EventEnvelope[];
  /** Cursor to request the next page with; `null` when the server says the caller is caught up. */
  nextCursor: string | null;
  /** False once the caller is caught up (derived from `nextCursor === null` when absent). */
  hasMore: boolean;
  /** Best known resume position after this page (`lastCursor`, else a non-null `nextCursor`). */
  lastCursor: string | null;
}

export type EventFilter = Pick<ListEventsQueryInput, "streamId"> & {
  missionId?: MissionId;
  types?: readonly EventType[];
};

export interface ReplayAllOptions extends EventFilter, RequestOptions {
  /** Cursor to start after; omit to start at the oldest retained event. */
  from?: string;
  /** Page size; default 200. */
  limit?: number;
  /** Called with each page as it arrives. */
  onPage?: (page: EventsPage) => void;
}

export interface ReplayAllResult {
  events: EventEnvelope[];
  /** Position after the last event (pass to `stream({cursor})` or the next `replayAll({from})`). */
  cursor: string;
}

/** Information passed to `onGap`. */
export interface GapInfo {
  /** `slow_consumer` (server dropped us) or `cursor_expired` (our position was pruned), or server text. */
  reason: string;
  /** The server's notion of the last delivered id, when it sent one. */
  lastEventId?: string;
  /** The raw `data` of the gap frame, parsed as JSON when possible. */
  data?: unknown;
}

export interface ReconnectInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
}

/** Connection state reported through `StreamOptions.onStatus`. */
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/** An SSE frame whose data failed `EventEnvelopeSchema` (e.g. an event type newer than this SDK). */
export interface InvalidEventInfo {
  id?: string;
  event: string;
  data: unknown;
  issues: ValidationIssue[];
}

/**
 * Note: the server's `retry:` field is ignored; reconnect timing comes from `backoff` only.
 */
export interface StreamOptions extends EventFilter {
  /**
   * Start after this cursor. Omit to receive only events appended after connecting; the stream
   * then anchors on the server's opening id (or `snapshot().cursor`) so reconnects lose nothing.
   */
  cursor?: string;
  signal?: AbortSignal;
  /** Called when the server signals a gap (`event: gap`) or the resume cursor has expired. */
  onGap?: (info: GapInfo) => void;
  onReconnect?: (info: ReconnectInfo) => void;
  /** `connecting` → `open` → (`reconnecting` → `open`)* → `closed`. Repeats are not reported. */
  onStatus?: (status: StreamStatus) => void;
  /**
   * Called for an event that fails validation; the event is skipped and the cursor advances.
   * Without it, an invalid event ends the stream with `MimirError('validation_failed')`.
   */
  onInvalidEvent?: (info: InvalidEventInfo) => void;
  backoff?: Partial<BackoffOptions>;
  /** Reconnect when no bytes (events or heartbeats) arrive for this long. Default 45 s; 0 disables. */
  idleTimeoutMs?: number;
  /**
   * How many recent event ids to remember for de-duplication. Default 10 000. Duplicates older
   * than the window are not caught; that only matters if a server replays more than this many
   * events after losing the resume position.
   */
  dedupeWindow?: number;
  /** Source of randomness for backoff jitter (tests). */
  random?: () => number;
}

/** A live event feed. Iterate once; `cursor` is the resume position after the last received event. */
export interface EventStream extends AsyncIterable<EventEnvelope> {
  readonly cursor: string | undefined;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function filterQuery(f: EventFilter) {
  return {
    streamId: f.streamId,
    missionId: f.missionId,
    types: f.types === undefined ? undefined : [...f.types],
  };
}

function matches(f: EventFilter, e: EventEnvelope): boolean {
  return (
    (f.streamId === undefined || e.streamId === f.streamId) &&
    (f.missionId === undefined || e.missionId === f.missionId) &&
    (f.types === undefined || f.types.length === 0 || f.types.includes(e.type))
  );
}

/** Normalizes the raw `GET /v1/events` body (see `EventsPage`). */
export function normalizePage(json: unknown, path = "/v1/events"): EventsPage {
  // `hasMore` and `lastCursor` are optional fields of the protocol schema, so they are validated.
  const page = parseResponse(ListEventsResponseSchema, json, path);
  const hasMore = page.nextCursor === null ? false : (page.hasMore ?? true);
  return {
    events: page.events,
    nextCursor: page.nextCursor,
    hasMore,
    lastCursor: page.lastCursor ?? page.nextCursor,
  };
}

export async function listEvents(
  http: Http,
  query: ListEventsQueryInput = {},
  options: RequestOptions = {},
): Promise<EventsPage> {
  const res = await http.fetch(http.url("/v1/events", { ...query }), {
    method: "GET",
    headers: await http.headers({ accept: "application/json" }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return normalizePage(await http.json(res));
}

/**
 * Pages `GET /v1/events` from `from` to the end and returns every event plus the final cursor.
 * The cursor is the server's `lastCursor` (or a non-null `nextCursor`). Older servers whose final
 * page carries no position get `snapshot().cursor`, which is approximate: events appended between
 * the last page and the snapshot are skipped.
 */
export async function replayAll(
  http: Http,
  options: ReplayAllOptions = {},
): Promise<ReplayAllResult> {
  const events: EventEnvelope[] = [];
  let cursor = options.from;
  let position: string | undefined = options.from;
  const limit = options.limit ?? DEFAULT_EVENTS_PAGE_LIMIT;
  const req = options.signal ? { signal: options.signal } : {};
  for (;;) {
    const page = await listEvents(
      http,
      { ...filterQuery(options), limit, ...(cursor !== undefined ? { cursor } : {}) },
      req,
    );
    events.push(...page.events);
    if (page.lastCursor !== null) position = page.lastCursor;
    else if (page.events.length > 0) position = undefined; // events past the last known position
    options.onPage?.(page);
    if (!page.hasMore || page.nextCursor === null) break;
    // Guard against a server that reports more but does not advance.
    if (page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  if (position === undefined) {
    position = (await http.get(SnapshotResponseSchema, "/v1/snapshot", undefined, req)).cursor;
  }
  return { events, cursor: position };
}

/** Remembers the most recent `size` ids (FIFO eviction). */
class RecentIds {
  private readonly set = new Set<string>();
  constructor(private readonly size: number) {}
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    this.set.add(id);
    if (this.set.size > this.size) {
      const oldest = this.set.values().next();
      if (!oldest.done) this.set.delete(oldest.value);
    }
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A network-level failure of one connection (fetch, read, idle timeout, retryable status). */
class ConnectionEnded extends Error {}

/**
 * SSE event feed with reconnect. Resumes from the last received SSE id (the server's cursor) via
 * `Last-Event-ID` and `?cursor=`, drops events whose envelope id was already delivered, and backs
 * off 250 ms → 10 s with jitter between attempts. Non-retryable HTTP errors (401, 404, 410, 422...)
 * end the iteration by throwing `MimirError`; abort via `signal` ends it quietly.
 *
 * Without `options.cursor` the stream anchors on the server's opening id-only block
 * (`id: <latest>`). If the server's opening block has no id (older servers), it takes
 * `snapshot().cursor` instead, so a drop before the first event does not lose events.
 */
export function streamEvents(http: Http, options: StreamOptions = {}): EventStream {
  let cursor = options.cursor;
  let started = false;
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  const seen = new RecentIds(options.dedupeWindow ?? 10_000);
  const outer = options.signal;
  let status: StreamStatus | undefined;
  const setStatus = (next: StreamStatus) => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  /** Best-effort anchor for a cursor-less stream; failures leave the stream live-only. */
  async function anchorFromSnapshot(signal: AbortSignal): Promise<void> {
    try {
      const snap = await http.get(SnapshotResponseSchema, "/v1/snapshot", undefined, { signal });
      if (cursor === undefined) cursor = snap.cursor;
    } catch {
      // keep going without an anchor
    }
  }

  async function* run(): AsyncGenerator<EventEnvelope> {
    let attempt = 0;
    setStatus("connecting");
    try {
      while (!outer?.aborted) {
        const conn = new AbortController();
        const abortConn = () => conn.abort();
        outer?.addEventListener("abort", abortConn, { once: true });
        let idle: ReturnType<typeof setTimeout> | undefined;
        const touch = () => {
          if (idleTimeoutMs <= 0) return;
          if (idle !== undefined) clearTimeout(idle);
          idle = setTimeout(() => conn.abort(new ConnectionEnded("idle timeout")), idleTimeoutMs);
        };
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let failure: unknown;
        try {
          // Reconnecting without ever having learned a position: anchor before connecting.
          if (cursor === undefined && attempt > 0) await anchorFromSnapshot(conn.signal);
          const res = await http
            .fetch(http.url("/v1/events/stream", { ...filterQuery(options), cursor }), {
              method: "GET",
              headers: await http.headers({
                accept: "text/event-stream",
                ...(cursor !== undefined ? { "last-event-id": cursor } : {}),
              }),
              signal: conn.signal,
            })
            .catch((cause: unknown) => {
              throw new ConnectionEnded("fetch failed", { cause });
            });
          if (!res.ok) {
            const err = await errorFromResponse(res);
            if (err.code === "cursor_expired") {
              options.onGap?.({ reason: "cursor_expired", data: err.details });
            }
            if (!RETRYABLE_STATUS.has(res.status)) throw err;
            throw new ConnectionEnded(`HTTP ${res.status}`, { cause: err });
          }
          if (!res.body) throw new ConnectionEnded("response has no body");
          setStatus("open");
          reader = res.body.getReader();
          const r = reader;
          const decoder = new TextDecoder();
          const pending: SseMessage[] = [];
          let firstBlock = cursor === undefined;
          let needSnapshot = false;
          const parser = new SseParser((m) => pending.push(m), {
            onId: (id) => {
              if (id !== "") cursor = id;
            },
            onBlock: (hadId) => {
              if (firstBlock && !hadId && cursor === undefined) needSnapshot = true;
              firstBlock = false;
            },
          });
          touch();
          for (;;) {
            const { value, done } = await r.read().catch((cause: unknown) => {
              throw new ConnectionEnded("read failed", { cause });
            });
            if (done) throw new ConnectionEnded("stream ended");
            touch();
            parser.feed(decoder.decode(value, { stream: true }));
            // Decided per chunk: an id-only block later in the same chunk (the real server writes
            // `retry:` and `id:` as two blocks) makes the snapshot unnecessary.
            if (needSnapshot) {
              needSnapshot = false;
              if (cursor === undefined) await anchorFromSnapshot(conn.signal);
            }
            while (pending.length > 0) {
              const msg = pending.shift() as SseMessage;
              if (msg.event === "gap") {
                const data = parseJson(msg.data);
                const d = (typeof data === "object" && data !== null ? data : {}) as {
                  reason?: unknown;
                  lastEventId?: unknown;
                };
                options.onGap?.({
                  reason: typeof d.reason === "string" ? d.reason : "unknown",
                  ...(typeof d.lastEventId === "string" ? { lastEventId: d.lastEventId } : {}),
                  data,
                });
                continue;
              }
              const data = parseJson(msg.data);
              const parsed = EventEnvelopeSchema.safeParse(data);
              if (!parsed.success) {
                const issues = toValidationIssues(parsed.error);
                if (!options.onInvalidEvent) {
                  throw new MimirError(
                    "validation_failed",
                    "stream event does not match the protocol",
                    { issues },
                  );
                }
                if (msg.id !== undefined && msg.id !== "") cursor = msg.id;
                options.onInvalidEvent({
                  ...(msg.id !== undefined ? { id: msg.id } : {}),
                  event: msg.event,
                  data,
                  issues,
                });
                continue;
              }
              if (msg.id !== undefined && msg.id !== "") cursor = msg.id;
              attempt = 0;
              const event = parsed.data;
              if (seen.has(event.id) || !matches(options, event)) continue;
              seen.add(event.id);
              yield event;
            }
          }
        } catch (err) {
          if (outer?.aborted) return;
          // Only connection-level failures are retried; protocol errors and errors thrown by
          // caller callbacks end the iteration.
          if (!(err instanceof ConnectionEnded)) throw err;
          failure = err;
        } finally {
          if (idle !== undefined) clearTimeout(idle);
          outer?.removeEventListener("abort", abortConn);
          conn.abort();
          reader?.cancel().catch(() => undefined);
        }
        setStatus("reconnecting");
        const delayMs = backoffDelay(attempt, backoff, options.random);
        options.onReconnect?.({ attempt, delayMs, error: failure });
        attempt += 1;
        await sleep(delayMs, outer);
      }
    } finally {
      setStatus("closed");
    }
  }

  return {
    get cursor() {
      return cursor;
    },
    [Symbol.asyncIterator]() {
      if (started) throw new Error("EventStream can only be iterated once");
      started = true;
      return run();
    },
  };
}
