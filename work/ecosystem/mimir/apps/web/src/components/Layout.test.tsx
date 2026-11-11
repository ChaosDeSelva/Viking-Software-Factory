import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { StoreProvider } from "../store/StoreProvider.js";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { approval, mission, project, snapshot } from "../test/fixtures.js";
import { mockClient, type MockClient } from "../test/mockClient.js";
import { SessionContext } from "../api/session.js";
import { Layout } from "./Layout.js";
import { RoutedProviders } from "./Providers.js";

function renderLayout(client: MockClient, route = "/") {
  return render(
    <StoreProvider client={client} refreshDelayMs={0}>
      <MemoryRouter initialEntries={[route]}>
        <RoutedProviders>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<h1 tabIndex={-1}>Overview page</h1>} />
              <Route path="/missions" element={<h1 tabIndex={-1}>Missions page</h1>} />
              <Route path="/reviews" element={<h1 tabIndex={-1}>Reviews page</h1>} />
              <Route path="/settings" element={<h1 tabIndex={-1}>Settings page</h1>} />
              <Route path="/activity" element={<input aria-label="search" />} />
            </Route>
          </Routes>
        </RoutedProviders>
      </MemoryRouter>
    </StoreProvider>,
  );
}

describe("Layout", () => {
  it("puts project pages in the top bar and global pages in the bottom bar, with a skip link", async () => {
    const { container } = renderLayout(mockClient());
    const top = screen.getByRole("navigation", { name: "Project pages" });
    for (const name of ["Overview", "Missions", "Crews", "Reviews", "Activity"]) {
      expect(within(top).getByRole("link", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    expect(within(top).queryByRole("link", { name: /Projects|Settings/ })).toBeNull();
    const bottom = screen.getByRole("contentinfo", { name: "Status and global" });
    const global = within(bottom).getByRole("navigation", { name: "Global pages" });
    expect(within(global).getByRole("link", { name: "Projects" })).toBeTruthy();
    expect(within(global).getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(within(bottom).getByRole("link", { name: "Docs" })).toBeTruthy();
    expect(within(bottom).getByRole("button", { name: "Ask" })).toBeTruthy();
    expect(within(bottom).getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /skip to content/i })).toBeTruthy();
    // No shortcut hint line: shortcuts live in the help dialog.
    expect(container.textContent).not.toMatch(/Alt\+1/);
    await waitFor(() => expect(screen.getByText("Overview page")).toBeTruthy());
    await expectNoSeriousA11yViolations(container);
  });

  it("links Docs to the current screen's section", async () => {
    renderLayout(mockClient(), "/missions");
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe(
      "/docs/mimir-screens#missions",
    );
  });

  it("signs out from the bottom bar", async () => {
    const signOut = vi.fn();
    render(
      <SessionContext.Provider value={{ signOut }}>
        <StoreProvider client={mockClient()} refreshDelayMs={0}>
          <MemoryRouter>
            <RoutedProviders>
              <Routes>
                <Route element={<Layout />}>
                  <Route path="/" element={<h1>Overview page</h1>} />
                </Route>
              </Routes>
            </RoutedProviders>
          </MemoryRouter>
        </StoreProvider>
      </SessionContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();
  });

  it("Ask opens a drawer that sends the operator to Sindri's guide", async () => {
    const user = userEvent.setup();
    renderLayout(mockClient());
    await user.click(screen.getByRole("button", { name: "Ask" }));
    const drawer = screen.getByRole("dialog", { name: "Ask the guide" });
    expect(drawer.textContent).toMatch(/no Sindri access token/i);
    const link = within(drawer).getByRole("link", { name: "Open the Guide in Sindri" });
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:4310/");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters the Reviews count and the page scope by the picked project", async () => {
    const user = userEvent.setup();
    const a = project({ name: "alpha" });
    const b = project({ name: "beta" });
    const ma = mission({ projectId: a.id });
    const mb = mission({ projectId: b.id });
    const client = mockClient({
      snapshot: vi.fn(async () =>
        snapshot({
          projects: [a, b],
          missions: [ma, mb],
          approvals: [
            approval({ missionId: ma.id }),
            approval({ missionId: mb.id }),
            approval({ missionId: mb.id }),
          ],
        }),
      ),
    });
    renderLayout(client);
    const top = screen.getByRole("navigation", { name: "Project pages" });
    // Two projects and no stored choice: All projects.
    await waitFor(() =>
      expect(within(top).getByRole("link", { name: /Reviews\s*3/ })).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: /^Project:/ }));
    await user.click(await screen.findByRole("option", { name: /beta/ }));
    await waitFor(() =>
      expect(within(top).getByRole("link", { name: /Reviews\s*2/ })).toBeTruthy(),
    );
    expect(localStorage.getItem("mimir.project")).toBe(b.id);
  });

  it("shows the connection indicator and reconnecting state", async () => {
    const client = mockClient();
    renderLayout(client);
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    const connection = () =>
      screen.getAllByRole("status").find((el) => /^Connection:/.test(el.textContent ?? ""))!;
    act(() => client.streamController.last?.onStatus?.("reconnecting"));
    expect(connection().textContent).toMatch(/reconnecting/i);
    act(() => client.streamController.last?.onStatus?.("open"));
    expect(connection().textContent).toMatch(/live/i);
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

  it("reopens the stream from the gap banner when the gap ended it (expired cursor)", async () => {
    const client = mockClient();
    renderLayout(client);
    await waitFor(() => expect(client.streamController.calls).toHaveLength(1));
    act(() => client.streamController.last?.onGap?.({ reason: "cursor_expired" }));
    act(() =>
      client.streamController.fail(
        Object.assign(new Error("cursor expired"), { name: "MimirError", code: "cursor_expired" }),
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((el) => /^Connection:.*offline/i.test(el.textContent ?? "")),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole("button", { name: /reload snapshot/i }));
    await waitFor(() => expect(client.streamController.calls).toHaveLength(2));
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
    const dialog = await screen.findByRole("dialog", { name: /keyboard shortcuts/i });
    expect(dialog.textContent).toMatch(/g m/);
    // The screen's docs section loads asynchronously after the dialog opens.
    expect(await within(dialog).findByRole("heading", { name: "On this screen" })).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: /full guide in Docs/ })
        .getAttribute("href"),
    ).toBe("/docs/mimir-screens#overview");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("traps focus in the help dialog and suspends g-shortcuts while it is open", async () => {
    const user = userEvent.setup();
    renderLayout(mockClient());
    await user.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: /keyboard shortcuts/i });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
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

  it("toggles the theme from the bottom bar", async () => {
    const user = userEvent.setup();
    renderLayout(mockClient());
    await user.click(screen.getByRole("button", { name: /^Theme/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await user.click(screen.getByRole("button", { name: /^Theme/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("Layout (a11y/UX audit M-I1, M-I2, M-I8, M-m2, M-m12, M-m13)", () => {
  it("sets document.title per route and moves focus to the page heading on navigation", async () => {
    renderLayout(mockClient());
    await waitFor(() => expect(document.title).toBe("Overview · All projects · Mimir"));
    await userEvent.click(screen.getByRole("link", { name: /^Missions/ }));
    await waitFor(() => expect(document.title).toBe("Missions · All projects · Mimir"));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Missions page" })),
    );
  });

  it("disables the project picker on global pages", async () => {
    renderLayout(mockClient(), "/settings");
    await screen.findByText("Settings page");
    expect((screen.getByRole("button", { name: /^Project:/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
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
      await waitFor(() => expect(document.title).toBe("Overview · All projects · Mimir"));
      await userEvent.keyboard("gm");
      expect(document.title).toBe("Overview · All projects · Mimir");
      await userEvent.keyboard("?");
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      localStorage.removeItem("mimir.shortcuts");
    }
  });
});
