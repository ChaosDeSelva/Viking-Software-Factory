import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.js";
import { App } from "./App.js";
import { globalLink, globalNav, projectNav, tab } from "./test/shell.js";
import { mockApi } from "./test/utils.js";

afterEach(() => sessionStorage.clear());

const current = () =>
  within(projectNav())
    .getAllByRole("link")
    .find((b) => b.getAttribute("aria-current") === "page")?.textContent;

describe("App navigation for plans, runs, needs you, deliveries and harnesses", () => {
  it("lists the project screens and reaches them with Alt+7..0, global pages in the bottom bar", async () => {
    const api = mockApi({
      listProjects: [],
      listHarnesses: { source: "fake", harnesses: [] },
      listDecisions: [],
      listStewardNotes: [],
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    const nav = await screen.findByRole("navigation", { name: "Project pages" });
    for (const name of ["Plans", "Runs", "Needs you", "Deliveries", "Knowledge", "Autonomy"])
      expect(nav.textContent).toContain(name);
    for (const name of ["Projects", "Harnesses", "Autonomy (all)", "Settings"])
      expect(within(globalNav()).getByRole("link", { name })).toBeTruthy();
    await userEvent.keyboard("{Alt>}7{/Alt}");
    expect(current()).toBe("Needs you");
    await userEvent.keyboard("{Alt>}8{/Alt}");
    expect(current()).toBe("Deliveries");
    await userEvent.keyboard("{Alt>}9{/Alt}");
    expect(current()).toBe("Knowledge");
    await userEvent.keyboard("{Alt>}0{/Alt}");
    expect(current()).toBe("Autonomy");
    await userEvent.click(globalLink("Harnesses"));
    expect(await screen.findByText(/Fixture harnesses/)).toBeTruthy();
    // A global page has no current project tab.
    expect(current()).toBeUndefined();
  });

  it("lists Autonomy as the last project tab and opens Autonomy (all) from the bottom bar", async () => {
    const api = mockApi({
      listProjects: [],
      stewardStatus: {
        running: true,
        types: [],
        feedbackGraph: {
          configured: false,
          enabled: false,
          url: null,
          reachable: null,
          error: null,
        },
      },
      listDecisions: [],
      listStewardNotes: [],
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    await screen.findByRole("navigation", { name: "Project pages" });
    const links = within(projectNav()).getAllByRole("link");
    expect(links.at(-1)!.textContent).toBe("Autonomy");
    expect(tab("Autonomy").getAttribute("aria-keyshortcuts")).toBeNull();
    await userEvent.click(globalLink("Autonomy (all)"));
    expect(await screen.findByRole("heading", { name: "Decision log" })).toBeTruthy();
    expect(window.location.hash).toBe("#/autonomy-all");
    // The global page covers all projects: no projectId on the log or the notes.
    expect(api.listDecisions).toHaveBeenCalledWith({ limit: 50 });
    expect(api.listStewardNotes).toHaveBeenCalledWith(null);
  });
});
