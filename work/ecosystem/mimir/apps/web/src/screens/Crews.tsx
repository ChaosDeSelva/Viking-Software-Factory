import type { Agent, Crew, CrewRole } from "@mimir/protocol";
import {
  Badge,
  Button,
  Checkbox,
  Combobox,
  DataTable,
  Dialog,
  Field,
  Id,
  Input,
  KeyValue,
  Link,
  SegmentedControl,
  Select,
  Timestamp,
  type Column,
} from "@factory/ui";
import { useMemo, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { ActionResult } from "../components/ActionResult.js";
import { StatusBadge } from "../components/Badges.js";
import { EventList } from "../components/EventList.js";
import { RaiseBudgetDialog } from "../components/RaiseBudgetDialog.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { EmptyState, ErrorState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { isBudgetBlocked } from "../lib/budget.js";
import { filterEvents } from "../lib/derive.js";
import {
  crewEffectiveStatus,
  crewLabel,
  isCrewActive,
  isMissionEnded,
  missionName,
  taskName,
} from "../lib/names.js";
import { useScoped } from "../lib/scope.js";
import { useAction } from "../lib/useAction.js";
import { useAsync } from "../lib/useAsync.js";
import { useStore } from "../store/StoreProvider.js";

const ROLES: readonly CrewRole[] = ["lead", "implementer", "reviewer", "qa", "investigator"];
const LIVE_AGENT = new Set(["starting", "running", "waiting"]);

/** Create form; lives in the "New crew" dialog. Missions are the selected project's only. */
function CrewForm({ onCreated }: { onCreated?: () => void }) {
  const { client, state, refresh } = useStore();
  const scoped = useScoped();
  const caps = useAsync(() => client.capabilities(), "caps");
  const kinds = caps.data?.runtime?.agentKinds ?? [];
  const [missionId, setMissionId] = useState("");
  const [template, setTemplate] = useState("default");
  const [maxConcurrent, setMaxConcurrent] = useState("1");
  const [roles, setRoles] = useState<Partial<Record<CrewRole, string>>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, outcome, run } = useAction();

  const offered = kinds.length > 0 ? kinds : ["shell"];
  const defaultKind = offered[0] as string;
  // A role ticked before the capabilities loaded holds a kind that may not be offered any more;
  // the select then shows its first option, so that is what is sent.
  const kindFor = (role: CrewRole): string | undefined => {
    const kind = roles[role];
    return kind === undefined || offered.includes(kind) ? kind : defaultKind;
  };
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
      const kind = kindFor(role);
      return kind !== undefined ? [{ role, agentKind: kind }] : [];
    });
    // Not parseInt: it reads "1.5" and "1e3" as 1.
    const max = Number(maxConcurrent.trim() || Number.NaN);
    const mission = scoped.missions.find((m) => m.id === missionId);
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
    if (r) {
      void refresh();
      onCreated?.();
    }
  };

  if (scoped.missions.length === 0)
    return (
      <EmptyState
        body="A crew works on one mission. Create the mission first."
        action={<Link href="/missions">Go to Missions</Link>}
      >
        No missions to staff
      </EmptyState>
    );
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-field" noValidate>
      <Field label="Mission" hint="Only missions of the selected project.">
        <Combobox
          label="Mission"
          placeholder="Select a mission"
          searchPlaceholder="Search missions"
          value={missionId || null}
          onValueChange={setMissionId}
          options={scoped.missions.map((m) => ({
            value: m.id,
            label: missionName(m, state.tasks),
            keywords: `${m.id} ${m.objective}`,
          }))}
        />
      </Field>
      <Field label="Template name" term="Crew template">
        <Input value={template} onChange={(e) => setTemplate(e.target.value)} />
      </Field>
      <fieldset className="flex flex-col gap-3 rounded-md border border-line p-4">
        <legend className="px-1 text-sm font-medium">Roles</legend>
        {ROLES.map((role) => (
          <div key={role} className="flex flex-wrap items-center justify-between gap-3">
            <Checkbox
              label={role}
              checked={roles[role] !== undefined}
              onChange={() => toggle(role)}
            />
            {roles[role] !== undefined && (
              <Select
                aria-label={`Agent kind for ${role}`}
                size="sm"
                className="w-40"
                value={kindFor(role) ?? defaultKind}
                onValueChange={(v) => setRoles((r) => ({ ...r, [role]: v }))}
                options={offered.map((k) => ({ value: k, label: k }))}
              />
            )}
          </div>
        ))}
      </fieldset>
      <Field label="Max concurrent tasks">
        <Input
          type="number"
          min={1}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
        />
      </Field>
      {caps.status === "error" && (
        <ErrorState
          title="Could not load runtime capabilities"
          message={`${caps.error}; only the shell agent kind is offered.`}
          onRetry={caps.reload}
        />
      )}
      <p className="text-sm text-muted">
        Budgets are not part of the crew request in protocol v1; they are enforced by the server per
        mission/crew.
      </p>
      {invalid && (
        <p role="alert" className="text-sm text-danger-fg">
          {invalid}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          Create crew
        </Button>
      </div>
      <ActionResult outcome={outcome} />
    </form>
  );
}

