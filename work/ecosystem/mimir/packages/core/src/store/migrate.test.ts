import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { listMigrations, migrate } from "./migrate.js";

const dirs: string[] = [];
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-migrate-"));
  dirs.push(dir);
  return join(dir, "mimir.db");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tableNames = (db: ReturnType<typeof openDatabase>) =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

describe("openDatabase", () => {
  it("enables WAL, foreign keys and busy_timeout on a file db", () => {
    const db = openDatabase(tempDb());
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
  });
});

describe("migrate", () => {
  it("discovers numbered SQL files in order", () => {
    const ms = listMigrations();
    expect(ms.length).toBeGreaterThan(0);
    expect(ms[0]?.version).toBe(1);
    expect(ms.map((m) => m.version)).toEqual([...ms.map((m) => m.version)].sort((a, b) => a - b));
  });

  it("creates the schema and records applied versions", () => {
    const db = openDatabase(":memory:");
    const applied = migrate(db);
    expect(applied).toEqual(listMigrations().map((m) => m.version));
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "audit_entries",
        "commands",
        "events",
        "schema_migrations",
        "streams",
      ]),
    );
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining([
        "events_mission_global",
        "events_type_global",
        "events_session_global",
      ]),
    );
    const row = db.prepare("SELECT version, applied_at FROM schema_migrations").get() as {
      version: number;
      applied_at: string;
    };
    expect(row.version).toBe(1);
    expect(Number.isNaN(Date.parse(row.applied_at))).toBe(false);
    db.close();
  });

  it("is idempotent on re-run, including across reopen", () => {
    const path = tempDb();
    const db = openDatabase(path);
    migrate(db);
    expect(migrate(db)).toEqual([]);
    db.close();
    const again = openDatabase(path);
    expect(migrate(again)).toEqual([]);
    const count = again.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
      n: number;
    };
    expect(count.n).toBe(listMigrations().length);
    again.close();
  });

  it("enforces the events -> streams foreign key", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (id, stream_id, sequence, global_seq, type, provenance, source,
             occurred_at, observed_at, payload) VALUES ('e', 'missing', 0, 1, 't', 'observed', 's', 'x', 'x', '{}')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });
});

describe("migrate guards (fix round 1: M7, M11)", () => {
  it("adds the (stream_id, global_seq) index", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='events_stream_global'")
      .get();
    expect(idx).toBeDefined();
    db.close();
  });

  it("refuses a database migrated by a newer build", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (999, 'x')").run();
    expect(() => migrate(db)).toThrow(/newer/);
    db.close();
  });

  it("rejects duplicate migration versions with a clear message", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      migrate(db, [
        { version: 1, name: "a", sql: "SELECT 1" },
        { version: 1, name: "b", sql: "SELECT 1" },
      ]),
    ).toThrow(/duplicate migration version 1/);
    db.close();
  });
});
