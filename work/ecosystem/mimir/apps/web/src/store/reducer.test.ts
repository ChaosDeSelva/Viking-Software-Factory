import { newId } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { agent, approval, event, mission, snapshot, task } from "../test/fixtures.js";
import { initialState, MAX_EVENTS, needsSnapshotRefresh, reducer, type State } from "./reducer.js";

function loaded(over: Parameters<typeof snapshot>[0] = {}): State {
  return reducer(initialState, { type: "snapshot/loaded", snapshot: snapshot(over) });
}

describe("reducer: snapshot lifecycle", () => {
  it("starts in loading with empty collections", () => {
    expect(initialState.status).toBe("loading");
    expect(initialState.tasks).toEqual([]);
    expect(initialState.events).toEqual([]);
    expect(initialState.connection).toBe("connecting");
  });

  it("loads a snapshot and records its cursor", () => {
    const t = task();
    const s = loaded({ tasks: [t], cursor: "c42" });
    expect(s.status).toBe("ready");
    expect(s.tasks).toEqual([t]);
    expect(s.cursor).toBe("c42");
    expect(s.error).toBeNull();
  });

  it("records a snapshot failure", () => {
    const s = reducer(initialState, { type: "snapshot/failed", error: "boom" });
    expect(s.status).toBe("error");
    expect(s.error).toBe("boom");
  });

  it("keeps the last-good state when a refresh fails after the first load", () => {
    const t = task();
    let s = loaded({ tasks: [t] });
    s = reducer(s, { type: "snapshot/failed", error: "boom" });
    expect(s.status).toBe("ready");
    expect(s.tasks).toEqual([t]);
    expect(s.refreshError).toBe("boom");
    s = reducer(s, { type: "snapshot/loaded", snapshot: snapshot({ tasks: [t] }) });
    expect(s.refreshError).toBeNull();
  });

  it("keeps received events when a snapshot is reloaded", () => {
    const e = event("task.ready", { from: "pending", to: "ready" });
    let s = loaded();
    s = reducer(s, { type: "event/received", event: e });
    s = reducer(s, { type: "snapshot/loaded", snapshot: snapshot() });
    expect(s.events.map((x) => x.id)).toEqual([e.id]);
  });
});

describe("reducer: snapshot refresh vs live events (I4)", () => {
  it("re-applies events received after the refresh was requested over a stale snapshot", () => {
    const t = task({ status: "running" });
    let s = loaded({ tasks: [t] });
    const before = event("task.verifying", { from: "running", to: "verifying" }, { taskId: t.id });
    s = reducer(s, { type: "event/received", event: before });
    // refresh requested here (last event = before); then a newer event arrives
    s = reducer(s, {
      type: "event/received",
      event: event("task.completed", { from: "verifying", to: "completed" }, { taskId: t.id }),
    });
    expect(s.tasks[0]?.status).toBe("completed");
    // the stale snapshot (built before task.completed) lands
    s = reducer(s, {
      type: "snapshot/loaded",
      snapshot: snapshot({ tasks: [{ ...t, status: "verifying" }] }),
      lastEventIdAtRequest: before.id,
    });
    expect(s.tasks[0]?.status).toBe("completed");
  });

  it("re-applies the whole buffer when nothing was buffered at request time", () => {
    const m = mission({ status: "draft" });
    let s = loaded({ missions: [m] });
    s = reducer(s, {
      type: "event/received",
      event: event("mission.started", { from: "draft", to: "active" }, { missionId: m.id }),
    });
    s = reducer(s, {
      type: "snapshot/loaded",
      snapshot: snapshot({ missions: [m] }),
      lastEventIdAtRequest: null,
    });
    expect(s.missions[0]?.status).toBe("active");
  });

  it("does not re-apply events that were already in the buffer when the refresh was requested", () => {
    const t = task({ status: "running" });
    let s = loaded({ tasks: [t] });
    const old = event(
      "task.blocked",
      { from: "running", to: "blocked", reason: "x" },
      { taskId: t.id },
    );
    s = reducer(s, { type: "event/received", event: old });
    s = reducer(s, {
      type: "snapshot/loaded",
      snapshot: snapshot({ tasks: [{ ...t, status: "ready" }] }),
      lastEventIdAtRequest: old.id,
    });
    expect(s.tasks[0]?.status).toBe("ready");
  });
});

