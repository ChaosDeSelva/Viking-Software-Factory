import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmp(prefix = "brokkr-runner-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export const NODE = process.execPath;
export const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function readPids(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
}

/**
 * Node script that spawns a grandchild `sleep 60` in the same process group,
 * prints a marker, then writes "<own pid> <grandchild pid>" to `pids` and waits.
 */
export const TREE_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn("sleep", ["60"], { stdio: "ignore" });
console.log("tree started");
fs.writeFileSync("pids", process.pid + " " + child.pid);
setInterval(() => {}, 1000);
`;

/**
 * Node script whose grandchild leaves the process group (detached = new
 * session, like `setsid`) while inheriting stdout/stderr, then the main
 * process exits 0 at once. Writes the escapee's pid to `escapee`.
 */
export const ESCAPEE_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
child.unref();
fs.writeFileSync("escapee", String(child.pid));
console.log("escapee started");
`;

/** Like ESCAPEE_SCRIPT but the main process keeps running until killed. */
export const ESCAPEE_WAIT_SCRIPT = ESCAPEE_SCRIPT + "setInterval(() => {}, 1000);\n";

/**
 * The main process starts a grandchild in a new session (setsid via detached)
 * with stdio closed, stays alive briefly, then exits 0. Writes the escapee pid.
 */
export const SILENT_ESCAPEE_SCRIPT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
child.unref();
fs.writeFileSync("escapee", String(child.pid));
// Stay alive long enough for several tracker samples even on a loaded host.
setTimeout(() => process.exit(0), 3000);
`;
