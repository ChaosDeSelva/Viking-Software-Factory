import { newId } from "@mimir/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { deriveAttention } from "../lib/derive.js";
import { approval, event, project, snapshot, task } from "../test/fixtures.js";
import { mockClient } from "../test/mockClient.js";
import { initialState, needsSnapshotRefresh, reducer, type State } from "./reducer.js";
import { StoreProvider, useStore } from "./StoreProvider.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const LEASE = "2026-10-14T11:00:00.000Z";

function loaded(over: Parameters<typeof snapshot>[0] = {}): State {
  return reducer(initialState, { type: "snapshot/loaded", snapshot: snapshot(over) });
}

function receive(state: State, e: ReturnType<typeof event>): State {
  return reducer(state, { type: "event/received", event: e });
}

describe("reducer: task folding matches the server read model", () => {
  it("stores the 0-based attempt index from task.leased, whose payload is 1-based", () => {
    const t = task({ status: "ready" });
    const agentId = newId("agt");
    let s = loaded({ tasks: [t] });
    s = receive(
      s,
      event(
        "task.leased",
        { from: "ready", to: "leased", agentId, attempt: 1, leaseExpiresAt: LEASE },
        { taskId: t.id },
      ),
    );
    expect(s.tasks[0]?.attempt).toBe(0);
    s = receive(
      s,
      event(
        "task.leased",
        { from: "ready", to: "leased", agentId, attempt: 3, leaseExpiresAt: LEASE },
        { taskId: t.id },
      ),
    );
    expect(s.tasks[0]?.attempt).toBe(2);
  });

  it("a lease given back (launch_deferred: leased -> ready) leaves no agent and no lease", () => {
    const t = task({ status: "leased", agentId: newId("agt"), leaseExpiresAt: LEASE });
    const s = receive(
      loaded({ tasks: [t] }),
      event("task.ready", { from: "leased", to: "ready" }, { taskId: t.id }),
    );
    expect(s.tasks[0]?.status).toBe("ready");
    expect(s.tasks[0]?.agentId).toBeNull();
    expect(s.tasks[0]?.leaseExpiresAt).toBeNull();
  });

  it("a failed verification (verification_errored) fails the task and drops its lease", () => {
    const t = task({ status: "verifying", agentId: newId("agt"), leaseExpiresAt: LEASE });
    const s = receive(
      loaded({ tasks: [t] }),
      event(
        "task.failed",
        {
          from: "verifying",
          to: "failed",
          reason: "verification_errored",
          attempt: 1,
          retryable: true,
        },
        { taskId: t.id },
      ),
    );
    expect(s.tasks[0]?.status).toBe("failed");
    expect(s.tasks[0]?.attempt).toBe(1);
    expect(s.tasks[0]?.leaseExpiresAt).toBeNull();
  });

  it("task.retried clears the agent and the lease", () => {
    const t = task({ status: "failed", agentId: newId("agt"), leaseExpiresAt: LEASE });
    const s = receive(
      loaded({ tasks: [t] }),
      event("task.retried", { from: "failed", to: "ready", attempt: 1 }, { taskId: t.id }),
    );
    expect(s.tasks[0]?.agentId).toBeNull();
    expect(s.tasks[0]?.leaseExpiresAt).toBeNull();
    expect(s.tasks[0]?.attempt).toBe(1);
  });

  it("verifying -> running starts the next attempt", () => {
    const agentId = newId("agt");
    const t = task({ status: "verifying", attempt: 0, agentId });
    const s = receive(
      loaded({ tasks: [t] }),
      event(
        "task.started",
        { from: "verifying", to: "running", agentId, sessionId: newId("ses") },
        { taskId: t.id },
      ),
    );
    expect(s.tasks[0]?.status).toBe("running");
    expect(s.tasks[0]?.attempt).toBe(1);
  });

  it("does not count a verification retry twice when a refresh re-folds it over a snapshot that has it", () => {
    const agentId = newId("agt");
    const t = task({ status: "verifying", attempt: 0, agentId });
    let s = loaded({ tasks: [t] });
    s = receive(s, event("task.verifying", { from: "running", to: "verifying" }, { taskId: t.id }));
    const mark = s.events.at(-1)?.id ?? null;
    s = receive(
      s,
      event(
        "task.started",
        { from: "verifying", to: "running", agentId, sessionId: newId("ses") },
        { taskId: t.id },
      ),
    );
    expect(s.tasks[0]?.attempt).toBe(1);
    // The refresh answered after the server had applied task.started: its task is already on
    // attempt 1, and the event is re-folded because it arrived after the request mark.
    s = reducer(s, {
      type: "snapshot/loaded",
      snapshot: snapshot({ tasks: [{ ...t, status: "running", attempt: 1 }] }),
      lastEventIdAtRequest: mark,
    });
    expect(s.tasks[0]?.status).toBe("running");
    expect(s.tasks[0]?.attempt).toBe(1);
  });

  it("leased -> running keeps the attempt", () => {
    const agentId = newId("agt");
    const t = task({ status: "leased", attempt: 1 });
    const s = receive(
      loaded({ tasks: [t] }),
      event(
        "task.started",
        { from: "leased", to: "running", agentId, sessionId: newId("ses") },
        { taskId: t.id },
      ),
    );
    expect(s.tasks[0]?.attempt).toBe(1);
    expect(s.tasks[0]?.agentId).toBe(agentId);
  });

  it("task.completed records the result commit and drops the lease", () => {
    const t = task({ status: "verifying", leaseExpiresAt: LEASE });
    const s = receive(
      loaded({ tasks: [t] }),
      event(
        "task.completed",
        { from: "verifying", to: "completed", resultCommit: "abc1234" },
        { taskId: t.id },
      ),
    );
    expect(s.tasks[0]?.status).toBe("completed");
    expect(s.tasks[0]?.resultCommit).toBe("abc1234");
    expect(s.tasks[0]?.leaseExpiresAt).toBeNull();
  });

  it("ignores a task event without a target status and one without a task id", () => {
    const t = task({ status: "running" });
    const s0 = loaded({ tasks: [t] });
    const noTo = receive(s0, {
      ...event("task.ready", { from: "pending", to: "ready" }, { taskId: t.id }),
      payload: {},
    });
    expect(noTo.tasks).toBe(s0.tasks);
    const noId = receive(s0, event("task.ready", { from: "pending", to: "ready" }));
    expect(noId.tasks).toBe(s0.tasks);
  });

  it("ignores a mission event without a target status", () => {
    const s0 = loaded();
    const s = receive(s0, {
      ...event("mission.started", { from: "draft", to: "active" }),
      payload: {},
    });
    expect(s.missions).toBe(s0.missions);
  });

  it("ignores session events that name no session or an unknown one", () => {
    const s0 = loaded();
    expect(receive(s0, event("session.lost", { reason: "gone" })).agents).toBe(s0.agents);
    expect(
      receive(s0, event("session.lost", { reason: "gone" }, { sessionId: newId("ses") })).agents,
    ).toBe(s0.agents);
  });

  it("re-folds the whole buffer when the request mark fell out of the bounded buffer", () => {
    const t = task({ status: "running" });
    let s = loaded({ tasks: [t] });
    s = receive(s, event("task.verifying", { from: "running", to: "verifying" }, { taskId: t.id }));
    s = reducer(s, {
      type: "snapshot/loaded",
      snapshot: snapshot({ tasks: [t] }),
      lastEventIdAtRequest: "evt_no_longer_buffered",
    });
    expect(s.tasks[0]?.status).toBe("verifying");
  });
});

