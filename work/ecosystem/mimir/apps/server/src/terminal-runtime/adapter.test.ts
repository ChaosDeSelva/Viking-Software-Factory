import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeSessionSpec } from "@mimir/protocol";
import { TerminalRuntime, INTERACTIVE_HARNESSES, interactiveArgv } from "./adapter.js";
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
