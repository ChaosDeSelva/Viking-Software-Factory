import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
// A stand-in ACP agent. STUB_MODE selects the misbehaviour under test; no model is involved.
const agentSource = `import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const mode = process.env.STUB_MODE;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
if (mode === 'stubborn') process.on('SIGTERM', () => {});
let open;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.STUB_LOG, line + '\\n');
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: mode === 'old' ? 0 : 1 } });
  else if (message.method === 'session/new') send({ id: message.id, result: { sessionId: 'owned' } });
  else if (message.method === 'session/prompt') {
    if (mode === 'crash') process.exit(7);
    if (mode === 'orphan') {
      // A tool process in the agent's group keeps the agent's stdout open after the agent exits.
      const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      writeFileSync(process.env.STUB_PID + '.tool', String(tool.pid));
      process.exit(5);
    }
    send({ method: 'session/update', params: { sessionId: 'owned', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello \\u001b[31mred\\u0007 tab\\there\\u009b!' } } } });
    if (mode === 'hold') open = message.id;
    else send({ id: message.id, result: { stopReason: 'end_turn' } });
  } else if (message.method === 'session/cancel') send({ id: open, result: { stopReason: 'cancelled' } });
});
writeFileSync(process.env.STUB_PID, String(process.pid));
`;
const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const roots: string[] = [];
const added: [string, (...args: unknown[]) => void][] = [];
const pidFiles: string[] = [];
const argv = process.argv;
afterEach(() => {
  for (const [name, listener] of added.splice(0)) process.removeListener(name, listener);
  vi.restoreAllMocks();
  for (const file of pidFiles.splice(0)) {
    try {
      process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
    } catch {
      /* The stand-in agent already ended. */
    }
  }
  process.argv = argv;
  // The terminal sets the exit code of its own process, which is the test worker here.
  process.exitCode = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 90000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Imports the ACP terminal in this process with a real stand-in agent as its child. */
function start(mode: string, overrides: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "mimir-acp-terminal-"));
  roots.push(home);
  const agent = join(home, "agent.mjs"),
    hookFile = join(home, "hook.json"),
    log = join(home, "received.jsonl"),
    pidFile = join(home, "pid"),
    launch = join(home, "launch.json");
  pidFiles.push(pidFile, pidFile + ".tool");
  writeFileSync(agent, agentSource);
  writeFileSync(
    launch,
    JSON.stringify({
      executable: process.execPath,
      args: [agent],
      agentKind: "kimi",
      prompt: "first task",
      cwd: home,
      env: { MIMIR_HOOK_FILE: hookFile, STUB_MODE: mode, STUB_LOG: log, STUB_PID: pidFile },
      timeoutMs: 600000,
      ...overrides,
    }),
  );
  const stdin = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  const printed: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    printed.push(String(chunk));
    return true;
  });
  const before = new Map(signals.map((name) => [name, process.listeners(name)]));
  process.argv = [process.execPath, "acp-terminal.js", launch];
  vi.resetModules();
  const settled = import("./acp-terminal.js");
  const handler = (name: (typeof signals)[number]) => {
    const listener = process.listeners(name).find((l) => !before.get(name)!.includes(l));
    if (listener && !added.some(([, known]) => known === listener))
      added.push([name, listener as (...args: unknown[]) => void]);
    return listener as (() => void) | undefined;
  };
  const received = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const alive = () => {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    stdin,
    settled,
    handler,
    received,
    alive,
    hookFile,
    hook: () => JSON.parse(readFileSync(hookFile, "utf8")),
    output: () => printed.join(""),
    pid: () => Number(readFileSync(pidFile, "utf8")),
  };
}
it("runs the first prompt, strips terminal control sequences and relays operator lines as later turns", async () => {
  const t = start("normal");
  await t.settled;
  expect(t.output()).toContain("Mimir ACP terminal.");
  expect(t.output()).toContain("hello [31mred tab\there!");
  for (const control of ["\u001b", "\u0007", "\u009b"]) expect(t.output()).not.toContain(control);
  expect(t.output()).toContain("[turn ended: end_turn]");
  expect(t.hook()).toMatchObject({ state: "waiting", reason: "harness_awaiting_input" });
  expect(t.received().find((m) => m.method === "session/prompt").params.prompt[0].text).toBe(
    "first task",
  );
  // A split line with a carriage return is one prompt; the operator text is data.
  t.stdin.write("second; $(lit");
  t.stdin.write("eral)\r\n");
  await until(
    () => t.received().filter((m) => m.method === "session/prompt").length === 2,
    "the second turn",
  );
  expect(t.received().at(-1).params.prompt[0].text).toBe("second; $(literal)");
  t.stdin.write("/permit unknown 1\n");
  await until(() => t.output().includes("Permission selection is invalid or expired"), "refusal");
  t.stdin.write("x".repeat(70000));
  await until(() => t.output().includes("Input exceeds 64 KiB. Nothing submitted."), "the bound");
  t.stdin.write("\n");
  await until(() => t.output().includes("Prompt must contain"), "the empty prompt refusal");
  expect(t.received().filter((m) => m.method === "session/prompt")).toHaveLength(2);
  expect(process.exitCode).toBeUndefined();
  t.stdin.write("/quit\nnever submitted\n");
  await until(() => !t.alive(), "the agent to end");
  expect(process.exitCode).toBe(0);
  expect(t.received().filter((m) => m.method === "session/prompt")).toHaveLength(2);
  // An intended shutdown is not reported to the operator as a connection failure.
  expect(t.output()).not.toContain("ACP client closed");
  expect(t.output()).not.toContain("ACP connection closed");
}, 120000);
it("cancels the open turn on Ctrl-C without ending the session, then ends it on SIGTERM", async () => {
  const t = start("hold");
  await until(() => t.received().some((m) => m.method === "session/prompt"), "the open turn");
  expect(t.hook()).toMatchObject({ state: "running", reason: "harness_working" });
  t.handler("SIGINT")!();
  await t.settled;
  expect(t.received().at(-1)).toMatchObject({
    method: "session/cancel",
    params: { sessionId: "owned" },
  });
  expect(t.output()).toContain("[turn ended: cancelled]");
  expect(process.exitCode).toBeUndefined();
  expect(t.alive()).toBe(true);
  t.handler("SIGTERM")!();
  expect(process.exitCode).toBe(0);
  await until(() => !t.alive(), "the agent to end");
}, 120000);
it("ends the agent when the operator's input stream closes", async () => {
  const t = start("normal");
  await t.settled;
  t.stdin.end();
  await until(() => !t.alive(), "the agent to end");
  expect(process.exitCode).toBe(0);
}, 120000);
it("refuses an agent that negotiates another protocol version and stops it", async () => {
  const t = start("old");
  await t.settled;
  expect(t.output()).toContain("Unsupported ACP protocol version");
  expect(t.output()).not.toContain("Mimir ACP terminal.");
  expect(process.exitCode).toBe(1);
  await until(() => !t.alive(), "the agent to end");
  expect(t.received().some((m) => m.method === "session/prompt")).toBe(false);
}, 120000);
it("reports an agent that dies during a turn as a failure and never resubmits the prompt", async () => {
  const t = start("crash");
  await t.settled;
  expect(t.output()).toContain("ACP connection closed");
  expect(process.exitCode).toBe(1);
  expect(t.received().filter((m) => m.method === "session/prompt")).toHaveLength(1);
}, 120000);
it("reports an executable that cannot be started", async () => {
  const t = start("normal", { executable: join(tmpdir(), "mimir-no-such-agent-binary") });
  await t.settled;
  await until(() => t.output().includes("Unable to start agent"), "the start failure");
  expect(process.exitCode).toBe(1);
  expect(t.output()).not.toContain("Mimir ACP terminal.");
}, 120000);
it("escalates to SIGKILL for an agent that ignores SIGTERM", async () => {
  const t = start("stubborn");
  await t.settled;
  const kill = vi.spyOn(process, "kill");
  t.stdin.write("/quit\n");
  await until(() => !t.alive(), "the agent to be killed");
  const sent = kill.mock.calls.filter(([pid]) => pid === -t.pid()).map(([, signal]) => signal);
  expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
  expect(process.exitCode).toBe(0);
}, 120000);
it("signals the agent directly when its process group cannot be signalled", async () => {
  const t = start("normal");
  await t.settled;
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0) throw new Error("EPERM");
    return kill(pid, signal);
  });
  t.stdin.write("/quit\n");
  await until(() => !t.alive(), "the agent to end");
  expect(process.exitCode).toBe(0);
}, 120000);
it("ends its detached agent when the terminal hangs up", async () => {
  const t = start("hold");
  await until(() => t.received().some((m) => m.method === "session/prompt"), "the open turn");
  // The agent leads its own session, so a closed terminal reaches only this process.
  const hangup = t.handler("SIGHUP");
  expect(hangup).toBeTypeOf("function");
  hangup!();
  await until(() => !t.alive(), "the agent to end");
  expect(process.exitCode).toBe(129);
  await t.settled;
}, 120000);
it("ends the agent's remaining process group when the agent exits on its own", async () => {
  const t = start("orphan");
  const toolFile = () => readFileSync(join(dirname(t.hookFile), "pid.tool"), "utf8");
  await until(() => {
    try {
      return Boolean(toolFile());
    } catch {
      return false;
    }
  }, "the tool process");
  const tool = Number(toolFile());
  await until(() => !t.alive(), "the agent to exit");
  await until(() => {
    try {
      process.kill(tool, 0);
      return false;
    } catch {
      return true;
    }
  }, "the tool process to end");
  expect(process.exitCode).toBe(1);
}, 120000);
