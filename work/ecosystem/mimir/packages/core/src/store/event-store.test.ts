import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { EventEnvelopeSchema, MimirError, newId, type EventEnvelope } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { EventStore, decodeCursor, encodeCursor, openEventStore } from "./event-store.js";
import { migrate } from "./migrate.js";
import { eventInput, tempDir } from "./test-helpers.js";

let tmp: ReturnType<typeof tempDir>;
const open: EventStore[] = [];
const track = (s: EventStore) => (open.push(s), s);
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  tmp.cleanup();
});

describe("EventStore.append", () => {
  it("assigns id, schemaVersion and a per-stream gap-free sequence starting at 1", () => {
    const store = track(openEventStore(":memory:"));
    const a = store.append(eventInput({ streamId: "s1" }));
    const b = store.append(eventInput({ streamId: "s1" }));
    const c = store.append(eventInput({ streamId: "s2" }));
    expect(a.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.schemaVersion).toBe(1);
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 1]);
    expect(EventEnvelopeSchema.parse(a)).toEqual(a);
  });

  it("round-trips every optional envelope field", () => {
    const store = track(openEventStore(":memory:"));
    const input = eventInput({
      sourceEventId: "herdr-1",
      correlationId: "corr-1",
      missionId: newId("msn"),
      crewId: newId("crw"),
      taskId: newId("tsk"),
      sessionId: newId("ses"),
      payload: { n: 1, nested: { list: [1, "two", null] } },
    });
    const ev = store.append(input);
    expect(store.read({ limit: 10 }).events).toEqual([ev]);
    expect(ev).toMatchObject(input);
  });

  it("dedupes on (source, sourceEventId): returns the existing event and inserts nothing", () => {
    const store = track(openEventStore(":memory:"));
    const first = store.append(eventInput({ source: "herdr", sourceEventId: "x1" }));
    const again = store.append(
      eventInput({ source: "herdr", sourceEventId: "x1", payload: { other: true } }),
    );
    expect(again).toEqual(first);
    expect(store.read({ limit: 10 }).events).toHaveLength(1);
    // same sourceEventId from a different source is a different event
    store.append(eventInput({ source: "other", sourceEventId: "x1" }));
    expect(store.read({ limit: 10 }).events).toHaveLength(2);
  });

  it("rejects an invalid envelope with validation_failed and writes nothing", () => {
    const store = track(openEventStore(":memory:"));
    const bad = eventInput({ type: "nope" as EventEnvelope["type"] });
    expect(() => store.append(bad)).toThrow(MimirError);
    try {
      store.append(bad);
    } catch (e) {
      expect((e as MimirError).code).toBe("validation_failed");
    }
    expect(store.read({ limit: 10 }).events).toEqual([]);
  });

  it("I7: two connections in worker_threads keep sequences gap-free and global_seq strictly increasing", async () => {
    const path = join(tmp.dir, "c.db");
    openEventStore(path).close(); // create + migrate
    const streams = Array.from({ length: 10 }, (_, i) => `stream-${i}`);
    const script = fileURLToPath(new URL("./__fixtures__/append-worker.mjs", import.meta.url));
    const startAt = Date.now() + 1000;
    await Promise.all(
      [0, 1].map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(script, {
              workerData: { path, count: 500, streams, worker, startAt },
            });
            w.on("message", () => resolve());
            w.on("error", reject);
            w.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
          }),
      ),
    );

    const raw = new Database(path, { readonly: true });
    const rows = raw
      .prepare("SELECT stream_id, sequence, global_seq, source FROM events ORDER BY rowid")
      .all() as { stream_id: string; sequence: number; global_seq: number; source: string }[];
    raw.close();
    expect(rows).toHaveLength(1000);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(["worker-0", "worker-1"]));
    for (const s of streams) {
      const seqs = rows.filter((r) => r.stream_id === s).map((r) => r.sequence);
      expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    }
    const globals = rows.map((r) => r.global_seq);
    for (let i = 1; i < globals.length; i++)
      expect(globals[i]).toBeGreaterThan(globals[i - 1] ?? 0);
    expect(new Set(globals).size).toBe(1000);
  }, 30_000);
});

