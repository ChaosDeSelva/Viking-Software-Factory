import { join } from "node:path";
import { openDatabase, openEventStore, type CorruptRowInfo } from "@mimir/core";
import {
  injectCorruptEventRow,
  openSse,
  spawnMimir,
  type MimirProcess,
  type SqlDb,
} from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH, eventInput, makeServer, type TestServer } from "../../src/test-helpers.js";
import { MAIN, readAllEvents, serverSpawn, tempDataDir } from "./support.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A file-backed store holding good, corrupt, good, corrupt (unknown type), good. */
function seededStore() {
  const tmp = tempDataDir();
  cleanups.push(tmp.cleanup);
  const path = join(tmp.dir, "mimir.db");
  const corrupt: CorruptRowInfo[] = [];
  const store = openEventStore(path, { onCorruptRow: (info) => corrupt.push(info) });
  const raw = openDatabase(path);
  store.append(eventInput({ source: "t", sourceEventId: "good-1" }));
  injectCorruptEventRow(raw as unknown as SqlDb);
  store.append(eventInput({ source: "t", sourceEventId: "good-2" }));
  injectCorruptEventRow(raw as unknown as SqlDb, { type: "not.a.type", payload: "{}" });
  store.append(eventInput({ source: "t", sourceEventId: "good-3" }));
  raw.close();
  return { store, corrupt, dir: tmp.dir };
}

describe("chaos: corrupt partial event row", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("the server boots on a log with corrupt rows; GET /v1/events skips them and serves the rest", async () => {
    const { store, corrupt } = seededStore();
    server = makeServer({}, store);
    const res = await server.app.inject({ url: "/v1/events?limit=1000", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: { sourceEventId?: string }[]; nextCursor: null };
    expect(body.events.map((e) => e.sourceEventId)).toEqual(["good-1", "good-2", "good-3"]);
    expect(body.nextCursor).toBeNull();
    // Boot (ReadModel.load) already met both rows; repeated reads do not report them again.
    await server.app.inject({ url: "/v1/events?limit=1000", headers: AUTH });
    expect(corrupt).toHaveLength(2);
    expect(new Set(corrupt.map((c) => c.cursor)).size).toBe(2);
  });

  it("fix I1: GET /v1/health is degraded with the integrity summary once rows were refused", async () => {
    const { store } = seededStore();
    server = makeServer({ runtime: null }, store);
    const res = await server.app.inject({ url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      integrity: { refusedRows: number; firstRefusedAt: string | null };
    };
    expect(body.status).toBe("degraded");
    expect(body.integrity.refusedRows).toBe(2);
    expect(typeof body.integrity.firstRefusedAt).toBe("string");
  });

  it("fix I1: a clean log reports status ok with zero refused rows", async () => {
    server = makeServer({ runtime: null });
    const res = await server.app.inject({ url: "/v1/health" });
    expect(res.json()).toEqual({
      status: "ok",
      integrity: { refusedRows: 0, firstRefusedAt: null },
    });
  });

  it("small pages step over the corrupt rows without stalling", async () => {
    const { store } = seededStore();
    server = makeServer({}, store);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await server.app.inject({ url: `/v1/events?limit=1${q}`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      const page = res.json() as {
        events: { sourceEventId: string }[];
        nextCursor: string | null;
      };
      seen.push(...page.events.map((e) => e.sourceEventId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["good-1", "good-2", "good-3"]);
  });

  it("SSE replay from the start delivers the good events and then goes live", async () => {
    const { store } = seededStore();
    server = makeServer({}, store);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = server.app.server.address() as { port: number };
    const sse = await openSse(`http://127.0.0.1:${addr.port}/v1/events/stream?cursor=MA==`, AUTH);
    cleanups.push(() => sse.close());
    const got: string[] = [];
    while (got.length < 3) {
      const m = await sse.next(5000);
      if (m.event === "error") throw new Error(`stream error ${m.data}`);
      if (m.data !== undefined)
        got.push((JSON.parse(m.data) as { sourceEventId: string }).sourceEventId);
    }
    store.append(eventInput({ source: "t", sourceEventId: "live-1" }));
    for (;;) {
      const m = await sse.next(5000);
      if (m.data === undefined) continue;
      got.push((JSON.parse(m.data) as { sourceEventId: string }).sourceEventId);
      break;
    }
    expect(got).toEqual(["good-1", "good-2", "good-3", "live-1"]);
  });

  it("main.ts starts on a data dir with a corrupt row, serves the rest and logs the refusal", async () => {
    const { store, dir } = seededStore();
    store.close();
    const p: MimirProcess = await spawnMimir(serverSpawn(MAIN, dir));
    cleanups.push(async () => void (await p.kill("SIGKILL")));
    const { events } = await readAllEvents(p.url, p.token);
    expect(events.map((e) => e.sourceEventId)).toEqual(["good-1", "good-2", "good-3"]);
    await p.waitForLine(/corrupt event row/i, 5000);
  });
});
