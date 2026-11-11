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
    renderWithStore(ui, api, { view: "needs-you" });
    const card = await screen.findByRole("region", { name: /^Approvals awaiting you/ });
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
    const name = "Approve fs.write for implement-frontend";
    const approve = await screen.findByRole("button", { name });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    // The lock reason is announced as the button's description.
    const reason = document.getElementById(approve.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBeTruthy();
    await userEvent.click(approve);
    expect(api.decideApproval).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name }).getAttribute("aria-disabled")).toBeNull(),
    );
    expect(screen.getByRole("button", { name })).toHaveProperty("disabled", false);
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
    const blocks = within(alerts).getAllByRole("listitem");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.textContent).toMatch(/^Budget used up: qa/);
    expect(blocks[1]!.textContent).toMatch(/^Budget used up: the mission/);
    for (const b of blocks) {
      expect(b.textContent).toContain("Budget exceeded");
      expect(b.textContent).toContain("Mimir has not reported the numbers yet");
    }
    expect(screen.getByText(/after 3 failed attempt\(s\)/)).toBeTruthy();
    const findings = screen.getByRole("region", { name: /^Reviewer findings/ });
    const rows = within(findings).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      "Approvelowfinesecurity review of qa (src/a.ts:7)",
      expect.stringMatching(/^Request changes.*broken.*qa review of qa \(src\/b\.ts\)$/),
      "PendingInfolaterdocs review of qa",
    ]);
    expect(screen.getByText("No gate failures.")).toBeTruthy();
  });

  it("shows a budget block's numbers and links to Mimir's crew page and Heimdall", async () => {
    const api = mockApi({
      reviews: inbox({
        budgetAlerts: [
          {
            id: "b1",
            executionId: "e1",
            planTaskId: "qa",
            detail: {
              reason: "budget_exceeded",
              used: 120,
              limit: 100,
              unit: "tokens",
              crewId: "crew_1",
              budgetId: "bud_1",
            },
          },
          { id: "b2", executionId: "e1", planTaskId: null, detail: { used: "lots" } },
        ],
      }),
    });
    renderWithStore(ui, api);
    const alerts = await screen.findByRole("list", { name: "Budget alerts" });
    const [withNumbers, without] = within(alerts).getAllByRole("listitem");
    // "Used: 120 of 100 tokens" as a label/value pair.
    expect(within(withNumbers!).getByText("Used")).toBeTruthy();
    expect(within(withNumbers!).getByText("120 of 100 tokens")).toBeTruthy();
    expect(within(withNumbers!).getByRole("progressbar")).toBeTruthy();
    expect(withNumbers!.textContent).toContain("bud_1");
    const mimir = within(withNumbers!).getByRole("link", { name: "Raise it in Mimir" });
    expect(mimir.getAttribute("href")).toMatch(/\/crews\/crew_1$/);
    const heimdall = within(withNumbers!).getByRole("link", { name: "See it in Heimdall" });
    expect(heimdall.getAttribute("href")).toMatch(/[?&]project=p1(&|$)/);
    for (const a of [mimir, heimdall]) expect(a.getAttribute("rel")).toContain("noopener");
    // Odd numbers are left out: no progress bar, and Mimir's home instead of a crew page.
    expect(within(without!).queryByRole("progressbar")).toBeNull();
    expect(
      within(without!).getByRole("link", { name: "Raise it in Mimir" }).getAttribute("href"),
    ).not.toContain("/crews/");
  });
});
