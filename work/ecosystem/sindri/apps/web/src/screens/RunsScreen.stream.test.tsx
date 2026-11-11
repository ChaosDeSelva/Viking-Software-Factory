import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { ExecutionStreamMessage } from "../api/delivery-types.js";
import { NoticeRegion } from "../components/Layout.js";
import { useStore } from "../store/context.js";
import { executionDetail } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { RECONNECT_DELAYS_MS, RunsScreen } from "./RunsScreen.js";

function Where() {
  const { state } = useStore();
  return (
    <span data-testid="where">
      {`${state.view}:${state.executionId ?? ""}:${state.deliveryId ?? ""}:${state.token ?? "signed-out"}`}
    </span>
  );
}
const ui = (
  <>
    <NoticeRegion />
    <RunsScreen />
    <Where />
  </>
);
const summary = {
  id: "e1",
  planId: "pl1",
  planVersion: 1,
  projectId: "p1",
  status: "awaiting_human",
  mimirMissionId: "msn_1",
  createdAt: "2026-01-01T00:00:00Z",
  finishedAt: null,
};
const idleStream = () => new Promise<void>(() => undefined);
const withStatus = (status: "running" | "verified_pending_review" | "failed") =>
  executionDetail({
    execution: { ...executionDetail().execution, status },
    approvals: [],
  });
const event = (id: string, type: string): ExecutionStreamMessage => ({
  kind: "event",
  data: { id, mimirEventId: `m_${id}`, type, payload: {}, occurredAt: `2026-01-01T00:00:0${id}Z` },
});
const fakeReconnectTimer = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** Lets resolved requests and their renders finish without moving the fake clock. */
const settle = async () => {
  await advance(0);
  await advance(0);
};

afterEach(() => vi.useRealTimers());

