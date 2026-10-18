import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ActionResult } from "../components/ActionResult.js";
import { ProgressText, StatusBadge } from "../components/Badges.js";
import { PageTitle, Section } from "../components/Section.js";
import { EmptyState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { BOARD_COLUMNS, boardColumnFor, taskProgress } from "../lib/derive.js";
import { useAction } from "../lib/useAction.js";
import { useStore } from "../store/StoreProvider.js";

function MissionForm() {
  const { client, state, refresh } = useStore();
  const [projectId, setProjectId] = useState("");
  const [objective, setObjective] = useState("");
  const { busy, outcome, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;
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
    return <EmptyState>Create a project first to start a mission.</EmptyState>;
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-2">
      <label className="grid gap-1">
        <span className="font-medium">Project</span>
        <select
          className="input"
          required
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Select a project</option>
          {state.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Objective</span>
        <textarea
          className="input"
          required
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
      </label>
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Create mission
        </button>
      </div>
      <ActionResult outcome={outcome} />
    </form>
  );
}

export function Missions() {
  const { state, client } = useStore();
  const [filter, setFilter] = useState("");
  const start = useAction();
  const [startedId, setStartedId] = useState<string | null>(null);
  const tasks = filter ? state.tasks.filter((t) => t.missionId === filter) : state.tasks;
  const projectName = (id: string) => state.projects.find((p) => p.id === id)?.name ?? id;

  return (
    <>
      <PageTitle>Missions</PageTitle>
      <StoreGate label="missions">
        <Section title="All missions">
          {state.missions.length === 0 ? (
            <EmptyState>No missions yet.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {state.missions.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2">
                  <Link className="font-medium underline" to={`/missions/${m.id}`}>
                    {m.objective}
                  </Link>
                  <StatusBadge status={m.status} />
                  <span className="text-sm">{projectName(m.projectId)}</span>
                  <span className="text-sm">
                    <ProgressText progress={taskProgress(state.tasks, m.id)} />
                  </span>
                  {m.status === "draft" && (
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Start ${m.objective}`}
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
                    </button>
                  )}
                  {startedId === m.id && <ActionResult outcome={start.outcome} />}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="Task board"
          actions={
            <label className="text-sm">
              <span className="sr-only">Mission filter</span>
              <select
                className="input"
                aria-label="Mission filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">All missions</option>
                {state.missions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.objective}
                  </option>
                ))}
              </select>
            </label>
          }
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
            {BOARD_COLUMNS.map((col) => {
              const items = tasks.filter((t) => boardColumnFor(t.status) === col.id);
              return (
                <div
                  key={col.id}
                  className="rounded border border-zinc-300 p-2 dark:border-zinc-700"
                >
                  <h3 id={`col-${col.id}`} className="mb-1 font-semibold">
                    {col.label} ({items.length})
                  </h3>
                  <ul aria-label={col.label} className="space-y-1">
                    {items.map((t) => (
                      <li
                        key={t.id}
                        className="rounded border border-zinc-200 p-1 text-sm dark:border-zinc-800"
                      >
                        <Link className="underline" to={`/missions/${t.missionId}`}>
                          {t.title}
                        </Link>
                        <div className="text-xs text-zinc-700 dark:text-zinc-300">
                          {t.status}
                          {t.attempt > 0 ? ` · attempt ${t.attempt}/${t.maxAttempts}` : ""}
                          {t.blockedReason ? ` · ${t.blockedReason}` : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </Section>
        <Section title="Create mission">
          <MissionForm />
        </Section>
      </StoreGate>
    </>
  );
}
