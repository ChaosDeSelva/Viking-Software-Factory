// Every crew Mimir lists for the selected project, not only active ones, so counts match Mimir's.
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Page,
  PageHeader,
  Pagination,
  Timestamp,
  type Column,
} from "@factory/ui";
import { useState } from "react";
import { useHeimdall } from "../app/context";
import { LearnMore, Status } from "../components/app";
import type { R } from "../lib/api";
import { navigate } from "../lib/router";
import { ACTIVE, crewCounts } from "../features/scope";
import { missionSpecTitle } from "../features/workflowState";

const PAGE = 10;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function CrewsPage() {
  const { state, scope, projectName, open, href } = useHeimdall();
  const [crewPage, setCrewPage] = useState(1),
    [agentPage, setAgentPage] = useState(1);
  const counts = crewCounts(scope);
  const executions: R[] = state?.sindri?.executions ?? [];
  const specs: R[] = state?.sindri?.specs ?? [];
  const missionName = (id: string) => {
    const m = scope.missions.find((x) => x.id === id);
    return m
      ? (missionSpecTitle(m, executions, specs) ?? String(m.objective ?? m.id))
      : id;
  };
  const taskTitle = (id: string | undefined) =>
    scope.tasks.find((t) => t.id === id)?.title;
  const crewPages = Math.max(1, Math.ceil(scope.crews.length / PAGE));
  const agentPages = Math.max(1, Math.ceil(scope.agents.length / PAGE));
  const crewShown = Math.min(crewPage, crewPages),
    agentShown = Math.min(agentPage, agentPages);

  const crewColumns: Column<R>[] = [
    {
      key: "template",
      header: "Crew",
      primary: true,
      cell: (c) => String(c.template ?? c.id),
    },
    {
      key: "mission",
      header: "Mission",
      hideOnMobile: true,
      cell: (c) => (
        <span className="line-clamp-2">{missionName(c.missionId)}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (c) => <Status value={c.status} domain="crew" />,
    },
    {
      key: "agents",
      header: "Agents",
      align: "right",
      cell: (c) => scope.agents.filter((a) => a.crewId === c.id).length,
    },
    {
      key: "scheduling",
      header: "Scheduling",
      cell: (c) =>
        c.schedulingPaused ? (
          <Badge
            tone="warning"
            tooltip="No new tasks start for this crew; running sessions continue."
          >
            Paused
          </Badge>
        ) : (
          <Badge tone="neutral">Enabled</Badge>
        ),
    },
  ];
  const agentColumns: Column<R>[] = [
    {
      key: "agent",
      header: "Agent",
      primary: true,
      cell: (a) =>
        `${a.agentKind ?? "agent"} · ${a.role ?? "role not reported"}`,
    },
    {
      key: "status",
      header: "Status",
      cell: (a) => <Status value={a.status} domain="agent" />,
    },
    {
      key: "task",
      header: "Task",
      hideOnMobile: true,
      cell: (a) => (
        <span className="line-clamp-2">{taskTitle(a.taskId) ?? "No task"}</span>
      ),
    },
    {
      key: "updated",
      header: "Last update",
      hideOnMobile: true,
      cell: (a) =>
        a.updatedAt ? <Timestamp value={a.updatedAt} /> : "Not reported",
    },
    {
      key: "live",
      header: "Live",
      label: "Live output",
      cell: (a) =>
        a.runtimeSessionId && ACTIVE.includes(a.status) ? (
          <Button
            size="sm"
            variant="secondary"
            icon="monitor"
            onClick={() => open("agents", a)}
          >
            Watch live
          </Button>
        ) : null,
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Crews & agents"
        description={
          <>
            Who is working and on what: {plural(counts.crews, "crew")} (
            {counts.workingCrews} working now) and{" "}
            {plural(counts.agents, "agent")} ({counts.workingAgents} running).
          </>
        }
        learnMore={<LearnMore screen="crews-agents" />}
        term="Crew"
        scope={{ project: projectName }}
      />
      <Card
        title="Crews"
        count={scope.crews.length}
        term="Crew"
        description="Pause scheduling from a crew's inspector; running sessions continue."
        flush
        footer={
          <Pagination
            page={crewShown}
            pageCount={crewPages}
            onPageChange={setCrewPage}
          />
        }
      >
        <DataTable
          caption="Crews"
          className="rounded-none border-0"
          columns={crewColumns}
          rows={scope.crews.slice((crewShown - 1) * PAGE, crewShown * PAGE)}
          rowKey={(c) => c.id}
          onRowClick={(c) => open("crews", c)}
          rowLabel={(c) => `Inspect ${c.template ?? c.id}`}
          empty={
            <EmptyState
              compact
              title="No crews yet"
              body="Mimir creates a crew for each team a started plan needs; they are listed here as soon as it does."
              action={
                <Button
                  variant="secondary"
                  onClick={() => navigate(href("pipeline"))}
                >
                  View pipeline
                </Button>
              }
            />
          }
        />
      </Card>
      <Card
        title="Agents"
        count={scope.agents.length}
        term="Agent"
        description="Open an agent to watch its live output, tool calls and state."
        flush
        footer={
          <Pagination
            page={agentShown}
            pageCount={agentPages}
            onPageChange={setAgentPage}
          />
        }
      >
        <DataTable
          caption="Agents"
          className="rounded-none border-0"
          columns={
            scope.agents.some(
              (a) => a.runtimeSessionId && ACTIVE.includes(a.status),
            )
              ? agentColumns
              : agentColumns.filter((c) => c.key !== "live")
          }
          rows={scope.agents.slice((agentShown - 1) * PAGE, agentShown * PAGE)}
          rowKey={(a) => a.id}
          onRowClick={(a) => open("agents", a)}
          rowLabel={(a) =>
            `Inspect ${a.agentKind ?? "agent"} ${a.role ?? ""}`.trim()
          }
          empty={
            <EmptyState
              compact
              title="No agents yet"
              body="Agents appear when a crew starts a task."
            />
          }
        />
      </Card>
    </Page>
  );
}
