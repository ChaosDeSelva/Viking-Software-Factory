import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
const control = vi.hoisted(() => ({
  fake: undefined as ((...args: unknown[]) => unknown) | undefined,
  real: undefined as unknown,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  control.real = actual.spawn;
  return {
    ...actual,
    spawn: (...args: unknown[]) =>
      control.fake
        ? control.fake(...args)
        : (actual.spawn as (...a: unknown[]) => unknown)(...args),
  };
});
const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const roots: string[] = [];
const added: [string, (...args: unknown[]) => void][] = [];
const processes: ChildProcess[] = [];
const argv = process.argv;
afterEach(() => {
  for (const [name, listener] of added.splice(0)) process.removeListener(name, listener);
  for (const child of processes.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* The group already ended. */
    }
  }
  control.fake = undefined;
  process.argv = argv;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function launchFile(config: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "mimir-runner-"));
  roots.push(home);
  const file = join(home, "launch.json"),
    resultFile = join(home, "result.json");
  writeFileSync(
    file,
    JSON.stringify({
      executable: "/agent",
      args: ["--flag", "a prompt; $(literal)"],
      cwd: home,
      env: { MIMIR_HOOK_FILE: join(home, "hook.json") },
      timeoutMs: 60000,
      resultFile,
      ...config,
    }),
  );
  return { home, file, resultFile };
}
/** Imports the runner in this process with a controllable child and clock. */
async function load(config: Record<string, unknown> = {}) {
  const paths = launchFile(config);
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: vi.fn<(signal: string) => boolean>(() => true),
  });
  const spawn = vi.fn<(...args: unknown[]) => typeof child>(() => child);
  control.fake = spawn;
  // The runner signals its own process group; that group is the test worker here.
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.useFakeTimers();
  const before = new Map(signals.map((name) => [name, process.listeners(name)]));
  process.argv = [process.execPath, "runner.js", paths.file];
  vi.resetModules();
  await import("./runner.js");
  const handlers: Record<string, (() => void) | undefined> = {};
  for (const name of signals)
    for (const listener of process.listeners(name))
      if (!before.get(name)!.includes(listener)) {
        added.push([name, listener as (...args: unknown[]) => void]);
        handlers[name] = listener as () => void;
      }
  const result = () => JSON.parse(readFileSync(paths.resultFile, "utf8"));
  return { ...paths, child, spawn, kill, handlers, result };
}
it("starts the agent with its arguments as data, heartbeats while it runs and records a clean exit once", async () => {
  const run = await load();
  expect(run.spawn).toHaveBeenCalledTimes(1);
  const [executable, args, options] = run.spawn.mock.calls[0] as unknown as [
    string,
    string[],
    { cwd: string; env: Record<string, string>; stdio: string },
  ];
  expect(executable).toBe("/agent");
  expect(args).toEqual(["--flag", "a prompt; $(literal)"]);
  expect(options.cwd).toBe(run.home);
  expect(options.env.MIMIR_HOOK_FILE).toBe(join(run.home, "hook.json"));
  expect(options.stdio).toBe("inherit");
  expect(existsSync(run.resultFile)).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(run.result()).toMatchObject({ state: "running", pid: 4242 });
  run.child.emit("exit", 0);
  expect(run.result()).toMatchObject({ state: "completed", exitCode: 0 });
  // Neither a late heartbeat, a late error nor the launch deadline may replace the outcome.
  run.child.emit("error", new Error("late"));
  vi.advanceTimersByTime(120000);
  expect(run.result()).toMatchObject({ state: "completed", exitCode: 0 });
  expect(run.kill).not.toHaveBeenCalled();
});
it.each([
  ["a non-zero exit", ["exit", 2], 2],
  ["death by signal", ["exit", null], 1],
  ["a failed start", ["error", new Error("ENOENT")], 1],
] as const)("records %s as a failure", async (_name, [event, value], exitCode) => {
  const run = await load();
  run.child.emit(event, value);
  expect(run.result()).toMatchObject({ state: "failed", exitCode });
});
it.each(["kimi", "grok"])(
  "runs %s through the ACP terminal with the same launch file",
  async (agentKind) => {
    const run = await load({ agentKind });
    const [executable, args] = run.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(executable).toBe(process.execPath);
    expect(args).toEqual([fileURLToPath(new URL("./acp-terminal.js", import.meta.url)), run.file]);
  },
);
it("terminates its process group at the deadline and reports exit code 124 even for a clean exit", async () => {
  const run = await load({ timeoutMs: 5000 });
  vi.advanceTimersByTime(4999);
  expect(run.kill).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(run.kill).toHaveBeenCalledWith(-process.pid, "SIGTERM");
  expect(run.child.kill).not.toHaveBeenCalled();
  run.child.emit("exit", 0);
  expect(run.result()).toMatchObject({ state: "failed", exitCode: 124 });
});
it("records the timeout before the group kill that also ends the runner itself", async () => {
  const run = await load({ timeoutMs: 5000 });
  const atKill: unknown[] = [];
  run.kill.mockImplementation((_pid, signal) => {
    if (signal === "SIGKILL")
      atKill.push(existsSync(run.resultFile) ? run.result() : "no result recorded");
    return true;
  });
  // The agent ignores SIGTERM: no exit event arrives before the escalation.
  vi.advanceTimersByTime(5000 + 1500);
  expect(run.kill).toHaveBeenLastCalledWith(-process.pid, "SIGKILL");
  expect(atKill).toEqual([expect.objectContaining({ state: "failed", exitCode: 124 })]);
});
it("signals the agent directly when it does not lead a process group", async () => {
  const run = await load({ timeoutMs: 5000 });
  run.kill.mockImplementation(() => {
    throw new Error("ESRCH");
  });
  vi.advanceTimersByTime(5000);
  expect(run.child.kill.mock.calls).toEqual([["SIGTERM"]]);
  vi.advanceTimersByTime(1500);
  expect(run.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  expect(run.result()).toMatchObject({ state: "failed", exitCode: 124 });
});
it("forwards termination and hangup to the agent and leaves Ctrl-C to the terminal", async () => {
  const run = await load();
  run.handlers.SIGINT!();
  expect(run.child.kill).not.toHaveBeenCalled();
  run.handlers.SIGTERM!();
  expect(run.child.kill.mock.calls).toEqual([["SIGTERM"]]);
  // A closed terminal hangs up the runner: it must survive to record how the agent ended.
  expect(run.handlers.SIGHUP).toBeTypeOf("function");
  run.handlers.SIGHUP!();
  expect(run.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGHUP"]]);
  expect(existsSync(run.resultFile)).toBe(false);
  run.child.emit("exit", null);
  expect(run.result()).toMatchObject({ state: "failed", exitCode: 1 });
});
/** Runs the real runner as a process-group leader, as `exec` in a terminal pane does. */
function realRunner(agentSource: string, timeoutMs: number) {
  const paths = launchFile({ timeoutMs });
  const agent = join(paths.home, "agent.mjs"),
    ready = join(paths.home, "ready");
  writeFileSync(agent, agentSource.replaceAll("READY", JSON.stringify(ready)));
  writeFileSync(
    paths.file,
    JSON.stringify({
      executable: process.execPath,
      args: [agent],
      cwd: paths.home,
      env: {},
      timeoutMs,
      resultFile: paths.resultFile,
    }),
  );
  const spawn = control.real as typeof import("node:child_process").spawn;
  const runner = spawn(
    process.execPath,
    [fileURLToPath(new URL("./runner.ts", import.meta.url)), paths.file],
    { detached: true, stdio: "ignore" },
  );
  processes.push(runner);
  const exited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
  return { ...paths, runner, ready, exited };
}
async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 90000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
it("a real runner leading its group still reports a timed-out agent that ignores SIGTERM", async () => {
  const run = realRunner(
    `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(READY,'');setInterval(()=>{},1000);`,
    3000,
  );
  await run.exited;
  expect(JSON.parse(readFileSync(run.resultFile, "utf8"))).toMatchObject({
    state: "failed",
    exitCode: 124,
  });
}, 120000);
it("a real runner outlives a terminal hangup long enough to record the agent's exit", async () => {
  const run = realRunner(
    `import {writeFileSync} from 'node:fs';process.on('SIGHUP',()=>process.exit(3));writeFileSync(READY,'');setInterval(()=>{},1000);`,
    600000,
  );
  // The first heartbeat proves the runner is loaded; the marker proves the agent is.
  await until(() => existsSync(run.resultFile) && existsSync(run.ready), "runner and agent");
  process.kill(-run.runner.pid!, "SIGHUP");
  await run.exited;
  expect(JSON.parse(readFileSync(run.resultFile, "utf8"))).toMatchObject({
    state: "failed",
    exitCode: 3,
  });
}, 120000);
