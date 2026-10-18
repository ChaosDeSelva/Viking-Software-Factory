import Database from "better-sqlite3";
import { join } from "node:path";
import { MimirError } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandLedger, hashRequest } from "./command-ledger.js";
import { openDatabase, type Db } from "./db.js";
import { openEventStore } from "./event-store.js";
import { migrate } from "./migrate.js";
import { tempDir } from "./test-helpers.js";

let db: Db;
let ledger: CommandLedger;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  ledger = new CommandLedger(db);
});
afterEach(() => db.close());

describe("hashRequest", () => {
  it("is stable under key order and differs by kind or content", () => {
    expect(hashRequest("k", { a: 1, b: { c: 2, d: 3 } })).toBe(
      hashRequest("k", { b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(hashRequest("k", { a: 1 })).not.toBe(hashRequest("k", { a: 2 }));
    expect(hashRequest("k1", { a: 1 })).not.toBe(hashRequest("k2", { a: 1 }));
    expect(hashRequest("k", { a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("CommandLedger", () => {
  it("begin returns fresh for a new key and records an accepted command", () => {
    const r = ledger.begin("key-1", "mission.start", { missionId: "m" });
    expect("fresh" in r).toBe(true);
    if (!("fresh" in r)) return;
    expect(r.fresh).toMatchObject({
      idempotencyKey: "key-1",
      kind: "mission.start",
      status: "accepted",
      request: { missionId: "m" },
      response: null,
      error: null,
      requestHash: hashRequest("mission.start", { missionId: "m" }),
    });
    expect(r.fresh.id).toMatch(/^cmd_/);
    expect(r.fresh.createdAt).toBe(r.fresh.updatedAt);
  });

  it("same key and same request replays the stored response", () => {
    const first = ledger.begin("key-2", "k", { x: 1 });
    if (!("fresh" in first)) throw new Error("expected fresh");
    const done = ledger.succeed(first.fresh.id, { operationId: "op" });
    expect(done.status).toBe("succeeded");
    const again = ledger.begin("key-2", "k", { x: 1 });
    expect(again).toEqual({ replay: done });
    expect(db.prepare("SELECT COUNT(*) AS n FROM commands").get()).toEqual({ n: 1 });
  });

  it("replays a command that is still in flight", () => {
    const first = ledger.begin("key-3", "k", { x: 1 });
    const again = ledger.begin("key-3", "k", { x: 1 });
    if (!("fresh" in first)) throw new Error("expected fresh");
    expect(again).toEqual({ replay: first.fresh });
  });

  it("same key with a different request throws idempotency_replay_mismatch", () => {
    ledger.begin("key-4", "k", { x: 1 });
    let err: unknown;
    try {
      ledger.begin("key-4", "k", { x: 2 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MimirError);
    expect((err as MimirError).code).toBe("idempotency_replay_mismatch");
    expect(() => ledger.begin("key-4", "other", { x: 1 })).toThrow(
      expect.objectContaining({ code: "idempotency_replay_mismatch" }),
    );
  });

  it("fail records the error; finished commands cannot transition again", () => {
    const r = ledger.begin("key-5", "k", {});
    if (!("fresh" in r)) throw new Error("expected fresh");
    const failed = ledger.fail(r.fresh.id, { code: "internal", message: "x" });
    expect(failed).toMatchObject({ status: "failed", error: { code: "internal", message: "x" } });
    expect(ledger.get(r.fresh.id)).toEqual(failed);
    expect(() => ledger.succeed(r.fresh.id, {})).toThrow(
      expect.objectContaining({ code: "invalid_transition" }),
    );
  });

  it("unknown ids throw not_found", () => {
    expect(() => ledger.succeed("cmd_nope", {})).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    expect(ledger.get("cmd_nope")).toBeUndefined();
  });

  it("redacts secrets in stored request, response and error", () => {
    const tmp = tempDir();
    try {
      const path = join(tmp.dir, "l.db");
      const store = openEventStore(path);
      const secret = "AKIAIOSFODNN7EXAMPLE";
      const r = store.commands.begin("key-6", "session.input", { text: `use ${secret}` });
      if (!("fresh" in r)) throw new Error("expected fresh");
      store.commands.succeed(r.fresh.id, { echoed: secret });
      store.close();
      const raw = new Database(path, { readonly: true });
      const row = raw.prepare("SELECT request, response FROM commands").get() as Record<
        string,
        string
      >;
      raw.close();
      expect(JSON.stringify(row)).not.toContain(secret);
      // replay still matches on the original (unredacted) request
      const again = openEventStore(path);
      expect(
        "replay" in again.commands.begin("key-6", "session.input", { text: `use ${secret}` }),
      ).toBe(true);
      again.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("CommandLedger boot recovery (fix round 1: I8)", () => {
  it("listInFlight returns unfinished commands and markInterrupted fails them", () => {
    const tmp = tempDir();
    try {
      const path = join(tmp.dir, "boot.db");
      const s1 = openEventStore(path);
      const a = s1.commands.begin("k-a", "mission.start", { id: 1 });
      const b = s1.commands.begin("k-b", "mission.start", { id: 2 });
      if (!("fresh" in a) || !("fresh" in b)) throw new Error("expected fresh");
      s1.commands.succeed(b.fresh.id, { ok: true });
      s1.close(); // simulated crash: k-a never finished

      const s2 = openEventStore(path);
      const inFlight = s2.commands.listInFlight();
      expect(inFlight.map((c) => c.id)).toEqual([a.fresh.id]);
      const marked = s2.commands.markInterrupted(a.fresh.id);
      expect(marked.status).toBe("failed");
      expect(marked.error).toMatchObject({ code: "internal", interrupted: true });
      expect(s2.commands.listInFlight()).toEqual([]);
      expect(s2.commands.begin("k-a", "mission.start", { id: 1 })).toEqual({ replay: marked });
      expect(() => s2.commands.markInterrupted(a.fresh.id)).toThrow(
        expect.objectContaining({ code: "invalid_transition" }),
      );
      s2.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("T14a fix M1: request depth bound", () => {
  const nested = (depth: number): unknown => {
    let v: unknown = [];
    for (let i = 1; i < depth; i++) v = [v];
    return v;
  };

  it("begin refuses a request nested deeper than 64 levels with validation_failed", () => {
    expect(() => ledger.begin("deep", "x", nested(65))).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
    expect(() => ledger.begin("very-deep", "x", nested(200_000))).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
    expect(ledger.getByKey("deep")).toBeFalsy();
    expect("fresh" in ledger.begin("ok", "x", nested(64))).toBe(true);
  });
});
