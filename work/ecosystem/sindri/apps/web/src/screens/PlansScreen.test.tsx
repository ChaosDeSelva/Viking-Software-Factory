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
/** The plan detail is split into tabs; Tasks is open first. */
const openTab = async (name: RegExp) => userEvent.click(await screen.findByRole("tab", { name }));

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
    await openTab(/Task budgets/);
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
    await openTab(/Dry-run order/);
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
    expect(api.approvePlan).toHaveBeenCalledWith("pl1", {});
    await userEvent.click(await screen.findByRole("button", { name: "Execute plan" }));
    expect(api.createExecution).toHaveBeenCalledWith("pl1");
  });

  it("a plan with flagged instructions warns and needs the reviewer to confirm before approving", async () => {
    const review = plan({
      status: "review",
      untrustedInstructionDetected: true,
      injectionFindings: [{ source: "lesson:acme/demo-app#1", patternId: "ignore-previous" }],
    });
    const api = mockApi({
      listPlans: [review],
      listSpecs: [],
      getPlan: () => Promise.resolve(detail(review)),
      dryRunPlan: dry,
      approvePlan: plan({ status: "approved" }),
    });
    renderWithStore(ui, api, { planId: "pl1" });
    const note = await screen.findByRole("note", { name: "Untrusted instructions detected" });
    expect(note.textContent).toMatch(/lesson:acme\/demo-app#1/);
    const approve = screen.getByRole("button", { name: /^Approve plan/ });
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(
      screen.getByRole("checkbox", { name: /I reviewed the flagged instructions/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Approve plan/ }));
    expect(api.approvePlan).toHaveBeenCalledWith("pl1", { acknowledgeUntrusted: true });
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
    const button = await screen.findByRole("button", { name: /^Approve plan/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.textContent).toMatch(/pairing code/);
    await userEvent.type(screen.getByLabelText("Approval pairing code"), "ABCDE-FGH23");
    await userEvent.click(screen.getByRole("button", { name: "Unlock approvals" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve plan" }));
    expect(api.approvePlan).toHaveBeenCalledWith("pl1", {});
  });

  it("sends an emptied token budget as unset and confirms the save (L2)", async () => {
    const current = plan({
      tasks: plan().tasks.map((t) => ({ ...t, budget: { ...t.budget, tokens: 1000 } })),
    });
    const next = plan({ id: "pl2", version: 2 });
    const api = mockApi({
      listPlans: [current],
      listSpecs: [],
      getPlan: detail(current),
      dryRunPlan: dry,
      revisePlan: next,
    });
    renderWithStore(ui, api, { planId: "pl1" });
    await openTab(/Task budgets/);
    const tokens = (await screen.findByLabelText("implement-frontend: tokens")) as HTMLInputElement;
    expect(tokens.value).toBe("1000");
    // The server sets no upper limit, so the form does not either.
    expect(tokens.hasAttribute("max")).toBe(false);
    expect(screen.getByLabelText("implement-frontend: minutes").hasAttribute("max")).toBe(false);
    await userEvent.clear(tokens);
    await userEvent.click(screen.getByRole("button", { name: "Save budgets as new draft" }));
    const sent = (api.revisePlan.mock.calls[0] as [string, { id: string; budget: object }[]])[1];
    const task = sent.find((t) => t.id === "implement-frontend");
    expect(task?.budget).toEqual({ wallClockMinutes: 90 });
    expect("tokens" in (task?.budget ?? {})).toBe(false);
    expect(await screen.findByText(/Saved budgets as draft plan v2/)).toBeTruthy();
  });

  it("offers no submit, approve or budget save on a version that is not the latest", async () => {
    // Saving budgets makes v2 a draft and leaves v1 in review; the server acts on the latest only.
    const v1 = plan({ status: "review" });
    const v2 = plan({ id: "pl2", version: 2, status: "draft" });
    const api = mockApi({
      listPlans: [v1, v2],
      listSpecs: [],
      getPlan: { plan: v1, versions: [versionOf(v1), versionOf(v2)] },
      dryRunPlan: dry,
    });
    renderWithStore(ui, api, { planId: "pl1" });
    await screen.findByRole("heading", { name: "Plan v1" });
    expect(screen.queryByRole("button", { name: /^Approve plan/ })).toBeNull();
    const note = screen.getByRole("note", { name: "Not the latest version" });
    expect(within(note).getByRole("button", { name: "Open v2" })).toBeTruthy();
    await openTab(/Task budgets/);
    const save = screen.getByRole("button", { name: /^Save budgets as new draft/ });
    expect(save.getAttribute("aria-disabled")).toBe("true");
  });

  it.each([
    ["review", /^Approve plan/],
    ["approved", /^Execute plan/],
  ] as const)(
    "does not offer the next step on a %s plan whose spec was replaced",
    async (status, name) => {
      const p = plan({ status });
      const api = mockApi({
        listPlans: [p],
        listSpecs: [spec({ id: "s1", version: 2, status: "superseded" })],
        getPlan: detail(p),
        dryRunPlan: dry,
      });
      renderWithStore(ui, api, { planId: "pl1" });
      const button = await screen.findByRole("button", { name });
      await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
      expect(button.textContent).toMatch(/spec v2 is now superseded/);
      await userEvent.click(button);
      expect(api.approvePlan).not.toHaveBeenCalled();
      expect(api.createExecution).not.toHaveBeenCalled();
    },
  );

  it("says a run is starting while Execute plan is in flight (M9)", async () => {
    const approved = plan({ status: "approved" });
    const api = mockApi({
      listPlans: [approved],
      listSpecs: [],
      getPlan: detail(approved),
      dryRunPlan: dry,
      createExecution: () => new Promise(() => undefined),
    });
    renderWithStore(ui, api, { planId: "pl1" });
    await userEvent.click(await screen.findByRole("button", { name: "Execute plan" }));
    expect(screen.getByRole("button", { name: "Starting run…" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});

describe("PlansScreen layout", () => {
  it("names plans by their spec and opens the newest from the empty detail", async () => {
    const p = plan();
    const api = mockApi({
      listPlans: [p],
      listSpecs: [spec({ id: "s1", status: "approved" })],
      getPlan: detail(p),
      dryRunPlan: dry,
    });
    renderWithStore(ui, api);
    const row = await screen.findByRole("button", { name: /Plan v1 for spec v2/ });
    expect(row.textContent).toMatch(/^CSV export for reports/);
    await userEvent.click(screen.getByRole("button", { name: "Open the newest plan" }));
    expect(await screen.findByRole("heading", { name: "Plan v1" })).toBeTruthy();
    // Tasks open first; the other sections are one tab away.
    expect(screen.getByRole("tab", { name: /Tasks/ }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "Task budgets" }));
    expect(await screen.findByLabelText("docs: minutes")).toBeTruthy();
  });
});
