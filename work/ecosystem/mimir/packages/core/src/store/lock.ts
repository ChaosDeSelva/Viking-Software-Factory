import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { MimirError } from "@mimir/protocol";

export interface FileLock {
  readonly path: string;
  /** Removes the lock file if we still own it. Idempotent. */
  release(): void;
}

export interface LockOptions {
  /**
   * A lock file modified less than this many ms ago is not reclaimed unless its same-host owner
   * pid provably no longer exists (ESRCH). Unreadable or pid-less contents always wait this long.
   * Default 5000.
   */
  staleMs?: number;
}

interface LockContents {
  pid: number;
  token: string;
  hostname: string;
  createdAt: string;
}

interface Snapshot {
  raw: string;
  owner: Partial<LockContents> | undefined;
  mtimeMs: number;
}

export const DEFAULT_LOCK_STALE_MS = 5000;
const RECLAIM_MUTEX_STALE_MS = 10_000;
const MAX_ATTEMPTS = 200;
const CONFLICT_MESSAGE = "another Mimir server owns this database";

/** Tokens of locks held by this process, so a same-pid lock from a previous incarnation is stale. */
const HELD_TOKENS = new Set<string>();

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (errno(e) !== "ENOENT") throw e;
  }
}

/**
 * Atomically creates `path` with `contents`: the data is written to a private temp file and then
 * hard-linked into place, so `path` is never observed empty or partial, and `link` fails with
 * EEXIST when someone else already holds it.
 */
function tryCreate(path: string, contents: string, token: string): boolean {
  const tmp = `${path}.${token}.tmp`;
  writeFileSync(tmp, contents, { flag: "wx" });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (errno(e) === "EEXIST") return false;
    throw e;
  } finally {
    unlinkQuiet(tmp);
  }
}

function snapshot(path: string): Snapshot | undefined {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const raw = readFileSync(path, "utf8");
    let owner: Partial<LockContents> | undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") owner = parsed as Partial<LockContents>;
    } catch {
      owner = undefined;
    }
    return { raw, owner, mtimeMs };
  } catch (e) {
    if (errno(e) === "ENOENT") return undefined;
    throw e;
  }
}

/** True only when the pid provably does not exist (ESRCH); EPERM and success mean it may. */
function provablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return errno(e) === "ESRCH";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return errno(e) === "EPERM";
  }
}

type Verdict = { kind: "live" } | { kind: "stale" } | { kind: "foreign"; host: string };

function judge(snap: Snapshot, staleMs: number): Verdict {
  const { owner } = snap;
  if (owner?.pid === process.pid && owner.token && HELD_TOKENS.has(owner.token)) {
    return { kind: "live" };
  }
  const parsedPid = owner !== undefined && typeof owner.pid === "number";
  if (parsedPid && typeof owner.hostname === "string" && owner.hostname !== hostname()) {
    // We cannot probe a pid on another host; never reclaim, whatever its age.
    return { kind: "foreign", host: owner.hostname };
  }
  // Fast path at any age: a same-host owner whose pid provably no longer exists. A new holder
  // is the process that wrote its file, so it cannot be dead; pid reuse only makes a dead owner
  // look alive (conservative). Compare-and-unlink under the reclaim mutex still guards races.
  if (
    parsedPid &&
    owner.hostname === hostname() &&
    owner.pid !== process.pid &&
    provablyDead(owner.pid as number)
  ) {
    return { kind: "stale" };
  }
  // The age rule now only protects unreadable or pid-less contents (and the other cases below).
  if (Date.now() - snap.mtimeMs < staleMs) return { kind: "live" };
  if (!owner || typeof owner.pid !== "number") return { kind: "stale" };
  // Same pid as us but not one of our tokens: a previous incarnation (e.g. container pid 1).
  if (owner.pid === process.pid) return { kind: "stale" };
  if (!isAlive(owner.pid)) return { kind: "stale" };
  // A live pid that predates the last boot is a reused pid, not the original holder.
  const createdAt = Date.parse(owner.createdAt ?? "");
  const bootedAt = Date.now() - uptime() * 1000;
  if (Number.isFinite(createdAt) && createdAt < bootedAt) return { kind: "stale" };
  return { kind: "live" };
}

