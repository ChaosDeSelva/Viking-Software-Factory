import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAdapter, RuntimeSession } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadModel } from "../readmodel.js";
import { ArtifactStore } from "./artifacts.js";
import type { WorktreePort } from "./git-port.js";
import { Orchestrator, type OrchestratorLogger, type OrchestratorOptions } from "./orchestrator.js";
import { LocalDeliveryRunner } from "./pr.js";
import { createTask, harness, setupMission, type Harness } from "./test-harness.js";
import type { Verifier } from "./verifier.js";

// One case boots the server to build a mission (real git); the rest drive an Orchestrator alone.
vi.setConfig({ testTimeout: 120_000 });

const dirs: string[] = [];
const harnesses: Harness[] = [];
const orchestrators: Orchestrator[] = [];
afterEach(async () => {
  for (const o of orchestrators.splice(0)) await o.stop(0);
  for (const h of harnesses.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Reconciled = { sessions: RuntimeSession[]; lost: string[] };

/** A runtime that cannot say what it is; its `reconcile` answers what the test sets. */
function runtime(reconcile: () => Promise<Reconciled>, extra: object = {}): RuntimeAdapter {
  const unused = () => Promise.reject(new Error("not used"));
  return {
    capabilities: () => Promise.reject(new Error("capabilities endpoint down")),
    health: () => Promise.resolve({ ok: true }),
    createSession: unused,
    listSessions: () => Promise.resolve([]),
    getSession: () => Promise.resolve(null),
    sendInput: unused,
    requestStop: unused,
    reconcile,
    dispose: () => Promise.resolve(),
    subscribe: () => Promise.resolve({ close: () => undefined }),
    ...extra,
  } as RuntimeAdapter;
}

function orchestrator(
  store: Harness["store"],
  options: Partial<OrchestratorOptions> & Pick<OrchestratorOptions, "runtime">,
): Orchestrator {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-loop-")));
  dirs.push(dir);
  const git = {
    restore: () => Promise.resolve({ restored: 0, rejected: [] }),
  } as unknown as WorktreePort;
  const o = new Orchestrator({
    store,
    readModel: ReadModel.load(store),
    git,
    verifier: {} as Verifier,
    artifacts: new ArtifactStore(join(dir, "artifacts")),
    policies: [],
    now: () => new Date(),
    pr: new LocalDeliveryRunner(),
    tickMs: 0,
    ...options,
  });
  orchestrators.push(o);
  return o;
}

function recordingLog(): OrchestratorLogger & { lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (_o: object, msg?: string) => void lines.push(`${level}:${msg}`);
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

async function emptyStore() {
  const h = await harness();
  harnesses.push(h);
  return h.store;
}

describe("the orchestrator's own loop", () => {
  it("boots when the runtime cannot describe itself or be reconciled, logging both", async () => {
    const log = recordingLog();
    const o = orchestrator(await emptyStore(), {
      runtime: runtime(() => Promise.reject(new Error("unreachable"))),
      log,
    });
    await o.start();
    expect(log.lines).toEqual([
      "warn:runtime capabilities unavailable",
      "error:runtime reconcile failed",
    ]);
  });

  it("runs without a logger", async () => {
    const o = orchestrator(await emptyStore(), {
      runtime: runtime(() => Promise.reject(new Error("unreachable"))),
    });
    await expect(o.start()).resolves.toBeUndefined();
    await expect(o.tick()).resolves.toBeUndefined();
  });

  it("ticks on its interval, skips a tick while one is running and logs a failed one", async () => {
    const { store } = await startedMission();
    // The event store refuses writes (e.g. a full disk): every tick that must append fails.
    const failing = new Proxy(store, {
      get(target, prop) {
        if (prop === "append")
          return () => {
            throw new Error("SQLITE_FULL: database or disk is full");
          };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const log = recordingLog();
    let reconciles = 0;
    let hang: (() => void) | null = null;
    const o = orchestrator(failing, {
      runtime: runtime(() => {
        reconciles += 1;
        // The first periodic reconcile (after the one at boot) hangs until released.
        if (reconciles === 2)
          return new Promise((r) => (hang = () => r({ sessions: [], lost: [] })));
        return Promise.resolve({ sessions: [], lost: [] });
      }),
      log,
      tickMs: 5,
      reconcileEveryTicks: 1,
    });
    await o.start();
    const until = (cond: () => boolean) =>
      vi.waitFor(() => expect(cond()).toBe(true), { timeout: 30_000, interval: 10 });
    await until(() => hang !== null);
    // While that tick hangs, the interval fires many times and starts no other tick.
    await new Promise((r) => setTimeout(r, 100));
    expect(reconciles).toBe(2);
    (hang as unknown as () => void)();
    await until(() => log.lines.includes("error:tick failed"));
    // The loop goes on after a failed tick.
    await until(() => reconciles >= 4);
    expect(o.capacityWaiting()).toEqual([]);
    expect(store.read({ limit: 100_000, types: ["task.ready"] }).events).toEqual([]);
  });

  it("logs a scheduling decision it could not apply and keeps the task ready", async () => {
    const { store, t } = await startedMission();
    let failing = false;
    const flaky = new Proxy(store, {
      get(target, prop) {
        if (prop === "append" && failing)
          return () => {
            throw new Error("SQLITE_FULL: database or disk is full");
          };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const log = recordingLog();
    let full = true;
    const o = orchestrator(flaky, {
      runtime: runtime(() => Promise.resolve({ sessions: [], lost: [] }), {
        atCapacity: () => full,
      }),
      log,
    });
    await o.start();
    await o.tick(); // promoted to ready; waits for a worker
    failing = true;
    full = false;
    await o.tick(); // dispatch: the lease cannot be recorded
    expect(log.lines).toContain("error:decision failed");
    expect(store.read({ limit: 100_000, types: ["task.leased"] }).events).toEqual([]);
    expect(
      store.read({ limit: 100_000, types: ["task.ready"] }).events.map((e) => e.taskId),
    ).toEqual([t]);
  });

  it("lets a task wait for a free worker without appending anything", async () => {
    const { store, t, before } = await startedMission();
    const o = orchestrator(store, {
      runtime: runtime(() => Promise.resolve({ sessions: [], lost: [] }), {
        atCapacity: () => true,
      }),
    });
    await o.start();
    await o.tick();
    await o.tick();
    expect(o.capacityWaiting()).toEqual([t]);
    const events = store.read({ limit: 100_000 }).events;
    expect(events.slice(before).map((e) => e.type)).toEqual(["task.ready"]);
  });
});

/**
 * A mission with one pending task, started while no server runs (another process appended
 * it), in a stopped harness's store.
 */
async function startedMission() {
  const h = await harness();
  harnesses.push(h);
  const { missionId } = await setupMission(h);
  const t = await createTask(h, missionId, "T", "echo t");
  await h.app.close();
  const at = new Date().toISOString();
  const mission = h.store.read({ limit: 100_000, types: ["mission.created"] }).events.at(-1)!;
  h.store.append({
    streamId: mission.streamId,
    type: "mission.started",
    source: "test",
    provenance: "derived",
    occurredAt: at,
    observedAt: at,
    missionId: missionId as never,
    payload: { from: "draft", to: "active" },
  });
  return { store: h.store, t, before: h.store.read({ limit: 100_000 }).events.length };
}
