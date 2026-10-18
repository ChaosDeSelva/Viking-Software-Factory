import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, openDatabase } from "./db.js";

describe("openDatabase", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("opens a file database in WAL mode with foreign keys on", () => {
    const dir = mkdtempSync(join(tmpdir(), "sindri-db-"));
    dirs.push(dir);
    const db = openDatabase(join(dir, "s.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("applies namespaced migrations once, in order", () => {
    const db = openDatabase(":memory:");
    const migrations = ["CREATE TABLE t(a INTEGER)", "ALTER TABLE t ADD COLUMN b TEXT"];
    expect(applyMigrations(db, "demo", migrations)).toBe(2);
    expect(applyMigrations(db, "demo", migrations)).toBe(0);
    expect(applyMigrations(db, "demo", [...migrations, "CREATE TABLE u(x)"])).toBe(1);
    const cols = db.prepare("SELECT name FROM pragma_table_info('t')").all();
    expect(cols).toEqual([{ name: "a" }, { name: "b" }]);
    db.close();
  });

  it("rolls back a failing migration", () => {
    const db = openDatabase(":memory:");
    expect(() => applyMigrations(db, "bad", ["CREATE TABLE ok(a)", "NOT SQL"])).toThrow();
    const applied = db
      .prepare("SELECT count(*) AS n FROM schema_migrations WHERE namespace = 'bad'")
      .get() as { n: number };
    expect(applied.n).toBe(1);
    db.close();
  });
});
