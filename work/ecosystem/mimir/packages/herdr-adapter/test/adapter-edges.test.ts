// Edge paths of the adapter: launch failures, stop races, reconcile/bootstrap of bindings that
// were written by an earlier adapter process, and envelopes HerdR can push at awkward moments.
import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { newId, type RuntimeEvent } from "@mimir/protocol";
import {
  HerdrAdapter,
  HerdrError,
  HerdrSocketClient,
  MemoryBindingStore,
  SESSION_TOKEN_KEY,
  isBareShell,
  paneMatchesBinding,
  type HerdrEnvelope,
  type HerdrSubscription,
  type HerdrTiming,
  type RequestOptions,
  type SessionBinding,
  type SubscribeOptions,
  type SubscriptionSpec,
} from "../src/index.js";
import { FakeHerdr, type FakeHerdrOptions } from "./fake-herdr.js";
import { Collector, FAST_TIMING, cleanupAll, setup, spec, until } from "./helpers.js";

/** The real client on the fake's socket, with hooks to fail or alter single calls. */
class TamperClient extends HerdrSocketClient {
  beforeRequest: ((method: string) => void | Promise<void>) | null = null;
  mapResult: ((method: string, result: unknown) => unknown) | null = null;
  /** Called with the 1-based number of the subscribe call; may throw. */
  beforeSubscribe: ((n: number) => void) | null = null;
  readonly sinks: ((e: HerdrEnvelope) => void)[] = [];
  private subscribes = 0;

  override async request<T = unknown>(
    method: string,
    params: unknown = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    await this.beforeRequest?.(method);
    const result = await super.request<T>(method, params, opts);
    return (this.mapResult ? this.mapResult(method, result) : result) as T;
  }

  override async subscribe(
    specs: SubscriptionSpec[],
    onEvent: (e: HerdrEnvelope) => void,
    opts: SubscribeOptions = {},
  ): Promise<HerdrSubscription> {
    this.beforeSubscribe?.(++this.subscribes);
    this.sinks.push(onEvent);
    return super.subscribe(specs, onEvent, opts);
  }
}

class FlakyListStore extends MemoryBindingStore {
  failList = false;
  override list(): Promise<SessionBinding[]> {
    return this.failList ? Promise.reject(new Error("disk gone")) : super.list();
  }
}

interface Tampered {
  fake: FakeHerdr;
  client: TamperClient;
  adapter: HerdrAdapter;
  bindings: MemoryBindingStore;
}

const opened: { adapter: HerdrAdapter; fake: FakeHerdr }[] = [];

async function tampered(
  opts: FakeHerdrOptions = {},
  timing: Partial<HerdrTiming> = {},
  bindings: MemoryBindingStore = new MemoryBindingStore(),
): Promise<Tampered> {
  const fake = new FakeHerdr(opts);
  await fake.start();
  const client = new TamperClient(fake.socketPath, { requestTimeoutMs: 2_000 });
  const adapter = new HerdrAdapter({ client, bindings, timing: { ...FAST_TIMING, ...timing } });
  opened.push({ adapter, fake });
  return { fake, client, adapter, bindings };
}

/** A second adapter process on the same HerdR and binding store. */
function secondAdapter(fake: FakeHerdr, bindings: MemoryBindingStore): HerdrAdapter {
  const adapter = new HerdrAdapter({ socketPath: fake.socketPath, bindings, timing: FAST_TIMING });
  opened.push({ adapter, fake });
  return adapter;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const o of opened.splice(0)) {
    await o.adapter.dispose();
    await o.fake.stop();
  }
  await cleanupAll();
});

async function rejection(
  p: Promise<unknown>,
): Promise<Error & { code: string; details?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a rejection");
}

const NONCE = "0123456789abcdef";

