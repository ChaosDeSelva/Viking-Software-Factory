import { newId } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../store/reducer.js";
import { agent, approval, dependency, event, mission, snapshot, task } from "../test/fixtures.js";
import {
  deriveAttention,
  filterEvents,
  layerTasks,
  taskProgress,
  BOARD_COLUMNS,
  boardColumnFor,
} from "./derive.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

describe("taskProgress", () => {
  it("counts completed over total; never a guessed percentage", () => {
    const m = newId("msn");
    const tasks = [
      task({ missionId: m, status: "completed" }),
      task({ missionId: m, status: "running" }),
      task({ missionId: m, status: "cancelled" }),
      task({ status: "completed" }),
    ];
    expect(taskProgress(tasks, m)).toEqual({ completed: 1, total: 3 });
  });
});

describe("board columns", () => {
  it("has the seven operator columns", () => {
    expect(BOARD_COLUMNS.map((c) => c.id)).toEqual([
      "pending",
      "ready",
      "running",
      "verifying",
      "completed",
      "blocked",
      "failed",
    ]);
  });

  it("folds leased into running and cancelled into failed", () => {
    expect(boardColumnFor("leased")).toBe("running");
    expect(boardColumnFor("cancelled")).toBe("failed");
    expect(boardColumnFor("verifying")).toBe("verifying");
  });
});

describe("layerTasks", () => {
  it("places each task one layer after its deepest dependency", () => {
    const a = task({ title: "A" });
    const b = task({ title: "B" });
    const c = task({ title: "C" });
    const d = task({ title: "D" });
    const layers = layerTasks(
      [a, b, c, d],
      [dependency(b.id, a.id), dependency(d.id, b.id), dependency(d.id, c.id)],
    );
    expect(layers.map((l) => l.map((t) => t.title))).toEqual([["A", "C"], ["B"], ["D"]]);
  });

  it("survives cycles and dependencies on unknown tasks", () => {
    const a = task({ title: "A" });
    const b = task({ title: "B" });
    const layers = layerTasks(
      [a, b],
      [dependency(a.id, b.id), dependency(b.id, a.id), dependency(a.id, newId("tsk"))],
    );
    expect(
      layers
        .flat()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["A", "B"]);
  });
});

describe("deriveAttention", () => {
  it("lists pending approvals first, then blocked, stuck and budget items", () => {
    const m = mission();
    const blocked = task({
      missionId: m.id,
      status: "blocked",
      blockedReason: "unknown_after_restart",
      title: "Blocked one",
    });
    const stuck = task({
      missionId: m.id,
      status: "running",
      leaseExpiresAt: "2026-10-14T11:00:00.000Z",
      title: "Stuck one",
    });
    const fresh = task({
      missionId: m.id,
      status: "running",
      leaseExpiresAt: "2026-10-14T13:00:00.000Z",
    });
    const pending = approval({ action: "runtime.force_stop" });
    const decided = approval({ status: "approved" });
    let s = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({
        missions: [m],
        tasks: [blocked, stuck, fresh],
        approvals: [pending, decided],
      }),
    });
    s = reducer(s, {
      type: "event/received",
      event: event("budget.warning", { budgetId: newId("bgt"), unit: "cost", used: 8, limit: 10 }),
    });
    const items = deriveAttention(s, NOW);
    expect(items.map((i) => i.kind)).toEqual(["approval", "blocked", "stuck", "budget"]);
    expect(items[0]?.approvalId).toBe(pending.id);
    expect(items[1]?.detail).toContain("unknown_after_restart");
    expect(items[2]?.taskId).toBe(stuck.id);
  });

  it("merges server attention items without duplicating", () => {
    let s = reducer(initialState, { type: "snapshot/loaded", snapshot: snapshot() });
    s = reducer(s, {
      type: "attention/loaded",
      items: [{ id: "srv-1", kind: "stuck", title: "Server says stuck" }],
    });
    expect(deriveAttention(s, NOW).map((i) => i.id)).toEqual(["srv-1"]);
  });

  it("dedupes server items that describe the same entity as a client item", () => {
    const a = approval();
    let s = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({ approvals: [a] }),
    });
    s = reducer(s, {
      type: "attention/loaded",
      items: [{ id: "srv-approval-1", kind: "approval", title: "x", approvalId: a.id }],
    });
    expect(deriveAttention(s, NOW).filter((i) => i.kind === "approval")).toHaveLength(1);
  });

  it("flags agents whose state is unknown", () => {
    const s = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({ agents: [agent({ status: "unknown" })] }),
    });
    expect(deriveAttention(s, NOW).map((i) => i.kind)).toEqual(["unknown"]);
  });
});

describe("filterEvents", () => {
  const m = newId("msn");
  const t = newId("tsk");
  const evs = [
    event("task.ready", { from: "pending", to: "ready" }, { taskId: t, missionId: m }),
    event(
      "summary.created",
      { scope: "mission", text: "Halfway there", sourceEventIds: [] },
      {
        missionId: m,
        provenance: "summarized",
      },
    ),
    event("session.output", { text: "hello world", redacted: false, lines: 1 }),
  ];

  it("filters by task, type and provenance", () => {
    expect(filterEvents(evs, { taskId: t })).toHaveLength(1);
    expect(filterEvents(evs, { type: "summary.created" })).toHaveLength(1);
    expect(filterEvents(evs, { provenance: "summarized" })).toHaveLength(1);
    expect(filterEvents(evs, { missionId: m })).toHaveLength(2);
  });

  it("searches type, ids and payload text case-insensitively", () => {
    expect(filterEvents(evs, { search: "HELLO" })).toHaveLength(1);
    expect(filterEvents(evs, { search: t })).toHaveLength(1);
    expect(filterEvents(evs, { search: "summary" })).toHaveLength(1);
  });
});
