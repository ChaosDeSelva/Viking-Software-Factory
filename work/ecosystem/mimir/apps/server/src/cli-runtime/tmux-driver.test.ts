import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

// The driver acts at import time on process.argv; tmux and the agent are replaced by fakes.
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFileSync: mocks.execFileSync }));

const driver = fileURLToPath(new URL("./tmux-driver.ts", import.meta.url));
const roots: string[] = [];
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  process.exitCode = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.execFileSync.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function load(args: string[]) {
  vi.useFakeTimers({ now: Date.now() });
  const handlers = new Map<string, () => void>();
  vi.spyOn(process, "on").mockImplementation(((event: string, fn: () => void) => {
    handlers.set(event, fn);
    return process;
  }) as typeof process.on);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  process.argv = [process.execPath, driver, ...args];
  await import("./tmux-driver.js");
  return { handlers, kill };
}

function pane() {
  const dir = mkdtempSync(join(tmpdir(), "mimir-tmux-test-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ executable: "/opt/agent", args: ["-p", "brief"], cwd: dir, env: { A: "1" } }),
  );
  writeFileSync(join(dir, "heartbeat"), "alive");
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  mocks.spawn.mockReturnValue(child);
  return { dir, child };
}

it("runs the agent in the pane, records its output and exit code, and stops it on hangup", async () => {
  const { dir, child } = pane();
  const { handlers, kill } = await load(["--pane", dir]);
  expect(mocks.spawn).toHaveBeenCalledWith(
    "/opt/agent",
    ["-p", "brief"],
    expect.objectContaining({ cwd: dir, env: { A: "1" }, detached: true, shell: false }),
  );
  child.stdout.emit("data", Buffer.from("out "));
  child.stderr.emit("data", Buffer.from("err"));
  expect(readFileSync(join(dir, "output"), "utf8")).toBe("out err");
  child.emit("error", new Error("ignored: close reports the outcome"));
  handlers.get("SIGHUP")!();
  expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  handlers.get("SIGTERM")!();
  expect(kill).toHaveBeenCalledTimes(2);
  child.emit("close", 7);
  expect(readFileSync(join(dir, "exit"), "utf8")).toBe("7");
  // The heartbeat check stops with the agent.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(kill).toHaveBeenCalledTimes(2);
});

it("kills the agent when the controller-side driver stops beating or output is excessive", async () => {
  const { dir, child } = pane();
  const { kill } = await load(["--pane", dir]);
  await vi.advanceTimersByTimeAsync(500);
  expect(kill).not.toHaveBeenCalled();
  // A heartbeat older than three seconds means the driver is gone.
  const old = (Date.now() - 10_000) / 1000;
  utimesSync(join(dir, "heartbeat"), old, old);
  await vi.advanceTimersByTimeAsync(500);
  expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
  rmSync(join(dir, "heartbeat"));
  await vi.advanceTimersByTimeAsync(500);
  expect(kill).toHaveBeenCalledTimes(2);
  child.stdout.emit("data", Buffer.alloc(33 * 1024 * 1024));
  expect(kill).toHaveBeenCalledTimes(3);
  expect(existsSync(join(dir, "output"))).toBe(false);
  child.emit("close", null);
  expect(readFileSync(join(dir, "exit"), "utf8")).toBe("1");
});

it("tolerates an agent that has already exited when it is killed", async () => {
  const { dir, child } = pane();
  const { handlers, kill } = await load(["--pane", dir]);
  kill.mockImplementation(() => {
    throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  });
  expect(() => handlers.get("SIGTERM")!()).not.toThrow();
  Object.assign(child, { pid: undefined });
  handlers.get("SIGTERM")!();
  expect(kill).toHaveBeenCalledTimes(1);
});

it("starts a private tmux session, streams new pane output and exits with the agent's code", async () => {
  vi.stubEnv("MIMIR_TMUX_BIN", "/opt/tmux");
  let dir = "";
  mocks.execFileSync.mockImplementation((_bin: string, args: string[]) => {
    dir = /'--pane' '([^']+)'$/.exec(args.at(-1)!)![1]!;
  });
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await load(["/opt/agent", "it's", "brief"]);
  roots.push(dir);
  const [bin, args] = mocks.execFileSync.mock.calls[0]! as [string, string[]];
  expect(bin).toBe("/opt/tmux");
  expect(args.slice(0, 7)).toEqual(["-L", "mimir", "-f", "/dev/null", "new-session", "-d", "-s"]);
  expect(args[7]).toBe(`mimir-${process.pid}`);
  expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toMatchObject({
    executable: "/opt/agent",
    args: ["it's", "brief"],
    cwd: process.cwd(),
  });
  rmSync(join(dir, "heartbeat"));
  await vi.advanceTimersByTimeAsync(100);
  expect(readFileSync(join(dir, "heartbeat"), "utf8")).toBe("alive");
  expect(write).not.toHaveBeenCalled();
  appendFileSync(join(dir, "output"), "hello ");
  await vi.advanceTimersByTimeAsync(100);
  appendFileSync(join(dir, "output"), "world");
  await vi.advanceTimersByTimeAsync(100);
  expect(write.mock.calls.map(([data]) => Buffer.from(data as Uint8Array).toString())).toEqual([
    "hello ",
    "world",
  ]);
  writeFileSync(join(dir, "exit"), "3");
  await vi.advanceTimersByTimeAsync(100);
  expect(process.exitCode).toBe(3);
  expect(existsSync(dir)).toBe(false);
});

it("does not take an exit file that is still being written for a successful exit", async () => {
  let dir = "";
  mocks.execFileSync.mockImplementation((_bin: string, args: string[]) => {
    dir = /'--pane' '([^']+)'$/.exec(args.at(-1)!)![1]!;
  });
  await load(["/opt/agent"]);
  roots.push(dir);
  expect(mocks.execFileSync.mock.calls[0]![0]).toBe("tmux");
  // writeFileSync creates the file before writing its content: an empty file is not "0".
  writeFileSync(join(dir, "exit"), "");
  await vi.advanceTimersByTimeAsync(100);
  expect(process.exitCode).toBeUndefined();
  expect(existsSync(dir)).toBe(true);
  writeFileSync(join(dir, "exit"), "2");
  await vi.advanceTimersByTimeAsync(100);
  expect(process.exitCode).toBe(2);
});

it("fails with a clear message and leaves nothing behind when tmux cannot start", async () => {
  let dir = "";
  mocks.execFileSync.mockImplementation((_bin: string, args: string[]) => {
    dir = /'--pane' '([^']+)'$/.exec(args.at(-1)!)![1]!;
    throw new Error("tmux: not found");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await load(["/opt/agent"]);
  expect(stderr).toHaveBeenCalledWith("tmux backend unavailable\n");
  expect(process.exitCode).toBe(1);
  expect(existsSync(dir)).toBe(false);
});
