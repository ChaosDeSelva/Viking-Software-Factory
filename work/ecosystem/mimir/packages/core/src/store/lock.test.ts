import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MimirError } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "./lock.js";
import { tempDir } from "./test-helpers.js";

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const CONFLICT = "another Mimir server owns this database";
const DEAD_PID = 2 ** 30; // above any real pid_max: process.kill(pid, 0) fails with ESRCH

/** Writes a lock file and backdates its mtime by `ageMs`. */
function plantLock(db: string, contents: string, ageMs = 60_000): string {
  const path = `${db}.lock`;
  writeFileSync(path, contents);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

const lockJson = (o: Record<string, unknown>) =>
  JSON.stringify({ hostname: hostname(), createdAt: new Date().toISOString(), token: "t", ...o });

describe("acquireLock", () => {
  it("creates <db>.lock with pid, token, hostname and timestamp and removes it on release", () => {
    const db = join(tmp.dir, "a.db");
    const lock = acquireLock(db);
    expect(lock.path).toBe(`${db}.lock`);
    const contents = JSON.parse(readFileSync(lock.path, "utf8")) as Record<string, unknown>;
    expect(contents).toMatchObject({ pid: process.pid, hostname: hostname() });
    expect(typeof contents.token).toBe("string");
    expect(Number.isNaN(Date.parse(String(contents.createdAt)))).toBe(false);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    lock.release();
  });

  it("refuses while this process holds the lock", () => {
    const db = join(tmp.dir, "b.db");
    const lock = acquireLock(db);
    expect(() => acquireLock(db)).toThrow(
      expect.objectContaining({ code: "conflict", message: CONFLICT }),
    );
    expect(() => acquireLock(db)).toThrow(MimirError);
    lock.release();
    acquireLock(db).release();
  });

  it("reclaims an old lock left by a dead process or with garbage contents", () => {
    const db = join(tmp.dir, "c.db");
    plantLock(db, lockJson({ pid: DEAD_PID }));
    const l1 = acquireLock(db);
    expect(JSON.parse(readFileSync(l1.path, "utf8")).pid).toBe(process.pid);
    l1.release();
    plantLock(db, "not json");
    acquireLock(db).release();
  });

  it("C1: never reclaims an unparseable lock file younger than the stale threshold", () => {
    const db = join(tmp.dir, "fresh.db");
    plantLock(db, "", 0);
    expect(() => acquireLock(db)).toThrow(expect.objectContaining({ code: "conflict" }));
    plantLock(db, "{not json", 0);
    expect(() => acquireLock(db)).toThrow(expect.objectContaining({ code: "conflict" }));
    plantLock(db, JSON.stringify({ hostname: hostname() }), 0); // parses, but no pid
    expect(() => acquireLock(db)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(existsSync(`${db}.lock`)).toBe(true);
    // with an explicit short threshold the same unreadable lock is reclaimable once it ages
    plantLock(db, "", 200);
    acquireLock(db, { staleMs: 100 }).release();
  });

  it("T14a I3: a fresh lock whose same-host owner pid is dead (ESRCH) is reclaimed at once", () => {
    const db = join(tmp.dir, "dead-fresh.db");
    plantLock(db, lockJson({ pid: DEAD_PID }), 0);
    const lock = acquireLock(db);
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  it("T14a I3: the fast path never applies to another host's lock or a live pid", () => {
    const db = join(tmp.dir, "fast-guards.db");
    plantLock(db, lockJson({ pid: DEAD_PID, hostname: "elsewhere.example" }), 0);
    expect(() => acquireLock(db)).toThrow(/elsewhere\.example/);
    plantLock(db, lockJson({ pid: process.ppid }), 0); // our parent: alive
    expect(() => acquireLock(db)).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("I1: a lock with our own pid but an unknown token (previous incarnation) is reclaimed", () => {
    const db = join(tmp.dir, "reuse.db");
    plantLock(db, lockJson({ pid: process.pid, token: "previous-incarnation" }));
    const lock = acquireLock(db);
    expect(JSON.parse(readFileSync(lock.path, "utf8")).token).not.toBe("previous-incarnation");
    lock.release();
  });

  it("I1: a live pid whose lock predates the last boot is stale (pid reused after reboot)", () => {
    const db = join(tmp.dir, "boot.db");
    plantLock(db, lockJson({ pid: process.ppid, createdAt: "1970-01-02T00:00:00.000Z" }));
    acquireLock(db).release();
    plantLock(db, lockJson({ pid: process.ppid }));
    expect(() => acquireLock(db)).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("I1: a lock held by another host is never reclaimed and names the host", () => {
    const db = join(tmp.dir, "host.db");
    plantLock(db, lockJson({ pid: DEAD_PID, hostname: "elsewhere.example" }));
    expect(() => acquireLock(db)).toThrow(
      expect.objectContaining({
        code: "conflict",
        message: expect.stringContaining("elsewhere.example"),
      }),
    );
  });

  it("release does not remove a lock file now owned by someone else", () => {
    const db = join(tmp.dir, "d.db");
    const lock = acquireLock(db);
    writeFileSync(lock.path, JSON.stringify({ pid: process.pid, token: "other" }));
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
  });
});

const contender = fileURLToPath(new URL("./__fixtures__/lock-contender.mjs", import.meta.url));

function race(db: string, n: number): Promise<string[]> {
  const startAt = Date.now() + 1500;
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [contender, db, String(startAt), "2500"], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (d: Buffer) => (out += d.toString()));
          child.stderr.on("data", (d: Buffer) => (err += d.toString()));
          child.on("error", reject);
          child.on("close", () => (out ? resolve(out.trim()) : reject(new Error(err))));
        }),
    ),
  );
}

describe("acquireLock across processes (C1)", () => {
  it("exactly one of 8 concurrent openers wins on a fresh path", async () => {
    const results = await race(join(tmp.dir, "race.db"), 8);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(7);
  }, 20_000);

  it("T14a I3: a lock held by a SIGKILLed process is reclaimed immediately", async () => {
    const db = join(tmp.dir, "killed.db");
    const child = spawn(process.execPath, [contender, db, String(Date.now()), "60000"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) =>
        d.toString().includes("won") ? resolve() : undefined,
      );
      child.on("error", reject);
      child.on("close", () => reject(new Error("contender exited before winning")));
    });
    const gone = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await gone;
    const t0 = Date.now();
    const lock = acquireLock(db);
    expect(Date.now() - t0).toBeLessThan(1000);
    lock.release();
  }, 20_000);

  it("T14a I3: exactly one of 8 concurrent openers wins against a fresh dead-pid lock", async () => {
    const db = join(tmp.dir, "fresh-dead-race.db");
    plantLock(db, lockJson({ pid: DEAD_PID }), 0);
    const results = await race(db, 8);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(7);
  }, 20_000);

  it("exactly one of 8 concurrent openers wins when reclaiming a stale lock", async () => {
    const db = join(tmp.dir, "stale-race.db");
    plantLock(db, lockJson({ pid: DEAD_PID }));
    const results = await race(db, 8);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(7);
  }, 20_000);
});
