import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionSpec,
} from "@mimir/protocol";
import { FleetRuntime, isCapacityAware, type FleetNode } from "./adapter.js";

const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
type Emit = (event: RuntimeEvent) => void;
function worker(id: string, opts: { kinds?: string[]; sendInput?: boolean } = {}) {
  const sessions = new Map<string, RuntimeSession>();
  const emitters: Emit[] = [];
  const closed = vi.fn();
  const runtime: RuntimeAdapter & { readTerminal?: (id: string, n: number) => Promise<string> } = {
    capabilities: vi.fn(async () => ({
      runtime: "fixture",
      version: "1",
      agentKinds: opts.kinds ?? ["codex"],
      features: {
        createSession: true,
        sendInput: opts.sendInput ?? false,
        sendKeys: false,
        softStop: true,
        forceStop: true,
        pause: false,
        subscribe: true,
        terminalRead: false,
        processInfo: false,
        multiHost: false,
        notify: false,
      },
    })),
    health: vi.fn(async () => ({ ok: true })),
    createSession: vi.fn(async (s: RuntimeSessionSpec) => {
      const session: RuntimeSession = {
        sessionId: s.sessionId,
        state: "running",
        runtimeRef: { workspaceId: id },
        lastObservedAt: new Date().toISOString(),
      };
      sessions.set(s.sessionId, session);
      return session;
    }),
    listSessions: async () => [...sessions.values()],
    getSession: async (sid) => sessions.get(sid) ?? null,
    sendInput: vi.fn(async () => {}),
    requestStop: vi.fn(async () => {}),
    subscribe: vi.fn(async (handler: Emit) => {
      emitters.push(handler);
      return { close: closed };
    }),
    reconcile: vi.fn(async () => ({ sessions: [...sessions.values()], lost: [] })),
    dispose: vi.fn(async () => {}),
  };
  const node: FleetNode = { id, identity: id, runtime, capacity: 1 };
  return {
    node,
    runtime,
    sessions,
    closed,
    emit: (e: RuntimeEvent) => emitters.forEach((h) => h(e)),
  };
}
const spec = (id: string, extra: Partial<RuntimeSessionSpec> = {}): RuntimeSessionSpec => ({
  sessionId: id,
  idempotencyKey: id,
  taskId: id,
  crewId: "crew",
  agentKind: "codex",
  argv: ["codex", "exec", "test"],
  env: {},
  cwd: "/tmp",
  workspaceLabel: "test",
  ...extra,
});
function stateFile() {
  const root = mkdtempSync(join(tmpdir(), "mimir-fleet-paths-"));
  roots.push(root);
  return join(root, "nested", "fleet.json");
}

it("refuses an empty, duplicated or unsafe node list and an unknown state version", () => {
  const a = worker("a").node;
  expect(() => new FleetRuntime([], stateFile())).toThrow("unique safe node IDs");
  expect(() => new FleetRuntime([a, a], stateFile())).toThrow("unique safe node IDs");
  expect(() => new FleetRuntime([{ ...a, id: "../x" }], stateFile())).toThrow("unique");
  expect(() => new FleetRuntime([{ ...a, capacity: 1.5 }], stateFile())).toThrow("unique");
  const file = stateFile();
  new FleetRuntime([a], file);
  writeFileSync(file, JSON.stringify({ version: 2, nodes: [], placements: [] }));
  expect(() => new FleetRuntime([a], file)).toThrow("Unsupported fleet state");
});

it("forwards worker events, records state changes of its own placements only", async () => {
  const a = worker("a");
  const b = worker("b");
  const file = stateFile();
  const fleet = new FleetRuntime([a.node, b.node], file);
  const seen: RuntimeEvent[] = [];
  const sub = await fleet.subscribe((e) => seen.push(e));
  await fleet.createSession(spec("one"));
  const at = "2026-01-01T00:00:00.000Z";
  a.emit({ kind: "session.state_changed", sessionId: "one", state: "completed", observedAt: at });
  // A worker cannot change a placement it does not own, nor one that is unknown to the fleet.
  b.emit({ kind: "session.state_changed", sessionId: "one", state: "failed", observedAt: at });
  b.emit({ kind: "session.output", sessionId: "ghost", text: "x", observedAt: at });
  a.emit({ kind: "session.output", sessionId: "one", text: "out", observedAt: at });
  a.emit({ kind: "runtime.gap", reason: "reconnect", observedAt: at });
  expect(seen.map((e) => e.kind)).toEqual([
    "session.state_changed",
    "session.output",
    "runtime.gap",
  ]);
  expect(await fleet.getSession("one")).toMatchObject({ state: "completed", lastObservedAt: at });
  // The recorded state survives a restart.
  expect((await new FleetRuntime([a.node, b.node], file).getSession("one"))?.state).toBe(
    "completed",
  );
  sub.close();
  a.emit({ kind: "runtime.gap", reason: "restart", observedAt: at });
  expect(seen).toHaveLength(3);
  expect(await fleet.getSession("missing")).toBeNull();
  await fleet.dispose();
  expect(a.closed).toHaveBeenCalled();
  expect(b.runtime.dispose).toHaveBeenCalled();
});

it("retries connecting to workers after a subscription failure instead of failing forever", async () => {
  const a = worker("a");
  const b = worker("b");
  vi.mocked(b.runtime.subscribe).mockRejectedValueOnce(new Error("worker briefly unavailable"));
  const fleet = new FleetRuntime([a.node, b.node], stateFile());
  await expect(fleet.createSession(spec("one"))).rejects.toThrow("briefly unavailable");
  // The partial subscription to the healthy worker is closed rather than duplicated.
  expect(a.closed).toHaveBeenCalledTimes(1);
  expect((await fleet.createSession(spec("one"))).state).toBe("running");
  const seen: RuntimeEvent[] = [];
  await fleet.subscribe((e) => seen.push(e));
  expect(a.runtime.subscribe).toHaveBeenCalledTimes(2);
  expect(b.runtime.subscribe).toHaveBeenCalledTimes(2);
});

