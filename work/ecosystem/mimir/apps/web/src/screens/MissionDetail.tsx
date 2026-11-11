import type {
  Artifact,
  ArtifactId,
  EventEnvelope,
  EventPayloadMap,
  MissionId,
  Task,
} from "@mimir/protocol";
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  DataTable,
  Disclosure,
  Id,
  KeyValue,
  Link,
  Tabs,
  type Column,
} from "@factory/ui";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { describeError } from "../api/client.js";
import { ActionResult } from "../components/ActionResult.js";
import { BlockedReason } from "../components/BlockedReason.js";
import { ProgressText, ProvenanceBadge, StatusBadge, UsageChips } from "../components/Badges.js";
import { DagSvg } from "../components/DagSvg.js";
import { EventFilters } from "../components/EventFilters.js";
import { EventList } from "../components/EventList.js";
import { RaiseBudgetDialog } from "../components/RaiseBudgetDialog.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { LiveOutputLink, liveSession, TaskTitle } from "../components/TaskParts.js";
import { isBudgetBlocked } from "../lib/budget.js";
import { filterEvents, taskProgress, type EventFilter } from "../lib/derive.js";
import { crewLabel, missionName, missionOrigin, taskName } from "../lib/names.js";
import { useAction } from "../lib/useAction.js";
import { useAsync } from "../lib/useAsync.js";
import { HISTORY_MAX_PAGES, HISTORY_PAGE, useMissionEvents } from "../lib/useEventHistory.js";
import { useStore } from "../store/StoreProvider.js";

type ArtifactEvent = EventEnvelope & { payload: EventPayloadMap["artifact.recorded"] };
type TestEvent = EventEnvelope & {
  payload: EventPayloadMap["test.run_completed"];
};

const isFileArtifact = (kind: string) => /diff|patch|manifest|files/i.test(kind);

function ArtifactTable({
  items,
  taskLabel,
}: {
  items: ArtifactEvent[];
  taskLabel: (id: string) => string | undefined;
}) {
  const { client, reportError } = useStore();
  const [open, setOpen] = useState<Record<string, Artifact | string>>({});
  if (items.length === 0)
    return (
      <EmptyState body="Agents record diffs, patches and reports here as they finish work.">
        No artifacts recorded yet
      </EmptyState>
    );
  const view = async (id: ArtifactId) => {
    try {
      const r = await client.artifacts.get(id);
      setOpen((o) => ({ ...o, [id]: r.artifact }));
    } catch (e) {
      reportError(e);
      setOpen((o) => ({ ...o, [id]: describeError(e).message }));
    }
  };
  const columns: Column<ArtifactEvent>[] = [
    {
      key: "artifact",
      header: "Artifact",
      cell: (e) => <span className="font-mono text-xs break-all">{e.payload.artifactId}</span>,
    },
    { key: "kind", header: "Kind", cell: (e) => <Badge>{e.payload.kind}</Badge> },
    {
      key: "task",
      header: "Task",
      cell: (e) => taskLabel(e.payload.taskId) ?? <Id value={e.payload.taskId} label="Task ID" />,
    },
    {
      key: "details",
      header: "Details",
      cell: (e) => {
        const id = e.payload.artifactId;
        const detail = open[id];
        return detail === undefined ? (
          <Button size="sm" aria-label={`View ${id}`} onClick={() => void view(id)}>
            View
          </Button>
        ) : typeof detail === "string" ? (
          <span role="alert" className="text-danger-fg">
            {detail}
          </span>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
            <dt className="text-muted">URI</dt>
            <dd className="font-mono break-all">{detail.uri}</dd>
            <dt className="text-muted">Hash</dt>
            <dd className="font-mono break-all">{detail.hash}</dd>
          </dl>
        );
      },
    },
  ];
  return <DataTable caption="Artifacts" columns={columns} rows={items} rowKey={(e) => e.id} />;
}

