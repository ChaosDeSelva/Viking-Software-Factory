import type { Mission, Task } from "@mimir/protocol";
import {
  Button,
  Combobox,
  DataTable,
  Dialog,
  Field,
  Link,
  Textarea,
  Timestamp,
  type Column,
} from "@factory/ui";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ActionResult } from "../components/ActionResult.js";
import { BlockedReason } from "../components/BlockedReason.js";
import { ProgressText, StatusBadge } from "../components/Badges.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { EmptyState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { LiveOutputLink, liveSession, TaskTitle } from "../components/TaskParts.js";
import { BOARD_COLUMNS, boardColumnFor, taskProgress } from "../lib/derive.js";
import { missionName, missionOrigin, taskName } from "../lib/names.js";
import { useProjectScope, useScoped } from "../lib/scope.js";
import { useAction } from "../lib/useAction.js";
import { useStore } from "../store/StoreProvider.js";

/** Cards a board column shows before "Show N more". */
export const COLUMN_CAP = 6;
const ALL = "__all__";

function MissionForm() {
  const { client, state, refresh } = useStore();
  const { projectId: scoped } = useProjectScope();
  const [projectId, setProjectId] = useState(scoped ?? "");
  const [objective, setObjective] = useState("");
  const { busy, outcome, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project || !objective.trim()) return;
    const r = await run(
      () => client.missions.create({ projectId: project.id, objective: objective.trim() }),
      (res) => `Created mission ${res.mission.id}.`,
    );
    if (r) {
      setObjective("");
      void refresh();
    }
  };
  if (state.projects.length === 0) {
    return (
      <EmptyState body="A mission runs in a project's repository.">
        Create a project first to start a mission
      </EmptyState>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-field">
      <Field label="Project" required>
        <Combobox
          label="Project"
          placeholder="Select a project"
          value={projectId || null}
          onValueChange={setProjectId}
          options={state.projects.map((p) => ({
            value: p.id,
            label: p.name,
            description: p.repoPath,
          }))}
          className="w-full"
        />
      </Field>
      <Field
        label="Objective"
        hint="What the crews should achieve. The first sentence becomes the mission's name."
        required
      >
        <Textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={4} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy} disabled={!projectId}>
          Create mission
        </Button>
      </div>
      <ActionResult outcome={outcome} />
    </form>
  );
}

