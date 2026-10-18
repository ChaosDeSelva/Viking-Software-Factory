import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ExecutionStreamMessage } from "../api/delivery-types.js";
import { NoticeRegion } from "../components/Layout.js";
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
    expect(table.textContent).toMatch(/implement-frontend.*blocked/);
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
    expect(approve.hasAttribute("disabled")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Reject fs.write for implement-frontend" })
        .hasAttribute("disabled"),
    ).toBe(true);
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
    expect(table.textContent).toMatch(/failed: brokkr verification_report_missing/);
  });
});
