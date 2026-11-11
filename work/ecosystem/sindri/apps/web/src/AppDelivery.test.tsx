import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiClient } from "./api/client.js";
import { App } from "./App.js";
import { mockApi } from "./test/utils.js";

afterEach(() => sessionStorage.clear());

describe("App navigation for plans, runs, reviews, deliveries and harnesses", () => {
  it("lists the new screens and reaches them with Alt+7..0", async () => {
    const api = mockApi({
      listProjects: [],
      listHarnesses: { source: "fake", harnesses: [] },
    });
    render(<App api={api as unknown as ApiClient} initial={{ token: "t" }} />);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    for (const name of ["Plans", "Runs", "Reviews", "Deliveries", "Harnesses"])
      expect(nav.textContent).toContain(name);
    const current = () =>
      screen.getAllByRole("button").find((b) => b.getAttribute("aria-current") === "page")
        ?.textContent;
    await userEvent.keyboard("{Alt>}7{/Alt}");
    expect(current()).toBe("Plans");
    await userEvent.keyboard("{Alt>}8{/Alt}");
    expect(current()).toBe("Runs");
    await userEvent.keyboard("{Alt>}9{/Alt}");
    expect(current()).toBe("Reviews");
    await userEvent.keyboard("{Alt>}0{/Alt}");
    expect(current()).toBe("Deliveries");
    await userEvent.click(screen.getByRole("button", { name: "Harnesses" }));
    expect(await screen.findByText(/Fixture harnesses/)).toBeTruthy();
  });

  it("lists Autonomy last and opens it from the navigation", async () => {
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
    const nav = await screen.findByRole("navigation", { name: "Main" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.at(-1)!.textContent).toBe("Autonomy");
    expect(buttons.at(-1)!.getAttribute("aria-keyshortcuts")).toBeNull();
    await userEvent.click(buttons.at(-1)!);
    expect(await screen.findByRole("heading", { name: "Decision log" })).toBeTruthy();
    expect(window.location.hash).toBe("#/autonomy");
    // No project selected: the log and notes cover all projects.
    expect(api.listDecisions).toHaveBeenCalledWith({ limit: 50 });
    expect(api.listStewardNotes).toHaveBeenCalledWith(null);
  });
});
