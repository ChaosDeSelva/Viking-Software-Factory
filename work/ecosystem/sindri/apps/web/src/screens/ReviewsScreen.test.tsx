import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NoticeRegion } from "../components/Layout.js";
import { executionDetail, inbox } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { ReviewsScreen } from "./ReviewsScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <ReviewsScreen />
  </>
);

describe("ReviewsScreen", () => {
  it("shows empty sections and explains where gate results come from", async () => {
    renderWithStore(ui, mockApi({ reviews: inbox() }));
    expect(await screen.findByText(/Nothing is waiting for your approval/)).toBeTruthy();
    expect(screen.getByText(/No gate failures/)).toBeTruthy();
    expect(screen.getByText(/No reviewer findings/)).toBeTruthy();
    expect(screen.getByText(/No escalations/)).toBeTruthy();
    expect(screen.getByText(/Brokkr/)).toBeTruthy();
  });

  it("decides approvals and resolves escalations", async () => {
    const api = mockApi({
      reviews: inbox({
        approvals: executionDetail().approvals,
        escalations: [
          {
            executionId: "e1",
            planTaskId: "qa",
            escalation: "ask",
            reason: "failed twice",
            status: "failed",
            attempts: 2,
          },
        ],
        gateFailures: [
          {
            executionId: "e1",
            planTaskId: "docs",
            gateId: "brokkr",
            reason: "verification_report_missing",
            evaluatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        findings: [
          {
            executionId: "e1",
            reviewId: "rev_1",
            planTaskId: "implement-frontend",
            role: "reviewer",
            verdict: "request_changes",
            severity: "major",
            message: "Missing header row",
          },
        ],
      }),
      decideApproval: { approval: {} },
      resolveEscalation: executionDetail(),
    });
    renderWithStore(ui, api);
    await userEvent.click(
      await screen.findByRole("button", { name: "Reject fs.write for implement-frontend" }),
    );
    expect(api.decideApproval).toHaveBeenCalledWith("e1", "apr_1", "rejected");
    // A reason is required before deciding an escalation.
    expect(screen.getByRole("button", { name: "Retry qa" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason for qa"), "runner was flaky");
    await userEvent.click(screen.getByRole("button", { name: "Retry qa" }));
    expect(api.resolveEscalation).toHaveBeenCalledWith("e1", "qa", "retry", "runner was flaky");
    expect(screen.getByText(/verification_report_missing/)).toBeTruthy();
    expect(screen.getByText(/Missing header row/)).toBeTruthy();
  });
});
