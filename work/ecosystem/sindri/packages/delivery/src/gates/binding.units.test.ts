import type { MimirClientFacade } from "@sindri/mimir-client";
import { describe, expect, it } from "vitest";
import type { DeliveryLoop } from "../delivery-loop.js";
import { ensureDeliverySchema } from "../schema.js";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";
import { executionReaderFor, mimirActionsFor } from "./binding.js";

type Loop = Pick<DeliveryLoop, "get" | "tasks" | "events">;

/** A database with DeliveryLoop's tables and no rows. */
function deliveryDb() {
  const db = openDeliveryTestDb();
  ensureDeliverySchema(db);
  return db;
}

/** A DeliveryLoop that knows execution `exe_1` (mission `mis_1`) but has no stored plan row. */
const loop = (events: ReturnType<DeliveryLoop["events"]> = []): Loop =>
  ({
    get: (id: string) =>
      id === "exe_1"
        ? { id, planId: "pln_1", planVersion: 1, mimirMissionId: "mis_1", status: "running" }
        : undefined,
    tasks: () => [],
    events: () => events,
  }) as unknown as Loop;

describe("executionReaderFor: records that are missing", () => {
  it("has no execution without the loop's record or the stored plan", async () => {
    const reader = executionReaderFor({
      db: deliveryDb(),
      loop: loop(),
      mimir: { replayEnvelopes: () => Promise.reject(new Error("not asked")) },
    });
    expect(await reader.execution("exe_1")).toBeUndefined();
    expect(await reader.execution("exe_nope")).toBeUndefined();
    expect(await reader.events("exe_nope")).toEqual([]);
  });

  it("leaves out Sindri's own rows and keeps rows Mimir's log no longer has, without refs", async () => {
    const rows = [
      { mimirEventId: null, type: "sindri.note", payload: {}, occurredAt: "t0" },
      { mimirEventId: "evt_1", type: "task.started", payload: { a: 1 }, occurredAt: "t1" },
    ] as unknown as ReturnType<DeliveryLoop["events"]>;
    const reader = executionReaderFor({
      db: deliveryDb(),
      loop: loop(rows),
      mimir: { replayEnvelopes: () => Promise.resolve([]) },
    });
    expect(await reader.events("exe_1")).toEqual([
      {
        mimirEventId: "evt_1",
        type: "task.started",
        payload: { a: 1 },
        occurredAt: "t1",
        mimirTaskId: null,
        sessionId: null,
        source: null,
        provenance: null,
      },
    ]);
  });

  it("refuses to claim an attempt for a task it has no record of", async () => {
    const reader = executionReaderFor({
      db: deliveryDb(),
      loop: loop(),
      mimir: { replayEnvelopes: () => Promise.resolve([]) },
    });
    await expect(reader.claimAttempt("exe_1", "ghost")).rejects.toThrow(
      "unknown plan task ghost in exe_1",
    );
  });
});

describe("mimirActionsFor: crews and tasks", () => {
  function facade() {
    const calls: { method: string; args: unknown[] }[] = [];
    const f = {
      createCrew: (...args: unknown[]) => {
        calls.push({ method: "createCrew", args });
        return Promise.resolve({ crewId: "crw_1" });
      },
      createTask: (...args: unknown[]) => {
        calls.push({ method: "createTask", args });
        return Promise.resolve({ id: "tsk_1" });
      },
    } as unknown as MimirClientFacade;
    return { f, calls };
  }

  it("creates a crew under the caller's key", async () => {
    const { f, calls } = facade();
    const input = { missionId: "mis_1", role: "reviewer" as const, agentKind: "claude" };
    expect(await mimirActionsFor(f).createCrew(input, "k1")).toEqual({ crewId: "crw_1" });
    expect(calls).toEqual([{ method: "createCrew", args: [input, "k1"] }]);
  });

  it("sends no acceptance criteria for an empty acceptance text and no dependencies when none", async () => {
    const { f, calls } = facade();
    const actions = mimirActionsFor(f);
    const base = { missionId: "mis_1", crewId: "crw_1", title: "t", instruction: "do it" };
    expect(await actions.createTask({ ...base, acceptance: "" }, "k1")).toEqual({
      taskId: "tsk_1",
    });
    await actions.createTask(base, "k2");
    await actions.createTask({ ...base, acceptance: "AC-1", dependsOn: ["tsk_0"] }, "k3");
    const brief = { missionId: "mis_1", crewId: "crw_1", title: "t", brief: "do it" };
    expect(calls.map((c) => c.args)).toEqual([
      [brief, "k1"],
      [brief, "k2"],
      [{ ...brief, acceptanceCriteria: ["AC-1"], dependsOn: ["tsk_0"] }, "k3"],
    ]);
  });
});
