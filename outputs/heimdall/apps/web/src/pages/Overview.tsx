// Every card is narrowed to the picker's project; "All projects" shows a capped, searchable
// project table instead.
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Grid,
  GridItem,
  GuideChat,
  Id,
  Input,
  MetricCard,
  Page,
  PageHeader,
  Pagination,
  Progress,
  Select,
  Stack,
  Timeline,
  Timestamp,
  type Column,
} from "@factory/ui";
import { useState, type ReactNode } from "react";
import { useHeimdall } from "../app/context";
import { LearnMore, Status, label } from "../components/app";
import { askGuide, type R } from "../lib/api";
import { navigate } from "../lib/router";
import { RaiseBudgetButton } from "../features/Budget";
import { eventTitle } from "../features/events";
import { isFinalExecution } from "../features/profileForm";
import {
  attentionItems,
  crewCounts,
  liveAgentOf,
  type AttentionItem,
  type Scope,
} from "../features/scope";
import {
  missionSpecTitle,
  projectKey,
  runTitle,
} from "../features/workflowState";

/** Three questions worth asking about the current state, most specific first. */
export function guideSuggestions(scope: Scope): string[] {
  const out: string[] = [];
  if (
    scope.tasks.some(
      (t) =>
        t.status === "blocked" && String(t.blockedReason).startsWith("budget"),
    )
  )
    out.push("Why is a task blocked on its budget, and how do I raise it?");
  if (
    scope.executions.some((e) => (e.tasks ?? []).some((t: R) => t.escalation))
  )
    out.push("What does the open escalation need from me?");
  if (scope.approvals.length)
    out.push("Which approvals are waiting, and what do they allow?");
  if (
    scope.executions.some(
      (e) => e.execution.status === "verified_pending_review",
    )
  )
    out.push("What should I check before exporting a verified run?");
  out.push(
    "What is happening in this project right now?",
    "What does the steward want me to decide?",
    "How do I watch an agent's live output?",
  );
  return [...new Set(out)].slice(0, 3);
}

const ATTENTION_LABEL: Record<AttentionItem["kind"], string> = {
  approval: "awaiting_approval",
  budget: "blocked",
  blocked: "blocked",
  failed: "failed",
  escalation: "needs_attention",
  review: "review",
};