/** One kanban column: compact cards, capped, the rest behind "Show N more". */
function BoardColumn({
  id,
  label,
  tasks,
  render,
}: {
  id: string;
  label: string;
  tasks: readonly Task[];
  render: (t: Task) => ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? tasks : tasks.slice(0, COLUMN_CAP);
  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 rounded-lg border border-line bg-sunken p-2">
      <h3 id={`col-${id}`} className="flex items-center justify-between px-1 text-sm font-semibold">
        {label}
        <span className="rounded-full bg-surface px-2 text-xs font-medium text-muted tabular-nums">
          {tasks.length}
        </span>
      </h3>
      <ul aria-label={label} className="flex flex-col gap-2">
        {shown.map((t) => (
          <li key={t.id}>{render(t)}</li>
        ))}
      </ul>
      {tasks.length === 0 && <p className="px-1 py-2 text-xs text-muted">None</p>}
      {tasks.length > COLUMN_CAP && (
        <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show ${tasks.length - COLUMN_CAP} more`}
        </Button>
      )}
    </div>
  );
}

export function Missions() {
  const { state, client } = useStore();
  const scoped = useScoped();
  const [filter, setFilter] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const start = useAction();
  const [startedId, setStartedId] = useState<string | null>(null);

  const names = useMemo(
    () => new Map(scoped.missions.map((m) => [m.id as string, missionName(m, state.tasks)])),
    [scoped.missions, state.tasks],
  );
  const nameOf = (m: Mission) => names.get(m.id) ?? m.objective;
  const tasks = filter === ALL ? scoped.tasks : scoped.tasks.filter((t) => t.missionId === filter);
  const crewCount = (id: string) => scoped.crews.filter((c) => c.missionId === id).length;
  const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name;

  const columns: Column<Mission>[] = [
    {
      key: "name",
      header: "Mission",
      primary: true,
      width: "40%",
      cell: (m) => (
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 [overflow-wrap:anywhere]">{nameOf(m)}</span>
          {missionOrigin(m) && (
            <span className="text-xs font-normal text-muted">{missionOrigin(m)}</span>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (m) => <StatusBadge status={m.status} domain="mission" />,
    },
    {
      key: "progress",
      header: "Progress",
      cell: (m) => <ProgressText progress={taskProgress(state.tasks, m.id)} />,
    },
    {
      key: "crews",
      header: "Crews",
      align: "right",
      hideOnMobile: true,
      cell: (m) => crewCount(m.id),
    },
    // Only for All projects; the full objective is on the mission page (Objective disclosure).
    ...(scoped.missionIds === null
      ? [
          {
            key: "project",
            header: "Project",
            hideOnMobile: true,
            cell: (m: Mission) => (
              <span className="text-sm">{projectName(m.projectId) ?? "—"}</span>
            ),
          },
        ]
      : []),
    {
      key: "updated",
      header: "Updated",
      hideOnMobile: true,
      cell: (m) => <Timestamp value={m.updatedAt} className="text-xs text-muted" />,
    },
  ];
  // Only drafts can be started; without any, the column (and its empty phone label) is left out.
  if (scoped.missions.some((m) => m.status === "draft")) {
    columns.push({
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      label: "Actions",
      align: "right",
      cell: (m) =>
        m.status === "draft" ? (
          <span className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              aria-label={`Start ${nameOf(m)}`}
              disabled={start.busy}
              onClick={() => {
                setStartedId(m.id);
                void start.run(
                  () => client.missions.start(m.id, {}),
                  () => "Start requested",
                );
              }}
            >
              Start
            </Button>
            {startedId === m.id && <ActionResult outcome={start.outcome} />}
          </span>
        ) : null,
    });
  }

  const card = (t: Task) => {
    const session = liveSession(t, scoped.agents);
    return (
      <article className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3 shadow-0">
        <TaskTitle task={t} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <StatusBadge status={t.status} domain="task" size="sm" />
          {/* `attempt` is a 0-based index. */}
          {t.attempt > 0 && (
            <span>
              attempt {t.attempt + 1}/{t.maxAttempts}
            </span>
          )}
          {t.blockedReason && (
            <BlockedReason reason={t.blockedReason} className="text-warning-fg" />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <MissionLink missionId={t.missionId} name={names.get(t.missionId)} />
          {session && <LiveOutputLink sessionId={session} taskLabel={taskName(t)} />}
        </div>
      </article>
    );
  };

  return (
    <Screen
      screen="missions"
      title="Missions"
      term="Mission"
      description="Each mission is one objective, split into tasks that crews of agents work through."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New mission
        </Button>
      }
    >
      <StoreGate label="missions">
        <Section title="Missions" count={scoped.missions.length} flush>
          <DataTable
            caption="Missions"
            columns={columns}
            rows={[...scoped.missions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))}
            rowKey={(m) => m.id}
            rowHref={(m) => `/missions/${m.id}`}
            rowLabel={(m) => nameOf(m)}
            className="rounded-none border-0"
            empty={
              <EmptyState
                body="A mission is created here or by Sindri when a plan is approved."
                action={
                  <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
                    New mission
                  </Button>
                }
              >
                No missions yet
              </EmptyState>
            }
          />
        </Section>
        <Section
          title="Task board"
          term="Task"
          description="Every task of these missions by status. Open a card's prompt for the full text."
          actions={
            <div className="w-full max-w-72 min-w-0 sm:w-72">
              <Combobox
                label="Mission filter"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: ALL, label: "All missions" },
                  ...scoped.missions.map((m) => ({ value: m.id, label: nameOf(m) })),
                ]}
                className="w-full"
              />
            </div>
          }
        >
          {tasks.length === 0 ? (
            <EmptyState body="Tasks appear here once a mission has a plan.">
              No tasks yet
            </EmptyState>
          ) : (
            <div
              role="group"
              aria-label="Task columns"
              className="-mx-1 flex items-start gap-3 overflow-x-auto px-1 pb-2"
              tabIndex={0}
            >
              {BOARD_COLUMNS.map((col) => (
                <BoardColumn
                  key={col.id}
                  id={col.id}
                  label={col.label}
                  tasks={tasks.filter((t) => boardColumnFor(t.status) === col.id)}
                  render={card}
                />
              ))}
            </div>
          )}
        </Section>
      </StoreGate>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New mission"
        description="Mimir starts it as a draft. Add crews, then start it."
      >
        <MissionForm />
      </Dialog>
    </Screen>
  );
}

function MissionLink({ missionId, name }: { missionId: string; name: string | undefined }) {
  return (
    <Link
      href={`/missions/${missionId}`}
      className="min-w-0 truncate text-muted hover:text-fg hover:underline"
      title={name}
    >
      {name ?? "Open mission"}
    </Link>
  );
}