function TestsTable({ items }: { items: TestEvent[] }) {
  if (items.length === 0)
    return (
      <EmptyState body="Test runs appear when a task's verification runs its test command.">
        No test runs recorded yet
      </EmptyState>
    );
  return (
    <ul className="flex flex-col gap-3">
      {items.map((e) => (
        <li key={e.id} className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <code className="font-mono font-medium">{e.payload.command}</code>
            <StatusBadge status={e.payload.passed ? "passed" : "failed"} domain="test" />
            <span className="text-muted">{e.payload.passed ? "passed" : "failed"}</span>
            {e.payload.exitCode !== undefined && (
              <span className="text-muted">
                {e.payload.exitCode === null
                  ? "no exit code (killed)"
                  : `exit code ${e.payload.exitCode}`}
              </span>
            )}
            {e.payload.total !== undefined && (
              <span className="text-muted">
                {e.payload.failed ?? 0} of {e.payload.total} failed
              </span>
            )}
            {e.payload.durationMs !== undefined && (
              <span className="text-muted">{Math.round(e.payload.durationMs)} ms</span>
            )}
            <ProvenanceBadge provenance={e.provenance} />
          </div>
          {e.payload.output && (
            <pre className="max-h-64 overflow-auto rounded-md bg-sunken p-3 font-mono text-xs">
              {e.payload.output}
            </pre>
          )}
        </li>
      ))}
    </ul>
  );
}

function Costs({ missionId }: { missionId: MissionId }) {
  const { client } = useStore();
  const usage = useAsync(() => client.usage.get({ missionId }), missionId);
  if (usage.status === "loading") return <LoadingState label="costs" />;
  if (usage.status === "error") return <ErrorState message={usage.error} onRetry={usage.reload} />;
  return <UsageChips totals={usage.data.totals} />;
}

/** Keyed by mission id so tab, filter and dialog state never leak between missions. */
export function MissionDetail() {
  const { id = "" } = useParams();
  return <MissionDetailView key={id} id={id} />;
}

