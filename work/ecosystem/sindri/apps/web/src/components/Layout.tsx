import { getTerm, glossary, NAV, screenHref, termHref } from "@factory/docs";
import {
  AppShell,
  Button,
  Dialog,
  Drawer,
  GlossaryProvider,
  GuideChat,
  Icon,
  KeyValue,
  Link,
  LinkProvider,
  Tooltip,
  useNarrow,
  type ConnectionState,
  type GlobalLink,
  type GlossaryEntry,
  type LinkProps,
  type NavTab,
} from "@factory/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { switcherApps } from "../config.js";
import { useApi, useLive, useReportError, useStore } from "../store/context.js";
import type { View } from "../store/reducer.js";
import { appHref, routeHash } from "../store/route.js";
import { ApprovalUnlock } from "./ApprovalUnlock.js";

/** Top-bar project tabs and bottom-bar global pages, labels and groups from `@factory/docs` NAV. */
const NAV_SINDRI = NAV.sindri;
const label = (id: string) => NAV_SINDRI.find((s) => s.id === id)?.label ?? id;

export const TOP_VIEWS: readonly View[] = [
  "overview",
  "inbox",
  "director",
  "specs",
  "plans",
  "runs",
  "needs-you",
  "deliveries",
  "knowledge",
  "autonomy",
  "project-settings",
];
export const GLOBAL_VIEWS: readonly View[] = ["projects", "harnesses", "autonomy-all", "settings"];
const GLOBAL_ICONS: Partial<Record<View, GlobalLink["icon"]>> = {
  projects: "folder",
  harnesses: "check",
  "autonomy-all": "info",
  settings: "settings",
};

/** Every view with its visible name (document title, shortcuts, tests). */
export const VIEWS: { view: View; label: string }[] = [
  ...TOP_VIEWS,
  ...GLOBAL_VIEWS,
  "docs" as View,
].map((view) => ({ view, label: label(view) }));

const isGlobal = (v: View) => GLOBAL_VIEWS.includes(v);

/** Alt+1..9 then Alt+0 switch the first ten project tabs (outside text fields). */
const SHORTCUT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

/** Glossary for InfoHints: concept terms plus their aliases (so `term="Index"` resolves). */
const GLOSSARY: GlossaryEntry[] = glossary
  .filter((e) => e.category !== "status")
  .flatMap((e) => [e, ...e.aliases.map((a) => ({ ...e, term: a }))]);
const glossaryHref = (term: string) => {
  const e = getTerm(term);
  return e ? termHref(e) : "/docs/glossary";
};

export function NoticeRegion() {
  const { state, dispatch } = useStore();
  const n = state.notice;
  const box = (kind: "info" | "error", text: string) => (
    <div
      className={`mt-4 flex items-start justify-between gap-4 rounded-md border p-3 text-sm ${
        kind === "error"
          ? "border-danger-border bg-danger-bg text-fg"
          : "border-success-border bg-success-bg text-fg"
      }`}
    >
      <p className="min-w-0 break-words">
        <span
          className={`font-semibold ${kind === "error" ? "text-danger-fg" : "text-success-fg"}`}
        >
          {kind === "error" ? "Error: " : "Done: "}
        </span>
        {text}
      </p>
      <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "notice/dismiss" })}>
        Dismiss
      </Button>
    </div>
  );
  // Errors are assertive and stay until dismissed (audit S-I5); confirmations are polite.
  return (
    <>
      <div aria-live="polite" role="status">
        {n && n.kind !== "error" ? box(n.kind, n.text) : null}
      </div>
      <div role="alert">{n && n.kind === "error" ? box("error", n.text) : null}</div>
    </>
  );
}

/** Routes every library link through the hash router; `/docs/…` links open the Docs view. */
export function SindriLinks(props: { children: ReactNode }) {
  const { state } = useStore();
  const projectId = state.projectId;
  const render = useCallback(
    (p: LinkProps) => {
      const hash = appHref(p.href, projectId);
      return <a {...p} href={hash ?? p.href} />;
    },
    [projectId],
  );
  return (
    <LinkProvider render={render}>
      <GlossaryProvider entries={GLOSSARY} docsHref={glossaryHref}>
        {props.children}
      </GlossaryProvider>
    </LinkProvider>
  );
}