interface CrewRow {
  crew: Crew;
  name: string;
  mission: string;
  status: { value: string; domain: "crew" | "mission" };
  working: number;
  active: boolean;
}

export function Crews() {
  const { state } = useStore();
  const scoped = useScoped();
  const [view, setView] = useState<"active" | "all">("active");
  const [creating, setCreating] = useState(false);

  const rows = useMemo<CrewRow[]>(
    () =>
      scoped.crews.map((c) => {
        const m = state.missions.find((x) => x.id === c.missionId);
        return {
          crew: c,
          name: crewLabel(c),
          mission: m ? missionName(m, state.tasks) : c.missionId,
          status: crewEffectiveStatus(c, m, scoped.agents),
          working: scoped.agents.filter((a) => a.crewId === c.id && LIVE_AGENT.has(a.status))
            .length,
          active: isCrewActive(c, m),
        };
      }),
    [scoped.crews, scoped.agents, state.missions, state.tasks],
  );
  const shown = view === "active" ? rows.filter((r) => r.active) : rows;

  const columns: Column<CrewRow>[] = [
    {
      key: "crew",
      header: "Crew",
      primary: true,
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <Link href={`/crews/${r.crew.id}`} className="font-medium text-fg hover:underline">
            {r.name}
          </Link>
          <Link
            href={`/missions/${r.crew.missionId}`}
            className="truncate text-xs text-muted hover:underline"
          >
            {r.mission}
          </Link>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge status={r.status.value} domain={r.status.domain} />,
    },
    { key: "working", header: "Agents working", align: "right", cell: (r) => r.working },
    {
      key: "limit",
      header: "Concurrency",
      cell: (r) =>
        r.crew.limits.maxConcurrentTasks !== undefined
          ? `max ${r.crew.limits.maxConcurrentTasks} concurrent`
          : "—",
      hideOnMobile: true,
    },
    {
      key: "created",
      header: "Created",
      cell: (r) => <Timestamp value={r.crew.createdAt} className="text-sm text-muted" />,
      hideOnMobile: true,
    },
  ];

  return (
    <Screen
      screen="crews"
      title="Crews"
      term="Crew"
      description="The teams of agents staffed on each mission, and what they are doing now."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New crew
        </Button>
      }
    >
      <StoreGate label="crews">
        <Section
          title={view === "active" ? "Active crews" : "All crews"}
          count={shown.length}
          flush
          actions={
            <SegmentedControl
              label="Show crews"
              size="sm"
              value={view}
              onValueChange={(v) => setView(v as "active" | "all")}
              options={[
                { value: "active", label: "Active" },
                { value: "all", label: "All" },
              ]}
            />
          }
        >
          <DataTable
            caption="Crews"
            columns={columns}
            rows={shown}
            rowKey={(r) => r.crew.id}
            empty={
              <EmptyState
                body={
                  rows.length > 0
                    ? "Every crew's mission has ended. Show all crews to see them."
                    : "Staff a mission with a crew of agents to start work."
                }
                action={
                  rows.length > 0 ? (
                    <Button size="sm" onClick={() => setView("all")}>
                      Show all crews
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                      New crew
                    </Button>
                  )
                }
              >
                {rows.length > 0 ? "No active crews" : "No crews yet"}
              </EmptyState>
            }
          />
        </Section>
      </StoreGate>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New crew"
        description="Pick the mission, the roles and how many tasks may run at once."
      >
        <CrewForm />
      </Dialog>
    </Screen>
  );
}