describe("EventStore.appendMany", () => {
  it("appends all inputs in one transaction", () => {
    const store = track(openEventStore(":memory:"));
    const out = store.appendMany([
      eventInput({ streamId: "a" }),
      eventInput({ streamId: "a" }),
      eventInput({ streamId: "b", source: "h", sourceEventId: "1" }),
      eventInput({ streamId: "b", source: "h", sourceEventId: "1" }),
    ]);
    expect(out.map((e) => [e.streamId, e.sequence])).toEqual([
      ["a", 1],
      ["a", 2],
      ["b", 1],
      ["b", 1],
    ]);
    expect(out[3]).toEqual(out[2]);
    expect(store.read({ limit: 10 }).events).toHaveLength(3);
  });

  it("rolls back every insert when one input is invalid", () => {
    const store = track(openEventStore(":memory:"));
    expect(() =>
      store.appendMany([eventInput(), eventInput({ occurredAt: "not a date" })]),
    ).toThrow(MimirError);
    expect(store.read({ limit: 10 }).events).toEqual([]);
    expect(store.append(eventInput()).sequence).toBe(1);
  });
});

describe("EventStore.read", () => {
  it("N1: nextCursor is null exactly when hasMore is false; lastCursor keeps the resume position", () => {
    const store = track(openEventStore(":memory:"));
    const evs = Array.from({ length: 5 }, () => store.append(eventInput()));
    const p1 = store.read({ limit: 2 });
    expect(p1.events).toEqual(evs.slice(0, 2));
    expect(p1).toMatchObject({
      nextCursor: encodeCursor(2),
      lastCursor: encodeCursor(2),
      hasMore: true,
    });
    const p2 = store.read({ limit: 2, cursor: p1.nextCursor ?? "" });
    expect(p2.events).toEqual(evs.slice(2, 4));
    const p3 = store.read({ limit: 2, cursor: p2.nextCursor ?? "" });
    expect(p3.events).toEqual(evs.slice(4));
    expect(p3).toMatchObject({ nextCursor: null, lastCursor: encodeCursor(5), hasMore: false });
    // an exactly-full last page also ends with null
    expect(store.read({ limit: 1, cursor: encodeCursor(4) })).toMatchObject({
      nextCursor: null,
      hasMore: false,
    });
    // an empty page keeps the input cursor as lastCursor
    const p4 = store.read({ limit: 2, cursor: p3.lastCursor });
    expect(p4).toEqual({
      events: [],
      nextCursor: null,
      lastCursor: p3.lastCursor,
      hasMore: false,
      gaps: 0,
    });
    const later = store.append(eventInput());
    expect(store.read({ limit: 2, cursor: p4.lastCursor }).events).toEqual([later]);
  });

  it("N1: a loop on `while (nextCursor)` terminates and sees every event", () => {
    const store = track(openEventStore(":memory:"));
    const evs = Array.from({ length: 7 }, () => store.append(eventInput()));
    const got: EventEnvelope[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = store.read({ limit: 3, ...(cursor ? { cursor } : {}) });
      got.push(...page.events);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(got).toEqual(evs);
  });

  it("N1: an empty store read without a cursor returns the start position as lastCursor", () => {
    const store = track(openEventStore(":memory:"));
    expect(store.read({ limit: 5 })).toEqual({
      events: [],
      nextCursor: null,
      lastCursor: encodeCursor(0),
      hasMore: false,
      gaps: 0,
    });
  });

  it("filters by streamId, missionId and types", () => {
    const store = track(openEventStore(":memory:"));
    const m1 = newId("msn");
    const m2 = newId("msn");
    const a = store.append(eventInput({ streamId: "x", missionId: m1, type: "mission.created" }));
    const b = store.append(eventInput({ streamId: "y", missionId: m1, type: "task.created" }));
    const c = store.append(eventInput({ streamId: "x", missionId: m2, type: "task.created" }));
    expect(store.read({ limit: 10, streamId: "x" }).events).toEqual([a, c]);
    expect(store.read({ limit: 10, missionId: m1 }).events).toEqual([a, b]);
    expect(store.read({ limit: 10, types: ["task.created"] }).events).toEqual([b, c]);
    expect(store.read({ limit: 10, types: ["task.created"], missionId: m1 }).events).toEqual([b]);
    expect(store.read({ limit: 10, types: [] }).events).toEqual([a, b, c]);
  });

  it("rejects a malformed cursor or limit with validation_failed", () => {
    const store = track(openEventStore(":memory:"));
    for (const args of [
      { limit: 10, cursor: "!!!" },
      { limit: 10, cursor: Buffer.from("abc").toString("base64") },
      { limit: 0 },
      { limit: 1.5 },
    ]) {
      expect(() => store.read(args)).toThrow(
        expect.objectContaining({ code: "validation_failed" }),
      );
    }
  });

  it("latestCursor points at the newest event; reading from it yields nothing new", () => {
    const store = track(openEventStore(":memory:"));
    expect(store.read({ limit: 10, cursor: store.latestCursor() }).events).toEqual([]);
    store.append(eventInput());
    store.append(eventInput());
    const cur = store.latestCursor();
    expect(cur).toBe(Buffer.from("2").toString("base64"));
    expect(store.read({ limit: 10, cursor: cur }).events).toEqual([]);
    const next = store.append(eventInput());
    expect(store.read({ limit: 10, cursor: cur }).events).toEqual([next]);
  });

  it("readStream returns one stream from a sequence (inclusive)", () => {
    const store = track(openEventStore(":memory:"));
    const s = [1, 2, 3, 4].map(() => store.append(eventInput({ streamId: "st" })));
    store.append(eventInput({ streamId: "other" }));
    expect(store.readStream("st", 3)).toEqual(s.slice(2));
    expect(store.readStream("st")).toEqual(s);
    expect(store.readStream("missing")).toEqual([]);
  });

  it("countByType counts events per type", () => {
    const store = track(openEventStore(":memory:"));
    store.append(eventInput({ type: "task.created" }));
    store.append(eventInput({ type: "task.created" }));
    store.append(eventInput({ type: "mission.created" }));
    expect(store.countByType()).toEqual({ "task.created": 2, "mission.created": 1 });
  });
});

describe("EventStore.subscribe", () => {
  it("subscriberCount reflects registered listeners", () => {
    const store = track(openEventStore(":memory:"));
    expect(store.subscriberCount()).toBe(0);
    const off = store.subscribe(() => undefined);
    expect(store.subscriberCount()).toBe(1);
    off();
    expect(store.subscriberCount()).toBe(0);
  });

  it("notifies listeners after commit with event and cursor, not for dedupes or rollbacks", () => {
    const store = track(openEventStore(":memory:"));
    const seen: [string, string][] = [];
    const unsubscribe = store.subscribe((ev, cursor) => {
      // the event must already be readable when the listener runs
      expect(store.read({ limit: 100 }).events.map((e) => e.id)).toContain(ev.id);
      seen.push([ev.id, cursor]);
    });
    const a = store.append(eventInput({ source: "h", sourceEventId: "1" }));
    store.append(eventInput({ source: "h", sourceEventId: "1" }));
    const many = store.appendMany([eventInput(), eventInput()]);
    expect(() => store.appendMany([eventInput(), eventInput({ observedAt: "bad" })])).toThrow();
    expect(seen).toEqual([
      [a.id, Buffer.from("1").toString("base64")],
      [many[0]?.id, Buffer.from("2").toString("base64")],
      [many[1]?.id, Buffer.from("3").toString("base64")],
    ]);
    unsubscribe();
    store.append(eventInput());
    expect(seen).toHaveLength(3);
  });

  it("a throwing listener does not break append or other listeners", () => {
    const errors: unknown[] = [];
    const store = track(openEventStore(":memory:", { onListenerError: (e) => errors.push(e) }));
    let got = 0;
    store.subscribe(() => {
      throw new Error("boom");
    });
    store.subscribe(() => got++);
    expect(() => store.append(eventInput())).not.toThrow();
    expect(got).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

describe("EventStore redaction", () => {
  it("never writes a nested token to disk", () => {
    const path = join(tmp.dir, "r.db");
    const store = track(openEventStore(path));
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const ev = store.append(
      eventInput({ payload: { deep: { list: [{ header: `Bearer ${token}` }, token] } } }),
    );
    expect(JSON.stringify(ev.payload)).not.toContain(token);
    const raw = new Database(path, { readonly: true });
    const row = raw.prepare("SELECT payload FROM events WHERE id = ?").get(ev.id) as {
      payload: string;
    };
    raw.close();
    expect(row.payload).not.toContain(token);
    expect(JSON.parse(row.payload)).toEqual({
      deep: { list: [{ header: "Bearer [REDACTED:bearer]" }, "[REDACTED:github_token]"] },
    });
  });

  it("uses a custom payloadRedactor when given", () => {
    const store = track(
      openEventStore(":memory:", { payloadRedactor: () => ({ replaced: true }) }),
    );
    expect(store.append(eventInput({ payload: { a: 1 } })).payload).toEqual({ replaced: true });
  });
});

describe("EventStore bounded payloads", () => {
  it("replaces payloads over the limit with a truncation marker", () => {
    const store = track(openEventStore(":memory:", { maxPayloadBytes: 1024 }));
    const big = { text: "x".repeat(5000) };
    const ev = store.append(eventInput({ payload: big }));
    const originalBytes = Buffer.byteLength(JSON.stringify(big));
    expect(ev.payload).toMatchObject({ truncated: true, originalBytes });
    expect(Buffer.byteLength(JSON.stringify(ev.payload))).toBeLessThanOrEqual(1024);
    expect(store.read({ limit: 1 }).events[0]?.payload).toEqual(ev.payload);
    const small = store.append(eventInput({ payload: { text: "ok" } }));
    expect(small.payload).toEqual({ text: "ok" });
  });

  it("defaults to 256 KiB and honours MIMIR_MAX_PAYLOAD_BYTES", () => {
    const store = track(openEventStore(":memory:"));
    const under = { t: "y".repeat(200 * 1024) };
    expect(store.append(eventInput({ payload: under })).payload).toEqual(under);
    const over = { t: "y".repeat(257 * 1024) };
    expect(store.append(eventInput({ payload: over })).payload).toMatchObject({ truncated: true });

    const prev = process.env.MIMIR_MAX_PAYLOAD_BYTES;
    process.env.MIMIR_MAX_PAYLOAD_BYTES = "300";
    try {
      const envStore = track(openEventStore(":memory:"));
      expect(
        envStore.append(eventInput({ payload: { t: "z".repeat(400) } })).payload,
      ).toMatchObject({
        truncated: true,
      });
    } finally {
      if (prev === undefined) delete process.env.MIMIR_MAX_PAYLOAD_BYTES;
      else process.env.MIMIR_MAX_PAYLOAD_BYTES = prev;
    }
  });
});

describe("EventStore persistence and locking", () => {
  it("reads back identical events after close and reopen", () => {
    const path = join(tmp.dir, "p.db");
    const s1 = openEventStore(path);
    const written = s1.appendMany(
      Array.from({ length: 20 }, (_, i) =>
        eventInput({ streamId: `s${i % 3}`, missionId: newId("msn"), payload: { i } }),
      ),
    );
    const cursor = s1.latestCursor();
    s1.close();
    const s2 = track(openEventStore(path));
    expect(s2.read({ limit: 100 }).events).toEqual(written);
    expect(s2.latestCursor()).toBe(cursor);
    expect(s2.append(eventInput({ streamId: "s0" })).sequence).toBe(8);
  });

  it("a second open on the same path throws conflict until the first closes", () => {
    const path = join(tmp.dir, "l.db");
    const first = openEventStore(path);
    let err: unknown;
    try {
      openEventStore(path);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MimirError);
    expect((err as MimirError).code).toBe("conflict");
    expect((err as MimirError).message).toBe("another Mimir server owns this database");
    first.close();
    first.close(); // idempotent
    track(openEventStore(path)).append(eventInput());
  });

  it("':memory:' stores do not lock", () => {
    track(openEventStore(":memory:"));
    expect(() => track(openEventStore(":memory:"))).not.toThrow();
  });
});

describe("fix round 1: retention and cursor expiry (I4)", () => {
  it("earliestCursor is null when empty and points before the oldest retained event", () => {
    const store = track(openEventStore(":memory:"));
    expect(store.earliestCursor()).toBeNull();
    const [a] = [store.append(eventInput()), store.append(eventInput())];
    expect(store.earliestCursor()).toBe(encodeCursor(0));
    expect(store.read({ limit: 1, cursor: store.earliestCursor() ?? "" }).events).toEqual([a]);
  });

  it("read with a cursor below the retained minimum throws cursor_expired", () => {
    const store = track(openEventStore(":memory:"));
    const evs = Array.from({ length: 5 }, () => store.append(eventInput()));
    expect(store.prune(encodeCursor(3))).toBe(3);
    expect(store.earliestCursor()).toBe(encodeCursor(3));
    for (const c of [undefined, encodeCursor(0), encodeCursor(2)]) {
      expect(() => store.read({ limit: 10, ...(c ? { cursor: c } : {}) })).toThrow(
        expect.objectContaining({ code: "cursor_expired" }),
      );
    }
    expect(store.read({ limit: 10, cursor: encodeCursor(3) }).events).toEqual(evs.slice(3));
  });

  it("global_seq never restarts after pruning everything", () => {
    const store = track(openEventStore(":memory:"));
    store.append(eventInput());
    store.append(eventInput());
    const before = store.latestCursor();
    store.prune(before);
    expect(store.earliestCursor()).toBeNull();
    expect(store.latestCursor()).toBe(before);
    const next = store.append(eventInput());
    expect(store.read({ limit: 10, cursor: before }).events).toEqual([next]);
    expect(store.latestCursor()).toBe(encodeCursor(3));
  });

  it("a cursor past the end returns an empty page whose lastCursor is the latest cursor", () => {
    const store = track(openEventStore(":memory:"));
    store.append(eventInput());
    expect(store.read({ limit: 10, cursor: encodeCursor(99) })).toEqual({
      events: [],
      nextCursor: null,
      lastCursor: encodeCursor(1),
      hasMore: false,
      gaps: 0,
    });
  });
});

describe("fix round 1: subscriber fan-out after the outermost commit (I6)", () => {
  it("withTransaction delivers after commit and nothing on rollback", () => {
    const path = join(tmp.dir, "tx.db");
    const store = track(openEventStore(path));
    const seen: string[] = [];
    store.subscribe((ev) => {
      // committed: visible to an independent connection
      const raw = new Database(path, { readonly: true });
      expect(raw.prepare("SELECT id FROM events WHERE id = ?").get(ev.id)).toEqual({ id: ev.id });
      raw.close();
      seen.push(ev.id);
    });
    const committed = store.withTransaction(() => {
      const a = store.append(eventInput());
      const b = store.appendMany([eventInput()]);
      expect(seen).toEqual([]);
      return [a, ...b];
    });
    expect(seen).toEqual(committed.map((e) => e.id));

    expect(() =>
      store.withTransaction(() => {
        store.append(eventInput());
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(seen).toHaveLength(2);
    expect(store.read({ limit: 10 }).events).toHaveLength(2);
    store.append(eventInput());
    expect(seen).toHaveLength(3);
  });

  it("an inner withTransaction that throws and is caught drops only its own events", () => {
    const store = track(openEventStore(":memory:"));
    const seen: string[] = [];
    store.subscribe((ev) => seen.push(ev.id));
    const kept = store.withTransaction(() => {
      const a = store.append(eventInput());
      try {
        store.withTransaction(() => {
          store.append(eventInput());
          throw new Error("inner");
        });
      } catch {
        // swallowed on purpose
      }
      return a;
    });
    expect(seen).toEqual([kept.id]);
    expect(store.read({ limit: 10 }).events).toEqual([kept]);
  });

  it("N2: the store does not expose its connection", () => {
    const store = track(openEventStore(":memory:"));
    expect((store as unknown as Record<string, unknown>).db).toBeUndefined();
    expect(Object.keys(store)).not.toContain("db");
  });

  it("N2: an append rolled back by a raw savepoint nested inside withTransaction is not delivered", () => {
    // Only reachable by a caller that built the store around its own connection.
    const db = openDatabase(":memory:");
    migrate(db);
    const store = new EventStore(db, undefined);
    const seen: unknown[] = [];
    store.subscribe((ev) => seen.push((ev.payload as { n: number }).n));
    store.withTransaction(() => {
      try {
        db.transaction(() => {
          store.append(eventInput({ payload: { n: 1 } }));
          throw new Error("raw rollback");
        })();
      } catch {
        // swallowed on purpose
      }
      store.append(eventInput({ payload: { n: 2 } }));
    });
    expect(store.read({ limit: 10 }).events.map((e) => (e.payload as { n: number }).n)).toEqual([
      2,
    ]);
    expect(seen).toEqual([2]);
    store.close();
  });

  it("refuses to append inside a raw outer transaction it cannot observe", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const store = new EventStore(db, undefined);
    const seen: string[] = [];
    store.subscribe((ev) => seen.push(ev.id));
    expect(() =>
      db.transaction(() => {
        store.append(eventInput());
      })(),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(seen).toEqual([]);
    expect(store.read({ limit: 10 }).events).toEqual([]);
    store.close();
  });
});

describe("fix round 1: minors", () => {
  it("M1: rejects cursors beyond 2^53 and non-canonical base64", () => {
    const store = track(openEventStore(":memory:"));
    for (const cursor of [Buffer.from("99999999999999999999").toString("base64"), "MQ", "MQ=="]) {
      if (cursor === "MQ==") {
        expect(() => store.read({ limit: 1, cursor })).not.toThrow();
        continue;
      }
      expect(() => store.read({ limit: 1, cursor })).toThrow(
        expect.objectContaining({ code: "validation_failed" }),
      );
    }
    expect(() => decodeCursor("MDE=")).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
  });

  it("M2: subscribe after close throws", () => {
    const store = openEventStore(":memory:");
    store.close();
    expect(() => store.subscribe(() => undefined)).toThrow(MimirError);
  });

  it("M4: maxPayloadBytes below the marker size is rejected", () => {
    expect(() => openEventStore(":memory:", { maxPayloadBytes: 5 })).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
  });

  it("M5: events are append-only at the SQL level", () => {
    const path = join(tmp.dir, "m5.db");
    const store = openEventStore(path);
    const ev = store.append(eventInput());
    store.close();
    const raw = new Database(path);
    expect(() => raw.prepare("UPDATE events SET type = 'x' WHERE id = ?").run(ev.id)).toThrow(
      /append-only/,
    );
    expect(() => raw.prepare("DELETE FROM events WHERE id = ?").run(ev.id)).toThrow(/append-only/);
    raw.close();
  });

  it("M6: an onListenerError that throws does not make a committed append look failed", () => {
    const store = track(
      openEventStore(":memory:", {
        onListenerError: () => {
          throw new Error("handler broke");
        },
      }),
    );
    store.subscribe(() => {
      throw new Error("listener broke");
    });
    expect(() => store.append(eventInput())).not.toThrow();
    expect(store.read({ limit: 10 }).events).toHaveLength(1);
  });

  it("M8: onDuplicate reports a dedupe hit whose type or stream differs", () => {
    const dupes: [string, string][] = [];
    const store = track(
      openEventStore(":memory:", {
        onDuplicate: (existing, input) => dupes.push([existing.type, input.type]),
      }),
    );
    store.append(eventInput({ source: "h", sourceEventId: "1", type: "task.created" }));
    store.append(eventInput({ source: "h", sourceEventId: "1", type: "task.created" }));
    expect(dupes).toEqual([]);
    store.append(eventInput({ source: "h", sourceEventId: "1", type: "task.failed" }));
    expect(dupes).toEqual([["task.created", "task.failed"]]);
  });
});

describe("fix round 3: cursorsOf and connection()", () => {
  it("cursorsOf maps each known event id to its cursor; unknown ids are omitted", () => {
    const store = track(openEventStore(":memory:"));
    const evs = Array.from({ length: 3 }, () => store.append(eventInput()));
    const page = store.read({ limit: 10 });
    const ids = [...evs.map((e) => e.id), "evt_unknown"];
    const map = store.cursorsOf(ids);
    expect(map).toEqual(
      new Map([
        [evs[0]?.id, encodeCursor(1)],
        [evs[1]?.id, encodeCursor(2)],
        [evs[2]?.id, encodeCursor(3)],
      ]),
    );
    expect(map.get(page.events[2]?.id ?? "")).toBe(page.lastCursor);
    expect(store.cursorsOf([])).toEqual(new Map());
  });

  it("cursorsOf handles more ids than SQLite's parameter limit in one call", () => {
    const store = track(openEventStore(":memory:"));
    const evs = store.appendMany(Array.from({ length: 1200 }, () => eventInput()));
    const map = store.cursorsOf(evs.map((e) => e.id));
    expect(map.size).toBe(1200);
    expect(map.get(evs[1199]?.id ?? "")).toBe(encodeCursor(1200));
  });

  it("connection() returns the store's own connection for server-owned sidecar tables", () => {
    const store = track(openEventStore(":memory:"));
    const db = store.connection();
    db.exec("CREATE TABLE IF NOT EXISTS sidecar_test (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO sidecar_test VALUES ('a')").run();
    expect(db.prepare("SELECT id FROM sidecar_test").all()).toEqual([{ id: "a" }]);
    expect((store as unknown as Record<string, unknown>).db).toBeUndefined();
    store.close();
    expect(() => store.connection()).toThrow(MimirError);
  });
});

describe("openEventStore readOnly", () => {
  it("reads while another store holds the lock, takes no lock, and refuses writes", () => {
    const path = join(tmp.dir, "ro.db");
    const writer = track(openEventStore(path));
    const ev = writer.append(eventInput());
    const reader = track(openEventStore(path, { readOnly: true }));
    expect(reader.read({ limit: 10 }).events).toEqual([ev]);
    expect(() => reader.append(eventInput())).toThrow();
    reader.close();
    expect(() => writer.append(eventInput())).not.toThrow();
  });
  it("fails when the file does not exist and creates nothing", () => {
    const path = join(tmp.dir, "missing.db");
    expect(() => openEventStore(path, { readOnly: true })).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("T14a chaos: corrupt event rows", () => {
  /** Writes a row straight into SQLite (bypassing the store), as a torn or tampered write would. */
  function injectRow(path: string, over: { type?: string; payload: string; streamId?: string }) {
    const raw = new Database(path);
    try {
      raw.transaction(() => {
        const g = (
          raw
            .prepare(
              "UPDATE counters SET value = value + 1 WHERE name = 'global_seq' RETURNING value",
            )
            .get() as { value: number }
        ).value;
        const streamId = over.streamId ?? "mission-1";
        const seq = (
          raw
            .prepare(
              `INSERT INTO streams (stream_id, last_sequence) VALUES (?, 1)
               ON CONFLICT (stream_id) DO UPDATE SET last_sequence = last_sequence + 1
               RETURNING last_sequence`,
            )
            .get(streamId) as { last_sequence: number }
        ).last_sequence;
        const now = new Date().toISOString();
        raw
          .prepare(
            `INSERT INTO events (id, stream_id, sequence, global_seq, type, provenance, source,
               occurred_at, observed_at, payload)
             VALUES (?, ?, ?, ?, ?, 'observed', 'chaos', ?, ?, ?)`,
          )
          .run(newId("evt"), streamId, seq, g, over.type ?? "task.created", now, now, over.payload);
      })();
    } finally {
      raw.close();
    }
  }

  function setup() {
    const path = join(tmp.dir, "events.db");
    const corrupt: { id: string; cursor: string; reason: string }[] = [];
    const store = track(openEventStore(path, { onCorruptRow: (info) => corrupt.push(info) }));
    store.append(eventInput({ payload: { title: "before" } }));
    injectRow(path, { payload: '{"title":"trunc' });
    store.append(eventInput({ payload: { title: "after" } }));
    return { store, corrupt, path };
  }

  it("read() refuses a row whose payload is truncated JSON, reports it, and serves the rest", () => {
    const { store, corrupt } = setup();
    const page = store.read({ limit: 10 });
    expect(page.events.map((e) => (e.payload as { title: string }).title)).toEqual([
      "before",
      "after",
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.lastCursor).toBe(encodeCursor(3));
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]).toMatchObject({ cursor: encodeCursor(2) });
    expect(corrupt[0]?.reason).toMatch(/payload/);
  });

  it("paging across the corrupt row keeps moving the cursor past it", () => {
    const { store } = setup();
    const p1 = store.read({ limit: 1 });
    const p2 = store.read({ limit: 1, cursor: p1.lastCursor });
    expect(p2.events).toEqual([]);
    expect(p2.hasMore).toBe(true);
    expect(p2.lastCursor).toBe(encodeCursor(2));
    const p3 = store.read({ limit: 1, cursor: p2.lastCursor });
    expect(p3.events.map((e) => (e.payload as { title: string }).title)).toEqual(["after"]);
  });

  it("readStream refuses the corrupt row and keeps the others", () => {
    const { store } = setup();
    expect(store.readStream("mission-1").map((e) => e.sequence)).toEqual([1, 3]);
  });

  it("refuses a row with an event type this build does not know", () => {
    const { store, corrupt, path } = setup();
    injectRow(path, { type: "bogus.type", payload: "{}" });
    store.append(eventInput({ payload: { title: "last" } }));
    expect(store.read({ limit: 10 }).events).toHaveLength(3);
    expect(corrupt.map((c) => c.reason)).toEqual([
      expect.stringMatching(/payload/),
      expect.stringMatching(/type/),
    ]);
  });

  it("fix I1: reports each refused row once, however often it is read", () => {
    const { store, corrupt } = setup();
    store.read({ limit: 10 });
    store.read({ limit: 10 });
    store.readStream("mission-1");
    store.read({ limit: 1, cursor: encodeCursor(1) });
    expect(corrupt).toHaveLength(1);
  });

  it("fix I1: integrity() counts distinct refused rows and when the first was seen", () => {
    const path = join(tmp.dir, "integrity.db");
    const store = track(openEventStore(path, { onCorruptRow: () => undefined }));
    expect(store.integrity()).toEqual({ refusedRows: 0, firstRefusedAt: null });
    store.append(eventInput());
    injectRow(path, { payload: '{"a":' });
    injectRow(path, { type: "bogus.type", payload: "{}" });
    const before = Date.now();
    store.read({ limit: 10 });
    store.read({ limit: 10 });
    const integrity = store.integrity();
    expect(integrity.refusedRows).toBe(2);
    expect(Date.parse(integrity.firstRefusedAt as string)).toBeGreaterThanOrEqual(before - 1);
  });

  it("fix I1: read() reports how many rows it refused in the page as gaps", () => {
    const { store } = setup();
    expect(store.read({ limit: 10 }).gaps).toBe(1);
    expect(store.read({ limit: 1 }).gaps).toBe(0);
    expect(store.read({ limit: 1, cursor: encodeCursor(1) }).gaps).toBe(1);
  });

  it("fix I1: readStreamWithGaps names the per-stream sequences it refused", () => {
    const { store } = setup();
    const r = store.readStreamWithGaps("mission-1");
    expect(r.events.map((e) => e.sequence)).toEqual([1, 3]);
    expect(r.gaps).toEqual([2]);
    expect(store.readStreamWithGaps("mission-1", 3).gaps).toEqual([]);
  });

  it("appends after the corrupt row keep working and a fresh open still reads", () => {
    const { store, path } = setup();
    store.close();
    const reopened = track(openEventStore(path, { onCorruptRow: () => undefined }));
    expect(reopened.read({ limit: 10 }).events).toHaveLength(2);
  });
});

describe("T14a fix M1: payload depth bound", () => {
  const nested = (depth: number): unknown => {
    let v: unknown = [];
    for (let i = 1; i < depth; i++) v = [v];
    return v;
  };

  it("append refuses a payload nested deeper than 64 levels before redaction runs", () => {
    const store = track(openEventStore(":memory:"));
    expect(() => store.append(eventInput({ payload: nested(65) }))).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
    expect(() => store.append(eventInput({ payload: nested(200_000) }))).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
    expect(store.read({ limit: 10 }).events).toEqual([]);
    store.append(eventInput({ payload: nested(64) }));
    expect(store.read({ limit: 10 }).events).toHaveLength(1);
  });
});