/** A binding as an earlier adapter process would have persisted it. */
function bound(over: Partial<SessionBinding> & { paneId: string }): SessionBinding {
  const sessionId = over.sessionId ?? newId("ses");
  return {
    sessionId,
    idempotencyKey: `idem-${sessionId}`,
    workspaceId: over.paneId.split(":")[0]!,
    cwd: "/tmp",
    agentKind: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function seed(fake: FakeHerdr, paneId: string, terminalId = "term_now", cwd = "/tmp") {
  fake.seedPane({
    pane_id: paneId,
    workspace_id: paneId.split(":")[0]!,
    terminal_id: terminalId,
    cwd,
  });
  return fake.panes.get(paneId)!;
}

const stateOf = (e: RuntimeEvent, sessionId: string, state: string) =>
  e.kind === "session.state_changed" && e.sessionId === sessionId && e.state === state;

const hasStatusWatch = (fake: FakeHerdr, paneId: string) =>
  fake
    .subscriptionEntries()
    .flat()
    .some((e) => e.type === "pane.agent_status_changed" && e.pane_id === paneId);

describe("pure helpers", () => {
  it("isBareShell without a shell pid goes by the number of foreground processes", () => {
    expect(isBareShell({ pane_id: "p" })).toBe(true);
    expect(isBareShell({ pane_id: "p", foreground_processes: [{ pid: 1, name: "zsh" }] })).toBe(
      true,
    );
    expect(
      isBareShell({
        pane_id: "p",
        foreground_processes: [
          { pid: 1, name: "zsh" },
          { pid: 2, name: "sleep" },
        ],
      }),
    ).toBe(false);
    // shell pid known, no process list: only the group id can tell
    expect(isBareShell({ pane_id: "p", shell_pid: 7, foreground_process_group_id: 7 })).toBe(true);
    expect(isBareShell({ pane_id: "p", shell_pid: 7, foreground_process_group_id: 9 })).toBe(false);
  });

  it("paneMatchesBinding expands ~ in cwd and compares agent session ids when both are known", () => {
    const b = { sessionId: "ses_a", cwd: "~", launchTerminalId: "term_old", agentSessionId: "A" };
    const pane = { terminal_id: "term_new", cwd: os.homedir() };
    expect(paneMatchesBinding(b, pane)).toBe("unverified");
    expect(paneMatchesBinding({ ...b, cwd: "~/nope" }, pane)).toBe("mismatch");
    expect(paneMatchesBinding(b, { ...pane, agent_session: { value: "A" } })).toBe("unverified");
    expect(paneMatchesBinding(b, { ...pane, agent_session: { value: "B" } })).toBe("mismatch");
    expect(paneMatchesBinding(b, { ...pane, tokens: { [SESSION_TOKEN_KEY]: "ses_a" } })).toBe(
      "unverified",
    );
  });
});

describe("construction, capabilities, health", () => {
  it("useEnvironment resolves the socket from HERDR_SOCKET_PATH instead of the mimir session", () => {
    vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/from-env/herdr.sock");
    const adapter = new HerdrAdapter({ useEnvironment: true, bindings: new MemoryBindingStore() });
    expect(adapter.client.socketPath).toBe("/tmp/from-env/herdr.sock");
  });

  it("capabilities falls back to ping's version when the snapshot has none", async () => {
    const { adapter, client } = await tampered({ version: "0.9.4" });
    client.mapResult = (method, result) => {
      if (method !== "session.snapshot") return result;
      const r = result as { snapshot: Record<string, unknown> };
      return { ...r, snapshot: { ...r.snapshot, version: "" } };
    };
    expect((await adapter.capabilities()).version).toBe("0.9.4");
  });

  it("health reports a non-Error failure as its string", async () => {
    const { adapter, client } = await tampered();
    client.beforeRequest = () => {
      throw "socket layer exploded";
    };
    expect(await adapter.health()).toEqual({ ok: false, detail: "socket layer exploded" });
  });
});

describe("createSession edges", () => {
  it("agent kind: argv that does not start with the kind is passed whole as args", async () => {
    const { adapter, fake } = await setup();
    await adapter.createSession(spec({ agentKind: "claude", argv: ["-p", "hi"] }));
    expect(fake.requests.find((r) => r.method === "agent.start")!.params.args).toEqual([
      "-p",
      "hi",
    ]);
  });

  it("agent.wait timing out leaves the session starting instead of failing the launch", async () => {
    const { adapter, fake } = await setup({ agentBehavior: () => ({ kind: "interactive" }) });
    fake.failNext.set("agent.wait", { code: "timeout", message: "still launching", count: 1 });
    const session = await adapter.createSession(spec({ agentKind: "claude", argv: ["claude"] }));
    expect(session.state).toBe("starting");
    expect(fake.panes.has("w1:p1")).toBe(true);
  });

  it("any other agent.wait error fails the launch and closes the pane", async () => {
    const { adapter, fake } = await setup({ agentBehavior: () => ({ kind: "interactive" }) });
    fake.failNext.set("agent.wait", { code: "server_unavailable", message: "down", count: 1 });
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    const err = await rejection(adapter.createSession(s));
    expect(err.code).toBe("runtime_unavailable");
    expect(fake.panes.has("w1:p1")).toBe(false);
    expect((await adapter.getSession(s.sessionId))?.state).toBe("failed");
  });

  it("a pane that never reaches a bare shell is a retryable conflict naming the foreground process", async () => {
    const { adapter } = await setup({ shellStartupMs: 60_000 }, { shellReadyAttempts: 3 });
    const err = await rejection(adapter.createSession(spec()));
    expect(err.code).toBe("conflict");
    expect(err.details).toMatchObject({
      retryable: true,
      paneId: "w1:p1",
      lastForeground: ["zsh-startup"],
    });
  });

  it("reports no foreground names when HerdR sent none or was never asked", async () => {
    const never = await setup({}, { shellReadyAttempts: 0 });
    const a = await rejection(never.adapter.createSession(spec()));
    expect(a.details).toMatchObject({ lastForeground: [] });

    const { adapter, client } = await tampered({}, { shellReadyAttempts: 2 });
    client.mapResult = (method, result) =>
      method === "pane.process_info"
        ? { process_info: { pane_id: "w1:p1", shell_pid: 1, foreground_process_group_id: 2 } }
        : result;
    const b = await rejection(adapter.createSession(spec()));
    expect(b.code).toBe("conflict");
    expect(b.details).toMatchObject({ lastForeground: [] });
  });

  it("a key whose binding was lost returns that session as unknown and creates nothing new", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    await fake.recreate();
    expect((await adapter.reconcile()).lost).toEqual([s.sessionId]);
    const again = await adapter.createSession(s);
    expect(again).toMatchObject({ sessionId: s.sessionId, state: "unknown" });
    expect(fake.requests.filter((r) => r.method === "workspace.create")).toHaveLength(1);
  });

  it("refuses to create after dispose", async () => {
    const { adapter } = await setup();
    await adapter.dispose();
    expect((await rejection(adapter.createSession(spec()))).code).toBe("runtime_unavailable");
  });
});

describe("sendInput edges", () => {
  it("keys for an agent that released its pane fall back to pane.send_keys", async () => {
    const { adapter, fake } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude", "-p", "hi"] });
    await adapter.createSession(s);
    await c.waitFor((e) => stateOf(e, s.sessionId, "completed"));
    await adapter.sendInput(s.sessionId, { keys: ["enter"] });
    expect(fake.requests.at(-2)).toMatchObject({ method: "agent.send_keys" });
    expect(fake.requests.at(-1)).toMatchObject({
      method: "pane.send_keys",
      params: { pane_id: "w1:p1", keys: ["enter"] },
    });
  });

  it("another agent.send_keys error is mapped, not retried on the pane", async () => {
    const { adapter, fake } = await setup({ agentBehavior: () => ({ kind: "interactive" }) });
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    fake.failNext.set("agent.send_keys", { code: "server_unavailable", message: "x", count: 1 });
    const err = await rejection(adapter.sendInput(s.sessionId, { keys: ["enter"] }));
    expect(err.code).toBe("runtime_unavailable");
    expect(fake.requests.some((r) => r.method === "pane.send_keys")).toBe(false);
  });

  it("an empty input sends nothing", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    const before = fake.requests.filter((r) => r.method.endsWith(".send_keys")).length;
    await adapter.sendInput(s.sessionId, { keys: [] });
    expect(fake.requests.filter((r) => r.method.endsWith(".send_keys"))).toHaveLength(before);
    expect(fake.requests.filter((r) => r.method === "pane.send_text")).toHaveLength(1);
  });
});