/** The bottom bar's state is the change stream's: Live means pages update as Sindri changes. */
function useConnection(): { state: ConnectionState; detail: string; reconnect: () => void } {
  const live = useLive();
  const host = location.host || "local";
  return {
    state: live.state,
    detail: !live.streaming
      ? live.state === "live"
        ? `Connected to ${host}; this server has no live updates, so reload to refresh`
        : "Cannot reach the Sindri server; showing what was loaded last"
      : live.state === "live"
        ? `Live: pages update as Sindri changes (${host})`
        : live.state === "offline"
          ? "Cannot reach the Sindri server; showing what was loaded last"
          : live.state === "reconnecting"
            ? "Lost the live connection to Sindri; reconnecting"
            : "Connecting to the Sindri server…",
    reconnect: live.reconnect,
  };
}

/** Items waiting for the operator in this project (approvals, escalations, budget blocks). */
function useNeedsYouCount(projectId: string | null, view: View): number | undefined {
  const api = useApi();
  const { version } = useLive();
  const [count, setCount] = useState<number>();
  useEffect(() => {
    if (!projectId) return setCount(undefined);
    let live = true;
    api.reviews(projectId).then(
      // A partial answer (older server) counts what it has instead of throwing.
      (r) =>
        live &&
        setCount(
          (r.approvals?.length ?? 0) + (r.escalations?.length ?? 0) + (r.budgetAlerts?.length ?? 0),
        ),
      () => live && setCount(undefined),
    );
    return () => {
      live = false;
    };
    // Refreshed on every navigation and every change Sindri reports.
  }, [api, projectId, view, version]);
  return count;
}

const RECENT_KEY = "sindri.recentProjects";
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** The last five projects picked here, newest first, for the picker's Recent group. */
function useRecentProjects(projectId: string | null): string[] {
  const [recent, setRecent] = useState(readRecent);
  useEffect(() => {
    if (!projectId) return;
    setRecent((r) => {
      const next = [projectId, ...r.filter((id) => id !== projectId)].slice(0, 5);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: Recent lasts for this page only */
      }
      return next;
    });
  }, [projectId]);
  return recent;
}

function SessionContent(props: { onChange: () => void }) {
  const api = useApi();
  if (api.hasApprovalSession())
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="font-semibold">Operator unlocked</p>
        <p className="text-muted">
          Approvals and gated actions are available in this tab until it closes or you lock them
          again.
        </p>
        <Button
          variant="secondary"
          size="sm"
          icon="lock"
          onClick={() => {
            api.forgetApproval();
            props.onChange();
          }}
        >
          Lock approvals
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-semibold">Read-only for approvals</p>
      <p className="text-muted">
        You can browse and draft. Approving specs and plans, deciding gated actions and changing
        modes needs the approval pairing code.
      </p>
      <ApprovalUnlock id="session-approval-code" onUnlocked={props.onChange} />
    </div>
  );
}

function ShortcutsDialog(props: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Keyboard shortcuts"
      description="Shortcuts work outside text fields."
    >
      <KeyValue
        items={[
          ...TOP_VIEWS.slice(0, SHORTCUT_KEYS.length).map((v, i) => ({
            label: `Alt+${SHORTCUT_KEYS[i]}`,
            value: label(v),
          })),
          { label: "?", value: "Show this list" },
        ]}
      />
    </Dialog>
  );
}

