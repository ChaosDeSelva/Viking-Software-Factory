import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.js";
import { ApiError } from "./api/client.js";
import { App } from "./App.js";
import { spec } from "./test/fixtures.js";
import { globalLink, pickProject, projectPicker, tab } from "./test/shell.js";
import { mockApi } from "./test/utils.js";

const P1 = { id: "p1", name: "One", repoPath: "/repo/one" };
const P2 = { id: "p2", name: "Two", repoPath: "/repo/two" };

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("App", () => {
  it("asks for the token first and keeps it in sessionStorage only", async () => {
    const api = mockApi({ listProjects: [] });
    render(<App api={api as unknown as ApiClient} initial={{ token: null }} />);
    expect(screen.getByRole("heading", { name: "Sindri" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("API token"), "secret-token");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(sessionStorage.getItem("sindri.token")).toBe("secret-token");
    expect(localStorage.getItem("sindri.token")).toBeNull();
    expect(await screen.findByRole("navigation", { name: "Project pages" })).toBeTruthy();
  });

  it("navigates with the keyboard (Alt+6 opens Runs), opens Settings and sets the theme", async () => {
    const api = mockApi({
      listProjects: [],
      getSettings: {
        settings: { provider: "null", model: "m", localOnly: true },
        tokenLocation: "/d/auth-token",
      },
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    await userEvent.keyboard("{Alt>}6{/Alt}");
    expect(tab("Runs").getAttribute("aria-current")).toBe("page");
    expect(globalLink("Settings").getAttribute("href")).toBe("#/settings");
    await userEvent.click(globalLink("Settings"));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    // The theme lives in the bottom bar's Theme menu and lands on <html data-theme>.
    await userEvent.click(screen.getByRole("button", { name: /^Theme: / }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("factory-theme")).toBe("dark");
    await userEvent.click(screen.getByRole("button", { name: "Theme: Dark" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("returns to the token prompt when the server rejects the token", async () => {
    const api = mockApi({
      listProjects: () => Promise.reject(new ApiError(401, "unauthorized", "bad token")),
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "stale" }} />);
    await waitFor(() => expect(screen.getByLabelText("API token")).toBeTruthy());
    expect(screen.getByText(/rejected the token/)).toBeTruthy();
    // The approval session ends with the token.
    expect(api.forgetApproval).toHaveBeenCalled();
  });

  it("loads the project list on any screen, so the header selector works after a reload (H3)", async () => {
    const api = mockApi({ listProjects: [P1, P2], listIntakes: [] });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t", view: "inbox" }} />);
    await waitFor(() => expect(projectPicker().getAttribute("aria-label")).toBe("Project: One"));
    await userEvent.click(projectPicker());
    const list = await screen.findByRole("listbox", { name: "Project" });
    expect(within(list).getAllByRole("option", { name: /^(One|Two)/ })).toHaveLength(2);
    expect(api.listProjects).toHaveBeenCalledTimes(1);
  });

  it("never proposes a plan from the previous project's spec (H1)", async () => {
    const a1 = spec({ id: "sa1", status: "approved", title: "A one" });
    const a2 = spec({ id: "sa2", lineageId: "L2", status: "approved", title: "A two" });
    const b = spec({ id: "sb", projectId: "p2", lineageId: "L3", status: "approved", title: "B" });
    const api = mockApi({
      listProjects: [P1, P2],
      listPlans: [],
      listSpecs: (projectId: string) => Promise.resolve(projectId === "p1" ? [a1, a2] : [b]),
      proposePlan: () => new Promise(() => undefined),
    });
    render(
      <App
        api={api as unknown as ApiClient}
        initial={{ token: "t", view: "plans", projects: [P1, P2], projectId: "p1" }}
      />,
    );
    await userEvent.selectOptions(await screen.findByLabelText("Approved spec"), "sa2");
    await pickProject("Two");
    await waitFor(() =>
      expect(screen.getByLabelText("Approved spec").textContent).toMatch(/^B \(v1\)$/),
    );
    await userEvent.click(screen.getByRole("button", { name: "Propose plan" }));
    expect(api.proposePlan).toHaveBeenCalledWith("sb");
    expect(screen.getByRole("button", { name: "Proposing plan…" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("clears the Director's inbox choice when the project changes (M10)", async () => {
    const api = mockApi({
      listProjects: [P1, P2],
      listIntakes: (projectId: string) =>
        Promise.resolve(
          projectId === "p1"
            ? [
                {
                  id: "i1",
                  projectId: "p1",
                  source: "manual",
                  syncState: "imported",
                  display: { title: "Add CSV", body: "" },
                },
              ]
            : [],
        ),
    });
    render(
      <App
        api={api as unknown as ApiClient}
        initial={{ token: "t", view: "director", projects: [P1, P2], projectId: "p1" }}
      />,
    );
    await screen.findByRole("option", { name: "Add CSV" });
    await userEvent.selectOptions(screen.getByLabelText("Inbox item (optional)"), "i1");
    await userEvent.type(screen.getByLabelText("Request"), "x");
    await pickProject("Two");
    await waitFor(() =>
      expect((screen.getByLabelText("Inbox item (optional)") as HTMLSelectElement).value).toBe(""),
    );
    expect((screen.getByLabelText("Request") as HTMLTextAreaElement).value).toBe("");
  });

  it("forgets the approval session on sign out (L8)", async () => {
    const api = mockApi({ listProjects: [P1], listIntakes: [] });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t", view: "inbox" }} />);
    expect(api.forgetApproval).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("API token")).toBeTruthy();
    expect(api.forgetApproval).toHaveBeenCalled();
  });
});
