import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeSessionSpec } from "@mimir/protocol";
import { CliRuntime } from "./adapter.js";

const roots: string[] = [];
const runtimes: CliRuntime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), "mimir-cli-runtime-"));
  roots.push(root);
  const executable = join(root, "agent");
  writeFileSync(executable, `#!${process.execPath}\n${code}`);
  chmodSync(executable, 0o700);
  const runtime = new CliRuntime({ codex: executable, claude: executable });
  runtimes.push(runtime);
  const spec: RuntimeSessionSpec = {
    sessionId: "s1",
    idempotencyKey: "key1",
    taskId: "t1",
    crewId: "c1",
    agentKind: "codex",
    argv: ["codex", "exec", "brief"],
    cwd: root,
    env: {},
    workspaceLabel: "test",
  };
  return { root, runtime, spec };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition did not become true");
}
it("records measured usage before completion and deduplicates launches", async () => {
  const { runtime, spec } = fixture(
    'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,output_tokens:20}}));',
  );
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession(spec);
  await runtime.createSession(spec);
  await until(async () => (await runtime.getSession("s1"))?.state === "completed");
  expect(await runtime.listSessions()).toHaveLength(1);
  expect(events.find((e) => e.kind === "session.exited")).toMatchObject({
    usage: { tokens: 120, estimatedCost: null },
    exitCode: 0,
  });
  expect(events.at(-1)).toMatchObject({ kind: "session.state_changed", state: "completed" });
});

it("refuses changed replays and session identity reuse without launching another worker", async () => {
  const { runtime, spec } = fixture("setInterval(()=>{},1000);");
  await runtime.createSession({ ...spec, env: { B: "2", A: "1" } });
  await runtime.createSession({ ...spec, env: { A: "1", B: "2" } });
  await expect(
    runtime.createSession({ ...spec, argv: ["codex", "different"] }),
  ).rejects.toMatchObject({ code: "idempotency_replay_mismatch" });
  await expect(
    runtime.createSession({ ...spec, idempotencyKey: "different" }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await runtime.listSessions()).toHaveLength(1);
});

it("reports capabilities and supports stopping and reconciling tracked sessions", async () => {
  const { runtime, spec } = fixture("setInterval(()=>{},1000);");
  expect(await runtime.health()).toEqual({ ok: true });
  expect(await runtime.capabilities()).toMatchObject({
    agentKinds: ["codex", "claude", "opencode", "gemini", "pi"],
    features: { sendInput: false, forceStop: true },
  });
  await expect(runtime.createSession({ ...spec, agentKind: "unsupported" })).rejects.toMatchObject({
    code: "capability_unavailable",
  });
  expect(await runtime.getSession("missing")).toBeNull();
  await expect(runtime.requestStop("missing", "soft")).rejects.toMatchObject({ code: "not_found" });
  const events: RuntimeEvent[] = [];
  const subscription = await runtime.subscribe((e) => events.push(e));
  subscription.close();
  await runtime.createSession(spec);
  await runtime.requestStop("s1", "force");
  await until(async () => (await runtime.getSession("s1"))?.state === "stopped");
  expect(events).toEqual([]);
  expect(await runtime.reconcile()).toMatchObject({ lost: [], sessions: [{ state: "stopped" }] });
});

it("fails cleanly when an installed executable disappears", async () => {
  const { runtime, spec, root } = fixture("");
  rmSync(join(root, "agent"));
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession(spec);
  await until(async () => (await runtime.getSession("s1"))?.state === "failed");
  expect(events.at(-1)).toMatchObject({ runtimeStatus: "cli_unavailable" });
});

it("terminates excessive output instead of growing an unbounded transcript", async () => {
  const { runtime, spec } = fixture(
    'const chunk="x".repeat(65536);for(let i=0;i<600;i++)process.stdout.write(chunk);setInterval(()=>{},1000);',
  );
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => {
    if (e.kind !== "session.output") events.push(e);
  });
  await runtime.createSession(spec);
  await until(async () => (await runtime.getSession("s1"))?.state === "failed");
  expect(events.at(-1)).toMatchObject({ runtimeStatus: "output_limit" });
});
it("counts Claude cache tokens and reports nonzero exits as failures", async () => {
  const { runtime, spec } = fixture(
    'console.log(JSON.stringify({type:"result",usage:{input_tokens:2,output_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:5},total_cost_usd:0.02}));process.exitCode=1;',
  );
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession({ ...spec, agentKind: "claude" });
  await until(async () => (await runtime.getSession("s1"))?.state === "failed");
  expect(events.find((e) => e.kind === "session.exited")).toMatchObject({
    usage: { tokens: 14, estimatedCost: 0.02 },
  });
});
it("enforces the wall-clock deadline and kills the process", async () => {
  const { runtime, spec, root } = fixture(
    'require("node:fs").writeFileSync("pid",String(process.pid)); setInterval(()=>{},1000);',
  );
  const events: RuntimeEvent[] = [];
  await runtime.subscribe((e) => events.push(e));
  await runtime.createSession({ ...spec, timeoutMs: 300 });
  await until(async () => (await runtime.getSession("s1"))?.state === "failed");
  expect(events.at(-1)).toMatchObject({ runtimeStatus: "wall_clock_limit" });
  expect(() => process.kill(Number(readFileSync(join(root, "pid"), "utf8")), 0)).toThrow();
});
it("disconnecting the watchdog stops the agent and refuses unsupported interactive input", async () => {
  const { runtime, spec, root } = fixture(
    'require("node:fs").writeFileSync("pid",String(process.pid)); setInterval(()=>{},1000);',
  );
  await runtime.createSession(spec);
  await until(() => existsSync(join(root, "pid")));
  const pid = Number(readFileSync(join(root, "pid"), "utf8"));
  await expect(runtime.sendInput()).rejects.toMatchObject({ code: "capability_unavailable" });
  await runtime.dispose();
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

it("exposes bounded terminal output from local CLI sessions", async () => {
  const { runtime, spec } = fixture('console.log("one\\ntwo");');
  await runtime.createSession(spec);
  await until(async () => (await runtime.getSession("s1"))?.state === "completed");
  expect(await runtime.readTerminal("s1", 10)).toContain("two");
  await expect(runtime.readTerminal("missing")).rejects.toMatchObject({ code: "not_found" });
});

it.each(["opencode", "gemini", "pi"] as const)(
  "runs the %s profile as a bounded headless executable",
  async (kind) => {
    const { root, spec } = fixture('console.log("profile output");');
    const runtime = new CliRuntime({ [kind]: join(root, "agent") });
    runtimes.push(runtime);
    await runtime.createSession({
      ...spec,
      agentKind: kind,
      argv: [kind, "prompt with ; $() quotes"],
    });
    await until(async () => (await runtime.getSession("s1"))?.state === "completed");
    expect(await runtime.readTerminal("s1")).toContain("profile output");
  },
);

it.skipIf(spawnSync(process.env["MIMIR_TMUX_BIN"] ?? "tmux", ["-V"]).status !== 0)(
  "runs a task in a real tmux session and returns its output and exit status",
  async () => {
    const { root, spec } = fixture('console.log("tmux evidence");');
    const runtime = new CliRuntime({ codex: join(root, "agent") }, "tmux");
    runtimes.push(runtime);
    await runtime.createSession(spec);
    await until(async () => (await runtime.getSession("s1"))?.state === "completed");
    expect(await runtime.readTerminal("s1")).toContain("tmux evidence");
  },
);
