import { newId } from "@mimir/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agent, approval, event, mission, snapshot, task } from "../test/fixtures.js";
import { mockClient, page } from "../test/mockClient.js";
import { initialState, reducer } from "../store/reducer.js";
import { StoreProvider } from "../store/StoreProvider.js";
import { deriveAttention, filterEvents } from "./derive.js";
import { useTheme } from "@factory/ui";
import { migrateLegacyTheme } from "./theme.js";
import { useAsync } from "./useAsync.js";
import {
  HISTORY_MAX_PAGES,
  HISTORY_PAGE,
  loadHistory,
  mergeEvents,
  useMissionEvents,
} from "./useEventHistory.js";
import { useNow } from "./useNow.js";
import { useShortcuts } from "./useShortcuts.js";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("deriveAttention details", () => {
  it("carries an approval's mission and task and leaves out an absent reason", () => {
    const m = mission();
    const t = task({ missionId: m.id });
    const a = approval({ reason: null, missionId: m.id, taskId: t.id });
    const s = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({ missions: [m], tasks: [t], approvals: [a] }),
    });
    const [item] = deriveAttention(s, NOW);
    expect(item).toEqual({
      id: `approval:${a.id}`,
      kind: "approval",
      title: `Approval needed: ${a.action}`,
      missionId: m.id,
      taskId: t.id,
      approvalId: a.id,
    });
  });

  it("says when a blocked task reported no reason", () => {
    const s = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({ tasks: [task({ status: "blocked" })] }),
    });
    expect(deriveAttention(s, NOW)[0]?.detail).toBe("Reason: not reported");
  });

  it("does not call a leased task stuck before its lease expires or without a lease", () => {
    const s = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({
        tasks: [
          task({ status: "leased", leaseExpiresAt: null }),
          task({ status: "leased", leaseExpiresAt: "2026-10-14T13:00:00.000Z" }),
          task({ status: "leased", leaseExpiresAt: "2026-10-14T11:00:00.000Z", title: "Late" }),
        ],
      }),
    });
    expect(deriveAttention(s, NOW).map((i) => i.title)).toEqual(["Stuck: Late"]);
  });

  it("labels an exceeded budget and links it to its mission", () => {
    const m = mission();
    const budgetId = newId("bgt");
    let s = reducer(initialState, { type: "snapshot/loaded", snapshot: snapshot() });
    s = reducer(s, {
      type: "event/received",
      event: event(
        "budget.exceeded",
        { budgetId, unit: "tokens", used: 12, limit: 10 },
        { missionId: m.id },
      ),
    });
    expect(deriveAttention(s, NOW)).toEqual([
      {
        id: `budget:${budgetId}`,
        kind: "budget",
        title: "Budget exceeded",
        detail: "12 of 10 tokens",
        missionId: m.id,
      },
    ]);
  });

  it("links an unknown agent to its session and task, when it has them", () => {
    const t = task();
    const bound = agent({ status: "unknown", taskId: t.id });
    const unbound = agent({ status: "unknown", runtimeSessionId: null });
    const s = reducer(initialState, {
      type: "snapshot/loaded",
      snapshot: snapshot({ agents: [bound, unbound, agent({ status: "running" })] }),
    });
    const items = deriveAttention(s, NOW);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sessionId: bound.runtimeSessionId, taskId: t.id });
    expect(items[1]).not.toHaveProperty("sessionId");
    expect(items[1]).not.toHaveProperty("taskId");
  });
});

describe("filterEvents by mission, crew and session", () => {
  it("keeps only events of the named mission, crew and session", () => {
    const missionId = newId("msn");
    const crewId = newId("crw");
    const sessionId = newId("ses");
    const hit = event(
      "session.output",
      { text: "x", redacted: false, lines: 1 },
      { missionId, crewId, sessionId },
    );
    const other = event("session.output", { text: "y", redacted: false, lines: 1 });
    expect(filterEvents([hit, other], { missionId })).toEqual([hit]);
    expect(filterEvents([hit, other], { crewId })).toEqual([hit]);
    expect(filterEvents([hit, other], { sessionId })).toEqual([hit]);
    expect(filterEvents([hit, other], { search: "   " })).toEqual([hit, other]);
  });
});

