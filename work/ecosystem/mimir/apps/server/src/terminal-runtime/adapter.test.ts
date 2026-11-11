import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvent, RuntimeSessionSpec } from "@mimir/protocol";
import {
  TerminalRuntime,
  INTERACTIVE_HARNESSES,
  DELIVERED_SESSIONS_KEPT,
  interactiveArgv,
} from "./adapter.js";
import { NativeTerminalBackend, type TerminalBackend } from "./backend.js";
const roots: string[] = [],
  runtimes: TerminalRuntime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  vi.unstubAllEnvs();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function spec(): RuntimeSessionSpec {
  return {
    sessionId: "test",
    idempotencyKey: "test",
    crewId: "crew",
    taskId: "task",
    agentKind: "codex",
    argv: ["codex", "exec", "a prompt; $(do-not-execute)"],
    env: {},
    cwd: tmpdir(),
    workspaceLabel: "test",
    timeoutMs: 5000,
  };
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mimir-terminal-"));
  roots.push(home);
  const backend: TerminalBackend = {
    name: "fixture",
    health: async () => true,
    create: vi.fn(async () => "target"),
    send: vi.fn(async () => {}),
    key: vi.fn(async () => {}),
    capture: vi.fn(async () => "visible output"),
    close: vi.fn(async () => {}),
  };
  const runtime = new TerminalRuntime(backend, home);
  runtimes.push(runtime);
  return { home, backend, runtime };
}
it("preserves each harness prompt as data without approval bypass", () => {
  for (const kind of INTERACTIVE_HARNESSES) {
    const args = interactiveArgv(kind, "$(bad); prompt\nwith quote '");
    if (!["kimi", "grok"].includes(kind)) expect(args.at(-1)).toBe("$(bad); prompt\nwith quote '");
    else expect(args).not.toContain("--prompt");
    expect(args.join(" ")).not.toMatch(/--yolo|--dangerously/);
  }
});
it("persists target and deduplicates concurrent launches", async () => {
  const { home, backend, runtime } = fixture();
  await Promise.all([runtime.createSession(spec()), runtime.createSession(spec())]);
  expect(backend.create).toHaveBeenCalledTimes(1);
  expect(vi.mocked(backend.send).mock.calls[0]![1]).toMatch(/^exec '/);
  const resumed = new TerminalRuntime(backend, home);
  runtimes.push(resumed);
  await resumed.createSession(spec());
  expect(backend.create).toHaveBeenCalledTimes(1);
  await expect(resumed.createSession({ ...spec(), argv: ["changed"] })).rejects.toThrow("changed");
});
it("keeps uncertain launch pinned without a blind resend", async () => {
  const { runtime, backend } = fixture();
  vi.mocked(backend.send).mockRejectedValue(new Error("lost response"));
  expect((await runtime.createSession(spec())).state).toBe("unknown");
  await runtime.createSession(spec());
  expect(backend.send).toHaveBeenCalledTimes(1);
  await expect(runtime.sendInput("test", { text: "retry" })).rejects.toThrow("not available");
});
it("refuses post-completion input and preserves unavailable observations", async () => {
  const { runtime, backend } = fixture();
  await runtime.createSession(spec());
  vi.mocked(backend.capture).mockRejectedValue(new Error("backend offline"));
  await runtime.reconcile();
  expect((await runtime.getSession("test"))!.state).toBe("unknown");
  await expect(runtime.sendInput("test", { text: "bad" })).rejects.toThrow();
});
it.skipIf(spawnSync("tmux", ["-V"]).status !== 0)(
  "runs real tmux, recovers after controller restart, accepts input and observes exit",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "mimir-tmux-interactive-"));
    roots.push(home);
    const agent = join(home, "agent");
    writeFileSync(
      agent,
      `#!${process.execPath}\nconsole.log('ready for operator');process.stdin.once('data',x=>{console.log('received:'+x.toString().trim());process.exit(0)});`,
      { mode: 0o700 },
    );
    vi.stubEnv("MIMIR_CODEX_BIN", agent);
    const backend = new NativeTerminalBackend("tmux-interactive", home);
    const first = new TerminalRuntime(backend, home);
    runtimes.push(first);
    const launched = await first.createSession(spec());
    expect(launched.state).toBe("running");
    const target = launched.runtimeRef.terminalId!;
    try {
      for (let i = 0; i < 40; i++) {
        if ((await first.readTerminal("test")).includes("ready for operator")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await first.readTerminal("test")).toContain("ready for operator");
      await first.dispose();
      const resumed = new TerminalRuntime(backend, home);
      runtimes.push(resumed);
      await resumed.sendInput("test", { text: "operator correction; $(literal)" });
      for (let i = 0; i < 40; i++) {
        await resumed.reconcile();
        if ((await resumed.getSession("test"))!.state === "completed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect((await resumed.getSession("test"))!.state).toBe("completed");
      await expect(
        resumed.sendInput("test", { text: "must not become a shell command" }),
      ).rejects.toThrow();
    } catch (error) {
      for (const name of readdirSync(home).filter((n) => n.endsWith(".result.json")))
        console.error(readFileSync(join(home, name), "utf8"));
      throw error;
    } finally {
      await backend.close(target, "mimir-9f86d081884c7d659a2feaa0").catch(() => {});
    }
  },
);
it("does not infer process death from an acknowledged terminal close", async () => {
  const { runtime } = fixture();
  await runtime.createSession(spec());
  await runtime.requestStop("test", "force");
  expect((await runtime.getSession("test"))!.state).toBe("unknown");
  await expect(runtime.sendInput("test", { text: "no" })).rejects.toThrow();
});

it("does not reuse a previous turn's waiting hook after new input or controller restart", async () => {
  const { home, backend, runtime } = fixture();
  await runtime.createSession(spec());
  const launch = JSON.parse(
    readFileSync(
      join(
        home,
        readdirSync(home).find((n) => n.endsWith(".launch.json"))!,
      ),
      "utf8",
    ),
  );
  const hookFile = launch.env.MIMIR_HOOK_FILE;
  writeFileSync(
    launch.resultFile,
    JSON.stringify({ state: "running", observedAt: new Date().toISOString() }),
  );
  writeFileSync(
    hookFile,
    JSON.stringify({
      id: "old-turn",
      state: "waiting",
      reason: "harness_awaiting_input",
      observedAt: new Date().toISOString(),
    }),
  );
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("waiting");
  await runtime.sendInput("test", { text: "another turn" });
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("running");
  const resumed = new TerminalRuntime(backend, home);
  runtimes.push(resumed);
  await resumed.reconcile();
  expect((await resumed.getSession("test"))?.state).toBe("running");
  writeFileSync(
    hookFile,
    JSON.stringify({
      id: "new-turn",
      state: "waiting",
      reason: "harness_awaiting_input",
      observedAt: new Date().toISOString(),
    }),
  );
  await resumed.reconcile();
  expect((await resumed.getSession("test"))?.state).toBe("waiting");
  await resumed.sendInput("test", { keys: ["Enter"] });
  await resumed.reconcile();
  expect((await resumed.getSession("test"))?.state).toBe("running");
  for (const observedAt of ["invalid", new Date(Date.now() + 60000).toISOString()]) {
    writeFileSync(
      hookFile,
      JSON.stringify({
        id: "invalid-time",
        state: "waiting",
        reason: "harness_awaiting_input",
        observedAt,
      }),
    );
    await resumed.reconcile();
    expect((await resumed.getSession("test"))?.state).toBe("running");
  }
});

it("invalidates idle evidence before ambiguous input dispatch and never sends invalid keys", async () => {
  const { home, backend, runtime } = fixture();
  await runtime.createSession(spec());
  const launchName = readdirSync(home).find((name) => name.endsWith(".launch.json"))!;
  const launch = JSON.parse(readFileSync(join(home, launchName), "utf8"));
  writeFileSync(
    launch.resultFile,
    JSON.stringify({ state: "running", observedAt: new Date().toISOString() }),
  );
  writeFileSync(
    launch.env.MIMIR_HOOK_FILE,
    JSON.stringify({
      id: "prior",
      state: "waiting",
      reason: "harness_awaiting_input",
      observedAt: new Date().toISOString(),
    }),
  );
  await runtime.reconcile();
  await expect(runtime.sendInput("test", { text: "valid", keys: ["invalid"] })).rejects.toThrow(
    "Unsupported terminal key",
  );
  expect(backend.send).toHaveBeenCalledTimes(1);
  vi.mocked(backend.send).mockRejectedValue(new Error("lost acknowledgment"));
  await expect(runtime.sendInput("test", { text: "next" })).rejects.toThrow("lost acknowledgment");
  expect((await runtime.getSession("test"))?.state).toBe("unknown");
  const resumed = new TerminalRuntime(backend, home);
  runtimes.push(resumed);
  await resumed.reconcile();
  expect((await resumed.getSession("test"))?.state).toBe("running");
});

function launchOf(home: string) {
  const name = readdirSync(home).find((n) => n.endsWith(".launch.json"))!;
  return JSON.parse(readFileSync(join(home, name), "utf8"));
}
const heartbeat = (resultFile: string, observedAt = new Date().toISOString()) =>
  writeFileSync(resultFile, JSON.stringify({ state: "running", pid: 1, observedAt }));

it("reports its capabilities and refuses unknown harnesses, reused ids and an unhealthy backend", async () => {
  const { home, backend, runtime } = fixture();
  expect(() => interactiveArgv("unknown-agent", "prompt")).toThrow("Unknown interactive harness");
  const capabilities = await runtime.capabilities();
  expect(capabilities).toMatchObject({ runtime: "fixture", agentKinds: INTERACTIVE_HARNESSES });
  expect(capabilities.features).toMatchObject({
    sendInput: true,
    pause: false,
    processInfo: false,
  });
  expect(await runtime.health()).toEqual({ ok: true });
  await expect(runtime.createSession({ ...spec(), agentKind: "unknown-agent" })).rejects.toThrow(
    "Unknown interactive harness",
  );
  await runtime.createSession(spec());
  await expect(runtime.createSession({ ...spec(), idempotencyKey: "other" })).rejects.toMatchObject(
    {
      code: "conflict",
    },
  );
  // Persisted sessions belong to the backend that launched them.
  expect(() => new TerminalRuntime({ ...backend, name: "another" }, home)).toThrow(
    "Terminal backend identity changed",
  );
  const down = fixture();
  down.backend.health = async () => false;
  expect(await down.runtime.health()).toEqual({ ok: false });
  await expect(down.runtime.createSession(spec())).rejects.toMatchObject({
    code: "runtime_unavailable",
  });
  expect(await down.runtime.listSessions()).toEqual([]);
  expect(down.backend.create).not.toHaveBeenCalled();
});
it("treats a replay with reordered environment as the same launch", async () => {
  const { backend, runtime } = fixture();
  const first = await runtime.createSession({ ...spec(), env: { B_VAR: "2", A_VAR: "1" } });
  const replay = await runtime.createSession({ ...spec(), env: { A_VAR: "1", B_VAR: "2" } });
  expect(replay).toEqual(first);
  expect(backend.create).toHaveBeenCalledTimes(1);
  await expect(
    runtime.createSession({ ...spec(), env: { A_VAR: "1", B_VAR: "changed" } }),
  ).rejects.toMatchObject({ code: "idempotency_replay_mismatch" });
});
it("launches ACP agents with the prompt in the launch file and wraps operator text as data", async () => {
  const { home, backend, runtime } = fixture();
  const kimi: RuntimeSessionSpec = { ...spec(), agentKind: "kimi" };
  delete kimi.timeoutMs;
  await runtime.createSession(kimi);
  const launch = launchOf(home);
  expect(launch).toMatchObject({
    agentKind: "kimi",
    prompt: "a prompt; $(do-not-execute)",
    args: ["acp"],
    timeoutMs: 1200000,
  });
  expect(launch.env.MIMIR_HOOK_FILE).toMatch(/\.hook\.json$/);
  const sent = () =>
    vi
      .mocked(backend.send)
      .mock.calls.slice(1)
      .map((call) => call[1]);
  for (const text of ["next step; $(x)", "/quit now", "/permit nonce 1", "/cancel", "/quit"])
    await runtime.sendInput("test", { text });
  expect(sent()).toEqual([
    '/prompt "next step; $(x)"',
    '/prompt "/quit now"',
    "/permit nonce 1",
    "/cancel",
    "/quit",
  ]);
});
it("validates operator input and sessions before touching the terminal", async () => {
  const { backend, runtime } = fixture();
  await expect(runtime.sendInput("missing", { text: "x" })).rejects.toMatchObject({
    code: "not_found",
  });
  expect(await runtime.getSession("missing")).toBeNull();
  await runtime.createSession(spec());
  for (const text of ["bell\u0007", "escape\u001b[2J", "delete\u007f", "x".repeat(65537)])
    await expect(runtime.sendInput("test", { text })).rejects.toMatchObject({
      code: "validation_failed",
    });
  // Tabs and newlines are ordinary text; an empty request sends nothing at all.
  await runtime.sendInput("test", {});
  await runtime.sendInput("test", { text: "a\tb\nc" });
  expect(
    vi
      .mocked(backend.send)
      .mock.calls.map((call) => call[1])
      .slice(1),
  ).toEqual(["a\tb\nc"]);
  await runtime.sendInput("test", { keys: ["Escape", "Tab"] });
  expect(vi.mocked(backend.key).mock.calls.map((call) => call[1])).toEqual(["Escape", "Tab"]);
});
it("soft-stops with Ctrl-C, reports the stop as stopped once the runner exits, then goes quiet", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const { home, backend, runtime } = fixture();
    const events: { kind: string; state?: string; exitCode?: number; text?: string }[] = [];
    const subscription = await runtime.subscribe((event) => events.push(event));
    await runtime.subscribe(() => {});
    await runtime.createSession(spec());
    const { resultFile } = launchOf(home);
    heartbeat(resultFile);
    await runtime.requestStop("test", "soft");
    expect(backend.key).toHaveBeenCalledWith("target", "C-c", expect.any(String));
    expect(events.at(-1)).toMatchObject({ kind: "session.state_changed", state: "stopping" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter((e) => e.kind === "session.output")).toEqual([
      expect.objectContaining({ text: "visible output" }),
    ]);
    expect(events.at(-1)).toMatchObject({ state: "stopping" });
    writeFileSync(
      resultFile,
      JSON.stringify({ state: "completed", exitCode: 0, observedAt: new Date().toISOString() }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.slice(-2)).toMatchObject([
      { kind: "session.exited", exitCode: 0 },
      { kind: "session.state_changed", state: "stopped" },
    ]);
    // A delivered session is neither observed nor stopped again.
    const seen = events.length;
    await vi.advanceTimersByTimeAsync(1000);
    await runtime.requestStop("test", "force");
    expect(backend.close).not.toHaveBeenCalled();
    expect(events).toHaveLength(seen);
    subscription.close();
    await runtime.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(events).toHaveLength(seen);
  } finally {
    vi.useRealTimers();
  }
});
it("never trusts a stale heartbeat or an unreadable result as a live or finished agent", async () => {
  const { home, runtime } = fixture();
  await runtime.createSession(spec());
  const { resultFile } = launchOf(home);
  heartbeat(resultFile, new Date(Date.now() - 60000).toISOString());
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("unknown");
  writeFileSync(resultFile, '{"state":"compl');
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("unknown");
  writeFileSync(resultFile, JSON.stringify({ state: "completed", exitCode: "0" }));
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("unknown");
  writeFileSync(resultFile, JSON.stringify({ state: "failed", exitCode: 124 }));
  const { sessions } = await runtime.reconcile();
  expect(sessions).toMatchObject([{ sessionId: "test", state: "failed" }]);
});
it("cannot stop or read a launch whose terminal was never created", async () => {
  const { backend, runtime } = fixture();
  vi.mocked(backend.create).mockRejectedValue(new Error("no terminal"));
  expect((await runtime.createSession(spec())).state).toBe("unknown");
  await expect(runtime.requestStop("test", "soft")).rejects.toMatchObject({
    code: "capability_unavailable",
  });
  await expect(runtime.readTerminal("test")).rejects.toMatchObject({
    code: "capability_unavailable",
  });
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("unknown");
  expect(backend.send).not.toHaveBeenCalled();
  expect(backend.capture).not.toHaveBeenCalled();
});
it("bounds terminal reads", async () => {
  const { backend, runtime } = fixture();
  await runtime.createSession(spec());
  await runtime.readTerminal("test", 100000);
  await runtime.readTerminal("test", -5);
  await runtime.readTerminal("test");
  expect(vi.mocked(backend.capture).mock.calls.map((call) => call[1])).toEqual([5000, 1, 200]);
});
it("wires Rovo and AGY hooks per launch and removes the AGY workspace hook once the agent exits", async () => {
  const { home, runtime } = fixture();
  const workspace = mkdtempSync(join(tmpdir(), "mimir-agy-"));
  roots.push(workspace);
  spawnSync("git", ["init", "--quiet", workspace]);
  vi.stubEnv("MIMIR_ROVO_CONFIG", join(workspace, "absent-rovo.yml"));
  await runtime.createSession({
    ...spec(),
    sessionId: "rovo",
    idempotencyKey: "rovo",
    agentKind: "rovo",
  });
  const rovo = launchOf(home);
  expect(rovo.args).toEqual([
    "rovodev",
    "run",
    "--config-file",
    expect.stringMatching(/\.rovo\.yml$/),
    rovo.prompt,
  ]);
  await runtime.createSession({
    ...spec(),
    sessionId: "agy",
    idempotencyKey: "agy",
    agentKind: "agy",
    cwd: workspace,
  });
  const hooks = join(workspace, ".agents", "hooks.json");
  expect(Object.keys(JSON.parse(readFileSync(hooks, "utf8")))).toHaveLength(1);
  const agy = readdirSync(home)
    .filter((n) => n.endsWith(".launch.json"))
    .map((n) => JSON.parse(readFileSync(join(home, n), "utf8")))
    .find((launch) => launch.agentKind === "agy");
  writeFileSync(agy.resultFile, JSON.stringify({ state: "completed", exitCode: 0 }));
  await runtime.reconcile();
  expect((await runtime.getSession("agy"))?.state).toBe("completed");
  expect(existsSync(hooks)).toBe(false);
});
it("derives Cursor idle from a new transcript and forgets it once the operator types again", async () => {
  const { home, runtime } = fixture();
  const projects = mkdtempSync(join(tmpdir(), "mimir-cursor-"));
  roots.push(projects);
  const project = join(projects, "slug");
  mkdirSync(project);
  writeFileSync(join(project, ".workspace-trusted"), JSON.stringify({ workspacePath: "/task" }));
  await runtime.createSession({
    ...spec(),
    agentKind: "cursor",
    cwd: "/task",
    env: { MIMIR_CURSOR_PROJECTS_ROOT: projects },
  });
  const { resultFile } = launchOf(home);
  heartbeat(resultFile);
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("running");
  // Input before the conversation exists has no earlier idle evidence to discard.
  await runtime.sendInput("test", { text: "start" });
  const dir = join(project, "agent-transcripts", "conversation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "conversation.jsonl"),
    JSON.stringify({ role: "user" }) + "\n" + JSON.stringify({ type: "turn_ended" }) + "\n",
  );
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((event) => events.push(event));
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("waiting");
  expect(events.at(-1)).toMatchObject({
    state: "waiting",
    runtimeStatus: "cursor_session_transcript",
  });
  await runtime.sendInput("test", { text: "continue" });
  heartbeat(resultFile);
  await runtime.reconcile();
  expect((await runtime.getSession("test"))?.state).toBe("running");
});
it("keeps polling after a failed observation and stops when disposed", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const { home, backend, runtime } = fixture();
    await runtime.createSession(spec());
    await runtime.subscribe(() => {});
    vi.mocked(backend.capture).mockClear();
    // The state file cannot be written while the home is gone; the poll fails without escaping.
    const moved = home + ".moved";
    renameSync(home, moved);
    try {
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      renameSync(moved, home);
    }
    expect(backend.capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.capture).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")).bindings).toHaveLength(1);
    await runtime.dispose();
    await vi.advanceTimersByTimeAsync(3000);
    expect(backend.capture).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
it("launches with an empty prompt when the request carries no arguments", async () => {
  const { home, runtime } = fixture();
  await runtime.createSession({ ...spec(), argv: [] });
  const launch = launchOf(home);
  expect(launch.prompt).toBe("");
  expect(launch.args.at(-1)).toBe("");
});
it("accepts input for a session persisted before hook evidence existed", async () => {
  const { home, backend, runtime } = fixture();
  await runtime.createSession(spec());
  await runtime.dispose();
  const file = join(home, "sessions.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  delete stored.bindings[0][1].hookFile;
  writeFileSync(file, JSON.stringify(stored));
  const resumed = new TerminalRuntime(backend, home);
  runtimes.push(resumed);
  await resumed.sendInput("test", { text: "continue" });
  expect(vi.mocked(backend.send).mock.calls.at(-1)?.[1]).toBe("continue");
  expect((await resumed.getSession("test"))?.state).toBe("running");
});
it("prunes the oldest delivered sessions beyond the retention bound but keeps live ones", async () => {
  const { home, runtime } = fixture();
  await runtime.createSession({ ...spec(), sessionId: "live", idempotencyKey: "live" });
  const total = DELIVERED_SESSIONS_KEPT + 5;
  for (let n = 0; n < total; n++) {
    const before = new Set(readdirSync(home));
    await runtime.createSession({ ...spec(), sessionId: `s${n}`, idempotencyKey: `k${n}` });
    const name = readdirSync(home).find((f) => f.endsWith(".launch.json") && !before.has(f))!;
    const { resultFile } = JSON.parse(readFileSync(join(home, name), "utf8"));
    writeFileSync(resultFile, JSON.stringify({ state: "completed", exitCode: 0 }));
    // The pass that delivers a session still reports it, so a boot reconcile can apply it.
    const { sessions } = await runtime.reconcile();
    expect(sessions).toContainEqual(
      expect.objectContaining({ sessionId: `s${n}`, state: "completed" }),
    );
  }
  await runtime.reconcile();
  const stored = JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"));
  expect(stored.bindings).toHaveLength(DELIVERED_SESSIONS_KEPT + 1);
  expect(await runtime.getSession("live")).not.toBeNull();
  expect(await runtime.getSession("s4")).toBeNull();
  await expect(runtime.readTerminal("s4")).rejects.toMatchObject({ code: "not_found" });
  expect(await runtime.readTerminal("s5")).toBe("visible output");
});
it("refuses to replay a pruned launch, also after a restart", async () => {
  const { home, backend, runtime } = fixture();
  for (let n = 0; n <= DELIVERED_SESSIONS_KEPT; n++) {
    const before = new Set(readdirSync(home));
    await runtime.createSession({ ...spec(), sessionId: `s${n}`, idempotencyKey: `k${n}` });
    const name = readdirSync(home).find((f) => f.endsWith(".launch.json") && !before.has(f))!;
    const { resultFile } = JSON.parse(readFileSync(join(home, name), "utf8"));
    writeFileSync(resultFile, JSON.stringify({ state: "completed", exitCode: 0 }));
    await runtime.reconcile();
  }
  await runtime.reconcile();
  expect(await runtime.getSession("s0")).toBeNull();
  const launches = vi.mocked(backend.create).mock.calls.length;
  const replay = { ...spec(), sessionId: "s0", idempotencyKey: "k0" };
  await expect(runtime.createSession(replay)).rejects.toMatchObject({ code: "conflict" });
  await expect(
    runtime.createSession({ ...replay, argv: ["codex", "changed"] }),
  ).rejects.toMatchObject({ code: "idempotency_replay_mismatch" });
  const resumed = new TerminalRuntime(backend, home);
  runtimes.push(resumed);
  await expect(resumed.createSession(replay)).rejects.toMatchObject({ code: "conflict" });
  expect(backend.create).toHaveBeenCalledTimes(launches);
});
it("stops polling when the last subscriber closes and resumes on the next subscribe", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const { backend, runtime } = fixture();
    await runtime.createSession(spec());
    const first = await runtime.subscribe(() => {});
    const second = await runtime.subscribe(() => {});
    first.close();
    expect(vi.getTimerCount()).toBe(1);
    second.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.mocked(backend.capture).mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.capture).not.toHaveBeenCalled();
    await runtime.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.capture).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("deletes the launch, result and hook files of a pruned session", async () => {
  const { home, runtime } = fixture();
  const labels: string[] = [];
  for (let n = 0; n <= DELIVERED_SESSIONS_KEPT; n++) {
    await runtime.createSession({
      ...spec(),
      sessionId: `s${n}`,
      idempotencyKey: `k${n}`,
      argv: ["codex", "secret prompt"],
    });
    const label = readdirSync(home)
      .filter((f) => f.endsWith(".launch.json"))
      .map((f) => f.slice(0, -".launch.json".length))
      .find((l) => !labels.includes(l))!;
    labels.push(label);
    writeFileSync(join(home, label + ".hook.json"), "{}");
    writeFileSync(
      join(home, label + ".result.json"),
      JSON.stringify({ state: "completed", exitCode: 0 }),
    );
    await runtime.reconcile();
  }
  await runtime.reconcile();
  expect(await runtime.getSession("s0")).toBeNull();
  // The launch file holds the prompt and environment; nothing references it once pruned.
  expect(readdirSync(home).filter((f) => f.startsWith(labels[0]!))).toEqual([]);
  expect(existsSync(join(home, labels[1]! + ".launch.json"))).toBe(true);
});
it("keeps a long-running session that was delivered last over older deliveries", async () => {
  const { home, runtime } = fixture();
  const deliver = (before: Set<string>) => {
    const name = readdirSync(home).find((f) => f.endsWith(".launch.json") && !before.has(f))!;
    return JSON.parse(readFileSync(join(home, name), "utf8")).resultFile as string;
  };
  let before = new Set(readdirSync(home));
  await runtime.createSession({ ...spec(), sessionId: "early", idempotencyKey: "early" });
  const earlyResult = deliver(before);
  for (let n = 0; n <= DELIVERED_SESSIONS_KEPT; n++) {
    before = new Set(readdirSync(home));
    await runtime.createSession({ ...spec(), sessionId: `s${n}`, idempotencyKey: `k${n}` });
    writeFileSync(deliver(before), JSON.stringify({ state: "completed", exitCode: 0 }));
    await runtime.reconcile();
  }
  writeFileSync(earlyResult, JSON.stringify({ state: "completed", exitCode: 0 }));
  await runtime.reconcile();
  await runtime.reconcile();
  expect(await runtime.getSession("early")).toMatchObject({ state: "completed" });
  expect(await runtime.readTerminal("early")).toBe("visible output");
  expect(await runtime.getSession("s1")).toBeNull();
});
