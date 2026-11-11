import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { ExecutionStreamMessage } from "../api/delivery-types.js";
import { NoticeRegion } from "../components/Layout.js";
import { useStore } from "../store/context.js";
import { executionDetail } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { RunsScreen } from "./RunsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <RunsScreen />
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
/**
 * The reconnect tests run on a fake clock so they can say exactly when a retry happens. Testing
 * Library's `findBy`/`waitFor` wait on real timers, so those tests use `settle()` and `advance()`
 * with plain queries instead.
 */
const fakeReconnectTimer = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
/** Lets resolved requests and the renders they cause finish, without moving the clock. */
const settle = async () => {
  await advance(0);
  await advance(0);
};

afterEach(() => vi.useRealTimers());
/** Where the store says the app is, so a test can assert navigation. */
function Where() {
  const { state } = useStore();
  return <output data-testid="where">{`${state.view}:${state.planId ?? ""}`}</output>;
}
const withWhere = (
  <>
    {ui}
    <Where />
  </>
);

describe("RunsScreen", () => {
  it("shows an empty state", async () => {
    renderWithStore(ui, mockApi({ listExecutions: [] }));
    expect(await screen.findByText(/No runs yet/)).toBeTruthy();
  });

  it("shows task status, a deep link to the Mimir mission and pending approvals", async () => {
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: idleStream,
    });
    renderWithStore(ui, api, { executionId: "e1" });
    const link = await screen.findByRole("link", { name: /Open mission msn_1 in Mimir/ });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:7700/missions/msn_1");
    expect(link.getAttribute("rel")).toMatch(/noreferrer/);
    const table = screen.getByRole("table", { name: "Tasks" });
    expect(table.textContent).toMatch(/implement-frontend.*Blocked/);
    expect(
      screen.getByRole("button", { name: "Approve fs.write for implement-frontend" }),
    ).toBeTruthy();
  });

  it("sends a human approval decision and reloads", async () => {
    const decided = executionDetail({
      approvals: executionDetail().approvals.map((a) => ({ ...a, status: "approved" as const })),
    });
    let detail = executionDetail();
    const api = mockApi({
      listExecutions: [summary],
      getExecution: () => Promise.resolve(detail),
      streamExecution: idleStream,
      decideApproval: () => {
        detail = decided;
        return Promise.resolve({ approval: {} });
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve fs.write for implement-frontend" }),
    );
    expect(api.decideApproval).toHaveBeenCalledWith("e1", "apr_1", "approved");
    expect((await screen.findByRole("status")).textContent).toMatch(/Approved fs.write/);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Approve fs.write/ })).toBeNull(),
    );
  });

  it("keeps agent-action decisions disabled until approvals are unlocked (review I1)", async () => {
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: idleStream,
      hasApprovalSession: () => false,
    });
    renderWithStore(ui, api, { executionId: "e1" });
    const approve = await screen.findByRole("button", {
      name: "Approve fs.write for implement-frontend",
    });
    // Soft-disabled: still focusable, and the reason is announced and shown as a tooltip.
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(approve.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toMatch(/pairing code/);
    expect(
      screen
        .getByRole("button", { name: "Reject fs.write for implement-frontend" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(approve);
    expect(api.decideApproval).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Approval pairing code")).toBeTruthy();
  });

  it("applies live events from the stream", async () => {
    let push: ((m: ExecutionStreamMessage) => void) | undefined;
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: (_id: string, on: (m: ExecutionStreamMessage) => void) => {
        push = on;
        return new Promise<void>(() => undefined);
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await screen.findByRole("table", { name: "Tasks" });
    await waitFor(() => expect(push).toBeDefined());
    act(() =>
      push?.({
        kind: "event",
        data: {
          id: "exv_1",
          mimirEventId: "evt_1",
          type: "task.completed",
          payload: {},
          occurredAt: "2026-01-01T00:00:01Z",
        },
      }),
    );
    expect((await screen.findByRole("log", { name: "Events" })).textContent).toMatch(
      /task.completed/,
    );
  });

  it("offers the delivery once verified", async () => {
    const verified = executionDetail({
      execution: { ...executionDetail().execution, status: "verified_pending_review" },
      approvals: [],
    });
    const api = mockApi({
      listExecutions: [{ ...summary, status: "verified_pending_review" }],
      getExecution: verified,
      streamExecution: () => Promise.resolve(),
    });
    renderWithStore(ui, api, { executionId: "e1" });
    expect(await screen.findByRole("button", { name: "Open delivery" })).toBeTruthy();
  });

  it("shows each task's gate result", async () => {
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail({
        gates: [
          {
            planTaskId: "implement-frontend",
            passed: false,
            engineering: null,
            failures: [{ gateId: "brokkr", reason: "verification_report_missing" }],
            evaluatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
      streamExecution: idleStream,
    });
    renderWithStore(ui, api, { executionId: "e1" });
    const table = await screen.findByRole("table", { name: "Tasks" });
    expect(table.textContent).toMatch(/FailedVerification report missing/);
    expect(
      table.querySelector('[data-reason-code="brokkr verification_report_missing"]')?.textContent,
    ).toBe("Verification report missing");
  });

  it("says when live updates drop, reconnects, and stops on unmount (M4)", async () => {
    let push: ((m: ExecutionStreamMessage) => void) | undefined;
    const api = mockApi({ listExecutions: [summary], getExecution: executionDetail() });
    // The first stream ends at once (server restart); the second stays open.
    api.streamExecution
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce((_id: string, on: (m: ExecutionStreamMessage) => void) => {
        push = on;
        return new Promise<void>(() => undefined);
      });
    fakeReconnectTimer();
    const { unmount } = renderWithStore(ui, api, { executionId: "e1" });
    await settle();
    const note = screen.getByRole("note", { name: "Live updates" });
    expect(note.textContent).toMatch(/Live updates disconnected — retrying/);
    // The first retry waits one second, no less.
    await advance(999);
    expect(api.streamExecution).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.streamExecution).toHaveBeenCalledTimes(2);
    expect(push).toBeDefined();
    act(() => push?.({ kind: "notice", data: { type: "status", executionId: "e1" } }));
    await settle();
    expect(screen.queryByRole("note", { name: "Live updates" })).toBeNull();
    unmount();

    // A stream that errors is retried too, and unmounting cancels the pending retry.
    const failing = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: () => Promise.reject(new Error("network down")),
    });
    const second = renderWithStore(ui, failing, { executionId: "e1" });
    await settle();
    expect(screen.getByRole("note", { name: "Live updates" })).toBeTruthy();
    expect(failing.streamExecution).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(failing.streamExecution).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect or warn once the run is final", async () => {
    const verified = executionDetail({
      execution: { ...executionDetail().execution, status: "verified_pending_review" },
      approvals: [],
    });
    const api = mockApi({
      listExecutions: [{ ...summary, status: "verified_pending_review" }],
      getExecution: verified,
    });
    let end: () => void = () => undefined;
    api.streamExecution.mockImplementation(() => new Promise<void>((r) => (end = r)));
    fakeReconnectTimer();
    renderWithStore(ui, api, { executionId: "e1" });
    await settle();
    expect(screen.getByRole("button", { name: "Open delivery" })).toBeTruthy();
    await act(async () => end());
    // No retry is even scheduled, however long the screen stays open.
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(api.streamExecution).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("note", { name: "Live updates" })).toBeNull();
  });

  it("points to Reviews when a task is escalated (M8)", async () => {
    const api = mockApi({
      listExecutions: [{ ...summary, status: "blocked" }],
      getExecution: executionDetail({
        execution: { ...executionDetail().execution, status: "blocked" },
        approvals: [],
        tasks: executionDetail().tasks.map((t) => ({
          ...t,
          escalation: "ask" as const,
          escalationReason: "tests keep failing",
        })),
      }),
      streamExecution: idleStream,
    });
    renderWithStore(withWhere, api, { executionId: "e1" });
    const note = await screen.findByRole("note", { name: "Tasks need a decision" });
    expect(note.textContent).toMatch(/implement-frontend/);
    expect(screen.queryByText("No gated actions are waiting.")).toBeNull();
    await userEvent.click(within(note).getByRole("button", { name: "Open Needs you" }));
    expect(screen.getByTestId("where").textContent).toBe("needs-you:");
  });

  it("explains a replan request and opens the plan to revise (H2)", async () => {
    const api = mockApi({
      listExecutions: [{ ...summary, status: "replan_requested" }],
      getExecution: executionDetail({
        execution: { ...executionDetail().execution, status: "replan_requested" },
        approvals: [],
      }),
      streamExecution: idleStream,
    });
    renderWithStore(withWhere, api, { executionId: "e1" });
    const note = await screen.findByRole("note", { name: "Replan requested" });
    expect(note.textContent).toMatch(/This run will not continue/);
    expect(note.textContent).toMatch(/Revise the plan/);
    await userEvent.click(within(note).getByRole("button", { name: "Open plan" }));
    expect(screen.getByTestId("where").textContent).toBe("plans:pl1");
  });

  it("cancels a run after a confirm step, with the reason", async () => {
    const cancelled = executionDetail({
      execution: { ...executionDetail().execution, status: "cancelled" },
      approvals: [],
    });
    let runs = [summary];
    const api = mockApi({
      listExecutions: () => Promise.resolve(runs),
      getExecution: executionDetail(),
      streamExecution: idleStream,
      cancelExecution: () => {
        runs = [{ ...summary, status: "cancelled" }];
        return Promise.resolve(cancelled);
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    expect(api.cancelExecution).not.toHaveBeenCalled();
    // Backing out leaves the run alone.
    await userEvent.click(screen.getByRole("button", { name: "Keep running" }));
    expect(screen.queryByRole("button", { name: "Confirm cancel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await userEvent.type(screen.getByLabelText("Reason (optional)"), " wrong plan ");
    await userEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(api.cancelExecution).toHaveBeenCalledWith("e1", "wrong plan");
    const note = await screen.findByRole("note", { name: "Run cancelled" });
    expect(note.textContent).toMatch(/was cancelled and will not continue/);
    expect(screen.getByRole("status").textContent).toMatch(/Run cancelled/);
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    // The list is reloaded, so it shows the new status too.
    const item = await screen.findByRole("button", { name: /Run 1 · Plan v1/, pressed: true });
    await waitFor(() => expect(item.textContent).toMatch(/Cancelled/));
  });

  it("sends no reason when none is given, and reports a refused cancel", async () => {
    const verified = executionDetail({
      execution: { ...executionDetail().execution, status: "verified_pending_review" },
      approvals: [],
    });
    let detail = executionDetail();
    const api = mockApi({
      listExecutions: [summary],
      getExecution: () => Promise.resolve(detail),
      streamExecution: idleStream,
      cancelExecution: () => {
        detail = verified;
        return Promise.reject(
          new ApiError(409, "invalid_state", "the execution has finished; nothing to cancel"),
        );
      },
    });
    renderWithStore(ui, api, { executionId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel run" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    expect(api.cancelExecution).toHaveBeenCalledWith("e1", undefined);
    expect((await screen.findByRole("alert")).textContent).toMatch(/nothing to cancel/);
    // The run is shown as it now is, and can no longer be cancelled.
    await screen.findByRole("button", { name: "Open delivery" });
    expect(screen.queryByRole("button", { name: "Confirm cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
  });

  it.each(["failed", "cancelled", "verified_pending_review"])(
    "offers no cancel for a run that is %s",
    async (status) => {
      const api = mockApi({
        listExecutions: [{ ...summary, status }],
        getExecution: executionDetail({
          execution: { ...executionDetail().execution, status: status as "failed" },
          approvals: [],
        }),
        streamExecution: idleStream,
      });
      renderWithStore(ui, api, { executionId: "e1" });
      await screen.findByRole("table", { name: "Tasks" });
      expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    },
  );

  it("can cancel a run that is waiting for a replan", async () => {
    const api = mockApi({
      listExecutions: [{ ...summary, status: "replan_requested" }],
      getExecution: executionDetail({
        execution: { ...executionDetail().execution, status: "replan_requested" },
        approvals: [],
      }),
      streamExecution: idleStream,
    });
    renderWithStore(ui, api, { executionId: "e1" });
    expect(await screen.findByRole("button", { name: "Cancel run" })).toBeTruthy();
  });

  it("says a failed run will not continue, and treats it as final", async () => {
    const api = mockApi({
      listExecutions: [{ ...summary, status: "failed" }],
      getExecution: executionDetail({
        execution: { ...executionDetail().execution, status: "failed" },
        approvals: [],
      }),
    });
    let end: () => void = () => undefined;
    api.streamExecution.mockImplementation(() => new Promise<void>((r) => (end = r)));
    fakeReconnectTimer();
    renderWithStore(withWhere, api, { executionId: "e1" });
    await settle();
    const note = screen.getByRole("note", { name: "Run failed" });
    expect(note.textContent).toBe(
      "This run failed and will not continue. Revise the plan or execute it again.Open plan",
    );
    // Final: a closed stream is not reopened and no disconnect warning appears.
    await act(async () => end());
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(api.streamExecution).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("note", { name: "Live updates" })).toBeNull();
    vi.useRealTimers();
    await userEvent.click(within(note).getByRole("button", { name: "Open plan" }));
    expect(screen.getByTestId("where").textContent).toBe("plans:pl1");
  });
});

describe("RunsScreen layout", () => {
  it("names runs by number and plan, and opens the most recent from the empty detail", async () => {
    const older = { ...summary, id: "e0", createdAt: "2025-12-01T00:00:00Z", status: "cancelled" };
    const api = mockApi({
      listExecutions: [older, summary],
      getExecution: executionDetail(),
      streamExecution: idleStream,
    });
    renderWithStore(withWhere, api);
    expect(await screen.findByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Run 2 · Plan v1.*Needs you/),
      expect.stringMatching(/^Run 1 · Plan v1.*Cancelled/),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Open the most recent run" }));
    expect(await screen.findByRole("heading", { name: "Run 2 · Plan v1" })).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("runs:");
  });

  it("explains task columns with glossary hints", async () => {
    const api = mockApi({
      listExecutions: [summary],
      getExecution: executionDetail(),
      streamExecution: idleStream,
    });
    renderWithStore(ui, api, { executionId: "e1" });
    // jsdom has no ResizeObserver; the hint's popover positioning needs one.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const table = await screen.findByRole("table", { name: "Tasks" });
    await userEvent.click(within(table).getByRole("button", { name: "What is Failed attempts?" }));
    expect((await screen.findByRole("dialog")).textContent).toMatch(/attempt/i);
    vi.unstubAllGlobals();
  });

  it("offers the plans screen when there are no runs", async () => {
    renderWithStore(withWhere, mockApi({ listExecutions: [] }));
    await userEvent.click(await screen.findByRole("button", { name: "Open Plans" }));
    expect(screen.getByTestId("where").textContent).toBe("plans:");
  });
});