describe("needsSnapshotRefresh: events added to the protocol", () => {
  it("reloads the snapshot for project, crew and usage events the reducer does not fold", () => {
    const p = project();
    expect(needsSnapshotRefresh(event("project.updated", { project: p }))).toBe(true);
    expect(needsSnapshotRefresh(event("project.created", { project: p }))).toBe(true);
    expect(
      needsSnapshotRefresh(
        event("crew.scheduling_changed", { crewId: newId("crw"), paused: true }),
      ),
    ).toBe(true);
    expect(needsSnapshotRefresh(event("approval.consumed", { approvalId: newId("apr") }))).toBe(
      false,
    );
  });
});

describe("deriveAttention: server items older than the local state", () => {
  it("drops a server approval item once the approval was decided over the stream", () => {
    const a = approval();
    let s = loaded({ approvals: [a] });
    s = reducer(s, {
      type: "attention/loaded",
      items: [{ id: "srv-1", kind: "approval", title: "Approve it", approvalId: a.id }],
    });
    expect(deriveAttention(s, NOW).filter((i) => i.kind === "approval")).toHaveLength(1);
    s = receive(
      s,
      event("approval.decided", { approvalId: a.id, decision: "approved", actor: "human" }),
    );
    expect(deriveAttention(s, NOW)).toEqual([]);
  });

  it("drops a server blocked item once the task left blocked", () => {
    const t = task({ status: "blocked", blockedReason: "approval_needed" });
    let s = loaded({ tasks: [t] });
    s = reducer(s, {
      type: "attention/loaded",
      items: [{ id: "srv-2", kind: "blocked", title: "Blocked too long", taskId: t.id }],
    });
    s = receive(s, event("task.ready", { from: "blocked", to: "ready" }, { taskId: t.id }));
    expect(deriveAttention(s, NOW)).toEqual([]);
  });

  it("keeps server items about entities the snapshot does not hold", () => {
    let s = loaded();
    s = reducer(s, {
      type: "attention/loaded",
      items: [
        { id: "srv-3", kind: "approval", title: "New approval", approvalId: newId("apr") },
        { id: "srv-4", kind: "blocked", title: "New blocked", taskId: newId("tsk") },
      ],
    });
    expect(deriveAttention(s, NOW).map((i) => i.id)).toEqual(["srv-3", "srv-4"]);
  });
});

