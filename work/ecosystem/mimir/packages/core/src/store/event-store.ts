import { resolve } from "node:path";
import {
  EVENT_TYPES,
  EventEnvelopeSchema,
  MimirError,
  newId,
  toValidationIssues,
  type EventEnvelope,
  type EventType,
} from "@mimir/protocol";
import { assertJsonDepth } from "../json-depth.js";
import { redactPayload, type PayloadRedactor } from "../redaction.js";
import { openDatabase, type Db, type Stmt } from "./db.js";
import { AuditLog } from "./audit-log.js";
import { CommandLedger } from "./command-ledger.js";
import { acquireLock, type FileLock } from "./lock.js";
import { migrate } from "./migrate.js";

export type AppendInput = Omit<EventEnvelope, "id" | "sequence" | "schemaVersion">;

export interface ReadOptions {
  /** Opaque cursor from a previous `read`/`latestCursor`; events strictly after it are returned. */
  cursor?: string;
  limit: number;
  streamId?: string;
  missionId?: string;
  types?: readonly EventType[];
}

export interface ReadResult {
  events: EventEnvelope[];
  /**
   * Cursor for the next page, or `null` when there are no more matching events right now
   * (brief + protocol `ListEventsResponse` contract: `nextCursor === null` iff `!hasMore`).
   */
  nextCursor: string | null;
  /** True when more matching events exist after this page right now. */
  hasMore: boolean;
  /**
   * Resume position, never null: the cursor of the last returned event; for an empty page the
   * input cursor (the start position when none was given); for a cursor past the end the latest
   * cursor. Pollers and SSE use this to continue after the last page without losing events.
   */
  lastCursor: string;
  /**
   * Stored rows in this page's range that were refused (corrupt or unknown type) and are missing
   * from `events`. Non-zero means the page has a hole; see `integrity()`.
   */
  gaps: number;
}

/** Summary of stored rows the store has refused to serve (see `onCorruptRow`). */
export interface StoreIntegrity {
  /** Distinct refused rows seen since this store was opened (boot folds read the whole log). */
  refusedRows: number;
  /** When the first refused row was seen, or null when none. */
  firstRefusedAt: string | null;
}

/** `readStreamWithGaps` result: events plus the per-stream sequences that were refused. */
export interface StreamReadResult {
  events: EventEnvelope[];
  gaps: number[];
}

/** Called after commit for every newly inserted event (not for dedupe hits). */
export type EventListener = (event: EventEnvelope, cursor: string) => void;

export interface EventStoreOptions {
  /** Applied to every payload before insert. Defaults to `redact` on all string leaves. */
  payloadRedactor?: PayloadRedactor;
  /** Defaults to `MIMIR_MAX_PAYLOAD_BYTES`, else 256 KiB. */
  maxPayloadBytes?: number;
  /** Receives errors thrown by subscribers. Defaults to `console.error`. Its own throws are ignored. */
  onListenerError?: (error: unknown) => void;
  /**
   * Called (after commit) when a `(source, sourceEventId)` dedupe hit differs from the stored
   * event in `type` or `streamId`, which usually means an adapter reused a source id.
   */
  onDuplicate?: (existing: EventEnvelope, input: AppendInput) => void;
  /**
   * Open an existing file read-only: no lock, no migration, no writes. For tools that must never
   * block or disturb a running server. Appending throws.
   */
  readOnly?: boolean;
  /**
   * Called once per row id when `read`/`readStream` meets a stored row it cannot decode (a torn
   * or tampered write: unparseable payload JSON; or an event type this build does not know, e.g.
   * after a downgrade). The row is refused (never served) and reading continues past it; it is
   * counted in `integrity()`. Defaults to `console.error`. Its own throws are ignored.
   */
  onCorruptRow?: (info: CorruptRowInfo) => void;
}

