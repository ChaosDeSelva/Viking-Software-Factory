import type {
  Artifact,
  ArtifactId,
  MissionId,
  EventEnvelope,
  EventPayloadMap,
} from "@mimir/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { describeError } from "../api/client.js";
import { ActionResult } from "../components/ActionResult.js";
import { ProgressText, ProvenanceBadge, StatusBadge, UsageChips } from "../components/Badges.js";
import { DagSvg } from "../components/DagSvg.js";
import { EventFilters } from "../components/EventFilters.js";
import { EventList } from "../components/EventList.js";
import { PageTitle, Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { Tabs } from "../components/Tabs.js";
import { filterEvents, taskProgress, type EventFilter } from "../lib/derive.js";
import { useAction } from "../lib/useAction.js";
import { useAsync } from "../lib/useAsync.js";
import { useMissionEvents } from "../lib/useEventHistory.js";
import { useStore } from "../store/StoreProvider.js";

const TABS = [
  { id: "plan", label: "Plan" },
  { id: "timeline", label: "Timeline" },
  { id: "agents", label: "Agents" },
  { id: "files", label: "Files" },
  { id: "tests", label: "Tests" },
  { id: "artifacts", label: "Artifacts" },
  { id: "costs", label: "Costs" },
] as const;

type ArtifactEvent = EventEnvelope & { payload: EventPayloadMap["artifact.recorded"] };
type TestEvent = EventEnvelope & {
  payload: EventPayloadMap["test.run_completed"] & { exitCode?: number; output?: string };
};

const isFileArtifact = (kind: string) => /diff|patch|manifest|files/i.test(kind);

function ArtifactTable({ items }: { items: ArtifactEvent[] }) {
  const { client } = useStore();
  const [open, setOpen] = useState<Record<string, Artifact | string>>({});
  if (items.length === 0) return <EmptyState>No artifacts recorded yet.</EmptyState>;
  const view = async (id: ArtifactId) => {
    try {
      const r = await client.artifacts.get(id);
      setOpen((o) => ({ ...o, [id]: r.artifact }));
    } catch (e) {
      setOpen((o) => ({ ...o, [id]: describeError(e).message }));
    }
  };
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr>
          <th scope="col">Artifact</th>
          <th scope="col">Kind</th>
          <th scope="col">Task</th>
          <th scope="col">Details</th>
        </tr>
      </thead>
      <tbody>
        {items.map((e) => {
          const id = e.payload.artifactId;
          const detail = open[id];
          return (
            <tr key={e.id} className="border-t border-zinc-200 align-top dark:border-zinc-800">
              <td className="font-mono">{id}</td>
              <td>{e.payload.kind}</td>
              <td className="font-mono">{e.payload.taskId}</td>
              <td>
                {detail === undefined ? (
                  <button
                    type="button"
                    className="btn"
                    aria-label={`View ${id}`}
                    onClick={() => void view(id)}
                  >
                    View
                  </button>
                ) : typeof detail === "string" ? (
                  <span role="alert">{detail}</span>
                ) : (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-2">
                    <dt>URI</dt>
                    <dd className="font-mono break-all">{detail.uri}</dd>
                    <dt>Hash</dt>
                    <dd className="font-mono break-all">{detail.hash}</dd>
                  </dl>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TestsTable({ items }: { items: TestEvent[] }) {
  if (items.length === 0) return <EmptyState>No test runs recorded yet.</EmptyState>;
  return (
    <ul className="space-y-2">
      {items.map((e) => (
        <li key={e.id} className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
          <div className="flex flex-wrap items-center gap-2">
            <code>{e.payload.command}</code>
            <StatusBadge status={e.payload.passed ? "completed" : "failed"} />
            <span>{e.payload.passed ? "passed" : "failed"}</span>
            {e.payload.exitCode !== undefined && <span>exit code {e.payload.exitCode}</span>}
            {e.payload.total !== undefined && (
              <span>
                {e.payload.failed ?? 0} of {e.payload.total} failed
              </span>
            )}
            {e.payload.durationMs !== undefined && (
              <span>{Math.round(e.payload.durationMs)} ms</span>
            )}
            <ProvenanceBadge provenance={e.provenance} />
          </div>
          {e.payload.output && (
            <pre className="mt-1 max-h-64 overflow-auto bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
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

/** Keyed by mission id so tab, filter and confirmation state never leak between missions. */
export function MissionDetail() {
  const { id = "" } = useParams();
  return <MissionDetailView key={id} id={id} />;
}

function MissionDetailView({ id }: { id: string }) {
  const { state, client } = useStore();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const refocusCancel = useRef(false);
  useEffect(() => {
    if (confirmCancel) confirmRef.current?.focus();
    else if (refocusCancel.current) {
      refocusCancel.current = false;
      cancelRef.current?.focus();
    }
  }, [confirmCancel]);
  const [tab, setTab] = useState<string>("plan");
  const [filter, setFilter] = useState<EventFilter>({});
  const history = useMissionEvents(client, id, state.events);
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

  if (state.status === "ready" && !mission) {
    return (
      <>
        <PageTitle>Mission</PageTitle>
        <EmptyState>
          Mission not found. <Link to="/missions">Back to missions</Link>
        </EmptyState>
      </>
    );
  }

  return (
    <StoreGate label="mission">
      {mission && (
        <>
          <PageTitle>Mission: {mission.objective}</PageTitle>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <StatusBadge status={mission.status} />
            <ProgressText progress={taskProgress(state.tasks, mission.id)} />
            {mission.status === "draft" && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () => client.missions.start(mission.id, {}),
                    () => "Start requested",
                  )
                }
              >
                Start mission
              </button>
            )}
            {(mission.status === "active" ||
              mission.status === "paused" ||
              mission.status === "draft") &&
              (!confirmCancel ? (
                <button
                  ref={cancelRef}
                  type="button"
                  className="btn"
                  disabled={action.busy}
                  onClick={() => setConfirmCancel(true)}
                >
                  Cancel mission
                </button>
              ) : (
                <>
                  <button
                    ref={confirmRef}
                    type="button"
                    className="btn btn-danger"
                    disabled={action.busy}
                    onClick={() => {
                      refocusCancel.current = true;
                      setConfirmCancel(false);
                      void action.run(
                        () => client.missions.cancel(mission.id, {}),
                        () => "Cancel requested",
                      );
                    }}
                  >
                    Confirm cancel mission
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      refocusCancel.current = true;
                      setConfirmCancel(false);
                    }}
                  >
                    Keep mission
                  </button>
                </>
              ))}
          </div>
          <ActionResult outcome={action.outcome} />
          <Tabs tabs={TABS} active={tab} onChange={setTab} label="Mission views">
            {tab === "plan" &&
              (tasks.length === 0 ? (
                <EmptyState>This mission has no tasks yet.</EmptyState>
              ) : (
                <>
                  <DagSvg tasks={tasks} deps={deps} />
                  <h2 className="mt-3 font-semibold">Tasks</h2>
                  <ul className="text-sm">
                    {tasks.map((t) => (
                      <li key={t.id}>
                        {t.title}: {t.status}
                        {t.blockedReason ? ` (${t.blockedReason})` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              ))}
            {tab === "timeline" && (
              <>
                <EventFilters
                  filter={filter}
                  onChange={setFilter}
                  crews={crews.map((c) => ({ value: c.id, label: c.template }))}
                  sessions={agents.flatMap((a) =>
                    a.runtimeSessionId
                      ? [{ value: a.runtimeSessionId, label: `${a.role} ${a.runtimeSessionId}` }]
                      : [],
                  )}
                  tasks={tasks.map((t) => ({ value: t.id, label: t.title }))}
                />
                {history.status === "loading" && <LoadingState label="timeline" />}
                {history.status === "error" && (
                  <ErrorState message={history.error ?? "failed"} onRetry={history.reload} />
                )}
                <Section title="Events">
                  <EventList events={filterEvents(history.events, filter)} />
                </Section>
              </>
            )}
            {tab === "agents" &&
              (agents.length === 0 ? (
                <EmptyState>No agents yet.</EmptyState>
              ) : (
                <ul className="space-y-1">
                  {agents.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <span>{a.role}</span>
                      <span>{a.agentKind}</span>
                      <StatusBadge status={a.status} />
                      {a.runtimeSessionId ? (
                        <Link className="font-mono underline" to={`/agents/${a.runtimeSessionId}`}>
                          {a.runtimeSessionId}
                        </Link>
                      ) : (
                        <span>no session</span>
                      )}
                    </li>
                  ))}
                </ul>
              ))}
            {tab === "files" && (
              <ArtifactTable items={artifacts.filter((e) => isFileArtifact(e.payload.kind))} />
            )}
            {tab === "tests" && <TestsTable items={tests} />}
            {tab === "artifacts" && <ArtifactTable items={artifacts} />}
            {tab === "costs" && <Costs missionId={mission.id} />}
          </Tabs>
        </>
      )}
    </StoreGate>
  );
}
