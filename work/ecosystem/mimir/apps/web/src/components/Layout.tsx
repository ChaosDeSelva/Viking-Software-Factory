import {
  AppShell,
  Button,
  Callout,
  IconButton,
  type ConnectionState,
  type NavTab,
} from "@factory/ui";
import { useCallback, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useSession } from "../api/session.js";
import { deriveAttention } from "../lib/derive.js";
import { docsHrefFor, routeFor } from "../lib/docs.js";
import { attentionInScope, useProjectScope, useScoped } from "../lib/scope.js";
import { useShortcutsEnabled } from "../lib/shortcutsPref.js";
import { useShortcuts } from "../lib/useShortcuts.js";
import { useNow } from "../lib/useNow.js";
import { HelpDialog } from "./HelpDialog.js";
import type { Connection } from "../store/reducer.js";
import { useStore } from "../store/StoreProvider.js";
import { FACTORY_APPS } from "./apps.js";
import { AskDrawer } from "./AskDrawer.js";

const CONNECTION: Record<Connection, ConnectionState> = {
  connecting: "connecting",
  open: "live",
  reconnecting: "reconnecting",
  closed: "offline",
};

/** Which top tab a route belongs to (detail pages light their list's tab). */
function activeTab(pathname: string): string | undefined {
  if (pathname === "/") return "overview";
  if (pathname.startsWith("/missions") || pathname.startsWith("/agents")) return "missions";
  if (pathname.startsWith("/crews")) return "crews";
  if (pathname.startsWith("/reviews")) return "reviews";
  if (pathname.startsWith("/activity")) return "activity";
  return undefined;
}

const GLOBAL_PATHS = ["/projects", "/settings", "/docs"];

export function Layout() {
  const { state, refresh, reconnect } = useStore();
  const { signOut } = useSession();
  const { projectId, setProjectId } = useProjectScope();
  const scoped = useScoped();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [shortcutsOn] = useShortcutsEnabled();
  const [helpOpen, setHelpOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const now = useNow(30_000);
  const route = routeFor(pathname);

  const attention = useMemo(
    () => deriveAttention({ ...state, ...scoped }, now).filter((i) => attentionInScope(i, scoped)),
    [state, scoped, now],
  );
  const pendingReviews = scoped.approvals.filter((a) => a.status === "pending").length;

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const go = useCallback((path: string) => void navigate(path), [navigate]);
  // Suspended while a modal is open.
  useShortcuts(go, openHelp, !helpOpen && !askOpen && shortcutsOn);

  const tabs: NavTab[] = [
    { id: "overview", label: "Overview", href: "/" },
    { id: "missions", label: "Missions", href: "/missions" },
    { id: "crews", label: "Crews", href: "/crews" },
    { id: "reviews", label: "Reviews", href: "/reviews", count: pendingReviews },
    { id: "activity", label: "Activity", href: "/activity" },
  ];
  const global = GLOBAL_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <AppShell
      appName="Mimir"
      pageTitle={route?.title ?? "Not found"}
      routeKey={pathname}
      apps={FACTORY_APPS}
      currentApp="mimir"
      projects={state.projects.map((p) => ({ id: p.id, name: p.name, description: p.repoPath }))}
      projectId={projectId}
      onProjectChange={setProjectId}
      allowAllProjects
      onManageProjects={() => go("/projects")}
      {...(global ? { projectPickerDisabledReason: "This page covers all projects" } : {})}
      tabs={tabs}
      activeTabId={activeTab(pathname)}
      connection={{
        state: CONNECTION[state.connection],
        detail:
          state.connection === "open"
            ? "Live: events stream in as they happen"
            : state.connection === "closed"
              ? "Disconnected: showing the last snapshot"
              : undefined,
        onReconnect: reconnect,
      }}
      session={{
        mode: "operator",
        content: (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-semibold">Signed in with the Mimir token</p>
            <p className="text-muted">
              The token allows every action: starting and cancelling missions, deciding approvals,
              raising budgets and stopping agents. Sign out in the bottom bar to forget it.
            </p>
          </div>
        ),
      }}
      globalLinks={[
        { id: "projects", label: "Projects", href: "/projects", icon: "folder" },
        { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
      ]}
      docsHref={docsHrefFor(route?.screen)}
      onAsk={() => setAskOpen(true)}
      onShortcuts={openHelp}
      onSignOut={signOut}
      extra={
        <span className="max-sm:hidden">
          <IconButton
            icon="help"
            label="Help and keyboard shortcuts"
            variant="ghost"
            size="sm"
            onClick={openHelp}
          />
        </span>
      }
    >
      {(state.gap || state.refreshError !== null) && (
        <div className="mx-auto flex w-full max-w-page flex-col gap-2 px-4 pt-4 sm:px-6">
          {state.gap && (
            <div role="alert">
              <Callout
                tone="warning"
                title="The live stream may have missed events"
                action={
                  // A gap that ended the stream (expired cursor) needs the stream reopened too.
                  <Button
                    size="sm"
                    onClick={() => (state.connection === "closed" ? reconnect() : void refresh())}
                  >
                    Reload snapshot
                  </Button>
                }
              >
                Views may be stale{state.gap.reason ? ` (${state.gap.reason})` : ""}; reload the
                snapshot to catch up.
              </Callout>
            </div>
          )}
          {state.refreshError !== null && (
            <Callout
              tone="danger"
              title="Could not refresh data"
              action={
                <Button size="sm" onClick={() => void refresh()}>
                  Retry
                </Button>
              }
            >
              {state.refreshError}. Showing the last loaded data.
            </Callout>
          )}
        </div>
      )}
      <p data-testid="attention-live" aria-live="polite" className="sr-only">
        {state.status === "ready"
          ? `${attention.length} ${attention.length === 1 ? "item needs" : "items need"} attention${
              attention.length > 0
                ? `: ${attention
                    .slice(0, 3)
                    .map((a) => a.title)
                    .join("; ")}${attention.length > 3 ? "; and more" : ""}`
                : ""
            }`
          : ""}
      </p>
      <Outlet />
      {helpOpen && <HelpDialog open onClose={() => setHelpOpen(false)} screen={route?.screen} />}
      <AskDrawer open={askOpen} onClose={() => setAskOpen(false)} screen={route?.screen} />
    </AppShell>
  );
}
