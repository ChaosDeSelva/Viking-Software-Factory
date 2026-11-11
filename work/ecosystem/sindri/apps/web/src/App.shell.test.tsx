import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.js";
import { App } from "./App.js";
import type { State } from "./store/reducer.js";
import { bottomBar, projectNav, projectPicker, tab } from "./test/shell.js";
import { mockApi } from "./test/utils.js";

const P1 = { id: "p1", name: "One", repoPath: "/repo/one" };
const REVIEWS = {
  deliveryService: "s6",
  approvals: [{ id: "a1" }],
  escalations: [{ id: "e1" }, { id: "e2" }],
  budgetAlerts: [],
  gateFailures: [],
  findings: [],
};

afterEach(() => sessionStorage.clear());

function app(initial: Partial<State>, over: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    health: { ok: true },
    listProjects: [P1],
    reviews: REVIEWS,
    listIntakes: [],
    listSpecs: [],
    listPlans: [],
    listExecutions: [],
    ...over,
  });
  render(
    <App
      api={api as unknown as ApiClient}
      initial={{ token: "t", projects: [P1], projectId: "p1", ...initial }}
    />,
  );
  return api;
}

describe("App shell", () => {
  it("links project tabs with ?project= and counts what needs the operator", async () => {
    const api = app({ view: "inbox" });
    expect(tab("Inbox").getAttribute("href")).toBe("#/inbox?project=p1");
    expect(tab("Runs").getAttribute("href")).toBe("#/runs?project=p1");
    // One approval and two escalations from the Needs you endpoint.
    await waitFor(() => expect(tab("Needs you").textContent).toBe("Needs you3"));
    expect(api.reviews).toHaveBeenCalledWith("p1");
    // Project settings sits beside the tabs on wide screens, still scoped to the project.
    const settings = screen.getByRole("link", { name: "Project settings" });
    expect(settings.getAttribute("href")).toBe("#/project-settings?project=p1");
    expect(within(projectNav()).queryByRole("link", { name: "Project settings" })).toBeNull();
  });

  it("points the bottom-bar Docs link at the current screen's docs section", async () => {
    app({ view: "runs" });
    const docs = within(bottomBar()).getByRole("link", { name: "Docs" });
    expect(docs.getAttribute("href")).toBe("#/docs/sindri-screens?project=p1&section=runs");
    await userEvent.click(tab("Inbox"));
    await waitFor(() =>
      expect(within(bottomBar()).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(
        "#/docs/sindri-screens?project=p1&section=inbox",
      ),
    );
  });

  it("opens the Guide from Ask with the screen and project as context", async () => {
    const api = app(
      { view: "runs" },
      {
        askGuide: {
          answer: "Open **Needs you** to decide it.",
          links: [{ label: "Open Needs you", href: "#/needs-you?project=p1" }],
          sources: ["state"],
        },
      },
    );
    await userEvent.click(within(bottomBar()).getByRole("button", { name: "Ask" }));
    const drawer = await screen.findByRole("dialog", { name: "Ask the factory" });
    await userEvent.type(within(drawer).getByLabelText("Your question"), "Why is my run waiting?");
    await userEvent.click(within(drawer).getByRole("button", { name: "Ask" }));
    expect(api.askGuide).toHaveBeenCalledWith("Why is my run waiting?", {
      app: "sindri",
      screen: "runs",
      projectId: "p1",
    });
    const log = await within(drawer).findByRole("log", { name: "Conversation" });
    expect(await within(log).findByText("Needs you")).toBeTruthy();
    // Following an answer's link navigates and closes the drawer.
    await userEvent.click(within(log).getByRole("link", { name: "Open Needs you" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Ask the factory" })).toBeNull(),
    );
    expect(tab("Needs you").getAttribute("aria-current")).toBe("page");
  });

  it("disables the project picker on Projects, which covers every project", async () => {
    app({ view: "projects" });
    const picker = projectPicker();
    expect(picker.hasAttribute("disabled")).toBe(true);
    expect(picker.getAttribute("title")).toBe("This page covers every project");
    await userEvent.click(tab("Specs"));
    await waitFor(() => expect(projectPicker().hasAttribute("disabled")).toBe(false));
  });

  it("lists the keyboard shortcuts on ?", async () => {
    app({ view: "inbox" });
    await screen.findByRole("navigation", { name: "Project pages" });
    await userEvent.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Alt+1")).toBeTruthy();
    expect(within(dialog).getByText("Overview")).toBeTruthy();
    expect(within(dialog).getByText("Alt+0")).toBeTruthy();
    expect(within(dialog).getByText("Autonomy")).toBeTruthy();
  });
});
