import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { RuntimeSessionSpec } from "@mimir/protocol";
import { SshRuntime } from "./adapter.js";
import { sshRequest } from "./transport.js";
import { git, snapshot, restore, digest, applyResult } from "./workspace.js";
const roots: string[] = [];
const runtimes: SshRuntime[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture(
  code = 'require("node:fs").writeFileSync("hello.txt","hello remote\\n"); console.log("remote evidence");',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-remote-")));
  roots.push(root);
  const cwd = join(root, "local");
  mkdirSync(cwd);
  git(cwd, ["init", "--quiet"]);
  writeFileSync(join(cwd, "hello.txt"), "original\n");
  git(cwd, ["add", "-A"]);
  git(cwd, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--quiet",
    "-m",
    "base",
  ]);
  const agent = join(root, "agent");
  writeFileSync(agent, `#!${process.execPath}\n${code}`);
  chmodSync(agent, 0o700);
  const remote = join(root, "remote"),
    ssh = join(root, "ssh");
  const entrypoint = fileURLToPath(
    new URL("../../dist/ssh-runtime/entrypoint.js", import.meta.url),
  );
  writeFileSync(
    ssh,
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,[${JSON.stringify(entrypoint)}],{stdio:'inherit',env:{...process.env,MIMIR_REMOTE_ROOT:${JSON.stringify(remote)},MIMIR_CODEX_BIN:${JSON.stringify(agent)}}});process.exit(r.status??1);`,
  );
  chmodSync(ssh, 0o700);
  const route: import("./transport.js").SshRoute = { host: "fixture-host", root: remote },
    state = join(root, "bindings.json");
  const request: typeof sshRequest = (route, req) => sshRequest(route, req, { executable: ssh });
  const runtime = new SshRuntime(route, state, request);
  runtimes.push(runtime);
  const spec: RuntimeSessionSpec = {
    sessionId: "s1",
    idempotencyKey: "key1",
    crewId: "c1",
    taskId: "t1",
    agentKind: "codex",
    argv: ["codex", "exec", "hello"],
    cwd,
    env: { MIMIR_TASK_ID: "t1" },
    workspaceLabel: "test",
    timeoutMs: 2000,
  };
  return { root, cwd, runtime, spec, route, state, request };
}
async function until(runtime: SshRuntime, state: string) {
  for (let i = 0; i < 60; i++) {
    await runtime.reconcile();
    if ((await runtime.getSession("s1"))?.state === state) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Expected ${state}: ${JSON.stringify(await runtime.getSession("s1"))}`);
}
it("runs the real remote entrypoint, returns source changes and exposes evidence", async () => {
  const f = fixture();
  expect(await f.runtime.health()).toEqual({ ok: true });
  await f.runtime.createSession(f.spec);
  await until(f.runtime, "completed");
  expect(readFileSync(join(f.cwd, "hello.txt"), "utf8")).toBe("hello remote\n");
  expect(await f.runtime.readTerminal("s1")).toContain("remote evidence");
  await f.runtime.createSession(f.spec);
  await expect(
    f.runtime.createSession({ ...f.spec, argv: ["codex", "different"] }),
  ).rejects.toMatchObject({ code: "idempotency_replay_mismatch" });
}, 15000);
it("recovers bindings after a controller restart without resubmitting the job", async () => {
  const f = fixture();
  await f.runtime.createSession(f.spec);
  await f.runtime.dispose();
  const restarted = new SshRuntime(f.route, f.state, f.request);
  runtimes.push(restarted);
  await until(restarted, "completed");
  expect(readFileSync(join(f.cwd, "hello.txt"), "utf8")).toBe("hello remote\n");
  await restarted.reconcile();
  expect(await restarted.listSessions()).toHaveLength(1);
}, 15000);
it("parks conflicting local changes instead of overwriting them", async () => {
  const f = fixture();
  await f.runtime.createSession(f.spec);
  writeFileSync(join(f.cwd, "hello.txt"), "human change\n");
  await until(f.runtime, "blocked");
  expect(readFileSync(join(f.cwd, "hello.txt"), "utf8")).toBe("human change\n");
}, 15000);
it("cancels a remote agent through the worker's durable cancellation marker", async () => {
  const f = fixture("setInterval(()=>{},1000)");
  await f.runtime.createSession(f.spec);
  await f.runtime.requestStop("s1", "force");
  await until(f.runtime, "stopped");
}, 15000);
it("keeps uncertain transport outcomes unknown and never launches locally", async () => {
  const f = fixture();
  const runtime = new SshRuntime(f.route, join(f.root, "unknown.json"), async () => ({
    state: "unknown",
    reason: "disconnected",
  }));
  runtimes.push(runtime);
  expect((await runtime.createSession(f.spec)).state).toBe("unknown");
  await runtime.reconcile();
  expect((await runtime.getSession("s1"))?.state).toBe("unknown");
  expect(readFileSync(join(f.cwd, "hello.txt"), "utf8")).toBe("original\n");
});
it("rejects traversal snapshots and applies patches only to the original input", () => {
  const f = fixture();
  const files = snapshot(f.cwd),
    hash = digest(files);
  expect(() =>
    restore(join(f.root, "bad"), [{ path: "../escape", data: "", executable: false }]),
  ).toThrow();
  writeFileSync(join(f.cwd, "hello.txt"), "changed");
  expect(() => applyResult(f.cwd, hash, "")).toThrow("changed");
});

it("runs interactive SSH work, accepts input, and reconciles after controller restart", async () => {
  const f = fixture(
    'process.stdin.setEncoding("utf8");process.stdin.on("data",s=>{if(s.includes("finish")){require("node:fs").writeFileSync("hello.txt","interactive remote\\n");process.exit(0);}});',
  );
  // Use the existing framed transport fixture, with a real remote tmux/PTY worker.
  await f.runtime.dispose();
  const route = { ...f.route, backend: "tmux-interactive" as const };
  f.spec.timeoutMs = 15000;
  const runtime = new SshRuntime(route, f.state + "-interactive", f.request);
  runtimes.push(runtime);
  await runtime.createSession(f.spec);
  for (let i = 0; i < 40; i++) {
    await runtime.reconcile();
    if ((await runtime.getSession("s1"))?.state === "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect((await runtime.getSession("s1"))?.state).toBe("running");
  await runtime.sendInput("s1", { text: "finish" });
  await runtime.dispose();
  const recovered = new SshRuntime(route, f.state + "-interactive", f.request);
  runtimes.push(recovered);
  for (let i = 0; i < 60; i++) {
    await recovered.reconcile();
    if ((await recovered.getSession("s1"))?.state === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect((await recovered.getSession("s1"))?.state).toBe("completed");
  expect(readFileSync(join(f.cwd, "hello.txt"), "utf8")).toContain("interactive remote");
}, 20000);
