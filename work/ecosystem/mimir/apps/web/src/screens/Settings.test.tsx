import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionContext } from "../api/session.js";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { mockClient } from "../test/mockClient.js";
import { renderWithStore } from "../test/render.js";
import { Settings } from "./Settings.js";

describe("Settings", () => {
  it("shows runtime status, config hints and theme", async () => {
    const { container } = renderWithStore(<Settings />, { client: mockClient() });
    const runtime = await screen.findByRole("region", { name: "Runtime" });
    await waitFor(() => expect(within(runtime).getByText(/fake 1/)).toBeTruthy());
    expect(within(runtime).getByText(/terminalRead: yes/)).toBeTruthy();
    expect(within(runtime).getByText(/pause: no/)).toBeTruthy();
    const data = screen.getByRole("region", { name: "Data and retention" });
    expect(data.textContent).toMatch(/MIMIR_DATA_DIR/);
    expect(data.textContent).toMatch(/MIMIR_ARTIFACT_RETENTION_DAYS/);
    expect(data.textContent).toMatch(/auth-token/);
    expect(screen.getByRole("radio", { name: "System" })).toBeTruthy();
    await expectNoSeriousA11yViolations(container);
  });

  it("changes the theme", async () => {
    const user = userEvent.setup();
    renderWithStore(<Settings />, { client: mockClient() });
    await user.click(await screen.findByRole("radio", { name: "Dark" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("forgets the token", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn();
    renderWithStore(
      <SessionContext.Provider value={{ signOut }}>
        <Settings />
      </SessionContext.Provider>,
      { client: mockClient() },
    );
    await user.click(await screen.findByRole("button", { name: "Forget token" }));
    expect(signOut).toHaveBeenCalled();
  });

  it("shows runtime errors", async () => {
    const client = mockClient({
      capabilities: vi.fn(async () => Promise.reject(new Error("runtime unavailable"))),
    });
    renderWithStore(<Settings />, { client });
    expect((await screen.findByRole("alert")).textContent).toMatch(/runtime unavailable/);
  });
});