it("routes input, stop and terminal reads to the owning worker only", async () => {
  const a = worker("a", { sendInput: true });
  const b = worker("b");
  a.runtime.readTerminal = vi.fn(async () => "screen");
  const fleet = new FleetRuntime([a.node, b.node], stateFile());
  await fleet.createSession(spec("one"));
  await fleet.createSession(spec("two"));
  await fleet.sendInput("one", { text: "hi" });
  expect(a.runtime.sendInput).toHaveBeenCalledWith("one", { text: "hi" });
  expect(await fleet.readTerminal("one")).toBe("screen");
  expect(a.runtime.readTerminal).toHaveBeenCalledWith("one", 200);
  await expect(fleet.readTerminal("two", 5)).rejects.toMatchObject({
    code: "capability_unavailable",
  });
  await expect(fleet.sendInput("missing", {})).rejects.toMatchObject({ code: "not_found" });
  expect(b.runtime.sendInput).not.toHaveBeenCalled();
  expect((await fleet.capabilities()).features).toMatchObject({ sendInput: true, sendKeys: false });
});

it("reports health and inventory per worker without failing on an unreachable one", async () => {
  const a = worker("a");
  const b = worker("b");
  vi.mocked(b.runtime.health).mockRejectedValue(new Error("offline"));
  vi.mocked(b.runtime.capabilities).mockRejectedValue(new Error("offline"));
  const fleet = new FleetRuntime([a.node, b.node], stateFile());
  expect(await fleet.health()).toEqual({ ok: true, detail: "1/2 workers reachable" });
  await fleet.createSession(spec("one"));
  const [ia, ib] = await fleet.inventory();
  expect(ia).toMatchObject({
    id: "a",
    active: 1,
    health: { ok: true },
    sessions: [{ sessionId: "one" }],
  });
  expect(ib).toMatchObject({
    id: "b",
    active: 0,
    health: { ok: false, detail: "Worker observation unavailable" },
    capabilities: null,
    sessions: [],
  });
  vi.mocked(a.runtime.health).mockResolvedValue({ ok: false });
  expect((await fleet.health()).ok).toBe(false);
  await expect(fleet.setDraining("nope", true)).rejects.toMatchObject({ code: "not_found" });
});

it("restricts a worker to its configured agent kinds", async () => {
  const a = worker("a", { kinds: ["codex", "claude"] });
  const node = { ...a.node, agentKinds: ["claude"] };
  const fleet = new FleetRuntime([node], stateFile());
  expect((await fleet.capabilities()).agentKinds).toEqual(["claude"]);
  await expect(fleet.createSession(spec("one"))).rejects.toMatchObject({
    code: "runtime_unavailable",
  });
  expect(fleet.atCapacity("codex")).toBe(false);
  expect((await fleet.createSession(spec("two", { agentKind: "claude" }))).state).toBe("running");
  expect(isCapacityAware(fleet)).toBe(true);
  expect(isCapacityAware(a.runtime)).toBe(false);
});

it("treats env order as the same request and refuses a session ID used by another key", async () => {
  const fleet = new FleetRuntime([worker("a").node, worker("b").node], stateFile());
  await fleet.createSession(spec("one", { env: { B: "2", A: "1" } }));
  expect((await fleet.createSession(spec("one", { env: { A: "1", B: "2" } }))).state).toBe(
    "running",
  );
  await expect(fleet.createSession(spec("one", { idempotencyKey: "other" }))).rejects.toMatchObject(
    { code: "conflict" },
  );
});

it("does not count a full worker whose capabilities cannot be read as merely busy", async () => {
  const a = worker("a");
  const fleet = new FleetRuntime([a.node], stateFile());
  await fleet.createSession(spec("one"));
  vi.mocked(a.runtime.capabilities).mockRejectedValue(new Error("offline"));
  await expect(fleet.createSession(spec("two"))).rejects.toSatisfy(
    (err: unknown) => (err as { details?: unknown }).details === undefined,
  );
});

it("keeps a placement unknown when its worker cannot report its runtime kind", async () => {
  const a = worker("a");
  const fleet = new FleetRuntime([a.node], stateFile());
  await fleet.createSession(spec("one"));
  a.sessions.clear();
  vi.mocked(a.runtime.capabilities).mockRejectedValue(new Error("offline"));
  const { sessions } = await fleet.reconcile();
  expect(sessions.map((s) => s.state)).toEqual(["unknown"]);
  // A worker reporting the session again re-binds it.
  vi.mocked(a.runtime.reconcile).mockResolvedValueOnce({
    sessions: [{ sessionId: "one", state: "running", runtimeRef: {}, lastObservedAt: "x" }],
    lost: [],
  });
  expect((await fleet.reconcile()).sessions[0]).toMatchObject({ state: "running" });
});

it("does not wait on a full worker that does not run the requested kind", async () => {
  const fleet = new FleetRuntime([worker("a", { kinds: ["codex", "claude"] }).node], stateFile());
  await fleet.capabilities();
  // A free slot on a worker known not to run the kind is not a free slot for it.
  expect(fleet.atCapacity("gemini")).toBe(false);
  await fleet.createSession(spec("one"));
  expect(fleet.atCapacity("claude")).toBe(true);
  expect(fleet.atCapacity("gemini")).toBe(false);
});
