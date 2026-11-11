import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvent, RuntimeSessionSpec } from "@mimir/protocol";

const mocks = vi.hoisted(() => ({ fork: vi.fn(), exists: new Set<string>() }));
vi.mock("node:child_process", () => ({ fork: mocks.fork }));
// Which optional files "exist" (the bundled Codex, compiled helpers) is decided per test.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: (path: string | URL) =>
      [...mocks.exists].some((suffix) => String(path).endsWith(suffix)),
  };
});
const BUNDLED =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const { CliRuntime, FINISHED_SESSIONS_KEPT } = await import("./adapter.js");

type FakeWorker = EventEmitter & {
  connected: boolean;
  send: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
};
function fakeWorker(): FakeWorker {
  const worker = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
    kill: vi.fn(),
    disconnect: vi.fn(() => {
      worker.connected = false;
    }),
  });
  mocks.fork.mockReturnValueOnce(worker);
  return worker;
}
const spec: RuntimeSessionSpec = {
  sessionId: "s1",
  idempotencyKey: "key1",
  taskId: "t1",
  crewId: "c1",
  agentKind: "codex",
  argv: ["codex", "exec", "brief"],
  cwd: "/tmp",
  env: { MIMIR_TASK_ID: "t1" },
  workspaceLabel: "test",
};
afterEach(() => {
  mocks.fork.mockReset();
  mocks.exists.clear();
  vi.unstubAllEnvs();
});

it("fails the session when the watchdog cannot be started instead of reporting it running", async () => {
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession(spec);
  // Node may emit only `error` (no `exit`) when the process could not be spawned.
  worker.connected = false;
  worker.emit("error", new Error("spawn EAGAIN"));
  expect((await runtime.getSession("s1"))?.state).toBe("failed");
  expect(events).toEqual([
    expect.objectContaining({
      kind: "session.state_changed",
      state: "failed",
      runtimeStatus: "worker_unavailable",
    }),
  ]);
  // A later exit does not report the failure twice; dispose does not wait forever.
  worker.emit("exit", 1);
  expect(events).toHaveLength(1);
  await runtime.dispose();
});

it("closes a still-connected watchdog after an IPC error so its agent is not orphaned", async () => {
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  await runtime.createSession(spec);
  worker.emit("error", new Error("channel closed"));
  expect(worker.disconnect).toHaveBeenCalled();
  expect((await runtime.getSession("s1"))?.state).toBe("failed");
});

it("resolves each agent's binary from its environment override, then the bare name", async () => {
  vi.stubEnv("MIMIR_CODEX_BIN", "/opt/codex-bin");
  vi.stubEnv("MIMIR_CLAUDE_BIN", "/opt/claude-bin");
  vi.stubEnv("MIMIR_GEMINI_BIN", undefined);
  const runtime = new CliRuntime();
  const started = async (agentKind: string, n: number) => {
    const worker = fakeWorker();
    await runtime.createSession({
      ...spec,
      sessionId: `s${n}`,
      idempotencyKey: `k${n}`,
      agentKind,
      argv: [agentKind, "run"],
    });
    return worker.send.mock.calls[0]![0] as { executable: string; args: string[] };
  };
  expect(await started("codex", 1)).toMatchObject({ executable: "/opt/codex-bin", args: ["run"] });
  expect((await started("claude", 2)).executable).toBe("/opt/claude-bin");
  expect((await started("gemini", 3)).executable).toBe("gemini");
});

it("runs the agent through the tmux driver with the resolved binary as its first argument", async () => {
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" }, "tmux");
  expect((await runtime.capabilities()).runtime).toBe("tmux");
  await runtime.createSession(spec);
  const start = worker.send.mock.calls[0]![0] as { executable: string; args: string[] };
  expect(start.executable).toBe(process.execPath);
  expect(start.args[0]).toMatch(/tmux-driver\.(js|ts)$/);
  expect(start.args.slice(1)).toEqual(["/opt/agent", "exec", "brief"]);
});

it("ignores unusable usage reports and keeps stderr out of usage parsing", async () => {
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession(spec);
  const usage = (value: unknown) => JSON.stringify(value) + "\n";
  for (const [text, stderr] of [
    [usage({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 5 } }), true],
    [usage({ type: "turn.completed", usage: { input_tokens: "5", output_tokens: 1 } }), false],
    [usage({ type: "turn.completed", usage: { input_tokens: -9, output_tokens: 1 } }), false],
    [usage({ type: "other", usage: { input_tokens: 1, output_tokens: 1 } }), false],
    [usage({ usage: { input_tokens: 1, output_tokens: 1 } }), false],
    ["not json\n", false],
  ] as const)
    worker.emit("message", { kind: "output", text, stderr });
  worker.emit("message", { kind: "output" });
  worker.emit("message", { kind: "exit" });
  const exited = events.find((e) => e.kind === "session.exited");
  expect(exited).toMatchObject({ exitCode: 1 });
  expect(exited).not.toHaveProperty("usage");
  // Output events carry exactly what was received; a message without text is empty output.
  expect(events.filter((e) => e.kind === "session.output").at(-1)).toMatchObject({ text: "" });
  expect((await runtime.getSession("s1"))?.state).toBe("failed");
});