describe("requestStop edges", () => {
  it("force twice: the second call finds no pane and still resolves as stopped", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    await adapter.requestStop(s.sessionId, "force");
    await adapter.requestStop(s.sessionId, "force");
    expect(fake.requests.filter((r) => r.method === "pane.close")).toHaveLength(2);
    expect((await adapter.getSession(s.sessionId))?.state).toBe("stopped");
  });

  it("force: a pane.close failure without an active monitor is just reported", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    fake.failNext.set("pane.close", { code: "server_unavailable", message: "x", count: 1 });
    expect((await rejection(adapter.requestStop(s.sessionId, "force"))).code).toBe(
      "runtime_unavailable",
    );
    expect(fake.subscriptionCount).toBe(0);
    expect((await adapter.getSession(s.sessionId))?.state).not.toBe("stopped");
  });

  it("soft on a finished session sends no Ctrl-C, also from an adapter that only has the binding", async () => {
    const { adapter, fake, bindings } = await setup();
    const s = spec({ argv: ["true"] });
    await adapter.createSession(s);
    await until(async () => (await adapter.getSession(s.sessionId))?.state === "completed");
    await adapter.requestStop(s.sessionId, "soft");
    await secondAdapter(fake, bindings).requestStop(s.sessionId, "soft");
    expect(
      fake.requests.filter(
        (r) => r.method === "pane.send_keys" && (r.params.keys as string[])[0] === "ctrl+c",
      ),
    ).toHaveLength(0);
  });

  it("soft from an adapter with no observation of its own stops the bound process", async () => {
    const { adapter, fake, bindings } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    await adapter.dispose();
    const other = secondAdapter(fake, bindings);
    expect((await other.listSessions()).map((x) => x.state)).toEqual(["unknown"]);
    const c = new Collector();
    await other.subscribe(c.handler);
    await other.requestStop(s.sessionId, "soft");
    expect(c.states(s.sessionId).slice(-2)).toEqual(["stopping", "stopped"]);
  });

  it("soft: the pane disappearing while waiting counts as stopped", async () => {
    const { adapter, fake } = await setup(
      { agentBehavior: () => ({ kind: "interactive", ctrlCToExit: 99 }) },
      { stopPollIntervalMs: 60 },
    );
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    const stop = adapter.requestStop(s.sessionId, "soft");
    await until(() => fake.requests.some((r) => r.method === "pane.send_keys"));
    await fake.client().request("pane.close", { pane_id: "w1:p1" });
    await stop;
    expect((await adapter.getSession(s.sessionId))?.state).toBe("stopped");
  });

  it("soft: an unconfirmed stop does not overwrite a terminal state reached meanwhile", async () => {
    const { adapter, fake } = await setup({
      agentBehavior: () => ({ kind: "interactive", ctrlCToExit: 99 }),
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    const stop = rejection(adapter.requestStop(s.sessionId, "soft"));
    await c.waitFor((e) => stateOf(e, s.sessionId, "stopping"));
    fake.exitShell("w1:p1");
    expect((await stop).details).toMatchObject({ reason: "stop_unconfirmed" });
    expect(c.states(s.sessionId).at(-1)).toBe("failed");
    expect(c.events.filter((e) => e.kind === "session.exited")).toHaveLength(1);
  });

  it("soft: a failed attempt does not overwrite a terminal state reached meanwhile", async () => {
    const { adapter, fake } = await setup(
      { agentBehavior: () => ({ kind: "interactive", ctrlCToExit: 99 }) },
      { stopPollIntervalMs: 200 },
    );
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    fake.failNext.set("pane.process_info", { code: "server_unavailable", message: "x", count: 1 });
    const stop = rejection(adapter.requestStop(s.sessionId, "soft"));
    await c.waitFor((e) => stateOf(e, s.sessionId, "stopping"));
    fake.exitShell("w1:p1");
    await c.waitFor((e) => stateOf(e, s.sessionId, "failed"));
    expect((await stop).code).toBe("runtime_unavailable");
    expect(c.states(s.sessionId).at(-1)).toBe("failed");
  });
});