export function Layout(props: { children: ReactNode }) {
  const { state, dispatch } = useStore();
  const api = useApi();
  const report = useReportError();
  const [askOpen, setAskOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [, setSessionTick] = useState(0);
  const connection = useConnection();
  const needsYou = useNeedsYouCount(state.projectId, state.view);
  const recent = useRecentProjects(state.projectId);
  const narrow = useNarrow();

  // The project picker needs the list on every screen, not only on Projects (which loads and
  // refreshes it itself). Reloaded when Sindri reports a change, so new projects appear.
  const { version } = useLive();
  // Failures are reported until a list has loaded once; later refreshes fail quietly.
  const projectsLoaded = useRef(false);
  useEffect(() => {
    if (state.view === "projects") return;
    // A slow answer to an older refresh, success or failure, must not act after a newer one.
    let current = true;
    api.listProjects().then(
      (projects) => {
        if (!current) return;
        projectsLoaded.current = true;
        dispatch({ type: "projects/loaded", projects });
      },
      (err: unknown) => {
        if (current && !projectsLoaded.current) report(err);
      },
    );
    return () => {
      current = false;
    };
  }, [api, version]);

  // A Guide link (or any navigation) closes the Ask drawer so the screen is visible.
  useEffect(() => setAskOpen(false), [state.view, state.projectId]);

  // Keyboard-first: Alt+1..9, Alt+0 switch project tabs; "?" lists the shortcuts. `code` keeps
  // Alt working where it changes the produced character (macOS).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal keys while the user types (audit S-I4).
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "?" && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const digit = /^Digit(\d)$/.exec(e.code)?.[1] ?? e.key;
      const v = TOP_VIEWS[SHORTCUT_KEYS.indexOf(digit)];
      if (v && SHORTCUT_KEYS.includes(digit)) {
        e.preventDefault();
        dispatch({ type: "navigate", view: v });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  const projectId = state.projectId;
  const hashFor = (view: View) =>
    routeHash({
      view,
      projectId,
      specId: null,
      planId: null,
      executionId: null,
      deliveryId: null,
      docsSlug: null,
      docsSection: null,
    });
  // Wide screens: Project settings is a gear at the right end of the top bar, so the ten work
  // tabs fit at 1440px; phones list it in the page menu with the other tabs.
  const tabViews = narrow ? TOP_VIEWS : TOP_VIEWS.filter((v) => v !== "project-settings");
  const tabs: NavTab[] = tabViews.map((view) => ({
    id: view,
    label: label(view),
    href: hashFor(view),
    group: NAV_SINDRI.find((s) => s.id === view)?.group ?? undefined,
    ...(view === "needs-you" && needsYou ? { count: needsYou } : {}),
  }));
  const globalLinks: GlobalLink[] = GLOBAL_VIEWS.map((view) => ({
    id: view,
    label: label(view),
    href: hashFor(view),
    icon: GLOBAL_ICONS[view],
  }));
  const apps = useMemo(() => switcherApps(projectId), [projectId]);
  const docsHref =
    (state.view === "docs" ? null : screenHref("sindri", state.view)) ?? "/docs/sindri-screens";
  const pageTitle = label(state.view);

  return (
    <AppShell
      appName="Sindri"
      pageTitle={pageTitle}
      routeKey={state.view}
      apps={apps}
      currentApp="sindri"
      projects={state.projects.map((p) => ({ id: p.id, name: p.name, description: p.repoPath }))}
      projectId={projectId}
      onProjectChange={(id) => id && dispatch({ type: "project/select", projectId: id })}
      recentProjectIds={recent}
      onManageProjects={() => dispatch({ type: "navigate", view: "projects" })}
      {...(isGlobal(state.view)
        ? { projectPickerDisabledReason: "This page covers every project" }
        : {})}
      tabs={tabs}
      activeTabId={state.view}
      primaryAction={
        <Tooltip content="Project settings: execution profile, Feedback Graph, index, delete data">
          <Link
            href={hashFor("project-settings")}
            aria-label="Project settings"
            aria-current={state.view === "project-settings" ? "page" : undefined}
            className="inline-flex h-control-sm items-center gap-1.5 rounded-md border border-line px-2.5 text-sm font-medium text-muted hover:bg-hover hover:text-fg aria-[current=page]:border-accent aria-[current=page]:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <Icon name="settings" size={16} />
            <span className="max-2xl:sr-only">Project settings</span>
          </Link>
        </Tooltip>
      }
      connection={{
        state: connection.state,
        detail: connection.detail,
        onReconnect: connection.reconnect,
      }}
      session={{
        mode: api.hasApprovalSession() ? "operator" : "read-only",
        content: <SessionContent onChange={() => setSessionTick((n) => n + 1)} />,
      }}
      globalLinks={globalLinks}
      docsHref={docsHref}
      onAsk={() => setAskOpen(true)}
      onShortcuts={() => setShortcutsOpen(true)}
      onSignOut={() => dispatch({ type: "token/clear" })}
    >
      <div className="mx-auto w-full max-w-page px-4 sm:px-6">
        <NoticeRegion />
      </div>
      {props.children}
      <Drawer open={askOpen} onOpenChange={setAskOpen} title="Ask the factory">
        <AskGuide screen={state.view} title="Guide" />
      </Drawer>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </AppShell>
  );
}

/** GuideChat wired to `POST /v1/guide/ask` with the current screen and project as context. */
export function AskGuide(props: {
  screen: string;
  suggestions?: readonly string[];
  title?: string;
  intro?: ReactNode;
}) {
  const api = useApi();
  const { state } = useStore();
  const context = {
    app: "sindri" as const,
    screen: props.screen,
    ...(state.projectId ? { projectId: state.projectId } : {}),
  };
  return (
    <GuideChat
      ask={(question, ctx: typeof context) => api.askGuide(question, ctx)}
      context={context}
      {...(props.suggestions ? { suggestions: props.suggestions } : {})}
      {...(props.title ? { title: props.title } : {})}
      intro={
        props.intro ??
        "Answers come from the docs and this project's state. The Guide never changes anything; it links to where you act."
      }
    />
  );
}