describe("reducer: events", () => {
  it("appends events and dedupes by id", () => {
    const e = event("task.ready", { from: "pending", to: "ready" });
    let s = loaded();
    s = reducer(s, { type: "event/received", event: e });
    s = reducer(s, { type: "event/received", event: e });
    expect(s.events).toHaveLength(1);
  });

  it("bounds the event buffer", () => {
    let s = loaded();
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      s = reducer(s, {
        type: "event/received",
        event: event("task.ready", { from: "pending", to: "ready" }),
      });
    }
    expect(s.events).toHaveLength(MAX_EVENTS);
  });

  it("applies task transitions to the matching task", () => {
    const t = task({ status: "ready" });
    const agentId = newId("agt");
    let s = loaded({ tasks: [t] });
    s = reducer(s, {
      type: "event/received",
      event: event(
        "task.leased",
        {
          from: "ready",
          to: "leased",
          agentId,
          attempt: 1,
          leaseExpiresAt: "2026-10-14T11:00:00.000Z",
        },
        { taskId: t.id },
      ),
    });
    expect(s.tasks[0]?.status).toBe("leased");
    expect(s.tasks[0]?.attempt).toBe(1);
    expect(s.tasks[0]?.agentId).toBe(agentId);
    expect(s.tasks[0]?.leaseExpiresAt).toBe("2026-10-14T11:00:00.000Z");
  });

  it("records and clears blockedReason", () => {
    const t = task({ status: "running" });
    let s = loaded({ tasks: [t] });
    s = reducer(s, {
      type: "event/received",
      event: event(
        "task.blocked",
        { from: "running", to: "blocked", reason: "awaiting approval" },
        { taskId: t.id },
      ),
    });
    expect(s.tasks[0]?.status).toBe("blocked");
    expect(s.tasks[0]?.blockedReason).toBe("awaiting approval");
    s = reducer(s, {
      type: "event/received",
      event: event("task.ready", { from: "blocked", to: "ready" }, { taskId: t.id }),
    });
    expect(s.tasks[0]?.status).toBe("ready");
    expect(s.tasks[0]?.blockedReason).toBeUndefined();
  });

  it("applies task.retried with its target status", () => {
    const t = task({ status: "failed", attempt: 1 });
    let s = loaded({ tasks: [t] });
    s = reducer(s, {
      type: "event/received",
      event: event("task.retried", { from: "failed", to: "ready", attempt: 2 }, { taskId: t.id }),
    });
    expect(s.tasks[0]?.status).toBe("ready");
    expect(s.tasks[0]?.attempt).toBe(2);
  });

  it("ignores events for unknown tasks", () => {
    const s0 = loaded({ tasks: [task()] });
    const s = reducer(s0, {
      type: "event/received",
      event: event("task.ready", { from: "pending", to: "ready" }, { taskId: newId("tsk") }),
    });
    expect(s.tasks).toEqual(s0.tasks);
  });

  it("applies mission transitions", () => {
    const m = mission({ status: "draft" });
    let s = loaded({ missions: [m] });
    s = reducer(s, {
      type: "event/received",
      event: event("mission.started", { from: "draft", to: "active" }, { missionId: m.id }),
    });
    expect(s.missions[0]?.status).toBe("active");
  });

  it("applies approval decisions and expiry", () => {
    const a = approval();
    const b = approval();
    let s = loaded({ approvals: [a, b] });
    s = reducer(s, {
      type: "event/received",
      event: event("approval.decided", {
        approvalId: a.id,
        decision: "approved",
        actor: "operator",
        reason: "ok",
      }),
    });
    s = reducer(s, {
      type: "event/received",
      event: event("approval.expired", { approvalId: b.id }),
    });
    expect(s.approvals[0]).toMatchObject({ status: "approved", actor: "operator", reason: "ok" });
    expect(s.approvals[1]?.status).toBe("expired");
  });

  it("applies session state changes to the agent bound to that session", () => {
    const ag = agent({ status: "running" });
    let s = loaded({ agents: [ag] });
    s = reducer(s, {
      type: "event/received",
      event: event(
        "session.state_changed",
        { from: "running", to: "blocked", runtimeStatus: "blocked:trust_prompt" },
        { sessionId: ag.runtimeSessionId as NonNullable<typeof ag.runtimeSessionId> },
      ),
    });
    expect(s.agents[0]?.status).toBe("blocked");
  });

  it("marks lost sessions unknown, never guessed", () => {
    const ag = agent({ status: "running" });
    let s = loaded({ agents: [ag] });
    s = reducer(s, {
      type: "event/received",
      event: event(
        "session.lost",
        { reason: "pane gone" },
        {
          sessionId: ag.runtimeSessionId as NonNullable<typeof ag.runtimeSessionId>,
        },
      ),
    });
    expect(s.agents[0]?.status).toBe("unknown");
  });

  it("tracks budget warnings and exceedances by budget id", () => {
    const budgetId = newId("bgt");
    const m = newId("msn");
    let s = loaded();
    s = reducer(s, {
      type: "event/received",
      event: event(
        "budget.warning",
        { budgetId, unit: "tokens", used: 80, limit: 100 },
        { missionId: m },
      ),
    });
    expect(s.budgetAlerts[budgetId]).toMatchObject({
      level: "warning",
      used: 80,
      limit: 100,
      missionId: m,
    });
    s = reducer(s, {
      type: "event/received",
      event: event("budget.exceeded", { budgetId, unit: "tokens", used: 101, limit: 100 }),
    });
    expect(s.budgetAlerts[budgetId]?.level).toBe("exceeded");
  });
});