describe("RunsScreen live updates", () => {
  it("backs off between reconnect attempts and repeats the last delay", async () => {
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: () => Promise.resolve(),
    });
    fakeReconnectTimer();
    renderWithStore(ui, api, { executionId: "e1" });
    await settle();
    expect(screen.getByRole("note", { name: "Live updates" })).toBeTruthy();
    expect(api.streamExecution).toHaveBeenCalledTimes(1);
    let calls = 1;
    for (const delay of [...RECONNECT_DELAYS_MS, 30_000, 30_000]) {
      await advance(delay - 1);
      expect(api.streamExecution, `before ${delay} ms`).toHaveBeenCalledTimes(calls);
      await advance(1);
      calls += 1;
      expect(api.streamExecution, `after ${delay} ms`).toHaveBeenCalledTimes(calls);
    }
    expect(api.streamExecution).toHaveBeenLastCalledWith(
      "e1",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("note", { name: "Live updates" })).toBeTruthy();
  });

  it("starts the backoff again once a message arrives", async () => {
    const pushes: ((m: ExecutionStreamMessage) => void)[] = [];
    const ends: (() => void)[] = [];
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: (_id: string, on: (m: ExecutionStreamMessage) => void) => {
        pushes.push(on);
        return new Promise<void>((resolve) => ends.push(resolve));
      },
    });
    fakeReconnectTimer();
    renderWithStore(ui, api, { executionId: "e1" });
    await settle();
    expect(screen.getByRole("table", { name: "Tasks" })).toBeTruthy();
    // Two drops in a row: the second retry waits two seconds.
    await act(async () => ends[0]!());
    await advance(1000);
    await act(async () => ends[1]!());
    await advance(1999);
    expect(api.streamExecution).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(api.streamExecution).toHaveBeenCalledTimes(3);
    // A message proves the stream works: the warning goes and the next drop waits one second.
    act(() =>
      pushes[2]!({ kind: "snapshot", data: { execution: executionDetail().execution, tasks: [] } }),
    );
    await settle();
    expect(screen.queryByRole("note", { name: "Live updates" })).toBeNull();
    await act(async () => ends[2]!());
    await settle();
    expect(screen.getByRole("note", { name: "Live updates" })).toBeTruthy();
    await advance(999);
    expect(api.streamExecution).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(api.streamExecution).toHaveBeenCalledTimes(4);
  });

  it("stops retrying when the run turns out to have finished while disconnected", async () => {
    let detail = executionDetail();
    const api = mockApi({
      listExecutions: [summary],
      getExecution: () => Promise.resolve(detail),
    });
    let end: () => void = () => undefined;
    api.streamExecution.mockImplementation(() => new Promise<void>((r) => (end = r)));
    fakeReconnectTimer();
    renderWithStore(ui, api, { executionId: "e1" });
    await settle();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
    // The server closes the stream as the run is verified; the refresh that follows shows it.
    detail = withStatus("verified_pending_review");
    await act(async () => end());
    await settle();
    expect(screen.getByRole("button", { name: "Open delivery" })).toBeTruthy();
    expect(screen.queryByRole("note", { name: "Live updates" })).toBeNull();
    // The retry that was already scheduled finds the run final and does not reconnect.
    expect(vi.getTimerCount()).toBe(1);
    await advance(60_000);
    expect(api.streamExecution).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryByRole("note", { name: "Live updates" })).toBeNull();
  });

  it("ends the session instead of retrying when the stream answers 401", async () => {
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: () => Promise.reject(new ApiError(401, "unauthorized", "bad token")),
    });
    fakeReconnectTimer();
    renderWithStore(ui, api, { executionId: "e1" });
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/rejected the token/);
    expect(screen.getByTestId("where").textContent).toMatch(/signed-out$/);
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(api.streamExecution).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("note", { name: "Live updates" })).toBeNull();
  });

  it("keeps what is shown when a refresh fails, and shows each event once", async () => {
    let push: (m: ExecutionStreamMessage) => void = () => undefined;
    const api = mockApi({
      listExecutions: [summary],
      streamExecution: (_id: string, on: (m: ExecutionStreamMessage) => void) => {
        push = on;
        return idleStream();
      },
    });
    api.getExecution
      .mockResolvedValueOnce(executionDetail())
      .mockRejectedValueOnce(new ApiError(0, "network_error", "Cannot reach the Sindri server"))
      .mockResolvedValue(withStatus("running"));
    renderWithStore(ui, api, { executionId: "e1" });
    await screen.findByRole("table", { name: "Tasks" });
    // A task event asks for fresh data; that request fails and nothing on screen changes.
    await act(async () => push(event("1", "task.completed")));
    expect(api.getExecution).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "Approve fs.write for implement-frontend" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
    // A replayed event is not listed twice; other event types do not trigger a refresh.
    await act(async () => push(event("1", "task.completed")));
    await act(async () => push(event("2", "agent.output")));
    const log = screen.getByRole("log", { name: "Events" });
    expect(
      within(log)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["2026-01-01T00:00:01Z task.completed", "2026-01-01T00:00:02Z agent.output"]);
    expect(api.getExecution).toHaveBeenCalledTimes(3);
    // The second task event's refresh succeeded: the run is shown as running, with no approvals.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Approve fs.write/ })).toBeNull(),
    );
    expect(screen.getByText("No gated actions are waiting.")).toBeTruthy();
  });

  it("keeps only the latest 200 events", async () => {
    let push: (m: ExecutionStreamMessage) => void = () => undefined;
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: (_id: string, on: (m: ExecutionStreamMessage) => void) => {
        push = on;
        return idleStream();
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await screen.findByRole("table", { name: "Tasks" });
    expect(screen.getByText("Waiting for events…")).toBeTruthy();
    act(() => {
      for (let i = 1; i <= 201; i++)
        push({
          kind: "event",
          data: {
            id: `x${i}`,
            mimirEventId: `m${i}`,
            type: `agent.line${i}`,
            payload: {},
            occurredAt: "t",
          },
        });
    });
    const items = within(screen.getByRole("log", { name: "Events" })).getAllByRole("listitem");
    expect(items).toHaveLength(200);
    expect(items[0]!.textContent).toBe("t agent.line2");
    expect(items[199]!.textContent).toBe("t agent.line201");
  });

  it("aborts the stream when another run is opened", async () => {
    const signals: AbortSignal[] = [];
    const other = { ...summary, id: "e2", status: "running" };
    const api = mockApi({
      listExecutions: [summary, other],
      getExecution: (id: string) =>
        Promise.resolve(
          id === "e1"
            ? executionDetail()
            : executionDetail({
                execution: {
                  ...executionDetail().execution,
                  id: "e2",
                  status: "running",
                  planVersion: 7,
                },
                approvals: [],
              }),
        ),
      streamExecution: (_id: string, _on: unknown, signal: AbortSignal) => {
        signals.push(signal);
        return idleStream();
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await screen.findByRole("heading", { name: "Run of plan v1" });
    await userEvent.click(screen.getByRole("button", { name: /e2/ }));
    expect(await screen.findByRole("heading", { name: "Run of plan v7" })).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toMatch(/^runs:e2:/);
    expect(screen.getByRole("button", { name: /e2/ }).getAttribute("aria-pressed")).toBe("true");
    expect(api.streamExecution).toHaveBeenLastCalledWith(
      "e2",
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
  });
});

describe("RunsScreen detail", () => {
  it("asks for a project first", () => {
    renderWithStore(<RunsScreen />, mockApi(), { projectId: null, projects: [] });
    expect(screen.getByText("Create or select a project first.")).toBeTruthy();
  });

  it("shows a run that could not be loaded as an error with retry", async () => {
    const api = mockApi({ listExecutions: [summary], streamExecution: idleStream });
    api.getExecution
      .mockRejectedValueOnce(new ApiError(404, "not_found", "execution not found"))
      .mockResolvedValue(executionDetail());
    renderWithStore(ui, api, { executionId: "e1" });
    const alert = await screen.findByText(/Could not load run: execution not found/);
    await userEvent.click(
      within(alert.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Retry" }),
    );
    expect(await screen.findByRole("table", { name: "Tasks" })).toBeTruthy();
  });

  it("rejects a gated action, and reports a decision the server refuses", async () => {
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: idleStream,
    });
    api.decideApproval
      .mockResolvedValueOnce({ approval: {} })
      .mockRejectedValueOnce(new ApiError(409, "invalid_state", "approval is already approved"));
    renderWithStore(ui, api, { executionId: "e1" });
    const reject = await screen.findByRole("button", {
      name: "Reject fs.write for implement-frontend",
    });
    await userEvent.click(reject);
    expect(api.decideApproval).toHaveBeenCalledWith("e1", "apr_1", "rejected");
    expect((await screen.findByRole("status")).textContent).toMatch(/Rejected fs.write/);
    await userEvent.click(
      screen.getByRole("button", { name: "Approve fs.write for implement-frontend" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/approval is already approved/);
    // The buttons work again after the failure.
    expect(
      screen.getByRole("button", { name: "Approve fs.write for implement-frontend" }),
    ).toHaveProperty("disabled", false);
  });

  it("unlocks approvals with the pairing code and enables the decisions", async () => {
    let unlocked = false;
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: idleStream,
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "local:me/web#aps_1", expiresAt: "" });
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    const approve = await screen.findByRole("button", {
      name: "Approve fs.write for implement-frontend",
    });
    expect(approve).toHaveProperty("disabled", true);
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    expect(api.unlockApprovals).toHaveBeenCalledWith("ABCDE-FGH23");
    await waitFor(() => expect(approve).toHaveProperty("disabled", false));
    expect(screen.queryByLabelText("Approval pairing code")).toBeNull();
  });

  it("describes mission-level approvals, passed gates, agent sessions without a link and several escalations", async () => {
    const base = executionDetail();
    const api = mockApi({
      listExecutions: [summary],
      streamExecution: idleStream,
      getExecution: executionDetail({
        approvals: [
          {
            ...base.approvals[0]!,
            id: "exa_2",
            mimirApprovalId: "apr_2",
            planTaskId: null,
            action: "pr.create",
            reason: null,
          },
          { ...base.approvals[0]!, id: "exa_3", disposition: "auto_rejected" },
          { ...base.approvals[0]!, id: "exa_4", status: "approved" },
        ],
        tasks: [
          { ...base.tasks[0]!, escalation: "ask", escalationReason: null, attempts: 3 },
          {
            ...base.tasks[0]!,
            id: "t2",
            planTaskId: "docs",
            escalation: "block",
            escalationReason: "no harness",
          },
          { ...base.tasks[0]!, id: "t3", planTaskId: "qa", status: "completed" },
        ],
        gates: [
          {
            planTaskId: "qa",
            passed: true,
            engineering: null,
            failures: [],
            evaluatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        links: {
          mission: null,
          agents: [{ planTaskId: "qa", sessionId: "ses_9", url: null }],
        },
        plan: null,
      }),
    });
    api.decideApproval.mockResolvedValue({ approval: {} });
    renderWithStore(ui, api, { executionId: "e1" });
    const table = await screen.findByRole("table", { name: "Tasks" });
    const rows = within(table)
      .getAllByRole("row")
      .map((r) => r.textContent);
    expect(rows[1]).toBe("implement-frontendblocked3ask: not evaluatedno session yet");
    expect(rows[2]).toBe("docsblocked0block: no harnessnot evaluatedno session yet");
    expect(rows[3]).toBe("qacompleted0nonepassedses_9");
    expect(screen.queryByRole("link", { name: /in Mimir/ })).toBeNull();
    expect(screen.getByRole("note", { name: "Tasks need a decision" }).textContent).toMatch(
      /2 tasks are escalated and waiting for your decision: implement-frontend, docs\./,
    );
    // Only the pending inbox approval is offered; it belongs to the mission and has no reason.
    expect(screen.getAllByRole("button", { name: /^Approve / })).toHaveLength(1);
    expect(screen.getByText("pr.create").parentElement?.textContent).toBe(
      "pr.create for the mission",
    );
    await userEvent.click(screen.getByRole("button", { name: "Reject pr.create for mission" }));
    expect(api.decideApproval).toHaveBeenCalledWith("e1", "apr_2", "rejected");
    await userEvent.click(screen.getByRole("button", { name: "Approve pr.create for mission" }));
    expect(api.decideApproval).toHaveBeenLastCalledWith("e1", "apr_2", "approved");
  });

  it("says escalations wait in Reviews when no gated action is pending", async () => {
    const base = executionDetail();
    const api = mockApi({
      listExecutions: [summary],
      streamExecution: idleStream,
      getExecution: executionDetail({
        approvals: [],
        tasks: [{ ...base.tasks[0]!, escalation: "ask", escalationReason: "flaky" }],
      }),
    });
    renderWithStore(ui, api, { executionId: "e1" });
    expect(
      await screen.findByText(
        "No gated actions are waiting, but escalated tasks need a decision in Reviews.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("note", { name: "Tasks need a decision" }).textContent).toMatch(
      /^A task is escalated/,
    );
    expect(screen.queryByLabelText("Approval pairing code")).toBeNull();
  });

  it.each([
    ["failed", "Run failed"],
    ["cancelled", "Run cancelled"],
    ["replan_requested", "Replan requested"],
  ] as const)("offers no plan link for a %s run whose plan is gone", async (status, name) => {
    const api = mockApi({
      listExecutions: [{ ...summary, status }],
      streamExecution: idleStream,
      getExecution: executionDetail({
        execution: { ...executionDetail().execution, status },
        approvals: [],
        plan: null,
      }),
    });
    renderWithStore(ui, api, { executionId: "e1" });
    const note = await screen.findByRole("note", { name });
    expect(note.textContent).toMatch(/will not continue/);
    expect(within(note).queryByRole("button", { name: "Open plan" })).toBeNull();
  });

  it("opens the delivery of a verified run", async () => {
    const api = mockApi({
      listExecutions: [{ ...summary, status: "delivered_pending_merge" }],
      getExecution: executionDetail({
        execution: { ...executionDetail().execution, status: "delivered_pending_merge" },
        approvals: [],
      }),
      streamExecution: idleStream,
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Open delivery" }));
    expect(screen.getByTestId("where").textContent).toMatch(/^deliveries:e1:e1:/);
  });
});

describe("RunsScreen refresh ordering", () => {
  /** getExecution calls after the first load, each answered when the test says. */
  const deferredRefreshes = () => {
    const pending: ((d: ReturnType<typeof executionDetail>) => void)[] = [];
    let first = true;
    const getExecution = () => {
      if (first) {
        first = false;
        return Promise.resolve(withStatus("running"));
      }
      return new Promise<ReturnType<typeof executionDetail>>((r) => pending.push(r));
    };
    return { pending, getExecution };
  };

  it("does not let an older refresh that answers late overwrite a newer one", async () => {
    let push: (m: ExecutionStreamMessage) => void = () => undefined;
    const { pending, getExecution } = deferredRefreshes();
    const api = mockApi({
      listExecutions: [summary],
      getExecution,
      streamExecution: (_id: string, on: (m: ExecutionStreamMessage) => void) => {
        push = on;
        return idleStream();
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    expect(await screen.findByRole("button", { name: "Cancel run" })).toBeTruthy();
    act(() => push({ kind: "notice", data: { type: "status", executionId: "e1" } }));
    act(() => push({ kind: "notice", data: { type: "status", executionId: "e1" } }));
    expect(pending).toHaveLength(2);
    // The second refresh answers first with the run verified; the first, older one then says
    // it is still running.
    await act(async () => pending[1]!(withStatus("verified_pending_review")));
    expect(screen.getByRole("button", { name: "Open delivery" })).toBeTruthy();
    await act(async () => pending[0]!(withStatus("running")));
    expect(screen.getByRole("button", { name: "Open delivery" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it("keeps a cancelled run cancelled when a refresh started before the cancel answers late", async () => {
    let push: (m: ExecutionStreamMessage) => void = () => undefined;
    const { pending, getExecution } = deferredRefreshes();
    const cancelled = executionDetail({
      execution: { ...executionDetail().execution, status: "cancelled" },
      approvals: [],
    });
    const api = mockApi({
      listExecutions: [summary],
      getExecution,
      cancelExecution: cancelled,
      streamExecution: (_id: string, on: (m: ExecutionStreamMessage) => void) => {
        push = on;
        return idleStream();
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    act(() => push({ kind: "notice", data: { type: "status", executionId: "e1" } }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(await screen.findByRole("note", { name: "Run cancelled" })).toBeTruthy();
    await act(async () => pending[0]!(withStatus("running")));
    expect(screen.getByRole("note", { name: "Run cancelled" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });
});