/** A stored event row that `read`/`readStream` refused to serve. */
export interface CorruptRowInfo {
  id: string;
  streamId: string;
  /** Position of the refused row; reading resumes after it. */
  cursor: string;
  reason: string;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

export interface TruncatedPayload {
  truncated: true;
  originalBytes: number;
  /** Leading slice of the (redacted) payload JSON, when it fits. */
  preview?: string;
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
/** Smallest accepted payload bound: room for the truncation marker plus a short preview. */
export const MIN_MAX_PAYLOAD_BYTES = 256;
const MAX_PREVIEW_CHARS = 4096;

interface EventRow {
  id: string;
  stream_id: string;
  sequence: number;
  global_seq: number;
  type: string;
  provenance: string;
  source: string;
  source_event_id: string | null;
  correlation_id: string | null;
  mission_id: string | null;
  crew_id: string | null;
  task_id: string | null;
  session_id: string | null;
  occurred_at: string;
  observed_at: string;
  payload: string;
}

export function encodeCursor(globalSeq: number): string {
  return Buffer.from(String(globalSeq), "utf8").toString("base64");
}

/** Inverse of `encodeCursor`. Only canonical encodings of safe non-negative integers are accepted. */
export function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, "base64").toString("utf8");
  const value = /^(0|[1-9]\d*)$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || encodeCursor(value) !== cursor) {
    throw new MimirError("validation_failed", "invalid cursor", { cursor });
  }
  return value;
}

function resolveMaxBytes(option: number | undefined): number {
  if (option !== undefined) {
    if (!Number.isInteger(option) || option < MIN_MAX_PAYLOAD_BYTES) {
      throw new MimirError(
        "validation_failed",
        `maxPayloadBytes must be an integer >= ${MIN_MAX_PAYLOAD_BYTES}`,
        { maxPayloadBytes: option },
      );
    }
    return option;
  }
  const env = process.env.MIMIR_MAX_PAYLOAD_BYTES;
  const parsed = env === undefined ? NaN : Number(env);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MAX_PAYLOAD_BYTES;
  return Math.max(parsed, MIN_MAX_PAYLOAD_BYTES);
}

/** Returns `payload` as stored JSON, replacing it with a truncation marker when over `max` bytes. */
export function boundPayload(payload: unknown, max: number): { json: string; value: unknown } {
  const json = JSON.stringify(payload) ?? "null";
  const originalBytes = Buffer.byteLength(json, "utf8");
  if (originalBytes <= max) return { json, value: JSON.parse(json) as unknown };
  const bare: TruncatedPayload = { truncated: true, originalBytes };
  let n = Math.min(MAX_PREVIEW_CHARS, json.length);
  while (n > 0) {
    const candidate: TruncatedPayload = { ...bare, preview: json.slice(0, n) };
    const text = JSON.stringify(candidate);
    if (Buffer.byteLength(text, "utf8") <= max) return { json: text, value: candidate };
    n = Math.floor(n * 0.75);
  }
  const text = JSON.stringify(bare);
  return { json: text, value: bare };
}

function rowToEvent(row: EventRow): EventEnvelope {
  const ev: Record<string, unknown> = {
    id: row.id,
    schemaVersion: 1,
    streamId: row.stream_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    type: row.type,
    source: row.source,
    provenance: row.provenance,
  };
  if (row.source_event_id !== null) ev.sourceEventId = row.source_event_id;
  if (row.correlation_id !== null) ev.correlationId = row.correlation_id;
  if (row.mission_id !== null) ev.missionId = row.mission_id;
  if (row.crew_id !== null) ev.crewId = row.crew_id;
  if (row.task_id !== null) ev.taskId = row.task_id;
  if (row.session_id !== null) ev.sessionId = row.session_id;
  ev.payload = JSON.parse(row.payload) as unknown;
  return ev as EventEnvelope;
}

/** Decodes a row, or explains why it must not be served. */
function decodeRow(row: EventRow): { event: EventEnvelope } | { reason: string } {
  if (!KNOWN_TYPES.has(row.type))
    return { reason: `unknown event type ${JSON.stringify(row.type)}` };
  try {
    return { event: rowToEvent(row) };
  } catch (e) {
    return { reason: `unparseable payload: ${e instanceof Error ? e.message : String(e)}` };
  }
}

type Fresh = { event: EventEnvelope; globalSeq: number };
type Notification =
  | { kind: "event"; fresh: Fresh }
  | { kind: "duplicate"; existing: EventEnvelope; input: AppendInput };

