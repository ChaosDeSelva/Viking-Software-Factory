import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ExecutionSummary } from "../api/delivery-types.js";
import { useStore } from "../store/context.js";
import { executionDetail, inbox, plan } from "../test/delivery-fixtures.js";
import { intake, spec } from "../test/fixtures.js";
import { decision } from "../test/steward-fixtures.js";
import { mockApi, renderWithStore, type MockApi } from "../test/utils.js";
import { OverviewScreen, suggestedQuestions } from "./OverviewScreen.js";

function Where() {
  const { state } = useStore();
  return <output data-testid="where">{state.view}</output>;
}
const ui = (
  <>
    <OverviewScreen />
    <Where />
  </>
);

const run = (over: Partial<ExecutionSummary> = {}): ExecutionSummary =>
  ({ ...executionDetail().execution, ...over }) as ExecutionSummary;

function api(over: Parameters<typeof mockApi>[0] = {}): MockApi {
  return mockApi({
    listIntakes: [intake(), intake({ id: "i2" })],
    listSpecs: [spec({ status: "review" }), spec({ id: "s2", status: "approved" })],
    listPlans: [plan({ status: "review" }), plan({ id: "pl2", status: "approved" })],
    listExecutions: [
      run({ id: "e1", status: "running" }),
      run({ id: "e2", status: "verified_pending_review", createdAt: "2026-01-02T00:00:00Z" }),
    ],
    listDeliveries: [run({ id: "e2", status: "verified_pending_review" })],
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
    }),
    listDecisions: [decision()],
    askGuide: { answer: "Open Needs you.", links: [], sources: [] },
    ...over,
  });
}

/** The value of a metric card, found by its link label. */
const metric = (label: string) =>
  screen.getByRole("link", { name: label }).closest("div.group")?.textContent ?? "";

describe("OverviewScreen", () => {
  it("counts only the selected project's work and links each metric to its tab", async () => {
    const a = api();
    renderWithStore(ui, a, {
      projects: [
        { id: "p1", name: "Demo", repoPath: "/r/d" },
        { id: "p2", name: "Other", repoPath: "/r/o" },
      ],
      projectId: "p2",
    });
    expect(await screen.findByRole("link", { name: "Inbox" })).toBeTruthy();
    for (const fn of [a.listIntakes, a.listSpecs, a.listPlans, a.listExecutions, a.listDeliveries])
      expect(fn).toHaveBeenCalledWith("p2");
    expect(a.reviews).toHaveBeenCalledWith("p2");
    expect(a.listDecisions).toHaveBeenCalledWith({ projectId: "p2", status: "pending", limit: 20 });
    expect(metric("Inbox")).toContain("2");
    expect(metric("Specs in review")).toMatch(/1.*1 approved/);
    expect(metric("Plans to approve")).toMatch(/1.*1 approved/);
    expect(metric("Active runs")).toMatch(/1.*1 verified or delivered/);
    expect(metric("Deliveries")).toContain("1");
    expect(screen.getByRole("link", { name: "Specs in review" }).getAttribute("href")).toBe(
      "#/specs?project=p2",
    );
  });

  it("shows a dash for a source that failed, without blanking the rest", async () => {
    renderWithStore(ui, api({ listSpecs: () => Promise.reject(new Error("down")) }));
    await screen.findByRole("link", { name: "Inbox" });
    expect(metric("Specs in review")).toContain("—");
    expect(metric("Inbox")).toContain("2");
  });

  it("lists what needs the operator and links each item", async () => {
    renderWithStore(ui, api());
    const list = await screen.findByRole("list", { name: "Waiting for you" });
    const text = list.textContent ?? "";
    expect(text).toContain("Approve fs.write for implement-frontend");
    expect(text).toContain("Escalated: qa");
    expect(text).toContain("After 2 failed attempt(s)");
    expect(text).toContain("CSV export: which columns?");
    expect(text).toContain("Steward recommends: All visible columns");
    const hrefs = within(list)
      .getAllByRole("link")
      .map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("#/needs-you?project=p1");
    expect(hrefs).toContain("#/autonomy?project=p1");
  });

  it("says when nothing needs the operator", async () => {
    renderWithStore(ui, api({ reviews: inbox(), listDecisions: [] }));
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  it("offers the Guide with three suggestions and asks it with the project as context", async () => {
    const a = api();
    renderWithStore(ui, a);
    const chat = await screen.findByRole("region", { name: "Ask the factory" });
    const suggestions = within(chat).getByRole("list", { name: "Suggested questions" });
    const buttons = within(suggestions).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    // Picked from the project's state: an escalation and an approval are waiting.
    expect(buttons[0]!.textContent).toBe("Why is a task escalated and what should I do?");
    expect(buttons[1]!.textContent).toBe("What is waiting for my approval?");
    await userEvent.click(buttons[0]!);
    expect(a.askGuide).toHaveBeenCalledWith("Why is a task escalated and what should I do?", {
      app: "sindri",
      screen: "overview",
      projectId: "p1",
    });
    expect(await within(chat).findByText("Open Needs you.")).toBeTruthy();
  });

  it("without a project, offers to add one instead of loading anything", async () => {
    const a = api();
    renderWithStore(ui, a, { projects: [], projectId: null });
    expect(screen.getByText("No project yet")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add a project" }));
    expect(screen.getByTestId("where").textContent).toBe("projects");
    expect(a.listSpecs).not.toHaveBeenCalled();
    expect(a.reviews).not.toHaveBeenCalled();
  });
});

describe("suggestedQuestions", () => {
  it("falls back to general questions and never repeats one", () => {
    expect(suggestedQuestions(null)).toEqual([
      "What should I do next in this project?",
      "How does a ticket become a delivery?",
    ]);
    const all = suggestedQuestions({
      intakes: [],
      specs: [],
      plans: [],
      runs: [run({ status: "verified_pending_review" })],
      deliveries: [],
      reviews: inbox({
        budgetAlerts: [{ id: "b", executionId: "e1", planTaskId: null, detail: {} }],
      }),
      decisions: [],
    });
    expect(all).toEqual([
      "A run is blocked by its budget. How do I raise it?",
      "A run is verified pending review. What do I do next?",
      "What should I do next in this project?",
    ]);
  });
});