it("keeps only a bounded partial line while waiting for a newline", async () => {
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession(spec);
  // An unterminated 2 MiB line is discarded, so a usage report after it parses on its own.
  worker.emit("message", { kind: "output", text: "x".repeat(2 * 1024 * 1024 + 1) });
  worker.emit("message", {
    kind: "output",
    text: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
  });
  worker.emit("message", { kind: "exit", code: 0 });
  expect(events.find((e) => e.kind === "session.exited")).toMatchObject({
    usage: { tokens: 3, estimatedCost: null },
  });
});

it("does not message a watchdog whose IPC channel already closed", async () => {
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  await runtime.createSession(spec);
  worker.connected = false;
  await runtime.requestStop("s1", "soft");
  expect(worker.send).toHaveBeenCalledTimes(1); // only the start message
  worker.emit("exit", 0);
  await runtime.dispose();
  expect(worker.disconnect).not.toHaveBeenCalled();
});

it("prefers the bundled Codex and compiled helpers when they are installed", async () => {
  vi.stubEnv("MIMIR_CODEX_BIN", undefined);
  const runtime = new CliRuntime({}, "tmux");
  const start = async (n: number) => {
    const worker = fakeWorker();
    await runtime.createSession({ ...spec, sessionId: `s${n}`, idempotencyKey: `k${n}` });
    return {
      script: String(mocks.fork.mock.calls.at(-1)![0]),
      start: worker.send.mock.calls[0]![0] as { args: string[] },
    };
  };
  const plain = await start(1);
  expect(plain.script).toMatch(/worker\.ts$/);
  expect(plain.start.args.slice(0, 2)).toEqual([
    expect.stringMatching(/tmux-driver\.ts$/),
    "codex",
  ]);
  mocks.exists.add(BUNDLED).add("/worker.js").add("/tmux-driver.js");
  const built = await start(2);
  expect(built.script).toMatch(/worker\.js$/);
  expect(built.start.args.slice(0, 2)).toEqual([
    expect.stringMatching(/tmux-driver\.js$/),
    BUNDLED,
  ]);
});

it("prepends project PATH entries even when the server has no PATH", async () => {
  vi.stubEnv("PATH", undefined);
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  await runtime.createSession({ ...spec, agentEnv: { pathPrepend: ["/opt/a", "/opt/b"] } });
  expect((worker.send.mock.calls[0]![0] as { env: Record<string, string> }).env).toMatchObject({
    PATH: "/opt/a:/opt/b",
    MIMIR_TASK_ID: "t1",
  });
});

it("ignores unknown watchdog messages, invalid costs and errors after the session ended", async () => {
  const worker = fakeWorker();
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession(spec);
  worker.emit("message", { kind: "progress" });
  expect(events).toEqual([]);
  for (const cost of [-1, Number.POSITIVE_INFINITY, "0.1"])
    worker.emit("message", {
      kind: "output",
      text:
        JSON.stringify({
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: cost,
        }) + "\n",
    });
  worker.emit("message", { kind: "exit", code: 0 });
  expect(events.find((e) => e.kind === "session.exited")).toMatchObject({
    usage: { tokens: 2, estimatedCost: null },
  });
  worker.emit("error", new Error("late IPC failure"));
  expect((await runtime.getSession("s1"))?.state).toBe("completed");
  expect(events.at(-1)).toMatchObject({ kind: "session.state_changed", state: "completed" });
});

it("forgets the oldest finished sessions beyond the retention bound but never a running one", async () => {
  const runtime = new CliRuntime({ codex: "/opt/agent" });
  fakeWorker();
  await runtime.createSession({ ...spec, sessionId: "running", idempotencyKey: "running" });
  const total = FINISHED_SESSIONS_KEPT + 5;
  for (let n = 0; n < total; n++) {
    const worker = fakeWorker();
    await runtime.createSession({ ...spec, sessionId: `s${n}`, idempotencyKey: `k${n}` });
    worker.emit("message", { kind: "output", text: `output of s${n}\n` });
    worker.emit("message", { kind: "exit", code: 0 });
    worker.connected = false;
    worker.emit("exit", 0);
  }
  expect(await runtime.listSessions()).toHaveLength(FINISHED_SESSIONS_KEPT + 1);
  expect((await runtime.getSession("running"))?.state).toBe("running");
  expect(await runtime.getSession("s0")).toBeNull();
  await expect(runtime.readTerminal("s4")).rejects.toMatchObject({ code: "not_found" });
  expect(await runtime.readTerminal("s5")).toContain("output of s5");
  expect(await runtime.readTerminal(`s${total - 1}`)).toContain(`output of s${total - 1}`);
  // The evicted launch's idempotency record goes with it.
  const relaunch = fakeWorker();
  await runtime.createSession({ ...spec, sessionId: "s0", idempotencyKey: "k0" });
  expect(relaunch.send).toHaveBeenCalled();
});