function RosterTable({ roster }: { roster: Agent[] }) {
  const { state } = useStore();
  const columns: Column<Agent>[] = [
    {
      key: "role",
      header: "Role",
      primary: true,
      cell: (a) => <Badge tone="forest">{a.role}</Badge>,
    },
    { key: "kind", header: "Agent kind", cell: (a) => a.agentKind },
    {
      key: "status",
      header: "State",
      cell: (a) => <StatusBadge status={a.status} domain="session" />,
    },
    {
      key: "task",
      header: "Task",
      cell: (a) => {
        const t = a.taskId ? state.tasks.find((x) => x.id === a.taskId) : undefined;
        return t ? (
          <span className="line-clamp-2 text-sm">{taskName(t)}</span>
        ) : (
          <span className="text-muted">—</span>
        );
      },
      hideOnMobile: true,
    },
    {
      key: "session",
      header: "Session",
      label: "Session",
      cell: (a) =>
        a.runtimeSessionId ? (
          <span className="flex flex-wrap items-center gap-2">
            <Link
              href={`/agents/${a.runtimeSessionId}?follow=1`}
              aria-label={`Live output ${a.runtimeSessionId}`}
              className="text-sm font-medium text-accent-fg hover:underline"
            >
              Live output
            </Link>
            <Id value={a.runtimeSessionId} label="Session ID" />
          </span>
        ) : (
          <span className="text-muted">no session</span>
        ),
    },
  ];
  return (
    <DataTable
      caption="Roster"
      columns={columns}
      rows={roster}
      rowKey={(a) => a.id}
      empty={
        <EmptyState body="Agents appear here once the scheduler gives this crew a task.">
          No agents have been started for this crew yet
        </EmptyState>
      }
    />
  );
}

export function CrewDetail() {
  const { id = "" } = useParams();
  const { state } = useStore();
  const [raising, setRaising] = useState(false);
  const c = state.crews.find((x) => x.id === id);
  if (state.status === "ready" && !c) {
    return (
      <Screen screen="crew-detail" title="Crew">
        <EmptyState
          compact={false}
          body="It may belong to a mission that was removed, or the link is wrong."
          action={<Link href="/crews">Back to crews</Link>}
        >
          Crew not found
        </EmptyState>
      </Screen>
    );
  }
  const m = c ? state.missions.find((x) => x.id === c.missionId) : undefined;
  const project = m ? state.projects.find((p) => p.id === m.projectId) : undefined;
  // The server refuses budget changes once the mission has ended (or is gone).
  const canRaise = m !== undefined && !isMissionEnded(m);
  const roster = state.agents.filter((a) => a.crewId === id);
  const status = c ? crewEffectiveStatus(c, m, state.agents) : null;
  const tasks = c ? state.tasks.filter((t) => t.missionId === c.missionId) : [];
  const budgetBlocked = tasks.find((t) => t.crewId === id && isBudgetBlocked(t));
  return (
    <Screen
      screen="crew-detail"
      title={c ? crewLabel(c) : "Crew"}
      term="Crew"
      description={m ? `Works on: ${missionName(m, state.tasks)}` : undefined}
      actions={
        c && canRaise ? (
          <Button
            variant={budgetBlocked ? "primary" : "secondary"}
            onClick={() => setRaising(true)}
          >
            Raise budget
          </Button>
        ) : undefined
      }
      breadcrumbs={[
        ...(project ? [{ label: project.name }] : []),
        { label: "Crews", href: "/crews" },
        { label: c ? crewLabel(c) : "Crew" },
      ]}
    >
      <StoreGate label="crew">
        {c && status && (
          <>
            <Section title="Summary">
              <KeyValue
                items={[
                  {
                    label: "Status",
                    value: <StatusBadge status={status.value} domain={status.domain} />,
                  },
                  {
                    label: "Active mission",
                    value: m ? (
                      <Link href={`/missions/${m.id}`} className="text-accent-fg hover:underline">
                        {missionName(m, state.tasks)}
                      </Link>
                    ) : (
                      <Id value={c.missionId} label="Mission ID" />
                    ),
                  },
                  { label: "Template", value: c.template, term: "Crew template" },
                  {
                    label: "Limits",
                    value:
                      [
                        c.limits.maxConcurrentTasks !== undefined &&
                          `max ${c.limits.maxConcurrentTasks} concurrent tasks`,
                        c.limits.maxAgents !== undefined && `max ${c.limits.maxAgents} agents`,
                        c.limits.maxAttemptsPerTask !== undefined &&
                          `${c.limits.maxAttemptsPerTask} attempts per task`,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "none set",
                  },
                  { label: "Scheduling", value: c.schedulingPaused ? "Paused" : "Running" },
                  { label: "Crew ID", value: <Id value={c.id} label="Crew ID" /> },
                ]}
              />
            </Section>
            <Section title="Roster" count={roster.length} flush>
              <RosterTable roster={roster} />
            </Section>
            <Section
              title="Live events"
              term="Event stream"
              description="Events for this crew since this page opened."
            >
              <EventList
                events={filterEvents(state.events, { crewId: id })}
                tasks={tasks}
                maxHeight="28rem"
                empty="No events for this crew since this page loaded"
                emptyBody="This list only shows events that arrive while the page is open. Older events are in Activity."
                emptyAction={<Link href="/activity">Open Activity</Link>}
              />
            </Section>
            <RaiseBudgetDialog
              open={raising}
              onOpenChange={setRaising}
              missionId={c.missionId}
              task={budgetBlocked}
              crews={[c]}
            />
          </>
        )}
      </StoreGate>
    </Screen>
  );
}