function Probe() {
  const { state, refresh, reconnect, reportError } = useStore();
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="connection">{state.connection}</span>
      <span data-testid="tasks">{state.tasks.map((t) => `${t.title}:${t.status}`).join(",")}</span>
      <span data-testid="refresh-error">{state.refreshError ?? ""}</span>
      <span data-testid="attention">{state.serverAttention.map((i) => i.id).join(",")}</span>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
      <button type="button" onClick={reconnect}>
        reconnect
      </button>
      <button type="button" onClick={() => reportError(new Error("plain"))}>
        report plain
      </button>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("StoreProvider: overlapping snapshot requests", () => {
  it("keeps the newer snapshot when an older request answers last", async () => {
    const t = task({ title: "A", status: "running" });
    const older = deferred<ReturnType<typeof snapshot>>();
    const newer = deferred<ReturnType<typeof snapshot>>();
    const snapshotFn = vi
      .fn()
      .mockResolvedValueOnce(snapshot({ tasks: [t] }))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const client = mockClient({ snapshot: snapshotFn });
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("tasks").textContent).toBe("A:running"));
    act(() => screen.getByRole("button", { name: "refresh" }).click());
    act(() => screen.getByRole("button", { name: "refresh" }).click());
    await waitFor(() => expect(snapshotFn).toHaveBeenCalledTimes(3));
    await act(async () => newer.resolve(snapshot({ tasks: [{ ...t, status: "completed" }] })));
    await waitFor(() => expect(screen.getByTestId("tasks").textContent).toBe("A:completed"));
    await act(async () => older.resolve(snapshot({ tasks: [{ ...t, status: "verifying" }] })));
    expect(screen.getByTestId("tasks").textContent).toBe("A:completed");
  });

  it("does not report a refresh error from an older request after a newer one loaded", async () => {
    const older = deferred<ReturnType<typeof snapshot>>();
    const snapshotFn = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce(snapshot());
    const client = mockClient({ snapshot: snapshotFn });
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    act(() => screen.getByRole("button", { name: "refresh" }).click());
    await act(async () => screen.getByRole("button", { name: "refresh" }).click());
    await waitFor(() => expect(snapshotFn).toHaveBeenCalledTimes(3));
    await act(async () => older.reject(new Error("timed out")));
    expect(screen.getByTestId("refresh-error").textContent).toBe("");
  });
});

describe("StoreProvider: stream lifecycle", () => {
  it("stores the server attention list loaded with the snapshot", async () => {
    const client = mockClient();
    vi.mocked(client.attention.list).mockResolvedValue({
      items: [{ id: "srv-9", kind: "stuck", title: "Stuck session" }],
    });
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("attention").textContent).toBe("srv-9"));
  });

  it("loads without the attention list when that request fails", async () => {
    const client = mockClient();
    vi.mocked(client.attention.list).mockRejectedValue(new Error("validation_failed"));
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    expect(screen.getByTestId("attention").textContent).toBe("");
  });

  it("marks the connection closed when the stream ends, and reconnect reloads and reopens it", async () => {
    const client = mockClient();
    const ended = {
      cursor: undefined,
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ value: undefined, done: true as const }),
      }),
    };
    vi.mocked(client.events.stream).mockReturnValueOnce(ended);
    render(
      <StoreProvider client={client}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("connection").textContent).toBe("closed"));
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: "reconnect" }).click());
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    act(() => client.streamController.last?.onStatus?.("open"));
    expect(screen.getByTestId("connection").textContent).toBe("open");
  });

  it("marks the connection closed on a stream failure that is not a 401, without signing out", async () => {
    const onUnauthorized = vi.fn();
    const client = mockClient();
    render(
      <StoreProvider client={client} onUnauthorized={onUnauthorized}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.fail(new Error("socket hang up")));
    await waitFor(() => expect(screen.getByTestId("connection").textContent).toBe("closed"));
    act(() => screen.getByRole("button", { name: "report plain" }).click());
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("ignores a stream failure that arrives after unmount", async () => {
    const onUnauthorized = vi.fn();
    const client = mockClient();
    const failing = deferred<IteratorResult<never>>();
    vi.mocked(client.events.stream).mockReturnValueOnce({
      cursor: undefined,
      [Symbol.asyncIterator]: () => ({ next: () => failing.promise }),
    });
    const { unmount } = render(
      <StoreProvider client={client} onUnauthorized={onUnauthorized}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.events.stream).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () =>
      failing.reject(Object.assign(new Error("401"), { name: "MimirError", code: "unauthorized" })),
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not reload the snapshot for a refresh scheduled just before unmount", async () => {
    const client = mockClient();
    const { unmount } = render(
      <StoreProvider client={client} refreshDelayMs={5000}>
        <Probe />
      </StoreProvider>,
    );
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => void vi.useRealTimers());
    const created = () =>
      event("task.created", {
        missionId: newId("msn"),
        crewId: null,
        title: "N",
        acceptance: "",
        dependsOn: [],
      });
    // No waitFor from here on: it needs real timers.
    await act(async () => {
      client.streamController.push(created());
      client.streamController.push(created());
      await Promise.resolve();
    });
    expect(screen.getByTestId("connection").textContent).toBe("open");
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(client.snapshot).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when useStore is used outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow("useStore must be used inside <StoreProvider>");
    spy.mockRestore();
  });
});
