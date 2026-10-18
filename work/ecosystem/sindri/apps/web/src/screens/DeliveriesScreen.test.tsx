import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { delivery, trace } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { DeliveriesScreen } from "./DeliveriesScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <DeliveriesScreen />
  </>
);
const summary = {
  id: "e1",
  executionId: "e1",
  planId: "pl1",
  planVersion: 1,
  projectId: "p1",
  status: "verified_pending_review",
  mimirMissionId: "msn_1",
  createdAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
};

describe("DeliveriesScreen", () => {
  it("shows and approves the local export gate without needing a GitHub workflow", async () => {
    const request = {
      deliveryId: "d1",
      status: "built",
      prs: [
        { planTaskId: "docs", mimirTaskId: "t1", status: "awaiting_approval", approvalId: "a1" },
      ],
    };
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      deliveryTrace: trace(),
      localDelivery: null,
      requestPr: request,
      decideApproval: {},
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Export local result" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve local export: docs" }),
    );
    expect(api.decideApproval).toHaveBeenCalledWith(
      "e1",
      "a1",
      "approved",
      "Approve verified local export",
    );
  });

  it("shows an empty state", async () => {
    renderWithStore(ui, mockApi({ listDeliveries: [] }));
    expect(await screen.findByText(/No deliveries yet/)).toBeTruthy();
  });

  it("shows the report, PR text with a copy button and the trace tree", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    const report = await screen.findByRole("region", { name: "Delivery report" });
    expect(report.textContent).toMatch(/AC1/);
    expect(report.textContent).toMatch(/pnpm test/);
    expect(report.textContent).toMatch(/unverified/);
    expect(report.textContent).toMatch(/verification_report_missing/);
    expect(report.textContent).toMatch(/\[ref:evt_8\]/);
    expect(screen.getByLabelText("Delivery description").textContent).toMatch(/## Requirements/);
    await userEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    expect(writeText).toHaveBeenCalledWith(delivery().prDescription);
    expect((await screen.findByRole("status")).textContent).toMatch(/copied/i);
    const tree = await screen.findByRole("list", { name: "Trace" });
    expect(within(tree).getByText(/Mimir mission msn_1/)).toBeTruthy();
    expect(within(tree).getByText(/test.output/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export local result" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("reports a refused PR request", async () => {
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      requestPr: () =>
        Promise.reject(
          new ApiError(
            409,
            "invalid_state",
            "quality gates have not passed for: implement-frontend",
          ),
        ),
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    await userEvent.click(await screen.findByRole("button", { name: "Export local result" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/quality gates have not passed/);
  });

  it("keeps Export local result disabled until approvals are unlocked (audit M9)", async () => {
    const api = mockApi({
      listDeliveries: [summary],
      getDelivery: delivery(),
      localDelivery: null,
      deliveryTrace: trace(),
      hasApprovalSession: () => false,
    });
    renderWithStore(ui, api, { deliveryId: "e1" });
    const button = await screen.findByRole("button", { name: "Export local result" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Approval pairing code")).toBeTruthy();
  });
});
