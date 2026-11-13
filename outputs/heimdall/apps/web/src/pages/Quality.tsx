// Quality & approvals: what waits on a human decision in the selected project, then each run's
// verification gates and delivery. Actions open in the inspector, where the reasons a control is
// unavailable are shown.
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Page,
  PageHeader,
  Section,
  Stack,
  type Column,
} from "@factory/ui";
import { useHeimdall } from "../app/context";
import { LearnMore, Status } from "../components/app";
import type { R } from "../lib/api";
import { navigate } from "../lib/router";
import { RaiseBudgetButton } from "../features/Budget";
import { openEscalations } from "../features/profileForm";
import { isBudgetBlocked, type Scope } from "../features/scope";
import { deliveryTitle, runTitle } from "../features/workflowState";
import { WorkKindBadge } from "../features/WorkForms";
import { documentWaiting, pendingDocuments } from "../features/workKinds";

interface Decision {
  id: string;
  kind: "Approval" | "Escalation" | "Budget" | "Specification" | "Plan";
  title: string;
  detail: string;
  status: string;
  open: [string, R];
  row: R;
}

/** Decisions waiting on a person; the count on the Quality & approvals tab. */
export function decisions(scope: Scope, specs: R[]): Decision[] {
  const out: Decision[] = [];
  for (const a of scope.approvals)
    out.push({
      id: "a:" + a.id,
      kind: "Approval",
      title: String(a.action ?? "Approval"),
      detail: String(a.reason ?? ""),
      status: "awaiting_approval",
      open: ["approvals", a],
      row: a,
    });
  for (const e of scope.executions)
    for (const t of openEscalations(e))
      out.push({
        id: "e:" + e.execution.id + ":" + t.planTaskId,
        kind: "Escalation",
        title: `${t.planTaskId} · Human decision needed`,
        detail: `${runTitle(e, specs)}${t.escalation?.reason ? " · " + t.escalation.reason : ""}`,
        status: "needs_attention",
        open: [
          "escalation",
          { ...t, id: t.planTaskId, executionId: e.execution.id },
        ],
        row: t,
      });
  for (const t of scope.tasks.filter(isBudgetBlocked))
    out.push({
      id: "b:" + t.id,
      kind: "Budget",
      title: String(t.title ?? t.id),
      detail: "Blocked on its crew's budget",
      status: "blocked",
      open: ["tasks", t],
      row: t,
    });
  for (const [kind, rows] of [
    ["Specification", scope.specs],
    ["Plan", scope.plans],
  ] as const)
    for (const r of rows.filter((x) =>
      ["draft", "in_review", "review"].includes(x.status),
    ))
      out.push({
        id: kind + ":" + r.id,
        kind,
        title: String(r.title ?? `Plan v${r.version}`),
        detail:
          r.status === "review"
            ? "Ready for your review"
            : "Draft: submit it for review first",
        status: r.status,
        open: [kind === "Plan" ? "plans" : "specs", r],
        row: r,
      });
  return out;
}

/** Tab badge: decisions that need action now (drafts are still being written), plus documents and reviews. */
export const qualityCount = (scope: Scope) =>
  decisions(scope, []).filter((d) => d.status !== "draft").length +
  pendingDocuments(scope.deliveries).length;

