import type { CrewRole } from "@mimir/protocol";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ActionResult } from "../components/ActionResult.js";
import { StatusBadge } from "../components/Badges.js";
import { EventList } from "../components/EventList.js";
import { PageTitle, Section } from "../components/Section.js";
import { EmptyState, ErrorState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { filterEvents } from "../lib/derive.js";
import { useAction } from "../lib/useAction.js";
import { useAsync } from "../lib/useAsync.js";
import { useStore } from "../store/StoreProvider.js";

const ROLES: readonly CrewRole[] = ["lead", "implementer", "reviewer", "qa", "investigator"];

function CrewForm() {
  const { client, state, refresh } = useStore();
  const caps = useAsync(() => client.capabilities(), "caps");
  const kinds = caps.data?.runtime?.agentKinds ?? [];
  const [missionId, setMissionId] = useState("");
  const [template, setTemplate] = useState("default");
  const [maxConcurrent, setMaxConcurrent] = useState("1");
  const [roles, setRoles] = useState<Partial<Record<CrewRole, string>>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, outcome, run } = useAction();

  const defaultKind = kinds[0] ?? "shell";
  const toggle = (role: CrewRole) =>
    setRoles((r) => {
      const next = { ...r };
      if (next[role] !== undefined) delete next[role];
      else next[role] = defaultKind;
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const members = ROLES.flatMap((role) => {
      const kind = roles[role];
      return kind !== undefined ? [{ role, agentKind: kind }] : [];
    });
    const max = Number.parseInt(maxConcurrent, 10);
    const mission = state.missions.find((m) => m.id === missionId);
    if (!mission) return setInvalid("Choose a mission.");
    if (members.length === 0) return setInvalid("Pick at least one role.");
    if (!Number.isInteger(max) || max < 1)
      return setInvalid("Max concurrent tasks must be 1 or more.");
    setInvalid(null);
    const r = await run(
      () =>
        client.crews.create({
          missionId: mission.id,
          template: template.trim() || "default",
          limits: { maxConcurrentTasks: max },
          members,
        }),
      (res) => `Created crew ${res.crew.id} with ${res.members.length} members.`,
    );
    if (r) void refresh();
  };

  if (state.missions.length === 0)
    return <EmptyState>Create a mission first to staff a crew.</EmptyState>;
  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-2" noValidate>
      <label className="grid gap-1">
        <span className="font-medium">Mission</span>
        <select className="input" value={missionId} onChange={(e) => setMissionId(e.target.value)}>
          <option value="">Select a mission</option>
          {state.missions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.objective}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">Template name</span>
        <input className="input" value={template} onChange={(e) => setTemplate(e.target.value)} />
      </label>
      <fieldset className="rounded border border-zinc-300 p-2 dark:border-zinc-700">
        <legend className="font-medium">Roles</legend>
        {ROLES.map((role) => (
          <div key={role} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={roles[role] !== undefined}
                onChange={() => toggle(role)}
              />
              {role}
            </label>
            {roles[role] !== undefined && (
              <select
                className="input"
                aria-label={`Agent kind for ${role}`}
                value={roles[role]}
                onChange={(e) => setRoles((r) => ({ ...r, [role]: e.target.value }))}
              >
                {(kinds.length > 0 ? kinds : ["shell"]).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </fieldset>
      <label className="grid gap-1">
        <span className="font-medium">Max concurrent tasks</span>
        <input
          className="input"
          type="number"
          min={1}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
        />
      </label>
      {caps.status === "error" && (
        <ErrorState
          message={`Could not load runtime capabilities (${caps.error}); only the shell agent kind is offered.`}
          onRetry={caps.reload}
        />
      )}
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        Budgets are not part of the crew request in protocol v1; they are enforced by the server per
        mission/crew.
      </p>
      {invalid && (
        <p role="alert" className="text-red-800 dark:text-red-200">
          {invalid}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Create crew
        </button>
      </div>
      <ActionResult outcome={outcome} />
    </form>
  );
}

export function Crews() {
  const { state } = useStore();
  const objective = (id: string) => state.missions.find((m) => m.id === id)?.objective ?? id;
  return (
    <>
      <PageTitle>Crews</PageTitle>
      <StoreGate label="crews">
        <Section title="All crews">
          {state.crews.length === 0 ? (
            <EmptyState>No crews yet.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {state.crews.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <Link className="font-medium underline" to={`/crews/${c.id}`}>
                    {c.template}
                  </Link>
                  <StatusBadge status={c.status} />
                  <span className="text-sm">{objective(c.missionId)}</span>
                  {c.limits.maxConcurrentTasks !== undefined && (
                    <span className="text-sm">max {c.limits.maxConcurrentTasks} concurrent</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Create crew">
          <CrewForm />
        </Section>
      </StoreGate>
    </>
  );
}

export function CrewDetail() {
  const { id = "" } = useParams();
  const { state } = useStore();
  const c = state.crews.find((x) => x.id === id);
  if (state.status === "ready" && !c) {
    return (
      <>
        <PageTitle>Crew</PageTitle>
        <EmptyState>
          Crew not found. <Link to="/crews">Back to crews</Link>
        </EmptyState>
      </>
    );
  }
  const m = c ? state.missions.find((x) => x.id === c.missionId) : undefined;
  const roster = state.agents.filter((a) => a.crewId === id);
  return (
    <StoreGate label="crew">
      {c && (
        <>
          <PageTitle>Crew: {c.template}</PageTitle>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusBadge status={c.status} />
            <span>Active mission:</span>
            {m ? (
              <Link className="underline" to={`/missions/${m.id}`}>
                {m.objective}
              </Link>
            ) : (
              <span className="font-mono">{c.missionId}</span>
            )}
          </div>
          <Section title="Roster">
            {roster.length === 0 ? (
              <EmptyState>No agents have been started for this crew yet.</EmptyState>
            ) : (
              <ul className="space-y-1">
                {roster.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span>{a.role}</span>
                    <span>{a.agentKind}</span>
                    <StatusBadge status={a.status} />
                    {a.runtimeSessionId && (
                      <Link className="font-mono underline" to={`/agents/${a.runtimeSessionId}`}>
                        {a.runtimeSessionId}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Live events">
            <EventList
              events={filterEvents(state.events, { crewId: id })}
              empty="No events for this crew since this page loaded."
            />
          </Section>
        </>
      )}
    </StoreGate>
  );
}