describe("reconcile of bindings persisted by an earlier adapter", () => {
  it("fails on a HerdR error other than pane_not_found instead of guessing", async () => {
    const { adapter, fake } = await setup({ agentBehavior: () => ({ kind: "interactive" }) });
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    fake.failNext.set("pane.process_info", { code: "server_unavailable", message: "x", count: 1 });
    expect((await rejection(adapter.reconcile())).code).toBe("runtime_unavailable");
    expect((await adapter.reconcile()).lost).toEqual([]);
  });

  it("a pane that answers process_info but is missing from the snapshot is kept as unknown", async () => {
    const { adapter, client } = await tampered({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    client.mapResult = (method, result) =>
      method === "session.snapshot"
        ? { snapshot: { ...(result as { snapshot: object }).snapshot, panes: [] } }
        : result;
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([]);
    expect(r.sessions).toMatchObject([{ sessionId: s.sessionId, state: "unknown" }]);
  });

  it("shell: a sentinel in restored scrollback after a HerdR restart completes the session", async () => {
    const { adapter, fake, bindings } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const b = bound({
      paneId: "w7:p1",
      agentKind: "shell",
      launchTerminalId: "term_old",
      sentinelNonce: NONCE,
    });
    await bindings.put(b);
    seed(fake, "w7:p1").screen.push(`MIMIR_DONE:${b.sessionId}:${NONCE}:3`);
    const r = await adapter.reconcile();
    expect(r.sessions).toMatchObject([{ sessionId: b.sessionId, state: "failed" }]);
    expect(await bindings.getBySessionId(b.sessionId)).toMatchObject({
      finalState: "failed",
      exitCode: 3,
      launchTerminalId: "term_now",
    });
    expect(c.events).toContainEqual(
      expect.objectContaining({ kind: "session.exited", sessionId: b.sessionId, exitCode: 3 }),
    );
  });

  it("shell: sealed, same terminal, no sentinel yet → the watcher picks the line up when it appears", async () => {
    const { adapter, fake, bindings } = await setup();
    const b = bound({
      paneId: "w7:p1",
      agentKind: "shell",
      launchTerminalId: "term_now",
      sentinelNonce: NONCE,
    });
    await bindings.put(b);
    const pane = seed(fake, "w7:p1");
    expect((await adapter.reconcile()).lost).toEqual([]);
    expect(fake.requests.some((r) => r.method === "pane.send_text")).toBe(false);
    pane.screen.push(`MIMIR_DONE:${b.sessionId}:${NONCE}:0`);
    await until(async () => (await adapter.getSession(b.sessionId))?.state === "completed");
    expect((await bindings.getBySessionId(b.sessionId))?.exitCode).toBe(0);
  });

  it("shell: a sentinel line that never appears ends as unknown(no_sentinel) after the bounded reads", async () => {
    const { adapter, fake, bindings } = await setup({}, { sentinelReadAttempts: 2 });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const b = bound({ paneId: "w7:p1", agentKind: "shell", launchTerminalId: "term_now" });
    await bindings.put(b);
    seed(fake, "w7:p1");
    await adapter.reconcile();
    const e = await c.waitFor(
      (x) => stateOf(x, b.sessionId, "unknown") && "runtimeStatus" in x && x.runtimeStatus !== "",
    );
    expect(e).toMatchObject({ runtimeStatus: "no_sentinel" });
    // the watcher typed the line once, with a nonce it persisted first
    const nonce = (await bindings.getBySessionId(b.sessionId))?.sentinelNonce;
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
    expect(
      fake.requests.filter((r) => r.method === "pane.send_text").map((r) => r.params.text),
    ).toEqual([` echo MIMIR_DONE:${b.sessionId}:${nonce}:$__mimir_rc`]);
  });

  it("agent kinds: restored agent is re-bound, vanished agent after a restart is lost, a foreground job is running", async () => {
    const { adapter, fake, bindings } = await setup();
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const restored = bound({ paneId: "w1:p1", launchTerminalId: "term_old" });
    const gone = bound({ paneId: "w2:p1", launchTerminalId: "term_old" });
    const busy = bound({ paneId: "w3:p1", launchTerminalId: "term_now" });
    const quiet = bound({ paneId: "w4:p1", launchTerminalId: "term_now" });
    for (const b of [restored, gone, busy, quiet]) await bindings.put(b);
    Object.assign(seed(fake, "w1:p1"), {
      agent: "claude",
      agent_name: "a",
      agent_status: "working",
      fg: { name: "claude.exe", argv: ["claude"] },
    });
    seed(fake, "w2:p1");
    seed(fake, "w3:p1").fg = { name: "vim", argv: ["vim"] };
    seed(fake, "w4:p1");
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([gone.sessionId]);
    const state = (id: string) => r.sessions.find((x) => x.sessionId === id)?.state;
    expect(state(restored.sessionId)).toBe("running");
    expect(state(busy.sessionId)).toBe("running");
    expect(state(quiet.sessionId)).toBe("unknown");
    expect((await bindings.getBySessionId(restored.sessionId))?.launchTerminalId).toBe("term_now");
    expect(c.events).toContainEqual(
      expect.objectContaining({
        kind: "session.lost",
        sessionId: gone.sessionId,
        reason: "restart: agent not restored",
      }),
    );
    expect(c.events).toContainEqual(
      expect.objectContaining({ sessionId: busy.sessionId, runtimeStatus: "foreground_process" }),
    );
  });

  it("a finished binding follows its pane to a new terminal; lost bindings stay lost; no terminal id is invented", async () => {
    const { adapter, fake, bindings } = await setup();
    const done = bound({ paneId: "w1:p1", launchTerminalId: "term_old", finalState: "completed" });
    const lost = bound({ paneId: "w2:p1", lost: true });
    const noPane = bound({ paneId: "w3:p1", finalState: "stopped" });
    for (const b of [done, lost, noPane]) await bindings.put(b);
    seed(fake, "w1:p1");
    const r = await adapter.reconcile();
    expect(r.lost).toEqual([lost.sessionId]);
    expect(r.sessions.map((s) => [s.sessionId, s.state])).toEqual([
      [done.sessionId, "completed"],
      [noPane.sessionId, "stopped"],
    ]);
    expect((await bindings.getBySessionId(done.sessionId))?.launchTerminalId).toBe("term_now");
    expect(r.sessions[1]!.runtimeRef).toEqual({ paneId: "w3:p1", workspaceId: "w3" });
    expect(await adapter.getSession(lost.sessionId)).toBeNull();
  });

  it("several live bindings at one pane id: the newest keeps the pane and its watch, older mismatches are lost", async () => {
    const { adapter, fake, bindings } = await setup();
    const oldA = bound({ paneId: "w1:p1", cwd: "/usr", launchTerminalId: "term_a" });
    const oldB = bound({ paneId: "w1:p1", cwd: "/usr", launchTerminalId: "term_b" });
    const newest = bound({
      paneId: "w1:p1",
      launchTerminalId: "term_now",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    // stored newest-first so ordering comes from createdAt, not insertion
    for (const b of [newest, oldA, oldB]) await bindings.put(b);
    Object.assign(seed(fake, "w1:p1"), { agent: "claude", agent_name: "a", agent_status: "idle" });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    expect(c.events.filter((e) => e.kind === "session.lost").map((e) => e.sessionId)).toEqual([
      oldA.sessionId,
      oldB.sessionId,
    ]);
    await until(() => hasStatusWatch(fake, "w1:p1"));
    fake.setStatus("w1:p1", "working");
    await c.waitFor((e) => stateOf(e, newest.sessionId, "running"));
    expect((await adapter.reconcile()).lost.sort()).toEqual(
      [oldA.sessionId, oldB.sessionId].sort(),
    );
    expect(hasStatusWatch(fake, "w1:p1")).toBe(true);
  });
});

describe("subscribe / bootstrap edges", () => {
  it("bootstrap of persisted bindings: foreign marker → unknown(marker_conflict), missing pane → unknown(pane_missing), finished stays finished", async () => {
    const { adapter, fake, bindings } = await setup();
    const conflict = bound({ paneId: "w1:p1", launchTerminalId: "term_old" });
    const finishedConflict = bound({
      paneId: "w2:p1",
      launchTerminalId: "term_old",
      finalState: "completed",
    });
    const missing = bound({ paneId: "w3:p1" });
    for (const b of [conflict, finishedConflict, missing]) await bindings.put(b);
    seed(fake, "w1:p1").tokens[SESSION_TOKEN_KEY] = "ses_someone_else";
    seed(fake, "w2:p1").tokens[SESSION_TOKEN_KEY] = "ses_someone_else";
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const byId = (id: string) => c.events.find((e) => "sessionId" in e && e.sessionId === id);
    expect(byId(conflict.sessionId)).toMatchObject({
      state: "unknown",
      runtimeStatus: "marker_conflict",
    });
    expect(byId(finishedConflict.sessionId)).toMatchObject({ state: "completed" });
    expect(byId(missing.sessionId)).toMatchObject({
      state: "unknown",
      runtimeStatus: "pane_missing",
    });
    expect(fake.subscriptionCount).toBe(1); // lifecycle only: none of these panes is watched
  });

  it("a second subscriber is told the current states; closing one keeps the monitor for the other", async () => {
    const { adapter, fake } = await setup({ agentBehavior: () => ({ kind: "interactive" }) });
    const first = new Collector();
    const sub1 = await adapter.subscribe(first.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    const second = new Collector();
    await adapter.subscribe(second.handler);
    expect(second.states(s.sessionId)).toEqual(["idle"]);
    sub1.close();
    const seen = first.events.length;
    fake.setStatus("w1:p1", "working");
    await second.waitFor((e) => stateOf(e, s.sessionId, "running"));
    expect(first.events).toHaveLength(seen);
  });

  it("subscribe fails as runtime_unavailable while HerdR is down and works once it is back", async () => {
    const { adapter, fake } = await setup();
    await fake.stop();
    const c = new Collector();
    expect((await rejection(adapter.subscribe(c.handler))).code).toBe("runtime_unavailable");
    await fake.start();
    const sub = await adapter.subscribe(c.handler);
    expect(fake.subscriptionCount).toBe(1);
    sub.close();
    await until(() => fake.subscriptionCount === 0);
  });

  it("dispose while the lifecycle subscription is being set up leaves no subscription behind", async () => {
    const { adapter, fake } = await setup();
    const pending = adapter.subscribe(() => {});
    await adapter.dispose();
    await pending;
    await until(() => fake.subscriptionCount === 0);
    expect(fake.requests.some((r) => r.method === "session.snapshot")).toBe(false);
  });

  it("dispose during the bootstrap snapshot stops before any pane watch", async () => {
    const { adapter, fake, client, bindings } = await tampered();
    await bindings.put(bound({ paneId: "w1:p1", launchTerminalId: "term_now" }));
    seed(fake, "w1:p1");
    const c = new Collector();
    client.beforeRequest = async (method) => {
      if (method === "session.snapshot") await adapter.dispose();
    };
    await adapter.subscribe(c.handler);
    await until(() => fake.subscriptionCount === 0);
    expect(c.events).toEqual([]);
    expect(
      fake.requests.filter((r) => r.method === "events.subscribe"),
      "only the lifecycle subscription was opened",
    ).toHaveLength(1);
  });

  it("dispose while a pane watch is being opened closes that watch", async () => {
    const { adapter, fake, client, bindings } = await tampered();
    await bindings.put(bound({ paneId: "w1:p1", launchTerminalId: "term_now" }));
    seed(fake, "w1:p1");
    client.beforeSubscribe = (n) => {
      if (n === 2) void adapter.dispose();
    };
    await adapter.subscribe(() => {});
    expect(fake.requests.filter((r) => r.method === "events.subscribe")).toHaveLength(2);
    await until(() => fake.subscriptionCount === 0);
  });

  it("a pane that vanishes between snapshot and its watch is unknown(pane_missing), with no gap", async () => {
    const { adapter, fake, client, bindings } = await tampered();
    const b = bound({ paneId: "w1:p1", launchTerminalId: "term_now" });
    const finished = bound({ paneId: "w2:p1", launchTerminalId: "term_now" });
    await bindings.put(b);
    await bindings.put(finished);
    seed(fake, "w1:p1");
    seed(fake, "w2:p1");
    client.beforeSubscribe = (n) => {
      if (n === 2) throw new HerdrError("pane_not_found", "pane not found", "events.subscribe");
    };
    const c = new Collector();
    await adapter.subscribe(c.handler);
    expect(c.events.find((e) => "sessionId" in e && e.sessionId === b.sessionId)).toMatchObject({
      state: "unknown",
      runtimeStatus: "pane_missing",
    });
    expect(c.events.some((e) => e.kind === "runtime.gap")).toBe(false);
    expect(hasStatusWatch(fake, "w2:p1")).toBe(true);
  });

  it.each([
    ["a HerdR error", () => new HerdrError("connection_closed", "boom", "events.subscribe")],
    ["an unexpected error", () => new Error("boom")],
  ])(
    "a pane watch failing with %s is a gap, and after the rebootstrap every bound pane is watched",
    async (_name, make) => {
      const { adapter, fake, client } = await tampered({
        agentBehavior: () => ({ kind: "interactive" }),
      });
      const a = spec({ agentKind: "claude", argv: ["claude"] });
      const b = spec({ agentKind: "claude", argv: ["claude"] });
      await adapter.createSession(a);
      await adapter.createSession(b);
      client.beforeSubscribe = (n) => {
        if (n === 2) throw make();
      };
      const c = new Collector();
      await adapter.subscribe(c.handler);
      await c.waitFor((e) => e.kind === "runtime.gap" && e.reason === "reconnect");
      await until(() => hasStatusWatch(fake, "w1:p1") && hasStatusWatch(fake, "w2:p1"));
      fake.setStatus("w2:p1", "working");
      await c.waitFor((e) => stateOf(e, b.sessionId, "running"));
    },
  );
});

describe("envelopes at awkward moments", () => {
  async function agentSession() {
    const h = await tampered({ agentBehavior: () => ({ kind: "interactive" }) });
    const c = new Collector();
    const sub = await h.adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await h.adapter.createSession(s);
    await c.waitFor((e) => stateOf(e, s.sessionId, "idle"));
    // sinks[0] is the lifecycle subscription's handler
    const lifecycle = (e: HerdrEnvelope) => h.client.sinks[0]!(e);
    return { ...h, c, s, sub, lifecycle };
  }

  it("ignores event types it does not handle and envelopes without a pane id", async () => {
    const { c, s, lifecycle, fake } = await agentSession();
    const seen = c.events.length;
    lifecycle({ event: "pane_focused", data: { pane_id: "w1:p1" } });
    lifecycle({ event: "workspace_closed", data: { workspace_id: "w1" } });
    lifecycle({ event: "pane_closed", data: { pane_id: "w9:p9" } }); // not bound
    fake.setStatus("w1:p1", "working");
    await c.waitFor((e) => stateOf(e, s.sessionId, "running"));
    expect(c.events.slice(seen).map((e) => e.kind)).toEqual(["session.state_changed"]);
  });

  it("a release without final_status is failed(released:unknown); later envelopes do not move it", async () => {
    const { c, s, lifecycle, fake, adapter } = await agentSession();
    lifecycle({ event: "pane_agent_detected", data: { pane_id: "w1:p1", released: true } });
    const e = await c.waitFor((x) => stateOf(x, s.sessionId, "failed"));
    expect(e).toMatchObject({ runtimeStatus: "released:unknown" });
    const seen = c.events.length;
    lifecycle({ event: "pane_agent_detected", data: { pane_id: "w1:p1", released: true } });
    lifecycle({ event: "pane_exited", data: { pane_id: "w1:p1" } });
    lifecycle({ event: "pane_created", data: { pane: fake.paneInfo(fake.panes.get("w1:p1")!) } });
    fake.setStatus("w1:p1", "working");
    lifecycle({ event: "pane_closed", data: { pane_id: "w1:p1" } });
    await until(() => !hasStatusWatch(fake, "w1:p1"));
    expect(c.events).toHaveLength(seen);
    expect((await adapter.getSession(s.sessionId))?.state).toBe("failed");
  });

  it("envelopes that arrive after the subscription was closed are dropped", async () => {
    const { c, sub, lifecycle } = await agentSession();
    sub.close();
    const seen = c.events.length;
    lifecycle({ event: "pane_exited", data: { pane_id: "w1:p1" } });
    await new Promise((r) => setImmediate(r));
    expect(c.events).toHaveLength(seen);
  });

  it("a failing binding store drops that envelope only; the next one is handled", async () => {
    const store = new FlakyListStore();
    const { adapter, fake } = await tampered(
      { agentBehavior: () => ({ kind: "interactive" }) },
      {},
      store,
    );
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    await c.waitFor((e) => stateOf(e, s.sessionId, "idle"));
    const lists = vi.spyOn(store, "list");
    store.failList = true;
    fake.setStatus("w1:p1", "blocked");
    await until(() => lists.mock.calls.length > 0);
    store.failList = false;
    fake.setStatus("w1:p1", "working");
    await c.waitFor((e) => stateOf(e, s.sessionId, "running"));
    expect(c.states(s.sessionId)).not.toContain("blocked");
  });

  it("a throwing subscriber does not stop delivery to the others", async () => {
    const { adapter, fake } = await setup({ agentBehavior: () => ({ kind: "interactive" }) });
    await adapter.subscribe(() => {
      throw new Error("consumer bug");
    });
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ agentKind: "claude", argv: ["claude"] });
    await adapter.createSession(s);
    fake.setStatus("w1:p1", "working");
    await c.waitFor((e) => stateOf(e, s.sessionId, "running"));
  });

  it("shell: the sentinel observed while a soft stop is in progress ends the session as stopped with its exit code", async () => {
    const { adapter, client, bindings } = await tampered(
      { msPerShellSecond: 1000 },
      { stopPollIntervalMs: 150 },
    );
    const c = new Collector();
    await adapter.subscribe(c.handler);
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    const b = (await bindings.getBySessionId(s.sessionId))!;
    await bindings.put({ ...b, sentinelNonce: NONCE });
    const stop = adapter.requestStop(s.sessionId, "soft");
    await c.waitFor((e) => stateOf(e, s.sessionId, "stopping"));
    const pane = client.sinks.at(-1)!;
    pane({ event: "pane.output_matched", data: { pane_id: b.paneId } }); // no line: ignored
    pane({
      event: "pane.output_matched",
      data: { pane_id: b.paneId, matched_line: `MIMIR_DONE:${s.sessionId}:${NONCE}:130` },
    });
    const exited = await c.waitFor((e) => e.kind === "session.exited");
    expect(exited).toMatchObject({ sessionId: s.sessionId, exitCode: 130 });
    await stop;
    expect(c.states(s.sessionId).at(-1)).toBe("stopped");
    expect(await bindings.getBySessionId(s.sessionId)).toMatchObject({
      finalState: "stopped",
      exitCode: 130,
    });
  });

  it("shell: the watcher stops polling once the pane is gone", async () => {
    const { adapter, fake } = await setup({ msPerShellSecond: 1000 });
    const s = spec({ argv: ["sleep", "30"] });
    await adapter.createSession(s);
    await fake.client().request("pane.close", { pane_id: "w1:p1" });
    const polls = () => fake.requests.filter((r) => r.method === "pane.process_info").length;
    await until(async () => {
      const n = polls();
      await new Promise((r) => setTimeout(r, 100));
      return polls() === n;
    });
    expect((await adapter.reconcile()).lost).toEqual([s.sessionId]);
  });
});
