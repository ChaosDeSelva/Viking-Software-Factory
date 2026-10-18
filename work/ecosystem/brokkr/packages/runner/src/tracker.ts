import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** Session id (Linux only; 0 when unknown). */
  sid: number;
  /** Opaque start marker used to avoid killing a recycled pid. */
  start: string;
  /** Linux only: the process environment carries this check's token. */
  hasToken: boolean;
}

/** Snapshot of processes owned by this user. Linux reads /proc; elsewhere `ps`. */
async function snapshot(token: string): Promise<ProcInfo[]> {
  if (process.platform === "linux") {
    const out: ProcInfo[] = [];
    for (const name of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = await readFile(`/proc/${name}/stat`, "utf8");
        // Fields after the parenthesised command: state ppid pgrp session ... starttime(22)
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const environ = await readFile(`/proc/${name}/environ`, "utf8").catch(() => "");
        out.push({
          pid: Number(name),
          ppid: Number(fields[1]),
          pgid: Number(fields[2]),
          sid: Number(fields[3]),
          start: fields[19] ?? "",
          hasToken: environ.split("\0").includes(`BROKKR_CHECK_TOKEN=${token}`),
        });
      } catch {
        // process exited while reading
      }
    }
    return out;
  }
  if (process.platform === "win32") return [];
  const stdout = await new Promise<string>((res) =>
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (err, out) => res(err ? "" : out),
    ),
  );
  const out: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m)
      out.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        sid: 0,
        start: m[4]!,
        hasToken: false,
      });
  }
  return out;
}

/**
 * Tracks every descendant of a check, including ones that leave its process
 * group or session (setsid, double fork). On Linux, membership is by session id
 * or the inherited `BROKKR_CHECK_TOKEN`, which survives reparenting. On macOS,
 * whose `ps` exposes neither, the ppid tree is sampled (100 ms doubling to `intervalMs`); a
 * descendant that forks, detaches and loses its parent between two samples can
 * be missed (ADR-004).
 */
export class ProcessTracker {
  private readonly known = new Map<number, string>();
  private timer: NodeJS.Timeout | undefined;
  private sampling: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rootPid: number,
    private readonly token: string,
    private readonly intervalMs = 2_000,
    /** Injectable process listing (tests). */
    private readonly list: (token: string) => Promise<ProcInfo[]> = snapshot,
  ) {}

  private inFlight = false;

  start(): void {
    // Escapes happen early (fork + setsid right after start), and every `ps` is a
    // process spawn (costly where endpoint security scans each exec): sample at
    // 100 ms, doubling up to `intervalMs`. A sample is never queued behind a slow one.
    let delay = 100;
    const tick = (): void => {
      if (!this.inFlight) {
        this.inFlight = true;
        void this.sample()
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            this.inFlight = false;
          });
      }
      this.timer = setTimeout(tick, delay);
      this.timer.unref();
      delay = Math.min(delay * 2, this.intervalMs);
    };
    tick();
  }

  /** Start marker of the root process, recorded at the first sample. */
  private rootStart: string | undefined;

  /** Take one snapshot now (serialised with the periodic ones). */
  sample(): Promise<ProcInfo[]> {
    const next = this.sampling.then(async () => {
      const procs = await this.list(this.token);
      const byPid = new Map(procs.map((p) => [p.pid, p]));
      const root = byPid.get(this.rootPid);
      if (this.rootStart === undefined && root) this.rootStart = root.start;
      // A ppid link only counts while the parent is the very process we recorded
      // (same pid AND start marker): pids are recycled, so a dead descendant's or the
      // dead root's pid may now belong to an unrelated process.
      const isTrackedParent = (ppid: number): boolean => {
        const parent = byPid.get(ppid);
        if (!parent) return false;
        if (ppid === this.rootPid)
          return this.rootStart !== undefined && parent.start === this.rootStart;
        return this.known.get(ppid) === parent.start;
      };
      const rootAlive = root !== undefined && root.start === this.rootStart;
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of procs) {
          if (p.pid === this.rootPid || this.known.has(p.pid)) continue;
          const member =
            isTrackedParent(p.ppid) ||
            p.hasToken ||
            (rootAlive && root.sid !== 0 && p.sid === root.sid);
          if (member) {
            this.known.set(p.pid, p.start);
            grew = true;
          }
        }
      }
      return procs;
    });
    this.sampling = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Tracked descendants still alive outside the check's process group (group
   * members are killed by the group kill; these escaped it).
   */
  async survivors(): Promise<number[]> {
    // One snapshot both extends the tracked set and tells who is still alive.
    const procs = await this.sample();
    const alive: number[] = [];
    for (const p of procs) {
      if (p.pid === this.rootPid || p.pgid === this.rootPid) continue;
      // Only exact (pid, start) matches recorded while tracking, or the check's token.
      const tracked = this.known.get(p.pid) === p.start;
      if (tracked || p.hasToken) alive.push(p.pid);
    }
    return alive;
  }

  /**
   * SIGKILL every surviving descendant. Returns the pids that were alive and
   * the ones still alive afterwards.
   */
  async killSurvivors(): Promise<{ found: number[]; remaining: number[] }> {
    this.stop();
    const found = await this.survivors();
    for (const pid of found) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (found.length === 0) return { found, remaining: [] };
    await new Promise((r) => setTimeout(r, 200));
    const after = await this.list(this.token);
    const remaining = found.filter((pid) =>
      after.some((p) => p.pid === pid && (p.start === this.known.get(pid) || p.hasToken)),
    );
    return { found, remaining };
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res) =>
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, out) =>
      res(err && !out ? "" : out),
    ),
  );
}

/**
 * macOS: processes (other than this one) holding the peer end of our output
 * sockets, i.e. escaped descendants still writing to the check's stdout/stderr.
 * Uses `lsof`; returns [] where unavailable.
 */
export async function outputPipeHolders(fds: readonly number[]): Promise<number[]> {
  if (process.platform !== "darwin" || fds.length === 0) return [];
  const peers = new Set<string>();
  for (const fd of fds) {
    const mine = await run("lsof", [
      "-nP",
      "-a",
      "-p",
      String(process.pid),
      "-d",
      String(fd),
      "-F",
      "n",
    ]);
    const peer = /n->(0x[0-9a-f]+)/.exec(mine)?.[1];
    if (peer) peers.add(peer);
  }
  if (peers.size === 0) return [];
  const all = await run("lsof", ["-nP", "-U", "-F", "pd"]);
  const holders = new Set<number>();
  let pid = 0;
  for (const line of all.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("d") && peers.has(line.slice(1)) && pid !== process.pid)
      holders.add(pid);
  }
  return [...holders];
}