export class EventStore {
  /** Private (ES `#`): callers must not run raw transactions on the store's connection. */
  readonly #db: Db;
  readonly commands: CommandLedger;
  readonly audit: AuditLog;
  private readonly lock: FileLock | undefined;
  private readonly redactor: PayloadRedactor;
  private readonly maxPayloadBytes: number;
  private readonly onListenerError: (error: unknown) => void;
  private readonly onDuplicate: ((existing: EventEnvelope, input: AppendInput) => void) | undefined;
  private readonly onCorruptRow: (info: CorruptRowInfo) => void;
  /** Ids of rows already refused (reported once each). */
  private readonly refused = new Set<string>();
  private firstRefusedAt: string | null = null;
  private readonly listeners = new Set<EventListener>();
  /** Notifications produced inside `withTransaction`, flushed after the outermost commit. */
  private pending: Notification[] = [];
  private txDepth = 0;
  private closed = false;
  private readonly readCache = new Map<string, Stmt>();

  private readonly stmts: {
    bySource: Stmt;
    bumpStream: Stmt;
    nextGlobal: Stmt;
    insert: Stmt;
    counter: Stmt;
    setCounter: Stmt;
    minGlobal: Stmt;
    prune: Stmt;
    readStream: Stmt;
    countByType: Stmt;
    exists: Stmt;
    cursorsOf: Stmt;
  };

  /**
   * Prefer `openEventStore`, which takes the single-writer lock and migrates. The constructor
   * expects an already-migrated connection.
   */
  constructor(db: Db, lock: FileLock | undefined, options: EventStoreOptions = {}) {
    this.#db = db;
    this.lock = lock;
    this.redactor = options.payloadRedactor ?? ((p) => redactPayload(p));
    this.maxPayloadBytes = resolveMaxBytes(options.maxPayloadBytes);
    this.onListenerError = options.onListenerError ?? ((e) => console.error(e));
    this.onDuplicate = options.onDuplicate;
    this.onCorruptRow =
      options.onCorruptRow ??
      ((info) => console.error(`mimir event store: refused corrupt event row`, info));
    this.commands = new CommandLedger(db, this.redactor);
    this.audit = new AuditLog(db);
    this.stmts = {
      bySource: db.prepare("SELECT * FROM events WHERE source = ? AND source_event_id = ?"),
      bumpStream: db.prepare(
        `INSERT INTO streams (stream_id, last_sequence) VALUES (?, 1)
         ON CONFLICT (stream_id) DO UPDATE SET last_sequence = last_sequence + 1
         RETURNING last_sequence`,
      ),
      nextGlobal: db.prepare(
        "UPDATE counters SET value = value + 1 WHERE name = 'global_seq' RETURNING value",
      ),
      insert: db.prepare(
        `INSERT INTO events (id, stream_id, sequence, global_seq, type, provenance, source,
           source_event_id, correlation_id, mission_id, crew_id, task_id, session_id,
           occurred_at, observed_at, payload)
         VALUES (@id, @streamId, @sequence, @globalSeq, @type, @provenance, @source,
           @sourceEventId, @correlationId, @missionId, @crewId, @taskId, @sessionId,
           @occurredAt, @observedAt, @payload)`,
      ),
      counter: db.prepare("SELECT value FROM counters WHERE name = ?"),
      setCounter: db.prepare("UPDATE counters SET value = ? WHERE name = ?"),
      minGlobal: db.prepare("SELECT MIN(global_seq) AS n FROM events"),
      prune: db.prepare("DELETE FROM events WHERE global_seq <= ?"),
      readStream: db.prepare(
        "SELECT * FROM events WHERE stream_id = ? AND sequence >= ? ORDER BY sequence",
      ),
      countByType: db.prepare("SELECT type, COUNT(*) AS n FROM events GROUP BY type"),
      exists: db.prepare("SELECT 1 FROM events WHERE id = ?"),
      cursorsOf: db.prepare(
        "SELECT id, global_seq FROM events WHERE id IN (SELECT value FROM json_each(?))",
      ),
    };
  }

  /** Appends one event; a repeated `(source, sourceEventId)` returns the stored event instead. */
  append(input: AppendInput): EventEnvelope {
    return this.appendMany([input])[0] as EventEnvelope;
  }

