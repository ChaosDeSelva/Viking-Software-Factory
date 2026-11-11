import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvent, RuntimeSessionSpec } from "@mimir/protocol";
import { SshRuntime } from "./adapter.js";
import type { RemoteRequest, SshRoute, TransportResult } from "./transport.js";
import { git } from "./workspace.js";

// The remote side is scripted, but every launch snapshots a real git worktree.
vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
const runtimes: SshRuntime[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
type Reply = TransportResult | Promise<TransportResult>;
const confirmed = (response: Record<string, unknown>): TransportResult => ({
  state: "confirmed",
  response: { protocol: 1, ...response },
});
const job = (state: string, extra: Record<string, unknown> = {}, output?: unknown) =>
  confirmed({ ok: true, job: { state, ...extra }, ...(output === undefined ? {} : { output }) });
function fixture(route: SshRoute = { host: "fixture-host", root: "/srv/mimir" }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-ssh-adapter-")));
  roots.push(root);
  const cwd = join(root, "local");
  mkdirSync(cwd);
  git(cwd, ["init", "--quiet"]);
  writeFileSync(join(cwd, "hello.txt"), "original\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.name=T", "-c", "user.email=t@localhost", "commit", "--quiet", "-m", "b"]);
  const remote = {
    requests: [] as RemoteRequest[],
    submit: (): Reply => job("starting"),
    inspect: (): Reply => job("running"),
    other: (): Reply => confirmed({ ok: true }),
  };
  const request = async (_route: SshRoute, req: RemoteRequest) => {
    remote.requests.push(req);
    return req.operation === "submit"
      ? remote.submit()
      : req.operation === "inspect"
        ? remote.inspect()
        : remote.other();
  };
  const state = join(root, "state", "bindings.json");
  const open = () => {
    const runtime = new SshRuntime(route, state, request);
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = open();
  const events: RuntimeEvent[] = [];
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
  };
  const operations = () => remote.requests.map((r) => r.operation);
  return { root, cwd, remote, runtime, open, state, route, spec, events, operations };
}
/** A patch as the remote worker produces it, without leaving the change in the local worktree. */
function remotePatch(cwd: string, text: string) {
  writeFileSync(join(cwd, "hello.txt"), text);
  git(cwd, ["add", "-A"]);
  const patch = git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"]);
  git(cwd, ["reset", "--quiet", "--hard", "HEAD"]);
  return patch;
}

it("advertises interactive control only for an interactive backend and reports worker health", async () => {
  const headless = fixture();
  expect(await headless.runtime.capabilities()).toMatchObject({
    runtime: "ssh",
    agentKinds: ["codex", "claude", "opencode", "gemini", "pi"],
    features: { sendInput: false, sendKeys: false, softStop: true, terminalRead: true },
  });
  headless.remote.other = () => confirmed({ ok: true });
  expect(await headless.runtime.health()).toEqual({ ok: true });
  expect(headless.remote.requests.at(-1)).toEqual({
    operation: "health",
    payload: { backend: "cli" },
  });
  headless.remote.other = () => confirmed({ ok: false });
  expect(await headless.runtime.health()).toMatchObject({ ok: false });
  headless.remote.other = () => ({ state: "unavailable", reason: "no ssh" });
  expect(await headless.runtime.health()).toMatchObject({ ok: false });

  const interactive = fixture({ host: "h", root: "/srv/mimir", backend: "tmux-interactive" });
  expect((await interactive.runtime.capabilities()).features).toMatchObject({
    sendInput: true,
    sendKeys: true,
  });
  await interactive.runtime.health();
  expect(interactive.remote.requests.at(-1)?.payload).toEqual({ backend: "tmux-interactive" });
});