/** Everything waiting on a person, with the action that resolves it where Heimdall has one. */
export function AttentionList({
  items,
  empty,
}: {
  items: AttentionItem[];
  empty: ReactNode;
}) {
  const { open } = useHeimdall();
  if (!items.length) return <>{empty}</>;
  return (
    <ul className="divide-y divide-line" aria-label="Needs you">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-col gap-2 px-card py-3 sm:flex-row sm:items-center sm:gap-4"
        >
          <div className="min-w-0 sm:flex-1">
            <button
              type="button"
              onClick={() => open(item.open.kind, item.open.row)}
              className="block max-w-full truncate text-left text-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {item.title}
            </button>
            <p className="line-clamp-2 text-xs text-muted">{item.detail}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Status value={ATTENTION_LABEL[item.kind]} />
            {item.kind === "budget" && <RaiseBudgetButton task={item.row} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function OverviewPage({ onAsk }: { onAsk: () => void }) {
  const { state, scope, projectName, open, href, setProject } = useHeimdall();
  const [missionId, setMissionId] = useState("latest");
  const [query, setQuery] = useState("");
  const [projectPage, setProjectPage] = useState(1);
  const specs: R[] = state?.sindri?.specs ?? [];
  const executions: R[] = state?.sindri?.executions ?? [];
  const counts = crewCounts(scope);
  const items = attentionItems(scope, (e) => runTitle(e, specs));
  const inProgress = scope.executions.filter(
    (e) => !isFinalExecution(e.execution.status),
  );
  const focused =
    scope.missions.find((m) => m.id === missionId) ?? scope.missions.at(-1);
  const focusedTasks = scope.tasks.filter((t) => t.missionId === focused?.id);
  const done = focusedTasks.filter((t) => t.status === "completed").length;
  const missionTitle = (m: R) =>
    missionSpecTitle(m, executions, specs) ?? String(label(m));
  const events: R[] = (state?.events ?? []).filter(scope.includes).slice(0, 8);
  const all = scope.filter === "all";
  const matching = scope.activeProjects.filter((p) =>
    `${p.name} ${p.repoPath ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(matching.length / 10));
  const shownPage = Math.min(projectPage, pageCount);

  const taskColumns: Column<R>[] = [
    {
      key: "title",
      header: "Task",
      primary: true,
      cell: (t) => <span className="line-clamp-2">{t.title}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => <Status value={t.status} domain="task" />,
    },
    {
      key: "attempt",
      header: "Attempt",
      align: "right",
      hideOnMobile: true,
      cell: (t) => `${t.attempt ?? 0} of ${t.maxAttempts ?? "—"}`,
    },
    {
      key: "live",
      header: "Live",
      label: "Live output",
      cell: (t) => {
        const agent = liveAgentOf(t, scope.agents);
        return agent ? (
          <Button
            size="sm"
            variant="secondary"
            icon="monitor"
            onClick={() => open("agents", agent)}
          >
            Watch live
          </Button>
        ) : null;
      },
    },
  ];
  const projectColumns: Column<R>[] = [
    {
      key: "name",
      header: "Project",
      primary: true,
      cell: (p) => String(p.name ?? "Local project"),
    },
    {
      key: "repo",
      header: "Repository",
      hideOnMobile: true,
      cell: (p) => (
        <span className="break-all font-mono text-xs text-muted">
          {p.repoPath ?? "—"}
        </span>
      ),
    },
    {
      key: "id",
      header: "ID",
      hideOnMobile: true,
      cell: (p) => <Id value={String(p.id)} />,
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Overview"
        description={
          <>
            What needs you, what is moving and what happened last
            {projectName ? ` in ${projectName}` : " across every project"}.
          </>
        }
        learnMore={<LearnMore screen="overview" />}
        scope={{ project: projectName }}
        meta={
          state?.generatedAt ? (
            <Timestamp value={state.generatedAt} prefix="Snapshot" />
          ) : undefined
        }
        actions={
          <Button
            variant="secondary"
            iconRight="arrowRight"
            onClick={() => navigate(href("pipeline"))}
          >
            View pipeline
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {all ? (
          <MetricCard
            label="Projects"
            term="Project"
            value={scope.activeProjects.length}
            description="Active in Heimdall; archived ones are hidden"
            href={href("projects")}
          />
        ) : (
          <MetricCard
            label="Runs in progress"
            term="Run"
            value={inProgress.length}
            description={`${scope.executions.length} ${scope.executions.length === 1 ? "run" : "runs"} in total`}
            href={href("pipeline")}
          />
        )}
        <MetricCard
          label="Crews"
          term="Crew"
          value={counts.crews}
          description={`${counts.workingCrews} working now`}
          href={href("crews-agents")}
        />
        <MetricCard
          label="Agents"
          term="Agent"
          value={counts.agents}
          description={`${counts.workingAgents} running now`}
          href={href("crews-agents")}
        />
        <MetricCard
          label="Needs you"
          term="Needs attention"
          value={items.length}
          description="Approvals, escalations, blocked tasks"
          href={href("quality-approvals")}
        />
      </div>
      <Grid gap={4}>
        <GridItem span={8}>
          <Stack gap={4}>
            <Card
              title="Needs you"
              count={items.length}
              term="Needs attention"
              flush
            >
              <AttentionList
                items={items}
                empty={
                  <EmptyState
                    compact
                    icon="check"
                    title="Nothing needs you"
                    body="No approvals, escalations, reviews or blocked tasks right now."
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
              title="Work in motion"
              term="Mission"
              actions={
                scope.missions.length > 1 ? (
                  <Select
                    aria-label="Mission in view"
                    size="sm"
                    className="w-56 max-w-full"
                    value={
                      scope.missions.some((m) => m.id === missionId)
                        ? missionId
                        : "latest"
                    }
                    onValueChange={setMissionId}
                    options={[
                      { value: "latest", label: "Latest mission" },
                      ...scope.missions.map((m) => ({
                        value: m.id,
                        label: missionTitle(m),
                      })),
                    ]}
                  />
                ) : undefined
              }
            >
              {focused ? (
                <Stack gap={4}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => open("missions", focused)}
                      className="min-w-0 truncate text-left text-md font-medium hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      {missionTitle(focused)}
                    </button>
                    <Status value={focused.status} domain="mission" />
                  </div>
                  <Progress
                    label={`${done} of ${focusedTasks.length} tasks completed`}
                    value={done}
                    max={focusedTasks.length || 1}
                    showValue
                  />
                  <DataTable
                    caption="Unfinished tasks"
                    columns={
                      focusedTasks.some((t) => liveAgentOf(t, scope.agents))
                        ? taskColumns
                        : taskColumns.filter((c) => c.key !== "live")
                    }
                    rows={focusedTasks.filter((t) => t.status !== "completed")}
                    rowKey={(t) => t.id}
                    onRowClick={(t) => open("tasks", t)}
                    rowLabel={(t) => `Open ${t.title}`}
                    dense
                    empty={
                      <EmptyState
                        compact
                        title="No unfinished tasks"
                        body="Every task of this mission is completed."
                        action={
                          <Button
                            variant="secondary"
                            onClick={() => open("missions", focused)}
                          >
                            Inspect mission
                          </Button>
                        }
                      />
                    }
                  />
                </Stack>
              ) : (
                <EmptyState
                  compact
                  title="No work in motion"
                  body="Missions appear here once a plan is approved and started."
                  action={
                    <Button
                      variant="primary"
                      icon="plus"
                      onClick={() => navigate(href("new-work"))}
                    >
                      New work
                    </Button>
                  }
                />
              )}
            </Card>
            <Card
              title="Latest activity"
              actions={
                <Button
                  size="sm"
                  variant="ghost"
                  iconRight="arrowRight"
                  onClick={() => navigate(href("activity"))}
                >
                  Full timeline
                </Button>
              }
            >
              {events.length ? (
                <Timeline
                  items={events.map((e, i) => ({
                    id: e.source + e.eventId + ":" + i,
                    time: e.timestamp ?? e.receivedAt ?? Date.now(),
                    rawType: e.type,
                    title: (
                      <button
                        type="button"
                        className="text-left hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                        onClick={() => open("event", e)}
                      >
                        {eventTitle(e.type)}
                      </button>
                    ),
                    meta: (
                      <span className="text-xs text-muted">
                        {e.source === "mimir" ? "Mimir" : "Sindri"}
                      </span>
                    ),
                  }))}
                />
              ) : (
                <EmptyState
                  compact
                  title="No activity yet"
                  body="Events appear here as Sindri and Mimir publish them."
                />
              )}
            </Card>
          </Stack>
        </GridItem>
        <GridItem span={4}>
          <Stack gap={4}>
            <Card title="Ask the factory" term="Guide">
              <GuideChat
                title="Guide"
                ask={askGuide}
                context={{
                  app: "heimdall",
                  screen: "overview",
                  ...(all ? {} : { projectId: scope.projects[0]?.id }),
                }}
                suggestions={guideSuggestions(scope)}
              />
              <Button variant="link" className="mt-3" onClick={onAsk}>
                Open the guide beside any page
              </Button>
            </Card>
            <Card title="Usage reported by Mimir" term="Usage source" dense>
              <p className="text-xl font-semibold tabular-nums">
                {(state?.mimir?.usage?.tokens ?? 0).toLocaleString()} tokens
              </p>
              <p className="text-sm text-muted">
                {state?.mimir?.usage?.estimatedCost > 0
                  ? `$${Number(state!.mimir.usage.estimatedCost).toFixed(2)} reported estimate · ${state!.mimir.usage.bySource?.unavailable ?? 0} unavailable samples`
                  : "Cost unavailable until the runtime reports usage."}{" "}
                Factory-wide: Mimir reports usage for all missions together.
              </p>
            </Card>
          </Stack>
        </GridItem>
      </Grid>
      {all && (
        <Card
          title="Projects"
          count={scope.activeProjects.length}
          flush
          actions={
            <Input
              aria-label="Search projects"
              prefix="search"
              placeholder="Search projects"
              className="w-56 max-w-full"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setProjectPage(1);
              }}
            />
          }
          footer={
            <Pagination
              page={shownPage}
              pageCount={pageCount}
              onPageChange={setProjectPage}
            />
          }
        >
          <DataTable
            caption="Projects"
            className="rounded-none border-0"
            columns={projectColumns}
            rows={matching.slice((shownPage - 1) * 10, shownPage * 10)}
            rowKey={(p) => p.id}
            onRowClick={(p) => setProject(projectKey(p))}
            rowLabel={(p) => `Show ${p.name ?? p.id}`}
            empty={
              <EmptyState
                compact
                title={query ? "No projects match" : "No projects yet"}
                body={
                  query
                    ? "Try a different name or path."
                    : "Register a local repository under New work."
                }
                action={
                  query ? (
                    <Button variant="secondary" onClick={() => setQuery("")}>
                      Clear search
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => navigate(href("new-work"))}
                    >
                      New work
                    </Button>
                  )
                }
              />
            }
          />
        </Card>
      )}
    </Page>
  );
}