  /** Appends all inputs in one transaction (all or nothing). Output order matches input order. */
  appendMany(inputs: readonly AppendInput[]): EventEnvelope[] {
    this.assertOpen();
    return this.withTransaction(() => inputs.map((input) => this.insertOne(input)));
  }

  /**
   * Runs `fn` in an IMMEDIATE transaction (a savepoint when nested). Appends at any depth queue
   * their notifications; subscribers and `onDuplicate` run only after the outermost
   * `withTransaction` commits. Notifications from a rolled-back inner `withTransaction` are
   * dropped, and at flush every queued event is re-checked against the committed table, so an
   * event rolled back by any savepoint is never delivered. Use this to combine appends with
   * ledger or audit writes atomically.
   *
   * The store's connection is private, so raw `db.transaction` cannot wrap store calls through
   * the public API. A caller who constructs `EventStore` around its own connection must not run
   * raw transactions on it: appending inside a raw outer transaction throws `conflict` (the
   * store could not tell when it commits); a raw savepoint nested inside `withTransaction` is
   * tolerated by the flush-time existence check.
   */
  withTransaction<T>(fn: () => T): T {
    this.assertOpen();
    if (this.txDepth === 0 && this.#db.inTransaction) {
      throw new MimirError(
        "conflict",
        "EventStore writes inside a raw db.transaction are not allowed; use store.withTransaction",
      );
    }
    const outermost = this.txDepth === 0;
    const mark = this.pending.length;
    this.txDepth++;
    let result: T;
    try {
      const tx = this.#db.transaction(fn);
      result = outermost ? tx.immediate() : tx();
    } catch (e) {
      this.pending.length = mark;
      throw e;
    } finally {
      this.txDepth--;
    }
    if (outermost) this.flush();
    return result;
  }

