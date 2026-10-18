import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { intake } from "../test/fixtures.js";
import { mockApi, renderWithStore } from "../test/utils.js";
import { InboxScreen } from "./InboxScreen.js";

const ui = (
  <>
    <NoticeRegion />
    <InboxScreen />
  </>
);

describe("InboxScreen", () => {
  it("asks for a project when none is selected", () => {
    renderWithStore(<InboxScreen />, mockApi(), { projectId: null });
    expect(screen.getByText(/select a project first/i)).toBeTruthy();
  });

  it("lists intakes with source badges and an empty state", async () => {
    const api = mockApi({ listIntakes: [] });
    const { unmount } = renderWithStore(ui, api);
    expect(await screen.findByText("The inbox is empty.")).toBeTruthy();
    unmount();
    renderWithStore(
      ui,
      mockApi({
        listIntakes: [
          intake(),
          intake({ id: "i2", source: "jira", display: { title: "PROJ-1 bug", body: "" } }),
        ],
      }),
    );
    expect(await screen.findByText("PROJ-1 bug")).toBeTruthy();
    expect(screen.getByText("Jira")).toBeTruthy();
    expect(screen.getAllByText("Manual").length).toBeGreaterThan(0);
  });

  it("creates a manual intake and reloads the list", async () => {
    const api = mockApi({ listIntakes: [], createIntake: intake() });
    renderWithStore(ui, api);
    await screen.findByText("The inbox is empty.");
    api.listIntakes.mockResolvedValue([intake()]);
    await userEvent.type(screen.getByLabelText("Title"), "Add CSV");
    await userEvent.type(screen.getByLabelText("Description"), "Please add CSV export");
    await userEvent.click(screen.getByRole("button", { name: "Add to inbox" }));
    expect(api.createIntake).toHaveBeenCalledWith({
      projectId: "p1",
      title: "Add CSV",
      body: "Please add CSV export",
    });
    expect(await screen.findByRole("button", { name: /Add CSV/ })).toBeTruthy();
  });

  it("explains a local-only import refusal", async () => {
    const api = mockApi({
      listIntakes: [],
      importIntake: () =>
        Promise.reject(
          new ApiError(503, "local_only", "local-only mode is on: ticket imports are disabled"),
        ),
    });
    renderWithStore(ui, api);
    await userEvent.type(
      screen.getByLabelText("Jira or Linear URL"),
      "https://acme.atlassian.net/browse/X-1",
    );
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/local-only mode is on/);
  });

  it("shows the sanitized detail, never raw HTML", async () => {
    const rec = intake({
      body: "<img src=x onerror=alert(1)>Hi",
      display: { title: "Add CSV", body: "Hi" },
    });
    const api = mockApi({ listIntakes: [rec], getIntake: { intake: rec, comments: [] } });
    renderWithStore(ui, api);
    await userEvent.click(await screen.findByRole("button", { name: /Add CSV/ }));
    const detail = await screen.findByRole("article", { name: "Intake detail" });
    expect(within(detail).getByText("Hi")).toBeTruthy();
    expect(detail.querySelector("img")).toBeNull();
  });
});
