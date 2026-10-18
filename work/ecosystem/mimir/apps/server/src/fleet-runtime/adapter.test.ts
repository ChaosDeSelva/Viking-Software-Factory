import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeAdapter, RuntimeSession, RuntimeSessionSpec } from "@mimir/protocol";
import { FleetRuntime, type FleetNode } from "./adapter.js";
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function worker(id: string): FleetNode {
  const sessions = new Map<string, RuntimeSession>();
  const runtime: RuntimeAdapter = {
    capabilities: async () => ({
      runtime: "fixture",
      version: "1",
      agentKinds: ["codex"],
      features: {
        createSession: true,
        sendInput: false,
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
    }),
    health: vi.fn(async () => ({ ok: true })),
    createSession: vi.fn(async (s) => {
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
    getSession: async (id) => sessions.get(id) ?? null,
    sendInput: vi.fn(async () => {}),
    requestStop: vi.fn(async () => {}),
    subscribe: async () => ({ close() {} }),
    reconcile: vi.fn(async () => ({ sessions: [...sessions.values()], lost: [] })),
    dispose: async () => {},
  };
  return { id, identity: id, runtime, capacity: 1 };
}
const spec = (id: string): RuntimeSessionSpec => ({
  sessionId: id,
  idempotencyKey: id,
  taskId: id,
  crewId: "crew",
  agentKind: "codex",
  argv: ["codex", "exec", "test"],
  env: {},
  cwd: "/tmp",
  workspaceLabel: "test",
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mimir-fleet-"));
  roots.push(root);
  const file = join(root, "fleet.json");
  const nodes = [worker("a"), worker("b")];
  return { file, nodes, fleet: new FleetRuntime(nodes, file) };
}
it("serializes concurrent placement and respects capacity", async () => {
  const { fleet, nodes } = fixture();
  await Promise.all([fleet.createSession(spec("one")), fleet.createSession(spec("two"))]);
  expect(nodes.map((n) => vi.mocked(n.runtime.createSession).mock.calls.length)).toEqual([1, 1]);
  await expect(fleet.createSession(spec("three"))).rejects.toThrow("capacity");
});
it("deduplicates concurrent requests and rejects changed replays", async () => {
  const { fleet, nodes } = fixture();
  await Promise.all([fleet.createSession(spec("one")), fleet.createSession(spec("one"))]);
  expect(nodes[0]!.runtime.createSession).toHaveBeenCalledTimes(1);
  await expect(fleet.createSession({ ...spec("one"), argv: ["changed"] })).rejects.toThrow(
    "changed",
  );
});
it("persists ownership before an ambiguous dispatch and never spills it", async () => {
  const { fleet, nodes, file } = fixture();
  vi.mocked(nodes[0]!.runtime.createSession).mockRejectedValue(
    new Error("disconnect after launch"),
  );
  expect((await fleet.createSession(spec("one"))).state).toBe("unknown");
  const resumed = new FleetRuntime(nodes, file);
  expect((await resumed.createSession(spec("one"))).state).toBe("unknown");
  expect(nodes[0]!.runtime.createSession).toHaveBeenCalledTimes(1);
  expect(nodes[1]!.runtime.createSession).not.toHaveBeenCalled();
});
it("retains reservation when reconciliation is unavailable or missing", async () => {
  const { fleet, nodes } = fixture();
  await fleet.createSession(spec("one"));
  vi.mocked(nodes[0]!.runtime.reconcile).mockResolvedValue({ sessions: [], lost: [] });
  await fleet.reconcile();
  expect((await fleet.getSession("one"))!.state).toBe("unknown");
  expect((await fleet.inventory())[0]!.active).toBe(1);
});
it("drain survives restart and leaves existing sessions on their owner", async () => {
  const { fleet, nodes, file } = fixture();
  await fleet.createSession(spec("one"));
  await fleet.setDraining("a", true);
  const resumed = new FleetRuntime(nodes, file);
  await resumed.createSession(spec("two"));
  await resumed.requestStop("one", "soft");
  expect(nodes[0]!.runtime.requestStop).toHaveBeenCalledWith("one", "soft");
  expect((await resumed.inventory())[0]!.draining).toBe(true);
});
it("rejects rerouting or removing a worker with unresolved work", async () => {
  const { fleet, nodes, file } = fixture();
  await fleet.createSession(spec("one"));
  expect(() => new FleetRuntime([{ ...nodes[0]!, identity: "other" }, nodes[1]!], file)).toThrow(
    "changed identity",
  );
  expect(() => new FleetRuntime([nodes[1]!], file)).toThrow("unresolved");
});
it("skips unhealthy nodes and incompatible harnesses", async () => {
  const { fleet, nodes } = fixture();
  vi.mocked(nodes[0]!.runtime.health).mockRejectedValue(new Error("offline"));
  expect((await fleet.createSession(spec("one"))).runtimeRef.workspaceId).toBe("b");
  await expect(fleet.createSession({ ...spec("two"), agentKind: "missing" })).rejects.toThrow(
    "compatible",
  );
});