  private insertOne(input: AppendInput): EventEnvelope {
    // Bound depth before redaction, which walks the payload recursively.
    assertJsonDepth(input.payload, "event payload");
    if (input.sourceEventId !== undefined) {
      const existing = this.stmts.bySource.get(input.source, input.sourceEventId) as
        EventRow | undefined;
      if (existing) {
        const event = rowToEvent(existing);
        if (event.type !== input.type || event.streamId !== input.streamId) {
          this.pending.push({ kind: "duplicate", existing: event, input });
        }
        return event;
      }
    }
    const { json, value } = boundPayload(this.redactor(input.payload), this.maxPayloadBytes);
    const candidate = { ...input, id: newId("evt"), schemaVersion: 1, sequence: 0, payload: value };
    const parsed = EventEnvelopeSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new MimirError("validation_failed", "invalid event envelope", {
        issues: toValidationIssues(parsed.error),
      });
    }
    const { last_sequence: sequence } = this.stmts.bumpStream.get(input.streamId) as {
      last_sequence: number;
    };
    const { value: globalSeq } = this.stmts.nextGlobal.get() as { value: number };
    const event: EventEnvelope = { ...parsed.data, sequence, payload: value };
    this.stmts.insert.run({
      id: event.id,
      streamId: event.streamId,
      sequence,
      globalSeq,
      type: event.type,
      provenance: event.provenance,
      source: event.source,
      sourceEventId: event.sourceEventId ?? null,
      correlationId: event.correlationId ?? null,
      missionId: event.missionId ?? null,
      crewId: event.crewId ?? null,
      taskId: event.taskId ?? null,
      sessionId: event.sessionId ?? null,
      occurredAt: event.occurredAt,
      observedAt: event.observedAt,
      payload: json,
    });
    this.pending.push({ kind: "event", fresh: { event, globalSeq } });
    return event;
  }

  /**
   * Reads events in global order strictly after `cursor`, optionally filtered.
   * Throws `cursor_expired` when events after the cursor have been pruned (including no cursor
   * once anything was pruned) and `validation_failed` for a malformed cursor or limit.
   */
  read(options: ReadOptions): ReadResult {
    this.assertOpen();
    const { limit } = options;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new MimirError("validation_failed", "limit must be a positive integer", { limit });
    }
    const after = options.cursor === undefined ? 0 : decodeCursor(options.cursor);
    return this.#db.transaction((): ReadResult => {
      const prunedThrough = this.counter("pruned_through");
      if (after < prunedThrough) {
        throw new MimirError("cursor_expired", "events after this cursor are no longer retained", {
          cursor: options.cursor ?? null,
          earliestCursor: this.earliestCursor(),
        });
      }
      const latest = this.counter("global_seq");
      if (after > latest) {
        return {
          events: [],
          nextCursor: null,
          hasMore: false,
          lastCursor: encodeCursor(latest),
          gaps: 0,
        };
      }

      const where = ["global_seq > ?"];
      const params: unknown[] = [after];
      if (options.streamId !== undefined) {
        where.push("stream_id = ?");
        params.push(options.streamId);
      }
      if (options.missionId !== undefined) {
        where.push("mission_id = ?");
        params.push(options.missionId);
      }
      if (options.types && options.types.length > 0) {
        where.push(`type IN (${options.types.map(() => "?").join(", ")})`);
        params.push(...options.types);
      }
      const sql = `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY global_seq LIMIT ?`;
      let stmt = this.readCache.get(sql);
      if (!stmt) {
        stmt = this.#db.prepare(sql);
        this.readCache.set(sql, stmt);
      }
      const rows = stmt.all(...params, limit + 1) as EventRow[];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const hasMore = rows.length > limit;
      const lastCursor = last ? encodeCursor(last.global_seq) : encodeCursor(after);
      const decoded = this.decodeRows(page);
      return {
        events: decoded.events,
        nextCursor: hasMore ? lastCursor : null,
        hasMore,
        lastCursor,
        gaps: decoded.refused.length,
      };
    })();
  }

  /** Events of one stream with `sequence >= fromSequence` (sequences start at 1), in order. */
  readStream(streamId: string, fromSequence = 1): EventEnvelope[] {
    return this.readStreamWithGaps(streamId, fromSequence).events;
  }

  /**
   * Like `readStream`, plus the sequences of refused rows. A fold over a stream must treat a
   * non-empty `gaps` as missing history, not as a complete stream.
   */
  readStreamWithGaps(streamId: string, fromSequence = 1): StreamReadResult {
    this.assertOpen();
    const decoded = this.decodeRows(
      this.stmts.readStream.all(streamId, fromSequence) as EventRow[],
    );
    return { events: decoded.events, gaps: decoded.refused.map((r) => r.sequence) };
  }

  /** Refused-row summary since open; non-zero means part of the log cannot be served. */
  integrity(): StoreIntegrity {
    return { refusedRows: this.refused.size, firstRefusedAt: this.firstRefusedAt };
  }

  /** Cursor positioned at the newest assigned global_seq (reading from it returns only later events). */
  latestCursor(): string {
    this.assertOpen();
    return encodeCursor(this.counter("global_seq"));
  }

  /**
   * Cursor from which `read` returns the oldest retained event, or `null` when no events are
   * retained. Any cursor below it is expired.
   */
  earliestCursor(): string | null {
    this.assertOpen();
    const { n } = this.stmts.minGlobal.get() as { n: number | null };
    return n === null ? null : encodeCursor(n - 1);
  }

  /**
   * Retention: deletes every event at or before `throughCursor` and records the floor, so older
   * cursors fail with `cursor_expired`. global_seq values are never reused. Returns rows deleted.
   */
  prune(throughCursor: string): number {
    this.assertOpen();
    const through = Math.min(decodeCursor(throughCursor), this.counter("global_seq"));
    return this.withTransaction(() => {
      if (through <= this.counter("pruned_through")) return 0;
      this.stmts.setCounter.run(1, "allow_event_delete");
      try {
        const { changes } = this.stmts.prune.run(through);
        this.stmts.setCounter.run(through, "pruned_through");
        return changes;
      } finally {
        this.stmts.setCounter.run(0, "allow_event_delete");
      }
    });
  }

  /**
   * Cursor of each given event (the envelope does not carry its global position), in one query.
   * Ids that are unknown (or pruned) are omitted from the map.
   */
  cursorsOf(eventIds: readonly string[]): Map<string, string> {
    this.assertOpen();
    const out = new Map<string, string>();
    if (eventIds.length === 0) return out;
    const rows = this.stmts.cursorsOf.all(JSON.stringify(eventIds)) as {
      id: string;
      global_seq: number;
    }[];
    for (const r of rows) out.set(r.id, encodeCursor(r.global_seq));
    return out;
  }

  /**
   * @internal The store's own connection, for **server-owned sidecar tables only** (e.g. the
   * server's `server_projects`). Going through this connection keeps every write under the
   * store's single-writer lock. Rules: never write to Mimir-owned tables (`events`, `streams`,
   * `counters`, `commands`, `audit_entries`, `schema_migrations`); never wrap store calls in a raw
   * `db.transaction` (use `withTransaction`); never close it (use `close()`).
   */
  connection(): Db {
    this.assertOpen();
    return this.#db;
  }

  /** Registers an in-process listener called after each commit. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of registered listeners (diagnostics; lets callers verify they unsubscribed). */
  subscriberCount(): number {
    return this.listeners.size;
  }

  countByType(): Partial<Record<EventType, number>> {
    this.assertOpen();
    const out: Partial<Record<EventType, number>> = {};
    for (const r of this.stmts.countByType.all() as { type: EventType; n: number }[]) {
      out[r.type] = r.n;
    }
    return out;
  }

  /** Closes the database and releases the lock. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.pending = [];
    try {
      this.#db.close();
    } finally {
      this.lock?.release();
    }
  }

  /** Decodes rows, refusing (and reporting) any that cannot be served. */
  private decodeRows(rows: readonly EventRow[]): { events: EventEnvelope[]; refused: EventRow[] } {
    const out: EventEnvelope[] = [];
    const refused: EventRow[] = [];
    for (const row of rows) {
      const decoded = decodeRow(row);
      if ("event" in decoded) {
        out.push(decoded.event);
        continue;
      }
      refused.push(row);
      if (this.refused.has(row.id)) continue; // reported already
      this.refused.add(row.id);
      this.firstRefusedAt ??= new Date().toISOString();
      const info: CorruptRowInfo = {
        id: row.id,
        streamId: row.stream_id,
        cursor: encodeCursor(row.global_seq),
        reason: decoded.reason,
      };
      try {
        this.onCorruptRow(info);
      } catch {
        // A failing reporter must not turn a refused row back into a failed read.
      }
    }
    return { events: out, refused };
  }

  private counter(name: string): number {
    return (this.stmts.counter.get(name) as { value: number }).value;
  }

  private flush(): void {
    const queue = this.pending;
    this.pending = [];
    for (const n of queue) {
      if (this.closed) return; // a listener closed the store
      // A raw savepoint may have rolled the event back after it was queued.
      const id = n.kind === "duplicate" ? n.existing.id : n.fresh.event.id;
      if (this.stmts.exists.get(id) === undefined) continue;
      if (n.kind === "duplicate") {
        this.safely(() => this.onDuplicate?.(n.existing, n.input));
        continue;
      }
      const cursor = encodeCursor(n.fresh.globalSeq);
      for (const listener of [...this.listeners])
        this.safely(() => listener(n.fresh.event, cursor));
    }
  }

  /** Runs a callback after commit; nothing it throws may surface as a failed append. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      try {
        this.onListenerError(e);
      } catch {
        // The error handler itself failed; the append is already committed, so drop it.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MimirError("conflict", "event store is closed");
  }
}

/**
 * Opens (creating and migrating if needed) the event store at `path`. File databases take an
 * exclusive `<path>.lock`; a second open while it is held throws `MimirError('conflict')`.
 */
export function openEventStore(path: string, options: EventStoreOptions = {}): EventStore {
  const memory = path === ":memory:";
  const readOnly = options.readOnly === true && !memory;
  const lock = memory || readOnly ? undefined : acquireLock(resolve(path));
  let db: Db | undefined;
  try {
    db = openDatabase(path, { readOnly });
    if (!readOnly) migrate(db);
    return new EventStore(db, lock, options);
  } catch (e) {
    db?.close();
    lock?.release();
    throw e;
  }
}
