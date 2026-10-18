import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { matchPath, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { deriveAttention } from "../lib/derive.js";
import type { ThemePref } from "../lib/theme.js";
import { useThemePref } from "../lib/useTheme.js";
import { useShortcutsEnabled } from "../lib/shortcutsPref.js";
import { useShortcuts } from "../lib/useShortcuts.js";
import { useNow } from "../lib/useNow.js";
import type { Connection } from "../store/reducer.js";
import { useStore } from "../store/StoreProvider.js";
import { useSession } from "../api/session.js";
import { HelpDialog } from "./HelpDialog.js";

const NAV: readonly { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Overview", end: true },
  { to: "/projects", label: "Projects" },
  { to: "/missions", label: "Missions" },
  { to: "/crews", label: "Crews" },
  { to: "/reviews", label: "Reviews" },
  { to: "/activity", label: "Activity" },
  { to: "/settings", label: "Settings" },
];

const ROUTE_TITLES: readonly { path: string; title: string }[] = [
  { path: "/", title: "Overview" },
  { path: "/projects", title: "Projects" },
  { path: "/missions", title: "Missions" },
  { path: "/missions/:id", title: "Mission" },
  { path: "/crews", title: "Crews" },
  { path: "/crews/:id", title: "Crew" },
  { path: "/agents/:sessionId", title: "Agent" },
  { path: "/reviews", title: "Reviews" },
  { path: "/activity", title: "Activity" },
  { path: "/settings", title: "Settings" },
];

export function titleForPath(pathname: string): string {
  const hit = ROUTE_TITLES.find((r) => matchPath({ path: r.path, end: true }, pathname));
  return hit ? hit.title : "Not found";
}

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
};

export function Layout() {
  const { state, refresh, reconnect } = useStore();
  const { signOut } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  const [shortcutsOn] = useShortcutsEnabled();
  const [helpOpen, setHelpOpen] = useState(false);
  const [theme, setTheme] = useThemePref();
  const now = useNow(30_000);
  const attention = useMemo(() => deriveAttention(state, now), [state, now]);
  const pendingReviews = state.approvals.filter((a) => a.status === "pending").length;

  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const go = useCallback((path: string) => void navigate(path), [navigate]);
  // Suspended while the modal help dialog is open.
  useShortcuts(go, openHelp, !helpOpen && shortcutsOn);

  // Announce route changes: per-route title always, focus to main on navigation (not first load).
  useEffect(() => {
    document.title = `${titleForPath(pathname)} - Mimir`;
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [pathname]);

  return (
    <div className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="flex flex-wrap items-center gap-4 border-b border-zinc-300 px-4 py-2 dark:border-zinc-700">
        <span className="project-brand text-lg font-semibold"><span className="project-initial" aria-hidden="true">M</span>Mimir</span>
        <nav aria-label="Main">
          <ul className="flex flex-wrap gap-1">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink
                  to={n.to}
                  end={n.end ?? false}
                  className={({ isActive }) =>
                    `rounded px-2 py-1 ${isActive ? "bg-zinc-200 font-semibold dark:bg-zinc-800" : "hover:underline"}`
                  }
                >
                  {n.label}
                  {n.to === "/reviews" && pendingReviews > 0 ? ` (${pendingReviews})` : ""}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span data-testid="connection" role="status" className="text-sm">
            <span aria-hidden="true">{state.connection === "open" ? "● " : "○ "}</span>
            {CONNECTION_LABEL[state.connection]}
          </span>
          {state.connection === "closed" && (
            <button type="button" className="btn" onClick={reconnect}>
              Reconnect
            </button>
          )}
          <label className="text-sm">
            <span className="mr-1">Theme</span>
            <select
              aria-label="Theme"
              className="input"
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemePref)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={openHelp}
            aria-label="Keyboard shortcuts help"
          >
            ?
          </button>
          <button type="button" className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      {state.gap && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-amber-700 bg-amber-50 px-4 py-2 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >
          <span>
            The live stream may have missed events{state.gap.reason ? ` (${state.gap.reason})` : ""}
            . Views may be stale; reload the snapshot to catch up.
          </span>
          <button type="button" className="btn" onClick={() => void refresh()}>
            Reload snapshot
          </button>
        </div>
      )}
      {state.refreshError !== null && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-red-700 bg-red-50 px-4 py-2 text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          <span>Could not refresh data: {state.refreshError}. Showing the last loaded data.</span>
          <button type="button" className="btn" onClick={() => void refresh()}>
            Retry
          </button>
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
      <main id="main" ref={mainRef} tabIndex={-1} className="mx-auto max-w-7xl p-4">
        <Outlet />
      </main>
      {helpOpen && <HelpDialog onClose={closeHelp} />}
    </div>
  );
}
