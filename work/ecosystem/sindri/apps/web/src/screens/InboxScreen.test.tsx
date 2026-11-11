import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { NoticeRegion } from "../components/Layout.js";
import { intake } from "../test/fixtures.js";
import { useStore } from "../store/context.js";
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
    await userEvent.click(screen.getByRole("tab", { name: "Import a ticket" }));
    await userEvent.type(
      await screen.findByLabelText("Jira or Linear URL"),
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

  it("hands an item to the Director with its title as the request (L7)", async () => {
    function Where() {
      const { state } = useStore();
      const seed = state.directorSeed;
      return (
        <output data-testid="where">{`${state.view}:${seed?.intakeId}:${seed?.request}`}</output>
      );
    }
    const rec = intake();
    const api = mockApi({ listIntakes: [rec], getIntake: { intake: rec, comments: [] } });
    renderWithStore(
      <>
        {ui}
        <Where />
      </>,
      api,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Add CSV/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Draft spec from this" }));
    expect(screen.getByTestId("where").textContent).toBe("director:i1:Add CSV");
  });
});

describe("InboxScreen layout", () => {
  it("leads with the page title and reopens the add form from the header after viewing an item", async () => {
    const item = intake({ id: "i1", display: { title: "Add CSV", body: "Body" } });
    renderWithStore(
      ui,
      mockApi({ listIntakes: [item], getIntake: { intake: item, comments: [] } }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeTruthy();
    // The add form shows while nothing is open; a soft-disabled submit says why.
    const add = screen.getByRole("button", { name: /^Add to inbox/ });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.textContent).toMatch(/Give it a title first/);
    await userEvent.click(await screen.findByRole("button", { name: /Add CSV/ }));
    expect(await screen.findByRole("article", { name: "Intake detail" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Manual intake" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(screen.getByRole("form", { name: "Manual intake" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Intake detail" })).toBeNull();
  });
});
