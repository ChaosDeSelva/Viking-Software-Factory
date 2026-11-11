import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "./lock.js";
import { tempDir } from "./test-helpers.js";

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const DEAD_PID = 2 ** 30;
const lockJson = (o: Record<string, unknown>) =>
  JSON.stringify({ hostname: hostname(), createdAt: new Date().toISOString(), token: "t", ...o });

function plant(path: string, contents: string, ageMs: number): void {
  writeFileSync(path, contents);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

describe("acquireLock edge cases", () => {
  it("gives up with conflict while another reclaimer holds a fresh reclaim mutex", () => {
    const db = join(tmp.dir, "a.db");
    plant(`${db}.lock`, "garbage", 60_000);
    plant(`${db}.lock.reclaim`, JSON.stringify({ pid: process.pid, token: "other" }), 0);
    expect(() => acquireLock(db)).toThrow(expect.objectContaining({ code: "conflict" }));
    // The stale lock was never touched without the mutex.
    expect(readFileSync(`${db}.lock`, "utf8")).toBe("garbage");
    // Gives up only after the full bounded retry loop, which exceeds 5 s on slow CI runners.
  }, 30_000);

  it("removes a reclaim mutex abandoned by a crashed reclaimer, then reclaims", () => {
    const db = join(tmp.dir, "b.db");
    plant(`${db}.lock`, lockJson({ pid: DEAD_PID }), 60_000);
    plant(`${db}.lock.reclaim`, JSON.stringify({ pid: DEAD_PID, token: "x" }), 60_000);
    const lock = acquireLock(db);
    expect(JSON.parse(readFileSync(lock.path, "utf8"))).toMatchObject({ pid: process.pid });
    expect(existsSync(`${db}.lock.reclaim`)).toBe(false);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
  });

  it("release still removes our lock when the reclaim mutex stays held", () => {
    const db = join(tmp.dir, "c.db");
    const lock = acquireLock(db);
    plant(`${db}.lock.reclaim`, JSON.stringify({ pid: process.pid, token: "other" }), 0);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    expect(existsSync(`${db}.lock.reclaim`)).toBe(true);
  });

  it("an old lock of a live pid owned by another user (EPERM) created after boot is live", () => {
    const db = join(tmp.dir, "d.db");
    // pid 1 is always running and owned by root, so signalling it fails with EPERM.
    plant(`${db}.lock`, lockJson({ pid: 1 }), 60_000);
    expect(() => acquireLock(db)).toThrow(
      expect.objectContaining({ code: "conflict", details: expect.objectContaining({ pid: 1 }) }),
    );
  });

  it("an old lock with a parsed non-object or pid-less body is reclaimed", () => {
    const db = join(tmp.dir, "e.db");
    plant(`${db}.lock`, "42", 60_000);
    acquireLock(db).release();
    plant(`${db}.lock`, JSON.stringify({ hostname: hostname() }), 60_000);
    acquireLock(db).release();
  });

  it("surfaces an unreadable lock path instead of treating it as free", () => {
    const db = join(tmp.dir, "f.db");
    mkdirSync(`${db}.lock`);
    expect(() => acquireLock(db)).toThrow(expect.objectContaining({ code: "EISDIR" }));
  });
});