it("submits the tracked workspace once and persists the binding privately", async () => {
  const f = fixture();
  const session = await f.runtime.createSession(f.spec);
  expect(session).toMatchObject({
    sessionId: "s1",
    state: "starting",
    agentKind: "codex",
    runtimeRef: { workspaceId: "fixture-host" },
  });
  expect(f.remote.requests).toHaveLength(1);
  expect(f.remote.requests[0]).toMatchObject({
    operation: "submit",
    jobId: session.runtimeRef.agentSessionId,
    payload: {
      backend: "cli",
      agentKind: "codex",
      argv: ["codex", "exec", "hello"],
      taskEnv: { MIMIR_TASK_ID: "t1" },
      timeoutMs: 1200000,
      files: [
        {
          path: "hello.txt",
          data: Buffer.from("original\n").toString("base64"),
          executable: false,
        },
      ],
    },
  });
  expect(statSync(f.state).mode & 0o777).toBe(0o600);
  expect(await f.runtime.createSession(f.spec)).toEqual(session);
  expect(f.remote.requests).toHaveLength(1);
  expect(await f.runtime.listSessions()).toEqual([session]);
  await expect(
    f.runtime.createSession({ ...f.spec, idempotencyKey: "another" }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(f.runtime.createSession({ ...f.spec, timeoutMs: 5 })).rejects.toMatchObject({
    code: "idempotency_replay_mismatch",
  });
  expect(await f.runtime.getSession("missing")).toBeNull();
});

it("refuses unsupported harnesses and environment forwarding before contacting the worker", async () => {
  const f = fixture();
  await expect(f.runtime.createSession({ ...f.spec, agentKind: "bash" })).rejects.toMatchObject({
    code: "capability_unavailable",
  });
  await expect(
    f.runtime.createSession({ ...f.spec, env: { AWS_SECRET_ACCESS_KEY: "x" } }),
  ).rejects.toMatchObject({ code: "validation_failed" });
  expect(f.remote.requests).toEqual([]);
  expect(await f.runtime.listSessions()).toEqual([]);
  const interactive = fixture({ host: "h", root: "/srv/mimir", backend: "tmux-interactive" });
  await expect(
    interactive.runtime.createSession({ ...interactive.spec, agentKind: "bash" }),
  ).rejects.toMatchObject({ code: "capability_unavailable" });
});

it("fails a launch the worker rejects and never polls it again", async () => {
  const f = fixture();
  await f.runtime.subscribe((e) => f.events.push(e));
  f.remote.submit = () => confirmed({ ok: false, error: "Job replay mismatch" });
  expect((await f.runtime.createSession(f.spec)).state).toBe("failed");
  expect(f.events).toMatchObject([
    { kind: "session.state_changed", state: "failed", runtimeStatus: "Job replay mismatch" },
  ]);
  await f.runtime.reconcile();
  expect(f.operations()).toEqual(["submit"]);
  await f.runtime.requestStop("s1", "force");
  expect(f.operations()).toEqual(["submit"]);

  const silent = fixture();
  await silent.runtime.subscribe((e) => silent.events.push(e));
  silent.remote.submit = () => confirmed({ ok: false });
  await silent.runtime.createSession(silent.spec);
  expect(silent.events).toMatchObject([{ state: "failed", runtimeStatus: "remote_rejected" }]);
});

it("does not inspect a job whose submission is still in flight", async () => {
  const f = fixture();
  await f.runtime.subscribe((e) => f.events.push(e));
  let release!: (value: TransportResult) => void;
  f.remote.submit = () => new Promise<TransportResult>((resolve) => (release = resolve));
  // Until the submission lands the worker does not know the job.
  f.remote.inspect = () => confirmed({ ok: false, error: "job_not_found" });
  const created = f.runtime.createSession(f.spec);
  await vi.waitFor(() => expect(f.operations()).toEqual(["submit"]));
  await f.runtime.reconcile();
  release(job("starting"));
  expect((await created).state).toBe("starting");
  expect(f.events).toEqual([]);
  expect(f.operations()).toEqual(["submit"]);
  f.remote.inspect = () => job("running");
  await f.runtime.reconcile();
  expect((await f.runtime.getSession("s1"))?.state).toBe("running");
});

it("fails a launch whose submission was refused locally instead of reporting it as starting", async () => {
  const f = fixture();
  await f.runtime.subscribe((e) => f.events.push(e));
  // sshRequest throws only before it starts SSH (e.g. an oversized request): nothing reached the worker.
  f.remote.submit = () => {
    throw new Error("Remote request exceeds 16 MiB");
  };
  await expect(f.runtime.createSession(f.spec)).rejects.toThrow("exceeds 16 MiB");
  expect(await f.runtime.getSession("s1")).toMatchObject({ state: "failed" });
  expect(f.events).toMatchObject([
    { state: "failed", runtimeStatus: "Remote request exceeds 16 MiB" },
  ]);
  // A replay reports the failure without resubmitting, and the job is never inspected.
  expect(await f.runtime.createSession(f.spec)).toMatchObject({ state: "failed" });
  await f.runtime.reconcile();
  expect(f.operations()).toEqual(["submit"]);
  expect(await f.open().getSession("s1")).toMatchObject({ state: "failed" });

  const odd = fixture();
  await odd.runtime.subscribe((e) => odd.events.push(e));
  odd.remote.submit = () => Promise.reject("not an error");
  await expect(odd.runtime.createSession(odd.spec)).rejects.toBe("not an error");
  expect(odd.events).toMatchObject([{ state: "failed", runtimeStatus: "remote_request_refused" }]);
});

it("streams new output, applies the returned patch, then reports exit before the final state", async () => {
  const f = fixture();
  await f.runtime.subscribe((e) => f.events.push(e));
  await f.runtime.createSession(f.spec);
  f.remote.inspect = () => job("running", {}, "one\n");
  await f.runtime.reconcile();
  await f.runtime.reconcile();
  const patch = remotePatch(f.cwd, "remote\n");
  f.remote.inspect = () => job("completed", { exitCode: 0, patch }, "one\ntwo\n");
  expect((await f.runtime.reconcile()).sessions).toMatchObject([{ state: "completed" }]);
  expect(readFileSync(join(f.cwd, "hello.txt"), "utf8")).toBe("remote\n");
  expect(f.events.map((e) => [e.kind, "text" in e ? e.text : "state" in e ? e.state : e])).toEqual([
    ["session.output", "one\n"],
    ["session.state_changed", "running"],
    ["session.state_changed", "running"],
    ["session.output", "two\n"],
    ["session.exited", expect.objectContaining({ exitCode: 0 })],
    ["session.state_changed", "completed"],
  ]);
  // A delivered result is final: no further requests, and the patch is not applied twice.
  const before = f.remote.requests.length;
  await f.runtime.reconcile();
  expect(f.remote.requests).toHaveLength(before);
  await expect(f.runtime.sendInput("s1", { text: "more" })).rejects.toMatchObject({
    code: "capability_unavailable",
  });
});

it("reports failed and stopped jobs with a nonzero exit code and the worker's reason", async () => {
  for (const [state, extra, exitCode] of [
    ["failed", { exitCode: 7, reason: "agent_error" }, 7],
    ["failed", { exitCode: 0, reason: "output_limit" }, 1],
    ["stopped", {}, 1],
  ] as const) {
    const f = fixture();
    await f.runtime.subscribe((e) => f.events.push(e));
    await f.runtime.createSession(f.spec);
    f.remote.inspect = () => job(state, extra, 42);
    await f.runtime.reconcile();
    expect(f.events).toMatchObject([
      { kind: "session.exited", exitCode },
      {
        kind: "session.state_changed",
        state,
        ...("reason" in extra ? { runtimeStatus: extra.reason } : {}),
      },
    ]);
    expect(readFileSync(join(f.cwd, "hello.txt"), "utf8")).toBe("original\n");
  }
});

it("parks a completion without usable patch evidence until it can be reconciled", async () => {
  const f = fixture();
  await f.runtime.subscribe((e) => f.events.push(e));
  await f.runtime.createSession(f.spec);
  f.remote.inspect = () => job("completed", { exitCode: 0 });
  await f.runtime.reconcile();
  expect(f.events).toMatchObject([
    {
      kind: "session.state_changed",
      state: "blocked",
      runtimeStatus: "remote_patch_requires_manual_reconciliation",
    },
  ]);
  // Not delivered: once the evidence is usable the same job completes.
  f.remote.inspect = () => job("completed", { exitCode: 0, patch: "" });
  await f.runtime.reconcile();
  expect((await f.runtime.getSession("s1"))?.state).toBe("completed");
});

it("keeps a session unknown while the worker's answer is missing, malformed or lost", async () => {
  const f = fixture();
  await f.runtime.subscribe((e) => f.events.push(e));
  await f.runtime.createSession(f.spec);
  const replies: [() => Reply, string][] = [
    [() => ({ state: "unknown", reason: "SSH exited 255" }), "remote_completion_unconfirmed"],
    [() => confirmed({ ok: false, error: "job_not_found" }), "remote_completion_unconfirmed"],
    [() => confirmed({ ok: true }), "invalid_remote_state"],
    [() => confirmed({ ok: true, job: {} }), "invalid_remote_state"],
    [() => job("exploded"), "invalid_remote_state"],
    [() => Promise.reject(new Error("requester crashed")), "remote_request_failed"],
  ];
  for (const [reply, reason] of replies) {
    f.remote.inspect = reply;
    await f.runtime.reconcile();
    expect(f.events.at(-1)).toMatchObject({ state: "unknown", runtimeStatus: reason });
  }
  expect(f.events.every((e) => e.kind === "session.state_changed")).toBe(true);
  f.remote.inspect = () => job("running");
  await f.runtime.reconcile();
  expect((await f.runtime.getSession("s1"))?.state).toBe("running");
});

it("reads bounded remote terminal output", async () => {
  const f = fixture();
  await expect(f.runtime.readTerminal("missing")).rejects.toMatchObject({ code: "not_found" });
  await f.runtime.createSession(f.spec);
  f.remote.inspect = () => job("running", {}, "one\ntwo\nthree");
  expect(await f.runtime.readTerminal("s1")).toBe("one\ntwo\nthree");
  expect(await f.runtime.readTerminal("s1", 2)).toBe("two\nthree");
  expect(await f.runtime.readTerminal("s1", 0)).toBe("three");
  f.remote.inspect = () => job("running");
  await expect(f.runtime.readTerminal("s1")).rejects.toMatchObject({
    code: "capability_unavailable",
  });
  f.remote.inspect = () => ({ state: "unknown", reason: "lost" });
  await expect(f.runtime.readTerminal("s1")).rejects.toMatchObject({
    code: "capability_unavailable",
  });
});

it("delivers text and keys to an interactive job with a fresh command identity each time", async () => {
  const f = fixture({ host: "h", root: "/srv/mimir", backend: "tmux-interactive" });
  await f.runtime.subscribe((e) => f.events.push(e));
  await expect(f.runtime.sendInput("missing", { text: "hi" })).rejects.toMatchObject({
    code: "not_found",
  });
  const session = await f.runtime.createSession({ ...f.spec, agentKind: "claude" });
  await f.runtime.sendInput("s1", { text: "hello" });
  await f.runtime.sendInput("s1", { keys: ["Enter"] });
  const [text, keys] = f.remote.requests.slice(-2);
  expect(text).toMatchObject({
    operation: "input",
    jobId: session.runtimeRef.agentSessionId,
    payload: { text: "hello" },
  });
  expect(keys).toMatchObject({ operation: "keys", payload: { keys: ["Enter"] } });
  expect(text!.payload!["commandId"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(keys!.payload!["commandId"]).not.toBe(text!.payload!["commandId"]);
  const sent = f.remote.requests.length;
  await expect(f.runtime.sendInput("s1", { text: "a", keys: ["Enter"] })).rejects.toMatchObject({
    code: "validation_failed",
  });
  await expect(f.runtime.sendInput("s1", {})).rejects.toMatchObject({ code: "validation_failed" });
  await expect(f.runtime.sendInput("s1", { text: "", keys: [] })).rejects.toMatchObject({
    code: "validation_failed",
  });
  expect(f.remote.requests).toHaveLength(sent);
  expect(f.events).toEqual([]);

  // An unconfirmed delivery is reported as uncertain, never silently retried.
  f.remote.other = () => confirmed({ ok: false, error: "Control delivery unconfirmed" });
  await expect(f.runtime.sendInput("s1", { text: "again" })).rejects.toMatchObject({
    code: "runtime_unavailable",
  });
  f.remote.other = () => ({ state: "unknown", reason: "lost" });
  await expect(f.runtime.sendInput("s1", { keys: ["C-c"] })).rejects.toMatchObject({
    code: "runtime_unavailable",
  });
  expect(f.remote.requests).toHaveLength(sent + 2);
  expect(f.events).toMatchObject([
    { state: "unknown", runtimeStatus: "remote_input_unconfirmed" },
    { state: "unknown", runtimeStatus: "remote_input_unconfirmed" },
  ]);

  f.remote.inspect = () => job("completed", { patch: "" });
  await f.runtime.reconcile();
  await expect(f.runtime.sendInput("s1", { text: "late" })).rejects.toMatchObject({
    code: "conflict",
  });
});

it("requests cancellation and reflects whether the worker acknowledged it", async () => {
  const f = fixture();
  await f.runtime.subscribe((e) => f.events.push(e));
  await expect(f.runtime.requestStop("missing", "soft")).rejects.toMatchObject({
    code: "not_found",
  });
  await f.runtime.createSession(f.spec);
  await f.runtime.requestStop("s1", "soft");
  expect(f.remote.requests.at(-1)).toMatchObject({
    operation: "cancel",
    payload: { mode: "soft" },
  });
  expect(f.events.at(-1)).toMatchObject({
    state: "stopping",
    runtimeStatus: "remote_cancel_requested",
  });
  f.remote.other = () => confirmed({ ok: false, error: "job_not_found" });
  await f.runtime.requestStop("s1", "force");
  expect(f.remote.requests.at(-1)).toMatchObject({ payload: { mode: "force" } });
  expect(f.events.at(-1)).toMatchObject({ state: "unknown" });
  f.remote.other = () => ({ state: "unknown", reason: "lost" });
  await f.runtime.requestStop("s1", "force");
  expect(f.events.at(-1)).toMatchObject({ state: "unknown" });
});

it("polls once a second for subscribers and stops when disposed", async () => {
  const f = fixture();
  await f.runtime.createSession(f.spec);
  vi.useFakeTimers();
  const first = await f.runtime.subscribe((e) => f.events.push(e));
  const other: RuntimeEvent[] = [];
  await f.runtime.subscribe((e) => other.push(e));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.operations()).toEqual(["submit", "inspect"]);
  expect(f.events).toMatchObject([{ kind: "session.state_changed", state: "running" }]);
  first.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.events).toHaveLength(1);
  expect(other).toHaveLength(2);
  await f.runtime.dispose();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.operations()).toEqual(["submit", "inspect", "inspect"]);
});

it("skips an overlapping poll and waits for the one in flight before disposing", async () => {
  const f = fixture();
  await f.runtime.createSession(f.spec);
  let release!: (value: TransportResult) => void;
  f.remote.inspect = () => new Promise<TransportResult>((resolve) => (release = resolve));
  const first = f.runtime.reconcile();
  await vi.waitFor(() => expect(f.operations()).toEqual(["submit", "inspect"]));
  await f.runtime.reconcile();
  expect(f.operations()).toEqual(["submit", "inspect"]);
  let disposed = false;
  const disposing = f.runtime.dispose().then(() => (disposed = true));
  await new Promise((r) => setTimeout(r, 60));
  expect(disposed).toBe(false);
  release(job("running"));
  await disposing;
  expect((await first).sessions).toMatchObject([{ state: "running" }]);
});

it("reloads bindings after a restart and refuses a state file that belongs to another route", async () => {
  const f = fixture();
  const session = await f.runtime.createSession(f.spec);
  await f.runtime.dispose();
  const restarted = f.open();
  expect(await restarted.listSessions()).toEqual([session]);
  // The replayed launch is recognised without contacting the worker again.
  expect(await restarted.createSession(f.spec)).toEqual(session);
  expect(f.operations()).toEqual(["submit"]);
  await expect(
    restarted.createSession({ ...f.spec, argv: ["codex", "other"] }),
  ).rejects.toMatchObject({ code: "idempotency_replay_mismatch" });
  expect(() => new SshRuntime({ ...f.route, root: "/srv/other" }, f.state)).toThrow(
    /SSH route changed/,
  );
  expect(() => new SshRuntime({ host: "user@host", root: "/srv/mimir" }, f.state)).toThrow(
    /SSH configuration alias/,
  );
});