function MissionDetailView({ id }: { id: string }) {
  const { state, client, reportError } = useStore();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [filter, setFilter] = useState<EventFilter>({});
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [raiseFor, setRaiseFor] = useState<Task | null | undefined>(undefined);
  const history = useMissionEvents(client, id, state.events, reportError);
  const action = useAction();

  const mission = state.missions.find((m) => m.id === id);
  const tasks = useMemo(() => state.tasks.filter((t) => t.missionId === id), [state.tasks, id]);
  const taskIds = new Set<string>(tasks.map((t) => t.id));
  const deps = state.taskDependencies.filter((d) => taskIds.has(d.taskId));
  const crews = state.crews.filter((c) => c.missionId === id);
  const crewIds = new Set<string>(crews.map((c) => c.id));
  const agents = state.agents.filter((a) => crewIds.has(a.crewId));
  const artifacts = history.events.filter(
    (e): e is ArtifactEvent => e.type === "artifact.recorded",
  );
  const tests = history.events.filter((e): e is TestEvent => e.type === "test.run_completed");
  const budgetBlocked = tasks.filter(isBudgetBlocked);
  const project = mission ? state.projects.find((p) => p.id === mission.projectId) : undefined;
  const taskLabel = (taskId: string) => {
    const t = tasks.find((x) => x.id === taskId);
    return t ? taskName(t) : undefined;
  };

  if (state.status === "ready" && !mission) {
    return (
      <Screen screen="mission-detail" title="Mission">
        <EmptyState
          compact={false}
          body="It may belong to another Mimir server, or the link is wrong."
          action={<Link href="/missions">Back to missions</Link>}
        >
          Mission not found
        </EmptyState>
      </Screen>
    );
  }

  const name = mission ? missionName(mission, state.tasks) : "Mission";
  const canCancel =
    mission?.status === "active" || mission?.status === "paused" || mission?.status === "draft";

  const selectTask = (taskId: string) => {
    setSelected(taskId);
    document.getElementById(`task-row-${taskId}`)?.scrollIntoView({ block: "center" });
  };

  const taskColumns: Column<Task>[] = [
    {
      key: "task",
      header: "Task",
      primary: true,
      width: "50%",
      cell: (t) => (
        <span id={`task-row-${t.id}`} className="block min-w-0 scroll-mt-24">
          <TaskTitle task={t} />
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => (
        <span className="flex flex-col items-start gap-1">
          <StatusBadge status={t.status} domain="task" />
          {t.blockedReason && (
            <BlockedReason reason={t.blockedReason} className="text-xs text-warning-fg" />
          )}
        </span>
      ),
    },
    {
      key: "attempt",
      header: "Attempt",
      align: "right",
      // `attempt` is a 0-based index.
      cell: (t) => `${Math.min(t.attempt + 1, t.maxAttempts)} of ${t.maxAttempts}`,
    },
    {
      key: "agent",
      header: "Agent",
      cell: (t) => {
        const session = liveSession(t, agents);
        if (session) return <LiveOutputLink sessionId={session} taskLabel={taskName(t)} />;
        const crew = crews.find((c) => c.id === t.crewId);
        return (
          <span className="text-xs text-muted">{crew ? crewLabel(crew) : "Not assigned"}</span>
        );
      },
    },
    // Only budget-blocked tasks have an action; otherwise no column (and no empty phone label).
    ...(budgetBlocked.length === 0
      ? []
      : [
          {
            key: "actions",
            header: <span className="sr-only">Actions</span>,
            label: "Actions",
            align: "right" as const,
            cell: (t: Task) =>
              isBudgetBlocked(t) ? (
                <Button
                  size="sm"
                  aria-label={`Raise budget for ${taskName(t)}`}
                  onClick={() => setRaiseFor(t)}
                >
                  Raise budget
                </Button>
              ) : null,
          },
        ]),
  ];

  const plan =
    tasks.length === 0 ? (
      <EmptyState body="Tasks come from the plan Sindri sends, or are added through the API.">
        This mission has no tasks yet
      </EmptyState>
    ) : (
      <div className="flex flex-col gap-section">
        {budgetBlocked.length > 0 && (
          <Callout
            tone="warning"
            title={`${budgetBlocked.length} ${budgetBlocked.length === 1 ? "task is" : "tasks are"} blocked: ${
              budgetBlocked.every((t) => t.blockedReason === "budget_uncertain")
                ? "budget usage unknown"
                : "budget exceeded"
            }`}
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => setRaiseFor(budgetBlocked[0] ?? null)}
              >
                Raise budget
              </Button>
            }
          >
            {budgetBlocked.some((t) => t.blockedReason === "budget_uncertain")
              ? "A budget cannot count usage the agent did not report, or a crew used up its tokens. Allow unknown usage or raise the limit to let the scheduler start them again."
              : "A crew used up its token budget. Raise the limit to let the scheduler start them again."}
          </Callout>
        )}
        <Section
          title="Task graph"
          term="Task graph"
          description="Arrows point from a task to the tasks waiting on it. Click a task to find it in the list."
        >
          <DagSvg tasks={tasks} deps={deps} selectedId={selected} onSelect={selectTask} />
        </Section>
        <Section title="Tasks" count={tasks.length} flush>
          <DataTable
            caption="Tasks"
            columns={taskColumns}
            rows={tasks}
            rowKey={(t) => t.id}
            selectedKey={selected}
            className="rounded-none border-0"
          />
        </Section>
      </div>
    );

  const timeline = (
    <div className="flex flex-col gap-4">
      <EventFilters
        filter={filter}
        onChange={setFilter}
        crews={crews.map((c) => ({ value: c.id, label: crewLabel(c) }))}
        sessions={agents.flatMap((a) =>
          a.runtimeSessionId
            ? [{ value: a.runtimeSessionId, label: `${a.role} ${a.runtimeSessionId}` }]
            : [],
        )}
        tasks={tasks.map((t) => ({ value: t.id, label: taskName(t) }))}
      />
      {history.status === "loading" && <LoadingState label="timeline" />}
      {history.status === "error" && (
        <ErrorState message={history.error ?? "failed"} onRetry={history.reload} />
      )}
      {history.truncated && (
        <p role="status" className="text-sm text-muted">
          Showing the first {HISTORY_MAX_PAGES * HISTORY_PAGE} recorded events and the live ones:
          older events only. Use Activity to replay from a cursor.
        </p>
      )}
      <Section title="Events">
        <EventList events={filterEvents(history.events, filter)} tasks={tasks} maxHeight="36rem" />
      </Section>
    </div>
  );

  const agentsTab =
    agents.length === 0 ? (
      <EmptyState body="Agents start when a crew picks up one of this mission's tasks.">
        No agents yet
      </EmptyState>
    ) : (
      <DataTable
        caption="Agents"
        rows={agents}
        rowKey={(a) => a.id}
        columns={[
          { key: "role", header: "Role", cell: (a) => <Badge>{a.role}</Badge> },
          { key: "kind", header: "Agent kind", cell: (a) => a.agentKind },
          {
            key: "status",
            header: "Status",
            cell: (a) => <StatusBadge status={a.status} domain="session" />,
          },
          {
            key: "task",
            header: "Task",
            cell: (a) => (a.taskId ? (taskLabel(a.taskId) ?? "—") : "—"),
          },
          {
            key: "session",
            header: "Session",
            cell: (a) =>
              a.runtimeSessionId ? (
                <Link
                  href={`/agents/${a.runtimeSessionId}`}
                  className="font-mono text-xs text-accent-fg hover:underline"
                >
                  {a.runtimeSessionId}
                </Link>
              ) : (
                <span className="text-xs text-muted">no session</span>
              ),
          },
        ]}
      />
    );

  return (
    <Screen
      screen="mission-detail"
      title={name}
      breadcrumbs={[
        ...(project ? [{ label: project.name }] : []),
        { label: "Missions", href: "/missions" },
        { label: name },
      ]}
      description={
        mission ? (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 align-middle">
            <StatusBadge status={mission.status} domain="mission" />
            <ProgressText progress={taskProgress(state.tasks, mission.id)} />
          </span>
        ) : undefined
      }
      actions={
        mission && (
          <>
            {mission.status === "draft" && (
              <Button
                variant="primary"
                loading={action.busy}
                onClick={() =>
                  void action.run(
                    () => client.missions.start(mission.id, {}),
                    () => "Start requested",
                  )
                }
              >
                Start mission
              </Button>
            )}
            {canCancel && (
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel mission
              </Button>
            )}
          </>
        )
      }
    >
      <StoreGate label="mission">
        {mission && (
          <>
            <ActionResult outcome={action.outcome} />
            <Disclosure
              title={
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  Objective
                  {missionOrigin(mission) && (
                    <span className="font-normal text-muted">{missionOrigin(mission)}</span>
                  )}
                </span>
              }
            >
              <KeyValue
                items={[
                  {
                    label: "Objective",
                    value: <span className="whitespace-pre-wrap">{mission.objective}</span>,
                  },
                  { label: "Mission ID", value: <Id value={mission.id} label="Mission ID" /> },
                  ...(project ? [{ label: "Project", value: project.name, term: "Project" }] : []),
                  {
                    label: "Crews",
                    term: "Crew",
                    value:
                      crews.length === 0 ? (
                        "None yet"
                      ) : (
                        <span className="flex flex-wrap gap-2">
                          {crews.map((c) => (
                            <Link
                              key={c.id}
                              href={`/crews/${c.id}`}
                              className="text-accent-fg hover:underline"
                            >
                              {crewLabel(c)}
                            </Link>
                          ))}
                        </span>
                      ),
                  },
                ]}
              />
            </Disclosure>
            <Tabs
              label="Mission views"
              urlParam="tab"
              items={[
                { value: "plan", label: "Plan", count: tasks.length, content: plan },
                { value: "timeline", label: "Timeline", content: timeline },
                { value: "agents", label: "Agents", count: agents.length, content: agentsTab },
                {
                  value: "files",
                  label: "Files",
                  content: (
                    <ArtifactTable
                      items={artifacts.filter((e) => isFileArtifact(e.payload.kind))}
                      taskLabel={taskLabel}
                    />
                  ),
                },
                { value: "tests", label: "Tests", content: <TestsTable items={tests} /> },
                {
                  value: "artifacts",
                  label: "Artifacts",
                  content: <ArtifactTable items={artifacts} taskLabel={taskLabel} />,
                },
                { value: "costs", label: "Costs", content: <Costs missionId={mission.id} /> },
              ]}
            />
            <ConfirmDialog
              open={confirmCancel}
              onOpenChange={setConfirmCancel}
              title="Cancel this mission?"
              description={`${name}: running agents are stopped and no further tasks start. This cannot be undone.`}
              confirmLabel="Confirm cancel mission"
              cancelLabel="Keep mission"
              tone="danger"
              onConfirm={() => {
                setConfirmCancel(false);
                void action.run(
                  () => client.missions.cancel(mission.id, {}),
                  () => "Cancel requested",
                );
              }}
            />
            <RaiseBudgetDialog
              open={raiseFor !== undefined}
              onOpenChange={(o) => !o && setRaiseFor(undefined)}
              missionId={mission.id}
              task={raiseFor ?? undefined}
              crews={crews}
            />
          </>
        )}
      </StoreGate>
    </Screen>
  );
}