function conflict(path: string, snap: Snapshot | undefined): MimirError {
  return new MimirError("conflict", CONFLICT_MESSAGE, { lockPath: path, pid: snap?.owner?.pid });
}

/**
 * Runs `fn` while holding `<path>.reclaim`, the mutex that every unlink of the lock file goes
 * through. Returns false (without running `fn`) when another process holds the mutex.
 */
function withReclaimMutex(path: string, fn: () => void): boolean {
  const mutex = `${path}.reclaim`;
  const token = randomUUID();
  if (!tryCreate(mutex, JSON.stringify({ pid: process.pid, token }), token)) {
    const snap = snapshot(mutex);
    // A reclaimer that crashed mid-reclaim; reclaims take milliseconds.
    if (snap && Date.now() - snap.mtimeMs > RECLAIM_MUTEX_STALE_MS) {
      const again = snapshot(mutex);
      if (again?.raw === snap.raw && again.mtimeMs === snap.mtimeMs) unlinkQuiet(mutex);
    }
    return false;
  }
  try {
    fn();
  } finally {
    const mine = snapshot(mutex);
    if (mine?.owner?.token === token) unlinkQuiet(mutex);
  }
  return true;
}

/**
 * Takes the exclusive `<dbPath>.lock` file holding `{pid, token, hostname, createdAt}`.
 *
 * - The file is created atomically (temp file + `link`), so it is never seen empty.
 * - A lock whose same-host owner pid provably no longer exists (ESRCH) is reclaimed at once, so a
 *   server restarted right after a crash starts immediately.
 * - Otherwise a lock is reclaimed only when it is older than `staleMs` and its holder is gone:
 *   unreadable contents, our own pid without one of our tokens, or a pid that predates boot.
 *   A lock from another hostname is never reclaimed.
 * - Reclaim is compare-and-unlink under the `<dbPath>.lock.reclaim` mutex: the file is
 *   unlinked only if it is byte-for-byte the one judged stale.
 *
 * Throws `MimirError('conflict', 'another Mimir server owns this database')` while held.
 */
export function acquireLock(dbPath: string, options: LockOptions = {}): FileLock {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const path = `${dbPath}.lock`;
  const token = randomUUID();
  const contents: LockContents = {
    pid: process.pid,
    token,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  const text = JSON.stringify(contents);

  let last: Snapshot | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryCreate(path, text, token)) {
      HELD_TOKENS.add(token);
      return makeHandle(path, token);
    }
    const seen = snapshot(path);
    if (!seen) continue; // released between our link and our read
    last = seen;
    const verdict = judge(seen, staleMs);
    if (verdict.kind === "live") throw conflict(path, seen);
    if (verdict.kind === "foreign") {
      throw new MimirError(
        "conflict",
        `${CONFLICT_MESSAGE} (lock held by host ${verdict.host}; remove ${path} if that host is gone)`,
        { lockPath: path, hostname: verdict.host, pid: seen.owner?.pid },
      );
    }
    const entered = withReclaimMutex(path, () => {
      const again = snapshot(path);
      if (again && again.raw === seen.raw && again.mtimeMs === seen.mtimeMs) unlinkQuiet(path);
    });
    if (!entered) sleepSync(2 + Math.floor(Math.random() * 10));
  }
  throw conflict(path, last);
}

function makeHandle(path: string, token: string): FileLock {
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      HELD_TOKENS.delete(token);
      const removeIfMine = () => {
        if (snapshot(path)?.owner?.token === token) unlinkQuiet(path);
      };
      for (let i = 0; i < 50; i++) {
        if (withReclaimMutex(path, removeIfMine)) return;
        sleepSync(5);
      }
      removeIfMine();
    },
  };
}