describe("shared theme (@factory/ui useTheme)", () => {
  function ThemeProbe() {
    const [pref, setPref] = useTheme();
    return (
      <button type="button" onClick={() => setPref(pref === "dark" ? "system" : "dark")}>
        {pref}
      </button>
    );
  }

  it("starts on system after an old 'system' choice is migrated, persists and applies dark", () => {
    localStorage.setItem("mimir.theme", "system");
    migrateLegacyTheme();
    render(<ThemeProbe />);
    expect(screen.getByRole("button").textContent).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("factory-theme")).toBe("dark");
    // Back to system: the attribute goes, so prefers-color-scheme decides.
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("useNow", () => {
  it("ticks on the interval and stops on unmount", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
    function Clock() {
      return <span data-testid="now">{useNow(1000)}</span>;
    }
    const { unmount } = render(<Clock />);
    expect(screen.getByTestId("now").textContent).toBe(String(NOW));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId("now").textContent).toBe(String(NOW + 3000));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useShortcuts", () => {
  function Keys({
    navigate,
    openHelp,
    enabled,
  }: {
    navigate: (p: string) => void;
    openHelp: () => void;
    enabled?: boolean;
  }) {
    useShortcuts(navigate, openHelp, enabled);
    return (
      <>
        <input aria-label="field" />
        <textarea aria-label="area" />
        <select aria-label="choice" />
        <button type="button">button</button>
      </>
    );
  }

  it("navigates on g then o/m/r and opens help on ?", () => {
    const navigate = vi.fn();
    const openHelp = vi.fn();
    render(<Keys navigate={navigate} openHelp={openHelp} />);
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "m" });
    fireEvent.keyDown(screen.getByRole("button"), { key: "g" });
    fireEvent.keyDown(screen.getByRole("button"), { key: "r" });
    expect(navigate.mock.calls).toEqual([["/missions"], ["/reviews"]]);
    fireEvent.keyDown(window, { key: "?" });
    expect(openHelp).toHaveBeenCalledTimes(1);
  });

  it("drops a pending g on an unknown second key, on ? and after 1.5 s", () => {
    vi.useFakeTimers();
    const navigate = vi.fn();
    render(<Keys navigate={navigate} openHelp={vi.fn()} />);
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "x" });
    fireEvent.keyDown(window, { key: "o" });
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "?" });
    fireEvent.keyDown(window, { key: "o" });
    fireEvent.keyDown(window, { key: "g" });
    vi.advanceTimersByTime(1600);
    fireEvent.keyDown(window, { key: "o" });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "o" });
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("ignores keys typed into fields, with modifiers, or already handled", () => {
    const navigate = vi.fn();
    const openHelp = vi.fn();
    render(<Keys navigate={navigate} openHelp={openHelp} />);
    for (const label of ["field", "area", "choice"]) {
      fireEvent.keyDown(screen.getByLabelText(label), { key: "?" });
      fireEvent.keyDown(screen.getByLabelText(label), { key: "g" });
      fireEvent.keyDown(screen.getByLabelText(label), { key: "o" });
    }
    for (const mod of ["metaKey", "ctrlKey", "altKey"]) {
      fireEvent.keyDown(window, { key: "?", [mod]: true });
    }
    const handled = new KeyboardEvent("keydown", { key: "?", cancelable: true, bubbles: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(openHelp).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("listens only while enabled and removes its listener on unmount", () => {
    const openHelp = vi.fn();
    const { rerender, unmount } = render(
      <Keys navigate={vi.fn()} openHelp={openHelp} enabled={false} />,
    );
    fireEvent.keyDown(window, { key: "?" });
    expect(openHelp).not.toHaveBeenCalled();
    rerender(<Keys navigate={vi.fn()} openHelp={openHelp} enabled />);
    fireEvent.keyDown(window, { key: "?" });
    expect(openHelp).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { key: "?" });
    expect(openHelp).toHaveBeenCalledTimes(1);
  });
});

describe("useAsync", () => {
  function Loader({ load, id }: { load: (id: string) => Promise<string>; id: string }) {
    const r = useAsync(() => load(id), id);
    return (
      <div>
        <span data-testid="state">
          {r.status}:{r.data ?? ""}:{r.error ?? ""}
        </span>
        <button type="button" onClick={r.reload}>
          reload
        </button>
      </div>
    );
  }

  function renderLoader(load: (id: string) => Promise<string>, onUnauthorized = vi.fn()) {
    const client = mockClient();
    const ui = (id: string) => (
      <StoreProvider client={client} onUnauthorized={onUnauthorized}>
        <Loader load={load} id={id} />
      </StoreProvider>
    );
    return { ...render(ui("a")), ui, onUnauthorized };
  }

  it("loads, and reload runs the function again", async () => {
    const load = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    renderLoader(load);
    expect(screen.getByTestId("state").textContent).toBe("loading::");
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("ready:one:"));
    act(() => screen.getByRole("button", { name: "reload" }).click());
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("ready:two:"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows a failure without signing out, and signs out on a rejected token", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(
        Object.assign(new Error("bad token"), { name: "MimirError", code: "unauthorized" }),
      );
    const { onUnauthorized } = renderLoader(load);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("error::boom"));
    expect(onUnauthorized).not.toHaveBeenCalled();
    act(() => screen.getByRole("button", { name: "reload" }).click());
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("error::bad token"));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("ignores a late result for a key that is no longer shown", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const load = vi.fn((id: string) => (id === "a" ? a.promise : b.promise));
    const { rerender, ui } = renderLoader(load);
    rerender(ui("b"));
    await act(async () => b.resolve("for b"));
    expect(screen.getByTestId("state").textContent).toBe("ready:for b:");
    await act(async () => a.resolve("for a"));
    expect(screen.getByTestId("state").textContent).toBe("ready:for b:");
  });

  it("ignores a late failure for a key that is no longer shown", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const load = vi.fn((id: string) => (id === "a" ? a.promise : b.promise));
    const { rerender, ui, onUnauthorized } = renderLoader(load);
    rerender(ui("b"));
    await act(async () => b.resolve("for b"));
    await act(async () =>
      a.reject(Object.assign(new Error("401"), { name: "MimirError", code: "unauthorized" })),
    );
    expect(screen.getByTestId("state").textContent).toBe("ready:for b:");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("loadHistory", () => {
  const ready = () => event("task.ready", { from: "pending", to: "ready" });

  it("stops when the server reports more but does not advance the cursor", async () => {
    const client = mockClient();
    vi.mocked(client.events.list).mockImplementation(async () => page([ready()], "c1"));
    const r = await loadHistory(client, {});
    expect(client.events.list).toHaveBeenCalledTimes(2);
    expect(r.events).toHaveLength(2);
    expect(r.truncated).toBe(false);
    expect(r.nextCursor).toBe("c1");
  });

  it("stops at the page limit and says where to continue", async () => {
    const client = mockClient();
    let n = 0;
    vi.mocked(client.events.list).mockImplementation(async () => page([ready()], `c${++n}`));
    const r = await loadHistory(client, { cursor: "c0" });
    expect(client.events.list).toHaveBeenCalledTimes(HISTORY_MAX_PAGES);
    expect(client.events.list).toHaveBeenNthCalledWith(1, { cursor: "c0", limit: HISTORY_PAGE });
    expect(r).toMatchObject({ truncated: true, nextCursor: `c${HISTORY_MAX_PAGES}` });
  });

  it("stops on an empty page even if the server reports more", async () => {
    const client = mockClient();
    vi.mocked(client.events.list).mockResolvedValue({
      events: [],
      nextCursor: "c9",
      hasMore: true,
      lastCursor: "c9",
    });
    const r = await loadHistory(client, {});
    expect(client.events.list).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ events: [], truncated: false, nextCursor: "c9" });
  });

  it("requests nothing once aborted", async () => {
    const client = mockClient();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await loadHistory(client, {}, ctrl.signal);
    expect(client.events.list).not.toHaveBeenCalled();
    expect(r).toEqual({ events: [], truncated: true, nextCursor: null });
  });

  it("stops paging when aborted between pages", async () => {
    const client = mockClient();
    const ctrl = new AbortController();
    vi.mocked(client.events.list).mockImplementation(async () => {
      ctrl.abort();
      return page([ready()], "c1");
    });
    await loadHistory(client, {}, ctrl.signal);
    expect(client.events.list).toHaveBeenCalledTimes(1);
  });
});

