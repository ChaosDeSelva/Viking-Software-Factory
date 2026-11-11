import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NoticeRegion } from "../components/Layout.js";
import { useStore } from "../store/context.js";
import { executionDetail, inbox } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { ReviewsScreen } from "./ReviewsScreen.js";

function Where() {
  const { state } = useStore();
  return <output data-testid="where">{`${state.view}:${state.executionId ?? ""}`}</output>;
}
const ui = (
  <>
    <NoticeRegion />
    <ReviewsScreen />
    <Where />
  </>
);
const approval = executionDetail().approvals[0]!;
const missionApproval = {
  ...approval,
  id: "exa_2",
  mimirApprovalId: "apr_2",
  planTaskId: null,
  action: "net.fetch",
  reason: null,
};

describe("ReviewsScreen approvals", () => {
  it("rejects a gated action, names mission-level ones, and opens the run", async () => {
    const api = mockApi({
      reviews: inbox({ approvals: [approval, missionApproval] }),
      decideApproval: { approval: {} },
    });
    renderWithStore(ui, api, { view: "reviews" });
    const card = (await screen.findByRole("heading", { name: "Approvals awaiting you" }))
      .parentElement!;
    const items = within(card).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("fs.write for implement-frontend: write export.ts");
    expect(items[1]!.textContent).toMatch(/^net\.fetch for the mission(Approve|$)/);
    await userEvent.click(screen.getByRole("button", { name: "Reject net.fetch for mission" }));
    expect(api.decideApproval).toHaveBeenCalledWith("e1", "apr_2", "rejected");
    expect(await screen.findByText("Rejected net.fetch")).toBeTruthy();
    await waitFor(() => expect(api.reviews).toHaveBeenCalledTimes(2));
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve fs.write for implement-frontend" }),
    );
    expect(api.decideApproval).toHaveBeenLastCalledWith("e1", "apr_1", "approved");
    expect(await screen.findByText("Approved fs.write")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Open run for fs.write" }));
    expect(screen.getByTestId("where").textContent).toBe("runs:e1");
  });

  it("enables the decisions once approvals are unlocked here", async () => {
    let unlocked = false;
    const api = mockApi({
      reviews: inbox({ approvals: [approval] }),
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "p", expiresAt: "" });
      },
    });
    renderWithStore(ui, api);
    const approve = await screen.findByRole("button", {
      name: "Approve fs.write for implement-frontend",
    });
    expect(approve).toHaveProperty("disabled", true);
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await waitFor(() => expect(approve).toHaveProperty("disabled", false));
  });
});

describe("ReviewsScreen inbox content", () => {
  it("lists budget alerts, escalations without a reason and findings of every shape", async () => {
    const api = mockApi({
      reviews: inbox({
        escalations: [
          {
            executionId: "e1",
            planTaskId: "qa",
            escalation: "block",
            reason: null,
            status: "failed",
            attempts: 3,
          },
        ],
        budgetAlerts: [
          { id: "b1", executionId: "e1", planTaskId: "qa", detail: {} },
          { id: "b2", executionId: "e1", planTaskId: null, detail: {} },
        ],
        findings: [
          {
            executionId: "e1",
            reviewId: "r1",
            planTaskId: "qa",
            role: "security",
            verdict: "approve",
            severity: "low",
            message: "fine",
            file: "src/a.ts",
            line: 7,
          },
          {
            executionId: "e1",
            reviewId: "r2",
            planTaskId: "qa",
            role: "qa",
            verdict: "request_changes",
            severity: "high",
            message: "broken",
            file: "src/b.ts",
          },
          {
            executionId: "e1",
            reviewId: "r3",
            planTaskId: "qa",
            role: "docs",
            verdict: null,
            severity: "info",
            message: "later",
          },
        ],
      }),
    });
    renderWithStore(ui, api);
    const alerts = await screen.findByRole("list", { name: "Budget alerts" });
    expect(
      within(alerts)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["budget exceeded qa", "budget exceeded mission"]);
    expect(screen.getByText(/after 3 failed attempt\(s\)$/)).toBeTruthy();
    const findings = screen.getByRole("heading", { name: "Reviewer findings" }).parentElement!;
    expect(
      within(findings)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "approve low security review of qa: fine (src/a.ts:7)",
      "request_changes high qa review of qa: broken (src/b.ts)",
      "pending info docs review of qa: later",
    ]);
    expect(screen.getByText("No gate failures.")).toBeTruthy();
  });
});
