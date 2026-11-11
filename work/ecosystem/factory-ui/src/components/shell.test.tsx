import { screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectNoSeriousA11yViolations } from "../test/axe.js";
import { setup } from "../test/render.js";
import { Page, PageHeader } from "./layout.js";
import { AppShell, type AppShellProps } from "./shell.js";

const baseProps: Omit<AppShellProps, "children"> = {
  appName: "Heimdall",
  pageTitle: "Overview",
  apps: [
    { id: "sindri", label: "Sindri", href: "/sindri" },
    { id: "heimdall", label: "Heimdall", href: "/heimdall" },
  ],
  currentApp: "heimdall",
  projects: [
    { id: "p1", name: "demo-app" },
    { id: "p2", name: "acme-billing" },
  ],
  projectId: "p1",
  onProjectChange: () => undefined,
  tabs: [
    { id: "overview", label: "Overview", href: "/overview", group: "watch" },
    { id: "quality", label: "Quality & approvals", href: "/quality", group: "decide", count: 2 },
  ],
  activeTabId: "overview",
  connection: { state: "live" },
  session: { mode: "read-only" },
  globalLinks: [
    { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    { id: "fleet", label: "Fleet", href: "/fleet" },
  ],
  docsHref: "/docs",
};

function Shell(props: Partial<AppShellProps>) {
  return (
    <AppShell {...baseProps} {...props}>
      <Page>
        <PageHeader title="Overview" scope={{ project: "demo-app" }} />
      </Page>
    </AppShell>
  );
}

describe("AppShell", () => {
  it("has a skip link, project-scoped tabs in the top bar and sets the document title", async () => {
    const { container } = setup(<Shell />);
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe(
      "#main",
    );
    const nav = screen.getByRole("navigation", { name: "Project pages" });
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(nav).getByRole("link", { name: /Quality & approvals/ }).textContent).toMatch("2");
    expect(document.title).toBe("Overview · demo-app · Heimdall");
    expect(screen.getByRole("main").className).toMatch("pb-[calc(var(--bottombar-height)");
    expect(screen.getByText("Scope:")).toBeTruthy();
    await expectNoSeriousA11yViolations(container);
  });

  it("keeps global things in the fixed bottom bar", () => {
    setup(<Shell onSignOut={() => undefined} onAsk={() => undefined} />);
    const bar = screen.getByRole("contentinfo", { name: "Status and global" });
    expect(bar.className).toMatch("fixed");
    expect(within(bar).getByRole("status").textContent).toMatch("Live");
    expect(within(bar).getByRole("button", { name: "Session: Read-only" })).toBeTruthy();
    expect(within(bar).getByRole("navigation", { name: "Global pages" })).toBeTruthy();
    expect(within(bar).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs");
    expect(within(bar).getByRole("button", { name: "Ask" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: /^Theme/ })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("More opens a sheet with global links, help, theme and sign out", async () => {
    const onSignOut = vi.fn();
    const onAsk = vi.fn();
    const { user } = setup(<Shell onSignOut={onSignOut} onAsk={onAsk} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = await screen.findByRole("dialog", { name: "More" });
    expect(within(sheet).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
      "/settings",
    );
    await user.click(within(sheet).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("factory-theme")).toBe("dark");
    await user.click(within(sheet).getByRole("radio", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    await user.click(within(sheet).getByRole("button", { name: "Ask the guide" }));
    expect(onAsk).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "More" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign out" }),
    );
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("shows Reconnect while reconnecting and a session popover when given content", async () => {
    const onReconnect = vi.fn();
    const { user } = setup(
      <Shell
        connection={{ state: "reconnecting", onReconnect }}
        session={{ mode: "read-only", content: <p>Enter the operator code</p> }}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch("Reconnecting");
    await user.click(screen.getAllByRole("button", { name: "Reconnect" })[0]!);
    expect(onReconnect).toHaveBeenCalledOnce();
    await user.click(screen.getAllByRole("button", { name: "Session: Read-only" })[0]!);
    expect((await screen.findByText("Enter the operator code")).textContent).toBeTruthy();
  });

  it("switches project through the picker and moves focus to the H1 on navigation", async () => {
    const onProjectChange = vi.fn();
    function Demo() {
      const [route, setRoute] = useState("overview");
      return (
        <>
          <button type="button" onClick={() => setRoute("quality")}>
            go
          </button>
          <Shell routeKey={route} onProjectChange={onProjectChange} />
        </>
      );
    }
    const { user } = setup(<Demo />);
    await user.click(screen.getByRole("button", { name: /^Project:/ }));
    await user.click(await screen.findByRole("option", { name: /acme-billing/ }));
    expect(onProjectChange).toHaveBeenCalledWith("p2");
    await user.click(screen.getByRole("button", { name: "go" }));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Overview" }),
    );
  });

  it("app switcher lists the factory apps with the current one marked", async () => {
    const { user } = setup(<Shell />);
    await user.click(screen.getByRole("button", { name: /Switch app/ }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitem", { name: /Heimdall/ })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});
