import { Projects } from "./features/Projects";
import { canControlMission } from "./features/missionState";
import {
  RecordRow,
  TaskCard,
  MetricCard,
  FactoryPulse,
} from "./components/factory";
import {
  CommandPalette,
  useCommandShortcut,
} from "./components/CommandPalette";
import { Fleet } from "./features/Fleet";
import { ComponentCatalog } from "./components/ComponentCatalog";
import {
  Disclosure,
  DisclosureTrigger,
  CodeBlock,
  Field,
  Input,
  Button,
  Select,
  Option,
  Card,
  Progress,
  Textarea,
  StatusBadge as Badge,
  DialogSurface,
  DialogTitle,
  ScrollArea,
} from "./components/ui";
import { NavIcon } from "./features/NavIcon";
import { Graph } from "./features/Graph";
import { Workbench, PlanEditor, SpecEditor } from "./features/Workflow";
import {
  Notifications,
  useDesktopAlerts,
  ConnectionEditor,
  Telemetry,
  PipelineSettings,
} from "./features/Operator";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type R = Record<string, any>;
const titles = [
  "Overview",
  "Projects",
  "Pipeline",
  "Crews & agents",
  "Execution graph",
  "Activity",
  "Quality & approvals",
  "New work",
  "Notifications",
  "Connections",
  "Fleet & supervisors",
];
const defaultStages = [
  "Intake",
  "Specification",
  "Planning",
  "Ready",
  "Building",
  "Verification",
  "Review",
  "Completed",
  "Delivery",
];
const active = ["running", "starting", "leased", "verifying", "busy"];
const attention = ["blocked", "failed", "needs_attention", "awaiting_approval"];
const label = (r: R) =>
  r.title ??
  r.objective ??
  r.name ??
  r.template ??
  r.action ??
  (r.agentKind ? `${r.agentKind} · ${r.role}` : null) ??
  r.type ??
  r.id;
const time = (v: any) => (v ? new Date(v).toLocaleString() : "Not reported");
const ago = (v: any) =>
  v
    ? `${Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 1000))}s ago`
    : "Not reported";
async function api(path: string, options: RequestInit = {}) {
  const r = await fetch("/api/" + path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-heimdall-request": "1",
      "idempotency-key": crypto.randomUUID(),
      ...options.headers,
    },
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.message ?? `HTTP ${r.status}`);
  return data;
}
const post = (path: string, data: R) =>
  api(path, { method: "POST", body: JSON.stringify(data) });
