import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NoticeRegion } from "../components/Layout.js";
import { plan, planTask, versionOf } from "../test/delivery-fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { latestPlans, PlansScreen } from "./PlansScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <PlansScreen />
  </>
);
const dry = { steps: [], order: [] };

describe("latestPlans", () => {
  it("keeps the newest version of each lineage, whatever the order, newest lineage first", () => {
    const a1 = plan({ id: "a1", lineageId: "A", version: 1, createdAt: "2026-01-01T00:00:00Z" });
    const a2 = plan({ id: "a2", lineageId: "A", version: 2, createdAt: "2026-01-03T00:00:00Z" });
    const b1 = plan({ id: "b1", lineageId: "B", version: 1, createdAt: "2026-01-02T00:00:00Z" });
    expect(latestPlans([a2, b1, a1]).map((p) => p.id)).toEqual(["a2", "b1"]);
    expect(latestPlans([a1, a2, b1]).map((p) => p.id)).toEqual(["a2", "b1"]);
    expect(latestPlans([])).toEqual([]);
  });
});

describe("PlansScreen navigation and budgets", () => {
  it("opens a plan from the list and another version from its detail", async () => {
    const v1 = plan({ id: "pl1", version: 1, status: "superseded" as "draft" });
    const v2 = plan({ id: "pl2", version: 2 });
    const api = mockApi({
      listPlans: [v1, v2],
      listSpecs: [],
      getPlan: (id: string) =>
        Promise.resolve({
          plan: id === "pl1" ? v1 : v2,
          versions: [versionOf(v1), versionOf(v2)],
        }),
      dryRunPlan: dry,
    });
    renderWithStore(ui, api);
    // Only the newest version of the lineage is listed.
    const open = await screen.findByRole("button", { name: /Plan v2 for spec v2/ });
    expect(screen.queryByRole("button", { name: /Plan v1 for spec/ })).toBeNull();
    await userEvent.click(open);
    expect(open.getAttribute("aria-pressed")).toBe("true");
    const versions = await screen.findByRole("navigation", { name: "Plan versions" });
    expect(
      within(versions).getByRole("button", { name: "v2 (draft)" }).getAttribute("aria-current"),
    ).toBe("true");
    const older = within(versions).getByRole("button", { name: "v1 (superseded)" });
    expect(older.getAttribute("aria-current")).toBeNull();
    await userEvent.click(older);
    expect(await screen.findByRole("heading", { name: "Plan v1" })).toBeTruthy();
    expect(api.getPlan).toHaveBeenLastCalledWith("pl1");
  });

  it("sends edited minutes for the edited task only", async () => {
    const current = plan({
      tasks: [planTask(), planTask({ id: "docs", skills: [], budget: { wallClockMinutes: 30 } })],
    });
    const next = plan({ id: "pl2", version: 2 });
    const api = mockApi({
      listPlans: [current],
      listSpecs: [],
      getPlan: { plan: current, versions: [versionOf(current)] },
      dryRunPlan: dry,
      revisePlan: next,
    });
    renderWithStore(ui, api, { planId: "pl1" });
    const docs = await screen.findByRole("article", { name: "Task docs" });
    expect(docs.textContent).not.toContain("skills");
    const minutes = screen.getByLabelText("docs: minutes");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "45");
    await userEvent.click(screen.getByRole("button", { name: "Save budgets as new draft" }));
    const [, tasks] = api.revisePlan.mock.calls[0] as [string, ReturnType<typeof planTask>[]];
    expect(tasks.map((t) => t.budget)).toEqual([
      { wallClockMinutes: 90 },
      { wallClockMinutes: 45 },
    ]);
  });
});
