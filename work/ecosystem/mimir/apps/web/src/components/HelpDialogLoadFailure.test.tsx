import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { StoreProvider } from "../store/StoreProvider.js";
import { mockClient } from "../test/mockClient.js";
import { Layout } from "./Layout.js";
import { RoutedProviders } from "./Providers.js";

// The docs text chunk is gone (the app was redeployed since the page opened).
vi.mock("../lib/docsSection.js", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

describe("Help dialog whose docs text fails to load", () => {
  it("still opens with the shortcuts switch, says the guide did not load, and closes", async () => {
    const user = userEvent.setup();
    render(
      <StoreProvider client={mockClient()} refreshDelayMs={0}>
        <MemoryRouter initialEntries={["/"]}>
          <RoutedProviders>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<h1>Overview page</h1>} />
                <Route path="/missions" element={<h1>Missions page</h1>} />
              </Route>
            </Routes>
          </RoutedProviders>
        </MemoryRouter>
      </StoreProvider>,
    );
    await user.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: /help/i });
    expect(await within(dialog).findByText(/did not load/)).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: /Single-key shortcuts/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/did not load/)).toBeNull();
    await user.keyboard("gm");
    expect(screen.getByRole("heading", { name: "Missions page" })).toBeTruthy();
  });
});