describe("mergeEvents", () => {
  it("dedupes by id and orders by event time, keeping arrival order for equal times", () => {
    const at = (iso: string) => ({ occurredAt: iso, observedAt: iso });
    const early = event(
      "task.ready",
      { from: "pending", to: "ready" },
      at("2026-10-14T10:00:00.000Z"),
    );
    const late = event(
      "task.ready",
      { from: "pending", to: "ready" },
      at("2026-10-14T10:00:05.000Z"),
    );
    const sameA = event(
      "task.ready",
      { from: "pending", to: "ready" },
      at("2026-10-14T10:00:02.000Z"),
    );
    const sameB = event(
      "task.ready",
      { from: "pending", to: "ready" },
      at("2026-10-14T10:00:02.000Z"),
    );
    const merged = mergeEvents([late, sameA], [early, sameB, late]);
    expect(merged.map((e) => e.id)).toEqual([early.id, sameA.id, sameB.id, late.id]);
  });
});

describe("useMissionEvents", () => {
  function History({
    client,
    onError,
  }: {
    client: ReturnType<typeof mockClient>;
    onError: () => void;
  }) {
    const h = useMissionEvents(client, "msn_x", [], onError);
    return (
      <span data-testid="history">
        {h.status}:{h.events.length}:{h.error ?? ""}
      </span>
    );
  }

  it("drops a history page that arrives after unmount", async () => {
    const client = mockClient();
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(client.events.list).mockReturnValue(pending.promise);
    const onError = vi.fn();
    const { unmount } = render(<History client={client} onError={onError} />);
    expect(screen.getByTestId("history").textContent).toBe("loading:0:");
    unmount();
    await act(async () => pending.resolve(page([])));
    expect(onError).not.toHaveBeenCalled();
  });

  it("drops a history failure that arrives after unmount", async () => {
    const client = mockClient();
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(client.events.list).mockReturnValue(pending.promise);
    const onError = vi.fn();
    const { unmount } = render(<History client={client} onError={onError} />);
    unmount();
    await act(async () => pending.reject(new Error("late")));
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failure and shows its message", async () => {
    const client = mockClient();
    vi.mocked(client.events.list).mockRejectedValue(new Error("history down"));
    const onError = vi.fn();
    render(<History client={client} onError={onError} />);
    await waitFor(() =>
      expect(screen.getByTestId("history").textContent).toBe("error:0:history down"),
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