describe("reducer: connection and gaps", () => {
  it("tracks connection status", () => {
    const s = reducer(initialState, { type: "connection/changed", connection: "reconnecting" });
    expect(s.connection).toBe("reconnecting");
  });

  it("records and dismisses a gap", () => {
    let s = reducer(initialState, {
      type: "stream/gap",
      reason: "slow consumer",
      at: "2026-10-14T10:00:00.000Z",
    });
    expect(s.gap).toEqual({ reason: "slow consumer", at: "2026-10-14T10:00:00.000Z" });
    s = reducer(s, { type: "gap/dismissed" });
    expect(s.gap).toBeNull();
  });

  it("clears a gap after a fresh snapshot", () => {
    let s = reducer(initialState, {
      type: "stream/gap",
      reason: null,
      at: "2026-10-14T10:00:00.000Z",
    });
    s = reducer(s, { type: "snapshot/loaded", snapshot: snapshot() });
    expect(s.gap).toBeNull();
  });

  it("stores server attention items", () => {
    const s = reducer(initialState, {
      type: "attention/loaded",
      items: [{ id: "x", kind: "stuck", title: "stuck" }],
    });
    expect(s.serverAttention).toHaveLength(1);
  });
});

describe("needsSnapshotRefresh", () => {
  it("is true for entity-creating events", () => {
    expect(
      needsSnapshotRefresh(
        event("task.created", {
          missionId: newId("msn"),
          crewId: null,
          title: "t",
          acceptance: "",
          dependsOn: [],
        }),
      ),
    ).toBe(true);
    expect(
      needsSnapshotRefresh(
        event("approval.requested", {
          approvalId: newId("apr"),
          action: "x",
          expiry: null,
        }),
      ),
    ).toBe(true);
  });

  it("is false for plain transitions", () => {
    expect(needsSnapshotRefresh(event("task.ready", { from: "pending", to: "ready" }))).toBe(false);
  });

  it("is true for event types the protocol does not know yet", () => {
    const e = {
      ...event("task.ready", { from: "pending", to: "ready" }),
      type: "crew.created",
    } as never;
    expect(needsSnapshotRefresh(e)).toBe(true);
  });
});
