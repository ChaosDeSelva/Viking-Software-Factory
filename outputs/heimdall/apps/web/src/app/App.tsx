// Heimdall's frame: sign-in, the snapshot stream, the selected project (in the URL), the shared
// AppShell (project tabs on top, global pages and status at the bottom), the inspector drawer,
// the command dialog, the Guide drawer, the jump palette and the shortcuts dialog.
import { screenHref } from "@factory/docs";
import {
  AppShell,
  Button,
  Callout,
  CommandPalette,
  Dialog,
  Drawer,
  GuideChat,
  KeyValue,
  useCommandShortcut,
  useToast,
  type CommandItem,
  type ConnectionState,
  type GlobalLink,
  type NavTab,
  type ToastInput,
} from "@factory/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  askGuide,
  post,
  setUnauthorizedHandler,
  unauthorized,
  type CommandHooks,
  type R,
} from "../lib/api";
import {
  GLOBAL_PAGES,
  hrefFor,
  navigate,
  setParams,
  useRoute,
  type PageId,
} from "../lib/router";
import { scopeOf, scopedNotifications } from "../features/scope";
import {
  projectAliases,
  projectKey,
  recordLabel,
  repoKey,
} from "../features/workflowState";
import { sindriProjectOf } from "../features/profileForm";
import { HeimdallContext, type Heimdall, type Session } from "./context";
import { commandErrorText } from "../features/workKinds";
import { CommandDialog } from "./CommandDialog";
import { Inspector } from "./Inspector";
import { Login } from "./Login";
import { OverviewPage, guideSuggestions } from "../pages/Overview";
import { PipelinePage } from "../pages/Pipeline";
import { CrewsPage } from "../pages/Crews";
import { GraphPage } from "../pages/GraphPage";
import { ActivityPage } from "../pages/Activity";
import { QualityPage, qualityCount } from "../pages/Quality";
import { DocsPage } from "../pages/Docs";
import { AutonomyAllPage, AutonomyPage } from "../features/Autonomy";
import { FleetPage } from "../features/Fleet";
import { ProjectsPage } from "../features/Projects";
import {
  ConnectionsPage,
  NotificationsPage,
  PairForm,
  UnlockForm,
  useDesktopAlerts,
} from "../features/Operator";
import { NewWorkPage } from "../features/Workflow";
import { switcherApps } from "../lib/apps";

const TABS: { id: PageId; label: string; group: string }[] = [
  { id: "overview", label: "Overview", group: "Watch" },
  { id: "pipeline", label: "Pipeline", group: "Watch" },
  { id: "crews-agents", label: "Crews & agents", group: "Watch" },
  { id: "execution-graph", label: "Execution graph", group: "Watch" },
  { id: "activity", label: "Activity", group: "Watch" },
  { id: "quality-approvals", label: "Quality & approvals", group: "Decide" },
  { id: "autonomy", label: "Autonomy", group: "Decide" },
];
const GLOBALS: { id: PageId; label: string; icon: GlobalLink["icon"] }[] = [
  { id: "notifications", label: "Notifications", icon: "inbox" },
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "connections", label: "Connections", icon: "settings" },
  { id: "fleet", label: "Fleet", icon: "apps" },
  { id: "autonomy-all", label: "Autonomy (all)", icon: "info" },
];
export const PAGE_TITLES: Record<PageId, string> = {
  ...(Object.fromEntries(
    [...TABS, ...GLOBALS].map((t) => [t.id, t.label]),
  ) as Record<PageId, string>),
  "new-work": "New work",
  docs: "Docs",
};

const readLocal = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the URL still carries the project.
  }
};
// The old app kept its theme under its own key; carry it over once to the shared one.
if (!readLocal("factory-theme") && readLocal("heimdall-theme"))
  writeLocal("factory-theme", readLocal("heimdall-theme")!);

/** Hands the shell's toast function out of its provider. */
function ToastBridge({
  bind,
}: {
  bind: (t: (input: ToastInput) => void) => void;
}) {
  const toast = useToast();
  useEffect(() => bind(toast), [toast]);
  return null;
}

