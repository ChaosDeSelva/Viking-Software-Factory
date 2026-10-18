import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { plan, versionOf } from "../test/delivery-fixtures.js";
import { spec } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { PlansScreen } from "./PlansScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <PlansScreen />
  </>
);
const dry = {
  steps: [
    { step: 1, tasks: [{ id: "implement-frontend", role: "implementer" }] },
    { step: 2, tasks: [{ id: "docs", role: "docs" }] },
  ],
  order: ["implement-frontend", "docs"],
};
const detail = (p = plan()) => ({ plan: p, versions: [versionOf(p)] });

describe("PlansScreen", () => {
  it("saves edited budgets as a new draft instead of modifying an approved run", async () => {
    const current = plan();
    const next = plan({ id: "pl2", version: 2 });
    const api = mockApi({
      listPlans: [current],
      listSpecs: [],
      getPlan: detail(current),
      dryRunPlan: dry,
      revisePlan: next,
    });
    renderWithStore(ui, api, { planId: "pl1" });
    const tokens = await screen.findByLabelText("implement-frontend: tokens");
    await userEvent.clear(tokens);
    await userEvent.type(tokens, "500000");
    await userEvent.click(screen.getByRole("button", { name: "Save budgets as new draft" }));
    expect(api.revisePlan).toHaveBeenCalledWith(
      "pl1",
      expect.arrayContaining([
        expect.objectContaining({
          id: "implement-frontend",
          budget: expect.objectContaining({ tokens: 500000 }),
        }),
      ]),
    );
  });

  it("asks for a project first", () => {
    renderWithStore(<PlansScreen />, mockApi(), { projectId: null, projects: [] });
    expect(screen.getByText(/select a project/i)).toBeTruthy();
  });

  it("shows an empty state and proposes a plan from an approved spec", async () => {
    const p = plan();
    const api = mockApi({
      listPlans: [],
      listSpecs: [spec({ status: "approved", version: 2, id: "s2" }), spec({ id: "s1" })],
      proposePlan: { plan: p, versions: [versionOf(p)], harnessSource: "fake" },
      getPlan: detail(p),
      dryRunPlan: dry,
    });
    renderWithStore(ui, api);
    expect(await screen.findByText(/No plans yet/)).toBeTruthy();
    const select = screen.getByLabelText("Approved spec");
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Propose plan" }));
    expect(api.proposePlan).toHaveBeenCalledWith("s2");
    expect((await screen.findByRole("status")).textContent).toMatch(/Proposed plan v1/);
    expect(await screen.findByRole("heading", { name: /Plan v1/ })).toBeTruthy();
  });

  it("shows the DAG, harness choice with why-this-harness, and the dry-run order", async () => {
    const api = mockApi({ listPlans: [plan()], listSpecs: [], getPlan: detail(), dryRunPlan: dry });
    renderWithStore(ui, api, { planId: "pl1" });
    const task = await screen.findByRole("article", { name: "Task implement-frontend" });
    expect(task.textContent).toMatch(/frontend-react@1\.1\.0/);
    expect(within(task).getByText("Why this harness")).toBeTruthy();
    expect(task.textContent).toMatch(/task types frontend match/);
    const docs = screen.getByRole("article", { name: "Task docs" });
    expect(docs.textContent).toMatch(/after implement-frontend/);
    const order = await screen.findByRole("list", { name: "Dry-run order" });
    expect(order.textContent).toMatch(/Step 1.*implement-frontend.*Step 2.*docs/);
  });

  it("submits, approves and then executes a plan", async () => {
    const draft = plan();
    const review = plan({ status: "review" });
    const approved = plan({ status: "approved", approvedBy: "user" });
    let current = draft;
    const api = mockApi({
      listPlans: () => Promise.resolve([current]),
      listSpecs: [],
      getPlan: () => Promise.resolve(detail(current)),
      dryRunPlan: dry,
      submitPlan: () => Promise.resolve((current = review)),
      approvePlan: () => Promise.resolve((current = approved)),
      createExecution: { execution: { id: "e1" } },
    });
    renderWithStore(ui, api, { planId: "pl1" });
    await userEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve plan" }));
    expect(api.approvePlan).toHaveBeenCalledWith("pl1");
    await userEvent.click(await screen.findByRole("button", { name: "Execute plan" }));
    expect(api.createExecution).toHaveBeenCalledWith("pl1");
  });

  it("explains when Mimir is not configured", async () => {
    const approved = plan({ status: "approved" });
    const api = mockApi({
      listPlans: [approved],
      listSpecs: [],
      getPlan: detail(approved),
      dryRunPlan: dry,
      createExecution: () =>
        Promise.reject(new ApiError(503, "mimir_unavailable", "Mimir is not configured")),
    });
    renderWithStore(ui, api, { planId: "pl1" });
    await userEvent.click(await screen.findByRole("button", { name: "Execute plan" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Mimir is not configured/),
    );
  });

  it("shows an error state with retry", async () => {
    let fail = true;
    const api = mockApi({
      listPlans: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve([])),
      listSpecs: [],
    });
    renderWithStore(ui, api);
    expect(await screen.findByText(/Could not load plans: boom/)).toBeTruthy();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No plans yet/)).toBeTruthy();
  });

  it("keeps Approve plan disabled until approvals are unlocked (audit M9)", async () => {
    const review = plan({ status: "review" });
    let unlocked = false;
    const api = mockApi({
      listPlans: [review],
      listSpecs: [],
      getPlan: detail(review),
      dryRunPlan: dry,
      approvePlan: plan({ status: "approved" }),
      hasApprovalSession: () => unlocked,
      unlockApprovals: () => {
        unlocked = true;
        return Promise.resolve({ principal: "p", expiresAt: "x" });
      },
    });
    renderWithStore(ui, api, { planId: "pl1" });
    const button = (await screen.findByRole("button", {
      name: "Approve plan",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve plan" }));
    expect(api.approvePlan).toHaveBeenCalledWith("pl1");
  });
});