export function QualityPage() {
  const { state, scope, projectName, open, href } = useHeimdall();
  const specs: R[] = state?.sindri?.specs ?? [];
  const list = decisions(scope, specs);
  const columns: Column<Decision>[] = [
    {
      key: "title",
      header: "Decision",
      primary: true,
      cell: (d) => (
        <span className="flex min-w-0 flex-col">
          <span className="line-clamp-2 font-medium">{d.title}</span>
          {d.detail && (
            <span className="line-clamp-2 text-xs font-normal text-muted">
              {d.detail}
            </span>
          )}
        </span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      hideOnMobile: true,
      cell: (d) => <Badge tone="neutral">{d.kind}</Badge>,
    },
    {
      key: "status",
      header: "Status",
      cell: (d) => <Status value={d.status} />,
    },
    {
      key: "action",
      header: "Action",
      label: "Action",
      cell: (d) =>
        d.kind === "Budget" ? <RaiseBudgetButton task={d.row} /> : null,
    },
  ];
  const executions: R[] = state?.sindri?.executions ?? [];
  const documents = pendingDocuments(scope.deliveries);
  const docTitle = (d: R) =>
    d.work?.title || deliveryTitle(d, executions, specs) || "Delivery " + d.id;
  const docColumns: Column<R>[] = [
    {
      key: "title",
      header: "Document or review",
      primary: true,
      cell: (d) => (
        <span className="line-clamp-2 font-medium">{docTitle(d)}</span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      hideOnMobile: true,
      cell: (d) => <WorkKindBadge kind={d.work?.kind} />,
    },
    {
      key: "waiting",
      header: "Waiting for",
      cell: (d) => <span className="text-sm">{documentWaiting(d.work)}</span>,
    },
  ];
  const gateColumns: Column<R>[] = [
    {
      key: "task",
      header: "Plan task",
      primary: true,
      cell: (g) => <code className="text-sm">{g.planTaskId}</code>,
    },
    {
      key: "failures",
      header: "Failures",
      cell: (g) =>
        (g.failures ?? []).length ? (
          <span className="line-clamp-3 text-xs text-muted">
            {(g.failures ?? [])
              .map((f: unknown) =>
                typeof f === "string" ? f : JSON.stringify(f),
              )
              .join(" · ")}
          </span>
        ) : (
          <span className="text-xs text-muted">None</span>
        ),
    },
    {
      key: "result",
      header: "Result",
      cell: (g) => (
        <Status value={g.passed ? "passed" : "failed"} domain="gate" />
      ),
    },
  ];
  return (
    <Page>
      <PageHeader
        title="Quality & approvals"
        description={
          <>
            Approvals, escalations and reviews that wait on you, and each run's
            verification gates.
          </>
        }
        learnMore={<LearnMore screen="quality-approvals" />}
        term="Quality gate"
        scope={{ project: projectName }}
      />
      <Card title="Human decisions" count={list.length} term="Approval" flush>
        <DataTable
          caption="Human decisions"
          columns={
            list.some((d) => d.kind === "Budget")
              ? columns
              : columns.filter((c) => c.key !== "action")
          }
          rows={list}
          rowKey={(d) => d.id}
          onRowClick={(d) => open(d.open[0], d.open[1])}
          rowLabel={(d) => d.title}
          className="rounded-none border-0"
          empty={
            <EmptyState
              compact
              icon="check"
              title="No decisions waiting"
              body="Approvals, escalations and specifications or plans to review appear here."
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
        title="Documents and reviews"
        count={documents.length}
        description="Research documents to accept or reject, and pull request reviews not yet posted."
        flush
      >
        <DataTable
          caption="Documents and reviews"
          columns={docColumns}
          rows={documents}
          rowKey={(d) => d.id}
          onRowClick={(d) => open("deliveries", { ...d, title: docTitle(d) })}
          rowLabel={(d) => docTitle(d)}
          className="rounded-none border-0"
          empty={
            <EmptyState
              compact
              icon="check"
              title="Nothing to read"
              body="Research documents and pull request reviews appear here when their runs finish."
            />
          }
        />
      </Card>
      <Section title="Verification & delivery" term="Verification">
        {scope.executions.length ? (
          <Stack gap={4}>
            {scope.executions.map((e) => {
              const deliverable = [
                "verified_pending_review",
                "delivered_pending_merge",
                "delivered",
              ].includes(e.execution.status);
              return (
                <Card
                  key={e.execution.id}
                  title={runTitle(e, specs)}
                  headingLevel={3}
                  flush
                  actions={
                    <>
                      <Status value={e.execution.status} domain="run" />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => open("execution", e.execution)}
                      >
                        Inspect run
                      </Button>
                      {deliverable && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            open("deliveries", {
                              ...e.execution,
                              id: e.execution.id,
                              title: "Delivery report",
                            })
                          }
                        >
                          Inspect delivery & patch
                        </Button>
                      )}
                    </>
                  }
                >
                  <DataTable
                    caption={`Quality gates of ${runTitle(e, specs)}`}
                    columns={gateColumns}
                    rows={e.gates ?? []}
                    rowKey={(g) => g.planTaskId}
                    onRowClick={(g) => open("gate", { ...g, id: g.planTaskId })}
                    rowLabel={(g) => `Gate ${g.planTaskId}`}
                    className="rounded-none border-0"
                    dense
                    empty={
                      <p className="px-card py-3 text-sm text-muted">
                        No gate results reported yet.
                      </p>
                    }
                  />
                </Card>
              );
            })}
          </Stack>
        ) : (
          <EmptyState
            title="No verification reports yet"
            body="Each run reports its quality gates here once Brokkr verifies its tasks."
            action={
              <Button
                variant="secondary"
                onClick={() => navigate(href("pipeline"))}
              >
                View pipeline
              </Button>
            }
          />
        )}
      </Section>
    </Page>
  );
}
