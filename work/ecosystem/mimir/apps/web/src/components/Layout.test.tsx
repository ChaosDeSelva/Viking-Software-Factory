import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { StoreProvider } from "../store/StoreProvider.js";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { approval, snapshot } from "../test/fixtures.js";
import { mockClient, type MockClient } from "../test/mockClient.js";
import { Layout } from "./Layout.js";

function renderLayout(client: MockClient, route = "/") {
  return render(
    <StoreProvider client={client} refreshDelayMs={0}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<h1>Overview page</h1>} />
            <Route path="/missions" element={<h1>Missions page</h1>} />
            <Route path="/reviews" element={<h1>Reviews page</h1>} />
            <Route path="/activity" element={<input aria-label="search" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </StoreProvider>,
  );
}

describe("Layout", () => {
  it("renders navigation for every screen and a skip link", async () => {
    const { container } = renderLayout(mockClient());
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const name of [
      "Overview",
      "Projects",
      "Missions",
      "Crews",
      "Reviews",
      "Activity",
      "Settings",
    ]) {
      expect(
        nav.querySelector(`a[href]`) && screen.getByRole("link", { name: new RegExp(`^${name}`) }),
      ).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: /skip to content/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Overview page")).toBeTruthy());
    await expectNoSeriousA11yViolations(container);
  });

  it("shows the connection indicator and reconnecting state", async () => {
    const client = mockClient();
    renderLayout(client);
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.last?.onStatus?.("reconnecting"));
    expect(screen.getByTestId("connection").textContent).toMatch(/reconnecting/i);
    act(() => client.streamController.last?.onStatus?.("open"));
    expect(screen.getByTestId("connection").textContent).toMatch(/live/i);
  });

  it("shows a gap banner whose reload refetches the snapshot", async () => {
    const client = mockClient();
    renderLayout(client);
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.last?.onGap?.({ reason: "buffer full" }));
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/missed events/i);
    expect(banner.textContent).toMatch(/buffer full/);
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));
    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("announces attention count in an aria-live region", async () => {
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ approvals: [approval()] })),
    });
    renderLayout(client);
    const live = await screen.findByTestId("attention-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    await waitFor(() => expect(live.textContent).toMatch(/1 item needs attention/));
  });

  it("supports g o / g m / g r navigation and ? help", async () => {
    const user = userEvent.setup();
    renderLayout(mockClient());
    await user.keyboard("gm");
    expect(screen.getByRole("heading", { name: "Missions page" })).toBeTruthy();
    await user.keyboard("gr");
    expect(screen.getByRole("heading", { name: "Reviews page" })).toBeTruthy();
    await user.keyboard("go");
    expect(screen.getByRole("heading", { name: "Overview page" })).toBeTruthy();
    await user.keyboard("?");
    const dialog = screen.getByRole("dialog", { name: /keyboard shortcuts/i });
    expect(dialog.textContent).toMatch(/g m/);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("traps focus in the help dialog and suspends g-shortcuts while it is open", async () => {
    const user = userEvent.setup();
    renderLayout(mockClient());
    await user.keyboard("?");
    const dialog = screen.getByRole("dialog", { name: /keyboard shortcuts/i });
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("gm");
    expect(screen.queryByText("Missions page")).toBeNull();
    await user.keyboard("{Escape}");
    await user.keyboard("gm");
    expect(screen.getByText("Missions page")).toBeTruthy();
  });

  it("announces the newest attention item, not only the count", async () => {
    const client = mockClient({
      snapshot: vi.fn(async () => snapshot({ approvals: [approval({ action: "git.push" })] })),
    });
    renderLayout(client);
    const live = await screen.findByTestId("attention-live");
    await waitFor(() => expect(live.textContent).toMatch(/Approval needed: git.push/));
  });

  it("ignores shortcuts while typing in a field", async () => {
    const user = userEvent.setup();
    renderLayout(mockClient(), "/activity");
    await user.click(screen.getByLabelText("search"));
    await user.keyboard("gm");
    expect(screen.queryByText("Missions page")).toBeNull();
  });

  it("toggles the theme", async () => {
    const user = userEvent.setup();
    renderLayout(mockClient());
    const select = screen.getByLabelText("Theme");
    await user.selectOptions(select, "dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await user.selectOptions(select, "light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

describe("Layout (a11y/UX audit M-I1, M-I2, M-I8, M-m2, M-m12, M-m13)", () => {
  it("sets document.title per route and moves focus to main on navigation", async () => {
    renderLayout(mockClient());
    await waitFor(() => expect(document.title).toBe("Overview - Mimir"));
    await userEvent.click(screen.getByRole("link", { name: /^Missions/ }));
    await waitFor(() => expect(document.title).toBe("Missions - Mimir"));
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  it("keeps screens and the attention live region when a refresh fails, with an alert and Retry", async () => {
    const client = mockClient({
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot({ approvals: [approval()] }))
        .mockRejectedValueOnce(new Error("server down"))
        .mockResolvedValue(snapshot({ approvals: [approval()] })),
    });
    renderLayout(client);
    const live = await screen.findByTestId("attention-live");
    await waitFor(() => expect(live.textContent).toMatch(/1 item needs attention/));
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.last?.onGap?.({ reason: "x" }));
    await userEvent.click(screen.getByRole("button", { name: /reload snapshot/i }));
    const alert = await screen.findByText(/could not refresh/i);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByText("Overview page")).toBeTruthy();
    expect(live.textContent).toMatch(/1 item needs attention/);
    await userEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    await waitFor(() => expect(screen.queryByText(/could not refresh/i)).toBeNull());
  });

  it("lists up to three attention titles in the live region", async () => {
    const client = mockClient({
      snapshot: vi.fn(async () =>
        snapshot({ approvals: [approval({ reason: "one" }), approval({ reason: "two" })] }),
      ),
    });
    renderLayout(client);
    const live = await screen.findByTestId("attention-live");
    await waitFor(() => expect(live.textContent).toMatch(/2 items need attention/));
    expect(live.textContent).toMatch(/;/);
  });

  it("gap banner copy no longer says until you reload", async () => {
    const client = mockClient();
    renderLayout(client);
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.last?.onGap?.({ reason: "" }));
    expect(screen.getByRole("alert").textContent).not.toMatch(/until you reload/i);
  });

  it("does not run g-shortcuts when single-key shortcuts are disabled", async () => {
    localStorage.setItem("mimir.shortcuts", "off");
    try {
      renderLayout(mockClient());
      await waitFor(() => expect(document.title).toBe("Overview - Mimir"));
      await userEvent.keyboard("gm");
      expect(document.title).toBe("Overview - Mimir");
      await userEvent.keyboard("?");
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      localStorage.removeItem("mimir.shortcuts");
    }
  });
});