function Raw({ data, title = "Source record" }: { data: any; title?: string }) {
  return (
    <Disclosure>
      <DisclosureTrigger>{title}</DisclosureTrigger>
      <CodeBlock>{JSON.stringify(data, null, 2)}</CodeBlock>
    </Disclosure>
  );
}
function App() {
  const [jumpOpen, setJumpOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [connectionSection, setConnectionSection] = useState("Services");
  const [auditPage, setAuditPage] = useState(0);
  const [activityPage, setActivityPage] = useState(0);
  const [crewPage, setCrewPage] = useState(0);
  const [overviewMission, setOverviewMission] = useState("latest");
  const [eventSource, setEventSource] = useState(""),
    [eventType, setEventType] = useState(""),
    [eventMission, setEventMission] = useState(""),
    [acknowledgeUntrusted, setAcknowledgeUntrusted] = useState(false);
  const [authenticated, setAuthenticated] = useState(false),
    [loginError, setLoginError] = useState(""),
    [token, setToken] = useState(""),
    [state, setState] = useState<R | null>(null),
    [page, setPage] = useState(new URLSearchParams(location.search).get("view") === "fleet" ? "Fleet & supervisors" : "Overview"),
    [search, setSearch] = useState(""),
    [project, setProject] = useState("all"),
    [selected, setSelected] = useState<R | null>(null),
    [details, setDetails] = useState<R | null>(null),
    [detailError, setDetailError] = useState(""),
    [history, setHistory] = useState<R[]>([]),
    [session, setSession] = useState<R>({}),
    [command, setCommand] = useState<R | null>(null),
    [reason, setReason] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [stream, setStream] = useState("Connecting"),
    [theme, setTheme] = useState(
      localStorage.getItem("heimdall-theme") ?? "light",
    ),
    [code, setCode] = useState(""),
    [pair, setPair] = useState(""),
    [eventRows, setEventRows] = useState<R[]>([]);
  useCommandShortcut(authenticated && !selected && !command, () =>
    setJumpOpen(true),
  );
  const linkedTask = useRef(new URLSearchParams(location.search).get("task"));
  useEffect(() => {
    if (!linkedTask.current || !state?.mimir?.tasks) return;
    const row = state.mimir.tasks.find((task: R) => task.id === linkedTask.current);
    if (row) {
      setSelected({ kind: "tasks", id: row.id, row });
      linkedTask.current = null;
      const url = new URL(location.href);
      url.searchParams.delete("task");
      window.history.replaceState(null, "", url);
    }
  }, [state]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [page]);
  const commandAttempt = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("heimdall-theme", theme);
  }, [theme]);
  useEffect(() => {
    api("session")
      .then((s) => {
        setSession(s);
        setAuthenticated(true);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    api("snapshot")
      .then(setState)
      .catch((e) => setNotice(e.message));
    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (e) => {
      setState(JSON.parse((e as MessageEvent).data));
      setStream("Live");
    });
    es.onerror = () => setStream("Reconnecting · data may be delayed");
    return () => es.close();
  }, [authenticated]);
  useEffect(() => {
    if (!selected) return;
    let gone = false;
    setDetails(null);
    setAcknowledgeUntrusted(false);
    setDetailError("");
    setHistory([]);
    const kind = selected.kind;
    const endpoint =
      kind === "artifact"
        ? `artifacts/${selected.id}`
        : ["specs", "plans", "intakes", "deliveries"].includes(kind)
          ? `details/${kind}/${selected.id}`
          : null;
    if (endpoint)
      api(endpoint)
        .then((d) => {
          if (!gone) setDetails(d);
        })
        .catch((e) => {
          if (!gone) setDetailError(e.message);
        });
    const taskId =
      kind === "tasks"
        ? selected.id
        : kind === "agents"
          ? selected.row.taskId
          : null;
    if (taskId)
      api("events?taskId=" + encodeURIComponent(taskId) + "&limit=500")
        .then((d) => {
          if (!gone) setHistory(d.events);
        })
        .catch((e) => {
          if (!gone) setDetailError(e.message);
        });
    return () => {
      gone = true;
    };
  }, [selected?.id, selected?.kind]);
  useEffect(() => {
    if (page !== "Activity" || !authenticated) return;
    setActivityPage(0);
    let gone = false;
    const timer = setTimeout(
      () =>
        api(
          "events?source=" +
            encodeURIComponent(eventSource) +
            "&type=" +
            encodeURIComponent(eventType) +
            "&missionId=" +
            encodeURIComponent(eventMission) +
            "&search=" +
            encodeURIComponent(search),
        )
          .then((d) => {
            if (!gone) setEventRows(d.events);
          })
          .catch((e) => setNotice(e.message)),
      150,
    );
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [
    page,
    search,
    eventSource,
    eventType,
    eventMission,
    state?.events?.[0]?.eventId,
  ]);
  const open = (kind: string, row: R) => {
    setSelected({ kind, id: row.id ?? row.eventId, row });
    setDetails(null);
    setAcknowledgeUntrusted(false);
  };
  function propose(action: string, id: string, body: R = {}, extra: R = {}) {
    commandAttempt.current = null;
    setCommand({ action, id, body, ...extra });
    setReason("");
    setNotice("");
  }
  async function execute() {
    if (!command || busy) return;
    setBusy(true);
    try {
      const payload = JSON.stringify({
        ...command,
        body: {
          ...command.body,
          ...("reason" in command.body && !command.action.startsWith("supervisor.") ? { reason } : {}),
        },
        reason,
      });
      if (commandAttempt.current?.payload !== payload)
        commandAttempt.current = { payload, key: crypto.randomUUID() };
      const result = await api("commands", {
        method: "POST",
        headers: { "idempotency-key": commandAttempt.current.key },
        body: payload,
      });
      setNotice("Source confirmed the request. Current state is shown below.");
      setCommand(null);
      setState(await api("snapshot"));
      setDetails(result);
      const sourceResult = result.result;
      if (sourceResult?.spec) open("specs", sourceResult.spec);
      else if (sourceResult?.plan) open("plans", sourceResult.plan);
      else if (sourceResult?.project) open("projects", sourceResult.project);
      else if (sourceResult?.intake) open("intakes", sourceResult.intake);
      else if (sourceResult?.artifactId)
        open("artifact", {
          id: sourceResult.artifactId,
          title: "Verification recheck",
          ...sourceResult,
        });
      else if (sourceResult?.execution) {
        setPage("Pipeline");
        setSelected(null);
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const preferences = state?.preferences ?? {};
  const stageOrder: string[] = preferences.stages ?? defaultStages;
  async function savePreferences(value: R) {
    try {
      const r = await post("preferences", value);
      setState((old) => (old ? { ...old, preferences: r.preferences } : old));
      setNotice("Preferences saved on this Mac.");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function inspectNotification(kind: string, row: R) {
    if (kind === "connection") {
      setPage("Connections");
      return;
    }
    open(kind, row);
  }
  useDesktopAlerts(
    state?.notifications ?? [],
    !!preferences.desktopNotifications,
    inspectNotification,
  );
  async function enableDesktop() {
    if (!("Notification" in window)) {
      setNotice("Desktop notifications are unavailable in this browser.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted")
      await savePreferences({
        desktopNotifications: !preferences.desktopNotifications,
      });
    else
      setNotice(
        "Browser notification permission was not granted. In-app alerts remain available.",
      );
  }
  if (!authenticated)
    return (
      <main className="login">
        <div className="mark">H</div>
        <p className="eyebrow">LOCAL FACTORY COMMAND CENTER</p>
        <h1>Eyes on the entire operation.</h1>
        <p>
          Sign in to Heimdall using the access token printed in its Terminal
          window.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post("login", { token });
              setToken("");
              setSession(await api("session"));
              setAuthenticated(true);
            } catch (e) {
              setLoginError((e as Error).message);
            }
          }}
        >
          <Field>
            Access token
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              required
            />
          </Field>
          <Button variant="primary" className="primary">
            Connect to factory →
          </Button>
        </form>
        {loginError && <p role="alert">{loginError}</p>}
        <small>Loopback only. Credentials remain on this Mac.</small>
      </main>
    );
  const m = state?.mimir ?? {},
    s = state?.sindri ?? {},
    allTasks: R[] = m.tasks ?? [],
    allMissions: R[] = m.missions ?? [],
    allProjects: R[] = [
      ...(m.projects ?? []).map((p: R) => ({ ...p, name: (s.projects ?? []).find((sp: R) => p.repoPath && sp.repoPath === p.repoPath)?.name ?? p.name })),
      ...(s.projects ?? []).filter(
        (sp: R) =>
          !(m.projects ?? []).some((mp: R) => mp.repoPath === sp.repoPath),
      ),
    ],
    executions: R[] = s.executions ?? [];
  const archivedProjects: string[] = preferences.archivedProjects ?? [];
  const activeProjects = allProjects.filter(p => !archivedProjects.includes(p.id));
  const visibleProjectIds = new Set(activeProjects.filter(p => project === "all" || p.id === project).map(p => p.id));
  const visibleRepos = new Set(activeProjects.filter(p => visibleProjectIds.has(p.id)).map(p => p.repoPath).filter(Boolean));
  const missions = allMissions.filter(r => visibleProjectIds.has(r.projectId));
  const missionIDs = new Set(missions.map((r) => r.id));
  const tasks = allTasks.filter((r) => missionIDs.has(r.missionId));
  const crews: R[] = (m.crews ?? []).filter((r: R) =>
    missionIDs.has(r.missionId),
  );
  const crewIDs = new Set(crews.map((r) => r.id));
  const agents: R[] = (m.agents ?? []).filter((r: R) => crewIDs.has(r.crewId));
  const sindriProjects: R[] = s.projects ?? [];
  const selectedRepo = allProjects.find((p) => p.id === project)?.repoPath;
  const sindriIDs = new Set(
    sindriProjects
      .filter((p) => visibleProjectIds.has(p.id) || (p.repoPath && visibleRepos.has(p.repoPath)))
      .map((p) => p.id),
  );
  const specs: R[] = (s.specs ?? []).filter((r: R) =>
      sindriIDs.has(r.projectId),
    ),
    plans: R[] = (s.plans ?? []).filter((r: R) => sindriIDs.has(r.projectId)),
    intakes: R[] = (s.intakes ?? []).filter((r: R) =>
      sindriIDs.has(r.projectId),
    );
  const approvals: R[] = (m.approvals ?? []).filter(
    (r: R) => r.status === "pending" && missionIDs.has(r.missionId),
  );
  const missionTitle = (mission: R) =>
    (s.specs ?? []).find((spec: R) => spec.id === executions.find(
      (e) => e.execution.mimirMissionId === mission.id,
    )?.plan?.specId)?.title ?? label(mission);
  const focusedMission = missions.find((mission) => mission.id === overviewMission) ?? missions.at(-1);
  const focusedTasks = tasks.filter((task) => task.missionId === focusedMission?.id);
  const completed = focusedTasks.filter((t) => t.status === "completed").length;
  const activeCrews = crews.filter((crew) =>
    agents.some((agent) => agent.crewId === crew.id && active.includes(agent.status)) ||
    tasks.some((task) => task.crewId === crew.id && active.includes(task.status)),
  );
  const filtered = (rows: R[]) =>
    rows.filter(
      (r) =>
        !search ||
        JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
    );
  const visibleTaskIds = new Set(tasks.map(task => task.id));
  const visibleExecutionIds = new Set(executions.filter(e => missionIDs.has(e.execution.mimirMissionId)).map(e => e.execution.id));
  const inProjectView = (row: R) => {
    if (row.projectId) return visibleProjectIds.has(row.projectId) || sindriIDs.has(row.projectId);
    if (row.missionId) return missionIDs.has(row.missionId);
    if (row.taskId) return visibleTaskIds.has(row.taskId);
    if (row.crewId) return crewIDs.has(row.crewId);
    if (row.executionId) return visibleExecutionIds.has(row.executionId);
    return project === "all";
  };
  const visibleNotifications = (state?.notifications ?? []).filter((n: R) =>
    n.kind === "connection" || (n.kind === "missions" ? missionIDs.has(n.resourceId ?? n.row?.id) :
      n.kind === "tasks" ? visibleTaskIds.has(n.resourceId ?? n.row?.id) : inProjectView(n.row ?? {})),
  );
  const matchingCrews = filtered(crews);
  const currentCrewPage = Math.min(crewPage, Math.max(0, Math.ceil(matchingCrews.length / 6) - 1));
  const recent: R[] = (state?.events ?? []).filter(inProjectView);
  const scopedEvents = eventRows.filter(inProjectView);
  const currentActivityPage = Math.min(activityPage, Math.max(0, Math.ceil(scopedEvents.length / 12) - 1));
  const rows = (
    kind: string,
    items: R[],
    empty = "No records in this view.",
  ) =>
    filtered(items).length ? (
      <div className="rows">
        {filtered(items).map((r, i) => (
          <RecordRow
            key={r.id ?? i}
            title={label(r)}
            description={
              <>
                {r.id} {r.blockedReason ? ` · ${r.blockedReason}` : ""}
              </>
            }
            status={r.status ?? r.role ?? r.type}
            onClick={() => open(kind, r)}
          />
        ))}
      </div>
    ) : (
      <div className="empty">
        {search && items.length
          ? "No matching records. Try a different search."
          : empty}
      </div>
    );
  const taskCard = (t: R) => (
    <TaskCard
      key={t.id}
      title={t.title}
      crew={crews.find((c) => c.id === t.crewId)?.template ?? "Unassigned crew"}
      status={t.status}
      detail={
        t.blockedReason ??
        `Attempt ${t.attempt ?? 0} of ${t.maxAttempts ?? "—"}`
      }
      onClick={() => open("tasks", t)}
    />
  );
  const eventsView = (events: R[]) =>
    events.length ? (
      <div className="timeline">
        {events.map((e, i) => (
          <Button
            variant="unstyled"
            key={e.eventId + ":" + i}
            className="event"
            onClick={() => open("event", e)}
          >
            <span className="event-dot" />
            <time>
              {e.timestamp
                ? new Date(e.timestamp).toLocaleTimeString()
                : "Unreported"}
            </time>
            <span>
              <strong>{e.type}</strong>
              <small>
                {e.source} ·{" "}
                {e.taskId ?? e.executionId ?? e.missionId ?? e.eventId}
              </small>
            </span>
            <span>↗</span>
          </Button>
        ))}
      </div>
    ) : (
      <div className="empty">
        No recorded activity yet. Events appear here as the source publishes
        them.
      </div>
    );
  const missingSelection =
    selected &&
    ["tasks", "missions", "crews", "agents", "approvals"].includes(
      selected.kind,
    ) &&
    state?.sources?.mimir?.status === "connected" &&
    !(m[selected.kind] ?? s[selected.kind] ?? []).some(
      (row: R) => row.id === selected.id,
    );
  const dataRow = selected
    ? ((m[selected.kind] ?? s[selected.kind] ?? []).find(
        (r: R) => r.id === selected.id,
      ) ?? selected.row)
    : null;
  const currentTask =
    selected?.kind === "tasks"
      ? dataRow
      : selected?.kind === "agents"
        ? allTasks.find((t) => t.id === dataRow.taskId)
        : null;
  const relatedEvents = currentTask
    ? [
        ...new Map(
          [...recent, ...history]
            .filter(
              (e) =>
                e.taskId === currentTask.id ||
                e.payload?.taskId === currentTask.id,
            )
            .map((e) => [e.source + e.eventId, e]),
        ).values(),
      ]
    : [];
  const taskExecution = currentTask
    ? executions.find((e) =>
        e.tasks?.some((t: R) => t.mimirTaskId === currentTask.id),
      )
    : null;
  const mappedTask = taskExecution?.tasks?.find(
    (t: R) => t.mimirTaskId === currentTask?.id,
  );
  const taskPlan = taskExecution?.plan?.tasks?.find(
    (t: R) => t.id === mappedTask?.planTaskId,
  );
  const sourceOffline = Object.values(state?.sources ?? {}).some(
    (v: any) => v.status === "disconnected",
  );
  return (
    <div className="shell">
      <aside className={mobileMenu ? "sidebar menu-open" : "sidebar"}>
        <a href="#" className="brand" onClick={() => setPage("Overview")}>
          <span className="mark">H</span>
          <span>
            Heimdall
          </span>
        </a>
        <div className="workspace">
          WORKSPACE
          <strong>Local workspace</strong>
        </div>
        <Button className="mobile-menu" aria-expanded={mobileMenu} aria-controls="main-navigation" onClick={() => setMobileMenu(!mobileMenu)}>{mobileMenu ? "Close menu" : "Menu"}</Button>
        <nav id="main-navigation" aria-label="Main navigation">
          {titles.map((p, i) => (
            <Button
              variant="unstyled"
              key={p}
              aria-label={p}
              aria-current={page === p ? "page" : undefined}
              className={page === p ? "nav active" : "nav"}
              onClick={() => {
                setPage(p);
                setMobileMenu(false);
                setSearch("");
              }}
            >
              <NavIcon index={i} />
              {p}
              {p === "Quality & approvals" && approvals.length > 0 && (
                <b>{approvals.length}</b>
              )}
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span
            className={stream === "Live" ? "status-dot live" : "status-dot"}
          />
          {stream}
          <small>
            {session.operator
              ? "Operator controls unlocked"
              : "Read-only session"}
          </small>
          <Button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "☀ Light theme" : "☾ Dark theme"}
          </Button>
          <Button
            onClick={() =>
              void post("logout", {}).then(() => {
                setAuthenticated(false);
                setState(null);
              })
            }
          >
            Sign out
          </Button>
        </div>
      </aside>
      <div className="main">
        <header>
          <div className="breadcrumb">
            Factory <span>/</span> {page}
          </div>
          <div className="header-right">
            <Button
              variant="ghost"
              aria-label="Open command palette"
              onClick={() => setJumpOpen(true)}
            >
              Jump to…{" "}
              <kbd className="rounded border border-line px-1.5 text-xs">
                ⌘ K
              </kbd>
            </Button>
            <Button
              variant="unstyled"
              className="new-work"
              onClick={() => setPage("New work")}
            >
              + New work
            </Button>
            <Button
              aria-label="Notifications"
              onClick={() => setPage("Notifications")}
            >
              Alerts{" "}
              {visibleNotifications.filter((n: R) => !n.seen).length}
            </Button>
            <span className="local">◉ LOCAL</span>
            <Select
              aria-label="Filter by project"
              className="w-[220px] max-w-full"
              value={project}
              onValueChange={(value) => setProject(value)}
            >
              <Option value="all">All projects</Option>
              {activeProjects.map((p) => (
                <Option key={p.id} value={p.id}>
                  {p.name}
                </Option>
              ))}
            </Select>
            <Button
              variant="unstyled"
              onClick={() => setPage("Connections")}
              className="avatar"
              aria-label="Operator connections"
            >
              OP
            </Button>
          </div>
        </header>
        <main key={page} className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">THE WATCHTOWER</p>
              <h1>{page === "Overview" ? "Factory overview" : page}</h1>
              <p className="subtitle">
                {page === "Overview"
                  ? "Every project. Every agent. Nothing out of sight."
                  : page === "Pipeline"
                    ? "Follow authoritative task state from intake to local delivery."
                    : page === "Crews & agents"
                      ? "Know who is working, what they are doing, and what is holding them up."
                      : page === "Execution graph"
                        ? "Trace dependencies and inspect the work behind each node."
                        : page === "Activity"
                          ? "Source events, preserved in their original order within each stream."
                          : page === "Quality & approvals"
                            ? "Evidence before acceptance. Human decisions where they matter."
                            : page === "New work"
                              ? "Turn an idea into a specification, an approved plan, and working software."
                              : page === "Notifications"
                                ? "Your decision queue. Inspect the evidence and keep work moving."
                                : page === "Projects" ? "Start fresh, switch repositories, or restore archived work."
                                : page === "Fleet & supervisors" ? "Inspect worker ownership, capacity, human holds and recovery evidence." : "Connect your local services and manage operator access."}
              </p>
            </div>
            <span className="updated">
              {state ? "Snapshot " + ago(state.generatedAt) : "Connecting…"}
            </span>
          </div>
          {(sourceOffline || stream !== "Live") && (
            <div className="warning" role="status">
              {sourceOffline
                ? "A source is disconnected. Its last snapshot is retained and may be stale."
                : stream}
            </div>
          )}
          {Object.entries(state?.sources ?? {}).map(
            ([name, v]: [string, any]) =>
              v.gap && (
                <div className="warning" key={name}>
                  {name}: {v.gap}
                </div>
              ),
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
              <Button
                onClick={() => setNotice("")}
                aria-label="Dismiss message"
              >
                ×
              </Button>
            </div>
          )}
          {!["Connections", "New work", "Notifications", "Projects", "Fleet & supervisors"].includes(page) && (
            <div className="searchbar">
              <span>⌕</span>
              <Input
                className="border-0 bg-transparent px-0 shadow-none focus:ring-0"
                aria-label="Search records"
                placeholder={
                  page === "Activity"
                    ? "Search event types, task IDs, tool output…"
                    : "Find a task, project, agent, or status…"
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
          {page === "Overview" && (
            <>
              <FactoryPulse
                tasks={tasks.map((t) => ({ status: String(t.status) }))}
                sources={state?.sources ?? {}}
                onInspect={() => setPage("Pipeline")}
              />
              <div className="metrics">
                {[
                  ["Projects", activeProjects.length, "projects", activeProjects],
                  [
                    "Active crews",
                    activeCrews.length,
                    "crews",
                    activeCrews,
                  ],
                  [
                    "Active agents",
                    agents.filter((a) => active.includes(a.status)).length,
                    "agents",
                    agents.filter((a) => active.includes(a.status)),
                  ],
                  [
                    "Needs attention",
                    visibleNotifications.filter(
                      (n: R) => n.active && n.severity !== "success",
                    ).length,
                    "tasks",
                    tasks.filter((t) => attention.includes(t.status)),
                  ],
                ].map(([name, n, kind, list], index) => (
                  <MetricCard
                    index={index}
                    key={String(name)}
                    name={String(name)}
                    value={String(n)}
                    description={
                      name === "Needs attention"
                        ? "Project alerts and service health"
                        : "Inspect source records"
                    }
                    onClick={() =>
                      name === "Needs attention"
                        ? setPage("Notifications")
                        : open("collection", {
                            id: String(name),
                            title: name,
                            kind,
                            items: list,
                          })
                    }
                  />
                ))}
              </div>
              <div className="overview-grid">
                <Card className="panel">
                  <div className="section-title">
                    <h2>Work in motion</h2>
                    <Button onClick={() => setPage("Pipeline")}>
                      View pipeline ↗
                    </Button>
                  </div>
                  {focusedMission && (
                    <div className="mission-brief">
                      <Field>
                        Mission in view
                        <Select value={missions.some((mission) => mission.id === overviewMission) ? overviewMission : "latest"}
                          onValueChange={setOverviewMission}>
                          <Option value="latest">Latest mission</Option>
                          {missions.map((mission) => <Option key={mission.id} value={mission.id}>
                            {missionTitle(mission)} · {mission.id.slice(-6)}
                          </Option>)}
                        </Select>
                      </Field>
                      <Button variant="unstyled" onClick={() => open("missions", focusedMission)}>
                        <strong>{missionTitle(focusedMission)}</strong>
                        <Badge value={focusedMission.status} />
                      </Button>
                    </div>
                  )}
                  <div className="progress-caption">
                    <span>
                      {completed} of {focusedTasks.length} tasks completed
                    </span>
                    <span>
                      {focusedTasks.length
                        ? Math.round((completed / focusedTasks.length) * 100) + "%"
                        : "—"}
                    </span>
                  </div>
                  <Progress
                    aria-label="Completed tasks"
                    value={completed}
                    max={focusedTasks.length || 1}
                  />
                  {rows(
                    "tasks",
                    focusedTasks.filter((t) => t.status !== "completed"),
                    "No unfinished tasks. Inspect the mission above or start new work.",
                  )}
                </Card>
                <Card className="panel">
                  <div className="section-title">
                    <h2>Operator attention</h2>
                    <Badge value={approvals.length ? "pending" : "clear"} />
                  </div>
                  {rows(
                    "approvals",
                    approvals,
                    "No pending execution approvals.",
                  )}
                  <div className="inset">
                    <small>USAGE REPORTED BY MIMIR</small>
                    <strong>
                      {(m.usage?.tokens ?? 0).toLocaleString()} tokens
                    </strong>
                    <p>
                      {m.usage?.estimatedCost > 0
                        ? `$${Number(m.usage.estimatedCost).toFixed(2)} reported estimate · ${m.usage.bySource?.unavailable ?? 0} unavailable samples`
                        : "Cost unavailable until the runtime reports usage."}
                    </p>
                  </div>
                </Card>
                <Card className="panel wide">
                  <div className="section-title">
                    <h2>Latest activity</h2>
                    <Button onClick={() => setPage("Activity")}>
                      Full timeline ↗
                    </Button>
                  </div>
                  {eventsView(recent.slice(0, 8))}
                </Card>
                <Card className="panel wide">
                  <div className="section-title">
                    <h2>Projects</h2>
                    <span className="muted">Source-owned records</span>
                  </div>
                  {rows("projects", activeProjects)}
                </Card>
              </div>
            </>
          )}
          {page === "Projects" && <Projects projects={allProjects.map(p => ({ id: p.id, name: p.name, repoPath: p.repoPath }))} archived={archivedProjects}
            onCreate={() => setPage("New work")}
            onOpen={(id) => { setProject(id); setPage("Overview"); }}
            onArchive={async (id, archive) => {
              const next = archive ? [...new Set([...archivedProjects, id])] : archivedProjects.filter(value => value !== id);
              const result = await post("preferences", { archivedProjects: next });
              setState(old => old ? { ...old, preferences: result.preferences } : old);
              if (archive && project === id) setProject("all");
              setNotice(archive ? "Project archived. Files and history preserved." : "Project restored.");
            }} />}
          {page === "Pipeline" && (
            <ScrollArea className="board" aria-label="Pipeline stages">
              {[
                ["Intake", intakes, "intakes"],
                [
                  "Specification",
                  specs.filter((x) => x.status === "draft"),
                  "specs",
                ],
                [
                  "Planning",
                  plans.filter((x) => x.status === "draft"),
                  "plans",
                ],
                [
                  "Ready",
                  tasks.filter((x) =>
                    ["pending", "ready", "leased"].includes(x.status),
                  ),
                  "tasks",
                ],
                [
                  "Building",
                  tasks.filter((x) =>
                    ["running", "blocked", "failed"].includes(x.status),
                  ),
                  "tasks",
                ],
                [
                  "Verification",
                  tasks.filter((x) => x.status === "verifying"),
                  "tasks",
                ],
                [
                  "Review",
                  [...specs, ...plans].filter((x) => x.status === "review"),
                  "specs",
                ],
                [
                  "Completed",
                  tasks.filter((x) => x.status === "completed"),
                  "tasks",
                ],
                [
                  "Delivery",
                  (s.deliveries ?? []).filter((r: R) =>
                    sindriIDs.has(r.projectId),
                  ),
                  "deliveries",
                ],
              ]
                .sort(
                  (a, b) =>
                    stageOrder.indexOf(String(a[0])) -
                    stageOrder.indexOf(String(b[0])),
                )
                .map(([name, list, kind]) => (
                  <Card className="column" key={String(name)} tabIndex={0} role="region" aria-label={`${name} stage, scroll for more items`}>
                    <h2>
                      {String(name)}
                      <b>{filtered(list as R[]).length}</b>
                    </h2>
                    {filtered(list as R[]).map((r) =>
                      kind === "tasks" ? (
                        taskCard(r)
                      ) : (
                        <Button
                          variant="unstyled"
                          key={r.id}
                          className="task-card"
                          onClick={() =>
                            open(
                              kind === "specs" && r.tasks
                                ? "plans"
                                : String(kind),
                              r,
                            )
                          }
                        >
                          <strong>{label(r)}</strong>
                          <Badge value={r.status} />
                          <small>{r.id}</small>
                        </Button>
                      ),
                    )}
                    {!filtered(list as R[]).length && <p className="empty">{search ? "No matching items" : "No items"}</p>}
                  </Card>
                ))}
            </ScrollArea>
          )}
          {page === "Crews & agents" && (
            <>
              <div className="section-title">
                <h2>Crews</h2>
                <span>Mission-level pause and resume</span>
              </div>
              <div className="crew-grid">
                {matchingCrews.slice(currentCrewPage * 6, (currentCrewPage + 1) * 6).map((c) => (
                  <Card className="panel" key={c.id}>
                    <Button
                      variant="unstyled"
                      className="crew-title"
                      onClick={() => open("crews", c)}
                    >
                      <span className="crew-icon">◎</span>
                      <span>
                        <h2>{c.template}</h2>
                        <small>{c.id}</small>
                      </span>
                      <Badge value={c.status} />
                    </Button>
                    {rows(
                      "agents",
                      agents.filter((a) => a.crewId === c.id),
                      "No agents assigned.",
                    )}
                    <Button
                      onClick={() =>
                        open(
                          "missions",
                          allMissions.find((m) => m.id === c.missionId) ?? {
                            id: c.missionId,
                          },
                        )
                      }
                    >
                      Inspect mission & controls ↗
                    </Button>
                  </Card>
                ))}
              </div>
              {matchingCrews.length > 6 && <div className="audit-pagination">
                <Button disabled={currentCrewPage === 0} onClick={() => setCrewPage(currentCrewPage - 1)}>Previous crews</Button>
                <span>Page {currentCrewPage + 1} of {Math.ceil(matchingCrews.length / 6)}</span>
                <Button disabled={(currentCrewPage + 1) * 6 >= matchingCrews.length} onClick={() => setCrewPage(currentCrewPage + 1)}>Next crews</Button>
              </div>}
              {!matchingCrews.length && (
                <div className="empty panel">
                  No crews yet. Crews appear when Mimir starts executing a plan.
                </div>
              )}
            </>
          )}
          {page === "Execution graph" && (
            <>
              {missions.map((mission) => (
                <Graph
                  key={mission.id}
                  mission={mission}
                  title={
                    specs.find(
                      (spec) =>
                        spec.id ===
                        executions.find(
                          (e) => e.execution.mimirMissionId === mission.id,
                        )?.plan?.specId,
                    )?.title
                  }
                  tasks={filtered(
                    tasks.filter((t) => t.missionId === mission.id),
                  )}
                  dependencies={m.taskDependencies ?? []}
                  saved={preferences.graphs?.[mission.id]}
                  onSave={(positions) =>
                    void savePreferences({
                      graphs: {
                        ...preferences.graphs,
                        [mission.id]: positions,
                      },
                    })
                  }
                  onInspect={(task) => open("tasks", task)}
                />
              ))}
              {!missions.length && (
                <div className="empty panel">
                  No execution graph yet. Create and approve a plan to begin.
                </div>
              )}
            </>
          )}
          {page === "Activity" && (
            <Card className="panel">
              <p className="muted">
                {state?.retention} Displayed newest first by arrival; timestamps
                retain source time.
              </p>
              <div className="form-grid">
                <Field>
                  Event source
                  <Select
                    value={eventSource}
                    onValueChange={(value) => setEventSource(value)}
                  >
                    <Option value="">All sources</Option>
                    <Option value="mimir">Mimir</Option>
                    <Option value="sindri">Sindri</Option>
                  </Select>
                </Field>
                <Field>
                  Event category
                  <Select
                    value={eventType}
                    onValueChange={(value) => setEventType(value)}
                  >
                    <Option value="">All events</Option>
                    {[
                      "session",
                      "tool",
                      "git",
                      "test",
                      "approval",
                      "task",
                      "mission",
                      "artifact",
                    ].map((t) => (
                      <Option key={t} value={t}>
                        {t}
                      </Option>
                    ))}
                  </Select>
                </Field>
                <Field>
                  Mission
                  <Select
                    value={eventMission}
                    onValueChange={(value) => setEventMission(value)}
                  >
                    <Option value="">All missions</Option>
                    {missions.map((m) => (
                      <Option key={m.id} value={m.id}>
                        {String(m.objective).slice(0, 80)}
                      </Option>
                    ))}
                  </Select>
                </Field>
              </div>
              {eventsView(scopedEvents.slice(currentActivityPage * 12, (currentActivityPage + 1) * 12))}
              {scopedEvents.length > 12 && <div className="audit-pagination">
                <Button disabled={currentActivityPage === 0} onClick={() => setActivityPage(currentActivityPage - 1)}>Previous events</Button>
                <span>Page {currentActivityPage + 1} of {Math.ceil(scopedEvents.length / 12)}</span>
                <Button disabled={(currentActivityPage + 1) * 12 >= scopedEvents.length} onClick={() => setActivityPage(currentActivityPage + 1)}>Next events</Button>
              </div>}
              {eventRows.length > 0 && (
                <Button
                  onClick={() =>
                    void api(
                      "events?source=" +
                        encodeURIComponent(eventSource) +
                        "&type=" +
                        encodeURIComponent(eventType) +
                        "&missionId=" +
                        encodeURIComponent(eventMission) +
                        "&search=" +
                        encodeURIComponent(search) +
                        "&before=" +
                        eventRows.at(-1)?.cacheSequence,
                    ).then((d) => setEventRows([...eventRows, ...d.events]))
                  }
                >
                  Load older events
                </Button>
              )}
            </Card>
          )}
          {page === "Quality & approvals" && (
            <>
              <Card className="panel decision-panel">
                <div className="section-title">
                  <h2>Human decisions</h2>
                  <span>{approvals.length} execution approvals</span>
                </div>
                {rows("approvals", approvals)}
                {rows(
                  "specs",
                  specs.filter((x) =>
                    ["draft", "in_review", "review"].includes(x.status),
                  ),
                  "No specifications awaiting review.",
                )}
                {rows(
                  "plans",
                  plans.filter((x) =>
                    ["draft", "in_review", "review"].includes(x.status),
                  ),
                  "No plans awaiting review.",
                )}
              </Card>
              <Card className="panel">
                <h2>Verification & delivery</h2>
                {executions
                  .filter((e) => missionIDs.has(e.execution.mimirMissionId))
                  .map((e) => (
                    <div className="quality-run" key={e.execution.id}>
                      <Button variant="unstyled" className="verification-heading" onClick={() => open("execution", e.execution)}>
                        <strong>
                          {e.plan?.title ?? "Execution verification"}
                        </strong>
                        <Badge value={e.execution.status} />
                      </Button>
                      {(e.gates ?? []).map((g: R) => (
                        <Button
                          variant="unstyled"
                          className="row"
                          key={g.planTaskId}
                          onClick={() =>
                            open("gate", { ...g, id: g.planTaskId })
                          }
                        >
                          <span>
                            {g.planTaskId}
                            <small>
                              {(g.failures ?? [])
                                .map((f: any) =>
                                  typeof f === "string" ? f : JSON.stringify(f),
                                )
                                .join(" · ")}
                            </small>
                          </span>
                          <Badge value={g.passed ? "passed" : "failed"} />
                        </Button>
                      ))}
                      {e.tasks
                        ?.filter((t: R) => t.escalation)
                        .map((t: R) => (
                          <Button
                            variant="unstyled"
                            className="row"
                            key={t.planTaskId}
                            onClick={() =>
                              open("escalation", {
                                ...t,
                                id: t.planTaskId,
                                executionId: e.execution.id,
                              })
                            }
                          >
                            <span>{t.planTaskId} · Human decision needed</span>
                            <Badge value="blocked" />
                          </Button>
                        ))}
                      {[
                        "verified_pending_review",
                        "delivered_pending_merge",
                        "delivered",
                      ].includes(e.execution.status) && (
                        <Button
                          onClick={() =>
                            open("deliveries", {
                              ...e.execution,
                              id: e.execution.id,
                              title: "Delivery report",
                            })
                          }
                        >
                          Inspect delivery & patch ↗
                        </Button>
                      )}
                    </div>
                  ))}
                {!executions.length && (
                  <div className="empty">No verification reports yet.</div>
                )}
              </Card>
            </>
          )}
          {page === "Fleet & supervisors" && <Fleet api={api} enabled={!!session.operator} propose={propose} />}
          {page === "New work" && (
            <>
              <p className="muted">
                {session.operator && session.pairedSindri
                  ? "Operator controls and Sindri pairing are ready."
                  : "Unlock operator controls and pair Sindri under Connections to create or run work."}
              </p>
              <Workbench
                data={{ ...s, projects: sindriProjects.filter(p => activeProjects.some(active => active.id === p.id || (p.repoPath && active.repoPath === p.repoPath))) }}
                enabled={!!session.operator && !!session.pairedSindri}
                propose={propose}
                inspect={open}
              />
            </>
          )}
          {page === "Notifications" && (
            <Notifications
              items={visibleNotifications}
              enabled={!!preferences.desktopNotifications}
              onEnable={() => void enableDesktop()}
              onRead={(id) =>
                void post("notifications/read", { id })
                  .then(() => api("snapshot"))
                  .then(setState)
                  .catch((e) => setNotice(e.message))
              }
              onInspect={inspectNotification}
            />
          )}
          {page === "Connections" && (
            <div className="connection-grid settings-page">
              <nav className="settings-nav wide" aria-label="Connection settings sections">
                {["Services", "Access", "Display", "Audit history"].map((section) => (
                  <Button key={section} aria-pressed={connectionSection === section}
                    onClick={() => setConnectionSection(section)}>{section}</Button>
                ))}
              </nav>
              {connectionSection === "Services" && ["mimir", "sindri"].map((name) => (
                <Card className="panel" key={name}>
                  <div className="section-title">
                    <h2>{name === "mimir" ? "Mimir" : "Sindri"}</h2>
                    <Badge value={state?.sources[name]?.status} />
                  </div>
                  <p>
                    {state?.sources[name]?.url ??
                      "Optional connection not configured"}
                  </p>
                  <p className="muted">
                    Last successful snapshot:{" "}
                    {time(state?.sources[name]?.lastSuccess)}
                  </p>
                  <p className="muted">
                    Event stream:{" "}
                    {state?.sources[name]?.stream ??
                      "Waiting for execution streams"}
                  </p>
                  {state?.sources[name]?.error && (
                    <p className="error">{state.sources[name].error}</p>
                  )}
                  <ConnectionEditor
                    source={name}
                    current={state?.sources[name]}
                    enabled={!!session.operator}
                    send={(value) => post("connections", value)}
                  />
                </Card>
              ))}
              {connectionSection === "Access" && <>
              <Card className="panel">
                <div className="section-title"><h2>Operator controls</h2>
                  <Badge value={session.operator ? "Unlocked" : "Read only"} />
                </div>
                <p>
                  Monitoring is read-only by default. Enter Heimdall’s operator
                  code from the Terminal to unlock controls.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await post("unlock", { code });
                      setCode("");
                      setSession(await api("session"));
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                >
                  <Field>
                    Heimdall operator code
                    <Input
                      type="password"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </Field>
                  <Button disabled={!code}>
                    {session.operator ? "Unlock again" : "Unlock controls"}
                  </Button>
                </form>

              </Card>
              <Card className="panel">
                <div className="section-title"><h2>Sindri human approval</h2>
                  <Badge value={session.pairedSindri ? "Paired" : "Not paired"} />
                </div>
                <p>
                  Specification, plan and integrated execution decisions retain
                  Sindri’s separate human approval check.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await post("pair", { code: pair });
                      setPair("");
                      setSession(await api("session"));
                      setNotice("Sindri approval session paired.");
                    } catch (e) {
                      setNotice((e as Error).message);
                    }
                  }}
                >
                  <Field>
                    Sindri pairing code
                    <Input
                      type="password"
                      value={pair}
                      onChange={(e) => setPair(e.target.value)}
                    />
                  </Field>
                  <Button disabled={!session.operator || !pair}>
                    Pair approval session
                  </Button>
                </form>
              </Card>
              </>}
              {connectionSection === "Display" && <Card className="panel wide settings-stack">
                <h2>Display preferences</h2>
                <PipelineSettings
                  stages={stageOrder}
                  onSave={(stages) => void savePreferences({ stages })}
                />
                <Button
                  onClick={() =>
                    void api("config").then((config) => {
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(config, null, 2)], {
                          type: "application/json",
                        }),
                      );
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = "heimdall-configuration.json";
                      link.click();
                      URL.revokeObjectURL(url);
                    })
                  }
                >
                  Export configuration (no credentials)
                </Button>
              </Card>}
              {connectionSection === "Audit history" && <Card className="panel wide settings-stack">
                <div className="section-title"><h2>Operator audit</h2><span>{(state?.audit ?? []).length} receipts</span></div>
                <div className="audit-list">
                {(state?.audit ?? []).slice(auditPage * 8, (auditPage + 1) * 8).map((a: R, i: number) => (
                  <div className="audit" key={i}>
                    <time>{time(a.at)}</time>
                    <strong>{a.action}</strong>
                    <span>{a.outcome}</span>
                    {a.reason && <small>{a.reason}</small>}
                  </div>
                ))}
                </div>
                <div className="audit-pagination">
                  <Button disabled={auditPage === 0} onClick={() => setAuditPage((page) => page - 1)}>Previous</Button>
                  <span>Page {auditPage + 1} of {Math.max(1, Math.ceil((state?.audit ?? []).length / 8))}</span>
                  <Button disabled={(auditPage + 1) * 8 >= (state?.audit ?? []).length} onClick={() => setAuditPage((page) => page + 1)}>Next</Button>
                </div>
                <p className="muted">
                  Heimdall stores its own display cache, cursors and audit
                  receipts. It does not edit factory databases.
                </p>
              </Card>}
            </div>
          )}
        </main>
        <footer>
          <span>HEIMDALL / LOCAL FIRST</span>
          <span>
            Mimir · execution &nbsp; Sindri · planning &nbsp; Brokkr · evidence
          </span>
        </footer>
      </div>
      {jumpOpen && (
        <CommandPalette
          onClose={() => setJumpOpen(false)}
          items={[
            ...titles.map((title) => ({
              id: "page:" + title,
              label: title,
              group: "Page",
              run: () => {
                setPage(title);
                setSearch("");
              },
            })),
            ...activeProjects.map((row) => ({
              id: "project:" + row.id,
              label: String(label(row)),
              group: "Project",
              run: () => open("projects", row),
            })),
            ...tasks.map((row) => ({
              id: "task:" + row.id,
              label: String(label(row)),
              group: "Task",
              run: () => open("tasks", row),
            })),
          ]}
        />
      )}
      {selected && (
        <DialogSurface
          side="right"
          titleId="detail-heading"
          onClose={() => setSelected(null)}
        >
          <div className="drawer-top">
            <span className="eyebrow">{selected.kind} / INSPECTOR</span>
            <Button
              aria-label="Close inspector"
              onClick={() => setSelected(null)}
            >
              ×
            </Button>
          </div>
          <DialogTitle id="detail-heading">
            {selected.kind === "tasks" && taskPlan
              ? taskPlan.id.replaceAll("-", " ")
              : selected.kind === "missions"
                ? missionTitle(dataRow)
                : String(label(dataRow)).length > 180
                ? String(label(dataRow)).slice(0, 177) + "…"
                : label(dataRow)}
          </DialogTitle>
          <Badge value={dataRow.status ?? dataRow.type} />
          {missingSelection && (
            <p className="warning">
              This record is absent from the latest source snapshot. These
              retained details are historical.
            </p>
          )}
          {sourceOffline && (
            <p className="warning">
              A source is disconnected. Details may be stale; inspect
              Connections before acting.
            </p>
          )}
          <p className="id">{selected.id}</p>
          {detailError && (
            <p role="alert" className="warning">
              {detailError}
            </p>
          )}
          {selected.kind === "collection" && rows(dataRow.kind, dataRow.items)}
          {selected.kind === "projects" && (
            <>
              <p>{dataRow.repoPath}</p>
              {rows(
                "missions",
                allMissions.filter((m) => m.projectId === dataRow.id),
              )}
              {rows(
                "specs",
                (s.specs ?? []).filter(
                  (sp: R) =>
                    sp.projectId === dataRow.id ||
                    sindriProjects.find((p) => p.id === sp.projectId)
                      ?.repoPath === dataRow.repoPath,
                ),
                "",
              )}
            </>
          )}
          {selected.kind === "crews" && (
            <>
              <div className="actions">
                <Button
                  disabled={!session.operator || !!dataRow.schedulingPaused}
                  onClick={() =>
                    propose("crew.pause", dataRow.id, {
                      expectedVersion: dataRow.version,
                    })
                  }
                >
                  Pause crew scheduling
                </Button>
                <Button
                  disabled={!session.operator || !dataRow.schedulingPaused}
                  onClick={() =>
                    propose("crew.resume", dataRow.id, {
                      expectedVersion: dataRow.version,
                    })
                  }
                >
                  Resume crew scheduling
                </Button>
              </div>
              <p className="muted">
                Scheduling is {dataRow.schedulingPaused ? "paused" : "enabled"}.
                Existing sessions continue. Use graceful stop in an agent
                inspector to stop an active session.
              </p>
              {rows(
                "agents",
                (m.agents ?? []).filter((a: R) => a.crewId === dataRow.id),
              )}
              {rows(
                "tasks",
                allTasks.filter((t) => t.crewId === dataRow.id),
              )}
            </>
          )}
          {selected.kind === "missions" && (
            <>
              <div className="actions">
                {["pause", "resume", "cancel"].map((action) => (
                  <Button
                    disabled={!session.operator || sourceOffline || missingSelection || !canControlMission(dataRow.status, action)}
                    key={action}
                    onClick={() =>
                      propose("mission." + action, dataRow.id, {
                        expectedVersion: dataRow.version,
                        ...(action === "cancel"
                          ? {
                              reason:
                                "Operator requested cancellation from Heimdall",
                            }
                          : {}),
                      })
                    }
                  >
                    {action} mission
                  </Button>
                ))}
              </div>
              <p className="muted">
                Mission controls affect every crew in this mission. A pause
                controls scheduling; inspect agent state to confirm what is
                still running.
              </p>
              {rows(
                "tasks",
                allTasks.filter((t) => t.missionId === dataRow.id),
              )}
            </>
          )}
          {selected.kind === "agents" && (
            <>
              <div className="facts">
                <div>
                  <small>Runtime</small>
                  {dataRow.agentKind}
                </div>
                <div>
                  <small>Role</small>
                  {dataRow.role}
                </div>
                <div>
                  <small>Last source update</small>
                  {ago(dataRow.updatedAt)}
                </div>
                <div>
                  <small>Session</small>
                  {dataRow.runtimeSessionId ?? "Not started"}
                </div>
              </div>
              <p className="muted">
                Model and heartbeats are shown only when the runtime reports
                them. No heartbeat means freshness is unknown.
              </p>
              {dataRow.runtimeSessionId && (
                <Button
                  disabled={!session.operator}
                  onClick={() =>
                    propose("session.stop", dataRow.runtimeSessionId, {
                      mode: "graceful",
                    })
                  }
                >
                  Request graceful stop
                </Button>
              )}
            </>
          )}
          {selected.kind === "agents" && (
            <Telemetry
              agent={dataRow}
              load={() => api(`agents/${dataRow.id}/telemetry`)}
            />
          )}
          {currentTask && (
            <>
              <h3>Task objective</h3>
              <p>{taskPlan?.objective ?? currentTask.title}</p>
              <h3>Acceptance criteria</h3>
              <p className="multiline">
                {String(currentTask.acceptance || "Not supplied by source.")
                  .split("\n")
                  .map((line) => {
                    const criterion = (s.specs ?? [])
                      .find((sp: R) => sp.id === taskExecution?.plan?.specId)
                      ?.body?.acceptanceCriteria?.find(
                        (a: R) => a.id === line.trim(),
                      );
                    return criterion
                      ? `${criterion.id}: ${criterion.text}`
                      : line;
                  })
                  .join("\n\n")}
              </p>
              <div className="facts">
                <div>
                  <small>Attempt / retries</small>
                  {currentTask.attempt} / {currentTask.maxAttempts}
                </div>
                <div>
                  <small>Updated</small>
                  {time(currentTask.updatedAt)}
                </div>
                <div>
                  <small>Agent</small>
                  <Button
                    onClick={() => {
                      const a = (m.agents ?? []).find(
                        (a: R) => a.id === currentTask.agentId,
                      );
                      if (a) open("agents", a);
                    }}
                  >
                    {currentTask.agentId ?? "Not assigned"}
                  </Button>
                </div>
                <div>
                  <small>Result commit</small>
                  {currentTask.resultCommit ?? "Not verified yet"}
                </div>
              </div>
              {currentTask.blockedReason && (
                <div className="warning">
                  Blocked: {currentTask.blockedReason}
                </div>
              )}
              <h3>Dependencies</h3>
              {rows(
                "tasks",
                (m.taskDependencies ?? [])
                  .filter((d: R) => d.taskId === currentTask.id)
                  .map(
                    (d: R) =>
                      allTasks.find((t) => t.id === d.dependsOnId) ?? {
                        id: d.dependsOnId,
                        title: "Dependency unavailable",
                      },
                  ),
                "No prerequisite tasks.",
              )}
              {taskExecution?.gates
                ?.filter((g: R) => g.planTaskId === mappedTask.planTaskId)
                .map((g: R) => (
                  <div key={g.planTaskId}>
                    <h3>Verification gate</h3>
                    <Badge value={g.passed ? "passed" : "failed"} />
                    <Raw data={g} title="Gate evidence & failures" />
                  </div>
                ))}
              <h3>Evidence & artifacts</h3>
              {relatedEvents
                .filter((e) => e.type === "artifact.recorded")
                .map((e) => (
                  <Button
                    variant="unstyled"
                    className="row"
                    key={e.eventId}
                    onClick={() =>
                      open("artifact", {
                        id: e.payload.artifactId,
                        title: e.payload.name ?? e.payload.kind,
                        ...e.payload,
                      })
                    }
                  >
                    <span>
                      {e.payload.name ?? e.payload.kind}
                      <small>
                        {e.payload.bytes?.toLocaleString()} bytes · hash checked
                        before preview
                      </small>
                    </span>
                    ↗
                  </Button>
                ))}
              <h3>Activity & agent output</h3>
              {eventsView(relatedEvents)}
              <div className="actions">
                <Button
                  disabled={
                    !session.operator ||
                    !["completed", "failed"].includes(currentTask.status)
                  }
                  onClick={() =>
                    propose("task.verify", currentTask.id, {
                      expectedVersion: currentTask.version,
                    })
                  }
                >
                  Re-run verification only
                </Button>
                <Button
                  disabled={
                    !session.operator ||
                    !["failed", "blocked"].includes(currentTask.status)
                  }
                  onClick={() =>
                    propose("task.retry", currentTask.id, {
                      expectedVersion: currentTask.version,
                    })
                  }
                >
                  Retry task
                </Button>
              </div>
              {taskPlan && (
                <Raw data={taskPlan} title="Plan & dependency details" />
              )}
              {mappedTask && (
                <Raw data={mappedTask} title="Execution state & escalation" />
              )}
              <Raw
                data={(m.worktrees ?? []).filter(
                  (w: R) => w.taskId === currentTask.id,
                )}
                title="Worktree & branch"
              />
            </>
          )}
          {selected.kind === "approvals" && (
            <>
              <h3>Requested action</h3>
              <p>{dataRow.action}</p>
              <p>{dataRow.reason}</p>
              <Raw data={dataRow} title="Review full approval request" />
              <div className="actions">
                {["approved", "rejected"].map((decision) => (
                  <Button
                    disabled={!session.operator}
                    key={decision}
                    onClick={() =>
                      propose("approval.decide", dataRow.id, {
                        decision,
                        reason: "Operator decision from Heimdall",
                      })
                    }
                  >
                    {decision === "approved" ? "Approve" : "Reject"}
                  </Button>
                ))}
              </div>
            </>
          )}
          {selected.kind === "intakes" && (
            <>
              <p className="multiline">
                {details?.intake?.body ?? dataRow.body}
              </p>
              <Button
                disabled={!session.operator || !session.pairedSindri}
                onClick={() =>
                  propose("spec.draft", "new", {
                    projectId: dataRow.projectId,
                    intakeId: dataRow.id,
                    request: dataRow.body ?? dataRow.title,
                  })
                }
              >
                Draft specification from intake
              </Button>
            </>
          )}
          {["specs", "plans"].includes(selected.kind) && (
            <>
              <div className="actions">
                <Button
                  disabled={!session.operator}
                  onClick={() =>
                    propose(
                      selected.kind === "specs" ? "spec.submit" : "plan.submit",
                      dataRow.id,
                    )
                  }
                >
                  Submit for review
                </Button>
                <Button
                  disabled={!session.operator}
                  onClick={() =>
                    propose(
                      selected.kind === "specs"
                        ? "spec.approve"
                        : "plan.approve",
                      dataRow.id,
                      selected.kind === "specs" && acknowledgeUntrusted
                        ? { acknowledgeUntrusted: true }
                        : {},
                    )
                  }
                >
                  Approve {selected.kind === "specs" ? "specification" : "plan"}
                </Button>
              </div>
              {selected.kind === "specs" &&
                details?.meta?.untrustedInstructionDetected && (
                  <Field className="warning">
                    <Input
                      type="checkbox"
                      checked={acknowledgeUntrusted}
                      onChange={(e) =>
                        setAcknowledgeUntrusted(e.target.checked)
                      }
                    />{" "}
                    I have reviewed the flagged source instructions and
                    explicitly acknowledge them for this specification.
                  </Field>
                )}
              {selected.kind === "specs" &&
                (details?.spec ?? dataRow)?.body && (
                  <SpecEditor
                    key={selected.id}
                    spec={details?.spec ?? dataRow}
                    enabled={!!session.operator && !!session.pairedSindri}
                    propose={propose}
                  />
                )}
              {selected.kind === "specs" && (
                <Button
                  disabled={!session.operator || dataRow.status !== "approved"}
                  onClick={() =>
                    propose("plan.propose", "new", { specId: dataRow.id })
                  }
                >
                  Propose implementation plan
                </Button>
              )}
              {selected.kind === "plans" &&
                (details?.plan ?? dataRow)?.tasks && (
                  <PlanEditor
                    key={selected.id}
                    plan={details?.plan ?? dataRow}
                    enabled={!!session.operator && !!session.pairedSindri}
                    propose={propose}
                  />
                )}
              {selected.kind === "plans" && (
                <Button
                  disabled={!session.operator || dataRow.status !== "approved"}
                  onClick={() =>
                    propose("execution.create", "new", { planId: dataRow.id })
                  }
                >
                  Start approved plan
                </Button>
              )}
              {selected.kind === "specs" && (
                <Button
                  onClick={() =>
                    void api("details/questions/" + dataRow.id)
                      .then((d) => setDetails({ ...details, ...d }))
                      .catch((e) => setNotice(e.message))
                  }
                >
                  Load clarification questions
                </Button>
              )}
              {details?.questions?.map((q: R) => (
                <Question
                  key={q.id}
                  question={q}
                  disabled={!session.operator}
                  answer={(answer: string) =>
                    propose("spec.answer", dataRow.id, {
                      questionId: q.id,
                      answer,
                    })
                  }
                />
              ))}
              {(details?.spec ?? (selected.kind === "specs" ? dataRow : null))
                ?.body && (
                <div>
                  <h3>Problem</h3>
                  <p>{(details?.spec ?? dataRow).body.problem}</p>
                  <h3>Acceptance criteria</h3>
                  {(
                    (details?.spec ?? dataRow).body.acceptanceCriteria ?? []
                  ).map((a: R) => (
                    <div className="criterion" key={a.id}>
                      <strong>{a.id}</strong>
                      <p>{a.text ?? a.description}</p>
                      <small>{a.verification}</small>
                    </div>
                  ))}
                </div>
              )}
              {(details?.plan ?? (selected.kind === "plans" ? dataRow : null))
                ?.tasks && rows("plan-task", (details?.plan ?? dataRow).tasks)}
              <Raw
                data={details ?? dataRow}
                title="Full specification / plan"
              />
            </>
          )}
          {selected.kind === "escalation" && (
            <>
              <Raw
                data={dataRow.escalation}
                title="Why operator intervention is required"
              />
              <div className="actions">
                {["retry", "skip", "replan", "abort"].map((decision) => (
                  <Button
                    key={decision}
                    disabled={!session.operator}
                    onClick={() =>
                      propose(
                        "execution.resolve",
                        dataRow.executionId,
                        { decision, reason: "Operator recovery decision" },
                        { taskId: dataRow.planTaskId },
                      )
                    }
                  >
                    {decision}
                  </Button>
                ))}
              </div>
            </>
          )}
          {selected.kind === "deliveries" && (
            <>
              <div className="actions">
                <Button
                  disabled={!session.operator}
                  onClick={() => propose("execution.assess", dataRow.id)}
                >
                  Reassess quality gates
                </Button>
                <Button
                  disabled={!session.operator}
                  onClick={() => propose("execution.export", dataRow.id)}
                >
                  Request local export
                </Button>
                <Button
                  onClick={() =>
                    void api("details/local/" + dataRow.id)
                      .then((d) => {
                        if (!d.result)
                          throw Error("No local export is available yet.");
                        setDetails(d);
                      })
                      .catch((e) => setNotice(e.message))
                  }
                >
                  View local patch
                </Button>
              </div>
              {details?.result?.patch && (
                <>
                  <Button
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([details.result.patch], {
                          type: "text/plain",
                        }),
                      );
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "result.patch";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download result.patch
                  </Button>
                  <CodeBlock>{details.result.patch}</CodeBlock>
                </>
              )}
              <Raw
                data={details ?? dataRow}
                title="Delivery report, requirements & evidence"
              />
            </>
          )}
          {selected.kind === "artifact" && details && (
            <>
              <p className="success">
                Integrity verified · {details.verifiedHash}
              </p>
              {details.image && (
                <img
                  className="artifact-image"
                  src={details.image}
                  alt="Verification evidence"
                />
              )}
              {details.content && (
                <CodeBlock className="artifact-content">
                  {details.content}
                </CodeBlock>
              )}
            </>
          )}
          {selected.kind === "event" && (
            <>
              <p>
                {time(dataRow.timestamp)} · {dataRow.source}
              </p>
              <CodeBlock>{JSON.stringify(dataRow.payload, null, 2)}</CodeBlock>
              {dataRow.payload?.artifactId && (
                <Button
                  onClick={() =>
                    open("artifact", {
                      id: dataRow.payload.artifactId,
                      title: dataRow.payload.kind,
                    })
                  }
                >
                  Open evidence artifact
                </Button>
              )}
            </>
          )}
          {!["collection", "artifact", "specs", "plans", "deliveries"].includes(
            selected.kind,
          ) && <Raw data={dataRow} />}
        </DialogSurface>
      )}
      {command && (
        <DialogSurface
          titleId="command-heading"
          onClose={() => setCommand(null)}
          busy={busy}
        >
          <p className="eyebrow">OPERATOR DECISION</p>
          <DialogTitle id="command-heading">
            {command.action.replaceAll(".", " · ")}
          </DialogTitle>
          <p>Target: {command.id}</p>
          <p>
            This request changes the owning service. Review the details and
            record why you are taking this action.
          </p>
          <Raw data={command.body} title="Command payload" />
          <Field>
            Reason
            <Textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain the decision for the audit trail"
            />
          </Field>
          {notice && (
            <p role="alert" className="warning">
              {notice}
            </p>
          )}
          <div className="actions">
            <Button disabled={busy} onClick={() => setCommand(null)}>
              Go back
            </Button>
            <Button
              variant="primary"
              className="primary"
              disabled={busy || !reason.trim()}
              onClick={() => void execute()}
            >
              {busy ? "Waiting for source…" : "Send to source"}
            </Button>
          </div>
        </DialogSurface>
      )}
    </div>
  );
}
function Question({
  question: q,
  answer,
  disabled,
}: {
  question: R;
  answer: (a: string) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <div className="question">
      <p>{q.question ?? q.text ?? JSON.stringify(q)}</p>
      <Field>
        Your answer
        <Textarea value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <Button disabled={disabled || !text.trim()} onClick={() => answer(text)}>
        Review answer
      </Button>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).get("view") === "components" ? (
    <ComponentCatalog />
  ) : (
    <App />
  ),
);