export function App() {
  const route = useRoute();
  const [checked, setChecked] = useState(false),
    [authenticated, setAuthenticated] = useState(false),
    [loginError, setLoginError] = useState(""),
    [state, setState] = useState<R | null>(null),
    [session, setSession] = useState<Session>({}),
    [stream, setStream] = useState<ConnectionState>("connecting"),
    [streamKey, setStreamKey] = useState(0),
    [command, setCommand] = useState<R | null>(null),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [commandError, setCommandError] = useState(""),
    [reloadKey, setReloadKey] = useState(0),
    [profileSaved, setProfileSaved] = useState<{
      id: string;
      harness: R | null;
    } | null>(null),
    [askOpen, setAskOpen] = useState(false),
    [jumpOpen, setJumpOpen] = useState(false),
    [shortcutsOpen, setShortcutsOpen] = useState(false),
    [storedProject, setStoredProject] = useState(
      () => readLocal("heimdall-project") ?? "all",
    ),
    [recent, setRecent] = useState<string[]>(() => {
      try {
        return JSON.parse(readLocal("heimdall-recent-projects") ?? "[]");
      } catch {
        return [];
      }
    });
  const toast = useRef<((t: ToastInput) => void) | null>(null);
  const rows = useRef(new Map<string, R>());
  const commandAttempt = useRef<{ payload: string; key: string } | null>(null);
  const commandHooks = useRef<CommandHooks>({});

  const notify = useCallback(
    (message: string, tone: ToastInput["tone"] = "info") => {
      toast.current?.({ title: message, tone });
    },
    [],
  );
  const refreshSession = useCallback(async () => {
    setSession(await api("session"));
  }, []);

  useEffect(() => {
    api("session")
      .then((s) => {
        setSession(s);
        setAuthenticated(true);
      })
      .catch(() => {})
      .finally(() => setChecked(true));
    // A source's own 401 is relayed with the same status, so only Heimdall's session decides.
    setUnauthorizedHandler(
      () =>
        void fetch("/api/session")
          .then((r) => {
            if (r.status !== 401) return;
            setAuthenticated(false);
            setState(null);
            setCommand(null);
            setLoginError("Your session ended. Sign in again.");
          })
          .catch(() => {}),
    );
    return () => setUnauthorizedHandler(null);
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    api("snapshot")
      .then(setState)
      .catch((e) => notify(e.message, "danger"));
    setStream("connecting");
    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => {
      setState(JSON.parse((e as MessageEvent).data));
      setStream("live");
    });
    es.onerror = () => {
      setStream("reconnecting");
      unauthorized();
    };
    return () => es.close();
  }, [authenticated, streamKey]);

  // The project: `?project=` wins (bookmarks, links from the other apps), then the last choice.
  const all = useMemo(() => scopeOf(state, "all"), [state]);
  const resolveProject = (value: string | null) => {
    if (!value || value === "all") return "all";
    const p = all.activeProjects.find(
      (row) =>
        row.id === value ||
        // A remembered key may still carry an older Sindri row's trailing slash.
        projectKey(row) === repoKey(value) ||
        projectAliases(row, all.sindriProjects).includes(value),
    );
    return p ? projectKey(p) : "all";
  };
  const urlProject = route.params.get("project");
  const selection = resolveProject(urlProject ?? storedProject);
  const scope = useMemo(() => scopeOf(state, selection), [state, selection]);
  const selected = scope.filter === "all" ? null : scope.projects[0];
  const urlId = selected?.id ?? null;
  // Put the remembered project in the URL so the address can be bookmarked as shown.
  useEffect(() => {
    if (state && urlId && urlProject !== urlId)
      setParams({ project: urlId }, { replace: true });
  }, [state, urlId, urlProject]);
  const setProject = useCallback(
    (key: string) => {
      setStoredProject(key);
      writeLocal("heimdall-project", key);
      if (key !== "all") {
        const next = [key, ...recent.filter((k) => k !== key)].slice(0, 5);
        setRecent(next);
        writeLocal("heimdall-recent-projects", JSON.stringify(next));
      }
      const row = all.activeProjects.find((p) => projectKey(p) === key);
      setParams(
        { project: key === "all" ? null : (row?.id ?? key) },
        { replace: true },
      );
    },
    [all, recent],
  );
  const href = useCallback(
    (
      page: PageId,
      params: Record<string, string | null | undefined> = {},
      sub = "",
    ) => hrefFor(page, { project: urlId, ...params }, sub),
    [urlId],
  );

  const open = useCallback((kind: string, row: R) => {
    const id = String(row.id ?? row.eventId);
    rows.current.set(kind + ":" + id, row);
    setParams({ inspect: kind + ":" + id });
  }, []);
  // `?task=` (old links) is closed with the drawer too, so it cannot reopen it.
  const closeInspector = () =>
    setParams({ inspect: null, task: null }, { replace: true });

  const propose = useCallback(
    (
      action: string,
      id: string,
      body: R = {},
      extra: R = {},
      hooks: CommandHooks = {},
    ) => {
      commandAttempt.current = null;
      commandHooks.current = hooks;
      setCommand({ action, id, body, ...extra });
      setReason("");
      setCommandError("");
    },
    [],
  );
  async function execute() {
    if (!command || busy) return;
    setBusy(true);
    setCommandError("");
    try {
      const payload = JSON.stringify({
        ...command,
        body: {
          ...command.body,
          ...("reason" in command.body &&
          !command.action.startsWith("supervisor.")
            ? { reason }
            : {}),
        },
        reason,
      });
      // A resend of the same request keeps its key, so the source answers it only once.
      if (commandAttempt.current?.payload !== payload)
        commandAttempt.current = { payload, key: crypto.randomUUID() };
      const result = await api("commands", {
        method: "POST",
        headers: { "idempotency-key": commandAttempt.current.key },
        body: payload,
      });
      const r = result.result;
      // Confirmed: from here on nothing counts as a command failure.
      setCommand(null);
      commandHooks.current.onSuccess?.(r);
      notify(
        "Source confirmed the request. Current state is shown.",
        "success",
      );
      try {
        setState(await api("snapshot"));
      } catch (e) {
        notify(
          `The request was confirmed, but the current state could not be read (${(e as Error).message}). It updates again from the live stream.`,
          "warning",
        );
      }
      // The open record may have changed even when the command returns no record of its own.
      setReloadKey((n) => n + 1);
      if (command.action === "project.profile")
        setProfileSaved({ id: command.id, harness: r?.harness ?? null });
      // A started run also returns its plan, so test for the run first.
      if (r?.execution) navigate(hrefFor("pipeline", { project: urlId }));
      else if (r?.spec) open("specs", r.spec);
      else if (r?.plan) open("plans", r.plan);
      else if (r?.project) open("projects", r.project);
      else if (r?.intake) open("intakes", r.intake);
      else if (r?.artifactId)
        open("artifact", {
          id: r.artifactId,
          title: "Verification recheck",
          ...r,
        });
    } catch (e) {
      if (commandHooks.current.onError?.(e as Error)) {
        setCommand(null);
        return;
      }
      setCommandError(commandErrorText(e as Error & R));
      // Decided elsewhere meanwhile: show the current decision behind the dialog.
      if ((e as R).code === "already_decided") {
        void api("snapshot").then(setState, () => {});
        setReloadKey((n) => n + 1);
      }
      if ((e as R).code === "pairing_required") {
        // Sindri keeps its refusal for this key, so the attempt after pairing needs a new one.
        commandAttempt.current = null;
        void refreshSession().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }

  const savePreferences = useCallback(async (value: R) => {
    try {
      const r = await post("preferences", value);
      setState((old) => (old ? { ...old, preferences: r.preferences } : old));
      notify("Preferences saved on this Mac.", "success");
      return true;
    } catch (e) {
      notify((e as Error).message, "danger");
      return false;
    }
  }, []);

  const inspectNotification = (kind: string, row: R) =>
    kind === "connection"
      ? navigate(href("connections", {}, "services"))
      : open(kind, row);
  useDesktopAlerts(
    // Undefined until the first snapshot, so its backlog primes the alerts instead of firing them.
    state?.notifications,
    !!state?.preferences?.desktopNotifications,
    inspectNotification,
    // Only what the badge counts: an archived project's news stays quiet.
    (n) => scopedNotifications([n], all).length > 0,
  );

  const page = route.page;
  const global = GLOBAL_PAGES.includes(page);
  useCommandShortcut(() => setJumpOpen(true), authenticated && !command);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        t &&
        (t.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
      )
        return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [page, route.sub]);

  const context: Heimdall = {
    api,
    session,
    refreshSession,
    state,
    scope,
    projectName: selected?.name ?? null,
    setProject,
    propose,
    open,
    reloadKey,
    profileSaved,
    notify,
    savePreferences,
    href,
  };

  if (!checked) return null;
  if (!authenticated)
    return (
      <Login
        error={loginError}
        onSignedIn={async () => {
          setLoginError("");
          setSession(await api("session"));
          setAuthenticated(true);
        }}
      />
    );

  const sources: [string, R][] = Object.entries(state?.sources ?? {});
  const offline = sources
    .filter(([, v]) => v.status === "disconnected")
    .map(([k]) => k);
  const unread = scopedNotifications(state?.notifications ?? [], all).filter(
    (n) => !n.seen,
  ).length;
  const tabs: NavTab[] = TABS.map((t) => ({
    ...t,
    href: href(t.id),
    count: t.id === "quality-approvals" ? qualityCount(scope) : undefined,
  }));
  const globalLinks: GlobalLink[] = GLOBALS.map((g) => ({
    ...g,
    href: href(g.id),
    count: g.id === "notifications" ? unread : undefined,
  }));
  const inspect = route.params.get("inspect");
  const pageBody: Record<PageId, () => ReactNode> = {
    overview: () => <OverviewPage onAsk={() => setAskOpen(true)} />,
    "new-work": () => <NewWorkPage />,
    pipeline: () => <PipelinePage />,
    "crews-agents": () => <CrewsPage />,
    "execution-graph": () => <GraphPage />,
    activity: () => <ActivityPage />,
    "quality-approvals": () => <QualityPage />,
    autonomy: () => <AutonomyPage />,
    notifications: () => <NotificationsPage />,
    projects: () => <ProjectsPage />,
    connections: () => <ConnectionsPage section={route.sub || "services"} />,
    fleet: () => <FleetPage />,
    "autonomy-all": () => <AutonomyAllPage />,
    docs: () => <DocsPage slug={route.sub} />,
  };
  const guideContext = {
    app: "heimdall" as const,
    screen: page,
    ...(selected
      ? {
          projectId:
            sindriProjectOf(selected, all.sindriProjects)?.id ?? selected.id,
        }
      : {}),
  };
  const jumpItems: CommandItem[] = [
    ...[
      ...TABS,
      ...GLOBALS,
      { id: "new-work" as PageId, label: "New work" },
      { id: "docs" as PageId, label: "Docs" },
    ].map((t) => ({
      id: "page:" + t.id,
      label: t.label,
      group: "Pages",
      run: () => navigate(href(t.id)),
    })),
    ...all.activeProjects.map((p) => ({
      id: "project:" + p.id,
      label: String(p.name ?? p.id),
      description: p.repoPath,
      group: "Projects",
      icon: "folder" as const,
      run: () => setProject(projectKey(p)),
    })),
    ...scope.tasks.map((t) => ({
      id: "task:" + t.id,
      label: String(recordLabel(t)),
      description: t.status,
      group: "Tasks",
      keywords: t.id,
      run: () => open("tasks", t),
    })),
  ];

  return (
    <HeimdallContext.Provider value={context}>
      <AppShell
        appName="Heimdall"
        pageTitle={PAGE_TITLES[page]}
        routeKey={page + "/" + route.sub}
        apps={switcherApps(href("overview"))}
        currentApp="heimdall"
        projects={all.activeProjects.map((p) => ({
          id: projectKey(p),
          name: String(p.name ?? p.id),
          description: p.repoPath,
        }))}
        projectId={selection === "all" ? null : selection}
        onProjectChange={(id) => setProject(id ?? "all")}
        recentProjectIds={recent}
        allowAllProjects
        onManageProjects={() => navigate(href("projects"))}
        projectPickerDisabledReason={
          global ? "This page covers all projects" : undefined
        }
        tabs={tabs}
        activeTabId={page}
        primaryAction={
          <Button
            variant="primary"
            icon="plus"
            onClick={() => navigate(href("new-work"))}
          >
            New work
          </Button>
        }
        connection={{
          state: stream,
          detail: [
            "Local · " + location.host,
            ...sources.map(
              ([k, v]) =>
                `${k === "mimir" ? "Mimir" : "Sindri"} ${v.status ?? "unknown"}`,
            ),
          ].join(" · "),
          onReconnect: () => setStreamKey((k) => k + 1),
        }}
        session={{
          mode: session.operator ? "operator" : "read-only",
          content: (
            <div className="flex flex-col gap-4">
              <UnlockForm />
              <PairForm />
            </div>
          ),
        }}
        globalLinks={globalLinks}
        docsHref={
          screenHref("heimdall", page === "docs" ? "overview" : page) ?? "/docs"
        }
        onAsk={() => setAskOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onSignOut={() =>
          void post("logout", {}).then(() => {
            setAuthenticated(false);
            setState(null);
          })
        }
      >
        <ToastBridge bind={(t) => (toast.current = t)} />
        {(offline.length > 0 ||
          stream === "reconnecting" ||
          sources.some(([, v]) => v.gap)) && (
          <div className="mx-auto flex w-full max-w-page flex-col gap-2 px-4 pt-6 sm:px-6">
            {offline.length > 0 && (
              <Callout
                tone="warning"
                title={`${offline.map((s) => (s === "mimir" ? "Mimir" : "Sindri")).join(" and ")} disconnected`}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      navigate(href("connections", {}, "services"))
                    }
                  >
                    Check connections
                  </Button>
                }
              >
                <span role="status">
                  A source is disconnected. Its last snapshot is retained and
                  may be stale.
                </span>
              </Callout>
            )}
            {sources.map(
              ([name, v]) =>
                v.gap && (
                  <Callout key={name} tone="warning">
                    {name === "mimir" ? "Mimir" : "Sindri"}: {String(v.gap)}
                  </Callout>
                ),
            )}
          </div>
        )}
        {state ? (
          pageBody[page]()
        ) : (
          <div
            className="mx-auto w-full max-w-page px-4 py-8 sm:px-6"
            role="status"
          >
            <p className="text-md text-muted">Loading the first snapshot…</p>
          </div>
        )}
      </AppShell>
      {inspect && state && (
        <Inspector
          inspect={inspect}
          cached={rows.current.get(inspect)}
          onClose={closeInspector}
        />
      )}
      <CommandDialog
        command={command}
        reason={reason}
        setReason={setReason}
        busy={busy}
        error={commandError}
        onCancel={() => setCommand(null)}
        onSend={() => void execute()}
      />
      <Drawer
        open={askOpen}
        onOpenChange={setAskOpen}
        title="Ask the guide"
        description="Answers from the docs and this project's state. The guide never makes changes; it tells you where to act."
      >
        <GuideChat
          title="Guide"
          ask={askGuide}
          context={guideContext}
          suggestions={guideSuggestions(scope)}
        />
      </Drawer>
      <CommandPalette
        open={jumpOpen}
        onOpenChange={setJumpOpen}
        items={jumpItems}
        title="Jump to"
      />
      <Dialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        title="Keyboard shortcuts"
        size="sm"
        footer={
          <Button variant="secondary" onClick={() => setShortcutsOpen(false)}>
            Close
          </Button>
        }
      >
        <KeyValue
          items={[
            { label: "⌘ K / Ctrl K", value: "Jump to a page, project or task" },
            { label: "?", value: "Show these shortcuts" },
            { label: "Esc", value: "Close the inspector or a dialog" },
            {
              label: "Alt + arrows",
              value: "Move the focused node in the execution graph",
            },
            { label: "Enter", value: "Open the focused graph node or row" },
          ]}
        />
      </Dialog>
    </HeimdallContext.Provider>
  );
}
