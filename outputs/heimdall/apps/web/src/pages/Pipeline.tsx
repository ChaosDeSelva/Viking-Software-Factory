// Pipeline: the selected project's runs, then its work by stage. Stage state belongs to Sindri and
// Mimir; the column order is a display preference. Stages with nothing in them collapse into one
// line so the board fits the window instead of scrolling sideways past empty columns.
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Id,
  Input,
  Page,
  PageHeader,
  Section,
  type Column,
} from "@factory/ui";
import { useState } from "react";
import { useHeimdall } from "../app/context";
import { LearnMore, Status, label } from "../components/app";
import type { R } from "../lib/api";
import { navigate } from "../lib/router";
import { isFinalExecution } from "../features/profileForm";
import { blockedText, liveAgentOf } from "../features/scope";
import {
  deliveryTitle,
  runTitle,
  statusBadge,
} from "../features/workflowState";

export const DEFAULT_STAGES = [
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

/** Records per stage, from authoritative source states. */
export function stages(scope: R): [string, R[], string][] {
  const tasks: R[] = scope.tasks;
  return [
    ["Intake", scope.intakes, "intakes"],
    [
      "Specification",
      scope.specs.filter((x: R) => x.status === "draft"),
      "specs",
    ],
    ["Planning", scope.plans.filter((x: R) => x.status === "draft"), "plans"],
    [
      "Ready",
      tasks.filter((x) => ["pending", "ready", "leased"].includes(x.status)),
      "tasks",
    ],
    [
      "Building",
      tasks.filter((x) =>
        ["running", "blocked", "failed", "cancelled"].includes(x.status),
      ),
      "tasks",
    ],
    ["Verification", tasks.filter((x) => x.status === "verifying"), "tasks"],
    [
      "Review",
      [...scope.specs, ...scope.plans].filter((x: R) => x.status === "review"),
      "specs",
    ],
    ["Completed", tasks.filter((x) => x.status === "completed"), "tasks"],
    ["Delivery", scope.deliveries, "deliveries"],
  ];
}

/** Live output for a run: the first of its tasks with an agent working now. */
export function runLiveAgent(e: R, tasks: R[], agents: R[]): R | undefined {
  const ids = new Set((e.tasks ?? []).map((t: R) => t.mimirTaskId));
  for (const t of tasks.filter(
    (t) => ids.has(t.id) || t.missionId === e.execution.mimirMissionId,
  )) {
    const agent = liveAgentOf(t, agents);
    if (agent) return agent;
  }
  return undefined;
}

export function PipelinePage() {
  const { state, scope, projectName, open, href } = useHeimdall();
  const [search, setSearch] = useState("");
  const specs: R[] = state?.sindri?.specs ?? [];
  const executions: R[] = state?.sindri?.executions ?? [];
  const order: string[] = state?.preferences?.stages ?? DEFAULT_STAGES;
  const match = (r: R) =>
    !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase());
  const board = stages(scope)
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([name, rows, kind]) => [name, rows.filter(match), kind] as const);
  const filled = board.filter(([, rows]) => rows.length);
  const empty = board.filter(([, rows]) => !rows.length).map(([name]) => name);
  const runs = scope.executions.filter(
    (e) => match(e.execution) || match({ t: runTitle(e, specs) }),
  );
  const running = scope.executions.filter(
    (e) => !isFinalExecution(e.execution.status),
  ).length;
  const ended = scope.executions.filter((e) =>
    ["failed", "cancelled"].includes(e.execution.status),
  ).length;

  const runColumns: Column<R>[] = [
    {
      key: "title",
      header: "Run",
      primary: true,
      cell: (e) => (
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 font-medium">{runTitle(e, specs)}</span>
          {["failed", "cancelled"].includes(e.execution.status) && (
            <span className="text-xs text-muted">ended without a delivery</span>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (e) => <Status value={e.execution.status} domain="run" />,
    },
    {
      key: "id",
      header: "Run ID",
      hideOnMobile: true,
      cell: (e) => <Id value={e.execution.id} />,
    },
    {
      key: "live",
      header: "Live",
      label: "Live output",
      cell: (e) => {
        const agent = runLiveAgent(e, scope.tasks, scope.agents);
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

  return (
    <Page>
      <PageHeader
        title="Pipeline"
        description={
          <>Runs, then every record by stage from intake to local delivery.</>
        }
        learnMore={<LearnMore screen="pipeline" />}
        term="Pipeline"
        scope={{ project: projectName }}
        actions={
          <Input
            aria-label="Search records"
            prefix="search"
            placeholder="Filter by title, ID or status"
            className="w-64 max-w-full"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        }
      />
      {scope.executions.length > 0 && (
        <section aria-labelledby="runs-heading">
          <Card
            title={<span id="runs-heading">Runs</span>}
            term="Run"
            description={`${running} in progress · ${ended} failed or cancelled`}
            flush
          >
            <DataTable
              caption="Runs"
              className="rounded-none border-0"
              columns={
                runs.some((e) => runLiveAgent(e, scope.tasks, scope.agents))
                  ? runColumns
                  : runColumns.filter((c) => c.key !== "live")
              }
              rows={runs}
              rowKey={(e) => e.execution.id}
              onRowClick={(e) => open("execution", e.execution)}
              rowLabel={(e) => `${runTitle(e, specs)}`}
              empty={
                <EmptyState
                  compact
                  title="No matching runs"
                  action={
                    <Button variant="secondary" onClick={() => setSearch("")}>
                      Clear search
                    </Button>
                  }
                />
              }
            />
          </Card>
        </section>
      )}
      <Section
        title="Stages"
        description={
          empty.length
            ? `Nothing in ${empty.join(", ")}.`
            : "Every stage has work in it."
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate(href("connections", {}, "display"))}
          >
            Change stage order
          </Button>
        }
      >
        {filled.length ? (
          <div
            className="flex gap-4 overflow-x-auto pb-2"
            aria-label="Pipeline stages"
          >
            {filled.map(([name, rows, kind]) => (
              <section
                key={name}
                role="region"
                tabIndex={0}
                aria-label={`${name} stage, scroll for more items`}
                className="flex max-h-[70vh] w-72 shrink-0 flex-col rounded-lg border border-line bg-surface focus-visible:outline-2 focus-visible:outline-focus"
              >
                <h3 className="flex items-center justify-between border-b border-line px-4 py-3 text-sm font-semibold">
                  {name}
                  <span className="rounded-full bg-sunken px-2 text-xs text-muted tabular-nums">
                    {rows.length}
                  </span>
                </h3>
                <ul className="flex flex-col gap-2 overflow-y-auto p-3">
                  {rows.map((r) => {
                    const target = kind === "specs" && r.tasks ? "plans" : kind;
                    const title =
                      (kind === "deliveries" &&
                        deliveryTitle(r, executions, specs)) ||
                      String(label(r));
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => open(target, r)}
                          className="flex w-full flex-col gap-2 rounded-md border border-line bg-raised p-3 text-left hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                        >
                          <strong className="line-clamp-2 text-sm font-medium">
                            {title}
                          </strong>
                          <span className="flex flex-wrap items-center gap-2">
                            <Status
                              value={statusBadge(kind, r)}
                              domain={kind === "tasks" ? "task" : undefined}
                              size="sm"
                              tooltip={false}
                            />
                            <span className="truncate font-mono text-xs text-muted">
                              {["specs", "plans"].includes(kind) &&
                              r.version != null
                                ? `v${r.version} · `
                                : ""}
                              {r.id}
                            </span>
                          </span>
                          {kind === "tasks" && r.blockedReason && (
                            <span className="line-clamp-2 text-xs text-warning-fg">
                              {blockedText(r.blockedReason)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <EmptyState
            title={search ? "No matching items" : "Nothing in the pipeline yet"}
            body={
              search
                ? "Try a different search."
                : "Describe new work to start a specification."
            }
            action={
              search ? (
                <Button variant="secondary" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              ) : (
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => navigate(href("new-work"))}
                >
                  New work
                </Button>
              )
            }
          />
        )}
      </Section>
    </Page>
  );
}
