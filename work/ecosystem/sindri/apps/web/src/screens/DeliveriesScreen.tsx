import {
  CardGroup,
  Cluster,
  CodeBlock,
  DataTable,
  Disclosure,
  EmptyState,
  formatRelative,
  KeyValue,
  Page,
  RecordList,
  RecordRow,
  SplitView,
  Stack,
  Tabs,
  type Column,
} from "@factory/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { GateFailureList, ReasonCode } from "../components/ReasonCode.js";
import type {
  DeliveryReport,
  ExecutionSummary,
  PrDelivery,
  TraceNode,
} from "../api/delivery-types.js";
import { traceTree } from "../api/trace-tree.js";
import {
  Badge,
  Button,
  Callout,
  Card,
  DetailHeading,
  Empty,
  Field,
  Id,
  LoadState,
  ScreenHeader,
  Status,
  textareaClass,
  Timestamp,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";
import { APPROVALS_LOCKED } from "./RunsScreen.js";

/** "Delivery 2": numbered by creation within the project, so the list never leads with UUIDs. */
function deliveryNumbers(items: readonly ExecutionSummary[]): Map<string, number> {
  const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return new Map(ordered.map((d, i) => [d.id, i + 1]));
}

export function DeliveriesScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const projectId = state.projectId;
  const list = useLoad(projectId ? () => api.listDeliveries(projectId) : null, [projectId]);
  const numbers = useMemo(
    () =>
      list.state.status === "ready" ? deliveryNumbers(list.state.data) : new Map<string, number>(),
    [list.state],
  );

  const header = (
    <ScreenHeader
      screen="deliveries"
      title="Deliveries"
      term="Delivery"
      description="Verified runs ready to review: the delivery report, the patch to apply locally, and its trace."
    />
  );
  if (!projectId)
    return (
      <Page>
        {header}
        <EmptyState
          title="Create or select a project first."
          action={
            <Button onClick={() => dispatch({ type: "navigate", view: "projects" })}>
              Open Projects
            </Button>
          }
        />
      </Page>
    );

  const newest =
    list.state.status === "ready"
      ? [...list.state.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      : [];

  return (
    <Page>
      {header}
      <SplitView
        showDetail={state.deliveryId !== null}
        onBack={() => dispatch({ type: "route", route: { deliveryId: null } })}
        backLabel="All deliveries"
        list={
          <Card
            title="Deliveries"
            headingLevel={2}
            flush
            {...(list.state.status === "ready" ? { count: list.state.data.length } : {})}
          >
            <LoadState state={list.state} what="deliveries" onRetry={list.reload}>
              {(items) =>
                items.length === 0 ? (
                  <EmptyState
                    compact
                    className="m-4"
                    title="No deliveries yet."
                    body="A run becomes a delivery once it is verified."
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => dispatch({ type: "navigate", view: "runs" })}
                      >
                        Open Runs
                      </Button>
                    }
                  />
                ) : (
                  <RecordList label="Deliveries">
                    {newest.map((d) => (
                      <RecordRow
                        key={d.id}
                        title={`Delivery ${numbers.get(d.id) ?? "?"} · Plan v${d.planVersion}`}
                        meta={`Verified ${formatRelative(new Date(d.finishedAt ?? d.createdAt))}`}
                        status={<Status value={d.status} domain="run" tooltip={false} />}
                        selected={state.deliveryId === d.id}
                        onClick={() => dispatch({ type: "delivery/open", deliveryId: d.id })}
                      />
                    ))}
                  </RecordList>
                )
              }
            </LoadState>
          </Card>
        }
        detail={
          state.deliveryId ? (
            <DeliveryDetail key={state.deliveryId} deliveryId={state.deliveryId} />
          ) : (
            <Card>
              <EmptyState
                title="No delivery selected"
                body="Pick a delivery to see its report, the patch to apply and its trace."
                action={
                  newest[0] ? (
                    <Button
                      onClick={() => dispatch({ type: "delivery/open", deliveryId: newest[0]!.id })}
                    >
                      Open the most recent delivery
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          )
        }
      />
    </Page>
  );
}

function DeliveryDetail({ deliveryId }: { deliveryId: string }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const detail = useLoad(() => api.getDelivery(deliveryId), [deliveryId]);
  const trace = useLoad(() => api.deliveryTrace(deliveryId), [deliveryId], { live: false });
  const local = useLoad(() => api.localDelivery(deliveryId), [deliveryId], { live: false });
  const [busy, setBusy] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [exportRequest, setExportRequest] = useState<PrDelivery | null>(null);
  const [tab, setTab] = useState("report");
  const [, setUnlockTick] = useState(0);
  const notify = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const locked = !api.hasApprovalSession();

  const exportResult = () => {
    setBusy(true);
    setTab("export");
    api
      .requestPr(deliveryId)
      .then((pr) => {
        setExportRequest(pr);
        notify(`Local delivery: ${pr.status === "built" ? "approve the export below" : "ready"}`);
      }, report)
      .finally(() => {
        setBusy(false);
        local.reload();
        detail.reload();
      });
  };
  const reassess = () => {
    setBusy(true);
    setAssessing(true);
    api
      .assessExecution(deliveryId)
      .then(() => {
        notify("Quality checks re-run");
        detail.reload();
      }, report)
      .finally(() => {
        setBusy(false);
        setAssessing(false);
      });
  };

  return (
    <LoadState state={detail.state} what="delivery" onRetry={detail.reload}>
      {(d) => {
        const r = d.report;
        const pendingExports =
          exportRequest?.prs.filter((p) => p.status === "awaiting_approval" && p.approvalId) ?? [];
        return (
          <div className="flex min-w-0 flex-col gap-6">
            <Stack gap={3}>
              <Cluster gap={3} justify="between" align="start">
                <Cluster gap={3} className="min-w-0">
                  <DetailHeading>{r.spec.title}</DetailHeading>
                  <Status value={r.status} domain="delivery" size="md" />
                </Cluster>
                <Cluster gap={2}>
                  <Button variant="secondary" disabled={busy} onClick={reassess}>
                    {assessing ? "Re-running quality checks…" : "Re-run quality checks"}
                  </Button>
                  <Button
                    disabled={busy}
                    {...(locked ? { disabledReason: APPROVALS_LOCKED } : {})}
                    aria-describedby="pr-hint"
                    onClick={exportResult}
                  >
                    Export local result
                  </Button>
                </Cluster>
              </Cluster>
              <p id="pr-hint" className="text-sm text-muted">
                Exporting requires passing quality gates and delivery approval. Download the patch
                and apply it in your project folder. GitHub is not required.
              </p>
              <KeyValue
                items={[
                  { label: "Spec", term: "Spec", value: `Version ${r.spec.version}` },
                  { label: "Plan", term: "Plan", value: `Version ${r.plan.version}` },
                  {
                    label: "Mission",
                    term: "Mission",
                    value: <Id value={r.missionId} label="Mission ID" />,
                  },
                  { label: "Built", value: <Timestamp value={r.createdAt} /> },
                ]}
              />
              {locked ? (
                <Callout tone="info" title="Approvals are locked">
                  <ApprovalUnlock
                    id="pr-approval-code"
                    onUnlocked={() => setUnlockTick((n) => n + 1)}
                  />
                </Callout>
              ) : null}
            </Stack>
            <Tabs
              label="Delivery sections"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: "report", label: "Report", content: <Report report={r} /> },
                {
                  value: "export",
                  label: "Local export",
                  ...(pendingExports.length ? { count: pendingExports.length } : {}),
                  content: (
                    <Stack gap={6}>
                      {pendingExports.length > 0 ? (
                        <Callout tone="warning" title="Approve the local export">
                          <Cluster gap={2}>
                            {pendingExports.map((p) => (
                              <Button
                                key={p.approvalId}
                                disabled={busy}
                                {...(locked ? { disabledReason: APPROVALS_LOCKED } : {})}
                                onClick={() => {
                                  setBusy(true);
                                  api
                                    .decideApproval(
                                      deliveryId,
                                      p.approvalId!,
                                      "approved",
                                      "Approve verified local export",
                                    )
                                    .then(() => api.requestPr(deliveryId))
                                    .then(setExportRequest, report)
                                    .finally(() => {
                                      setBusy(false);
                                      local.reload();
                                      detail.reload();
                                    });
                                }}
                              >
                                Approve local export: {p.planTaskId}
                              </Button>
                            ))}
                          </Cluster>
                        </Callout>
                      ) : null}
                      <Card
                        title="Local result"
                        term="Local export"
                        description="The verified change as a patch for your project folder."
                      >
                        <LoadState state={local.state} what="local result" onRetry={local.reload}>
                          {(result) =>
                            result ? (
                              <Stack gap={4}>
                                <KeyValue
                                  items={[
                                    {
                                      label: "Project folder",
                                      value: (
                                        <code className="text-xs [overflow-wrap:anywhere]">
                                          {result.repoPath}
                                        </code>
                                      ),
                                    },
                                    {
                                      label: "Verified result",
                                      value: <Id value={result.resultCommit} label="Commit" />,
                                    },
                                  ]}
                                />
                                {result.followUp ? (
                                  <PatchBlock
                                    title="Follow-up only — use this if you already applied the earlier delivery"
                                    note={`Only what changed since the earlier delivery's result (${result.followUp.baseSha}). It applies on top of that result, not on a project without it.`}
                                    patch={result.followUp.patch}
                                    fileName="follow-up.patch"
                                    name="follow-up patch"
                                  />
                                ) : null}
                                <PatchBlock
                                  title={
                                    result.followUp ? "Full patch — the whole change" : "Patch"
                                  }
                                  note="The exact patch, complete and unaltered. Download or copy it, then apply it with the command below."
                                  patch={result.patch}
                                  fileName="result.patch"
                                  name="patch"
                                />
                                <CodeBlock
                                  title="Apply — from the project folder, using the downloaded patch path"
                                  code={result.apply}
                                />
                                <CodeBlock title="Undo the same patch" code={result.undo} />
                              </Stack>
                            ) : (
                              <Empty
                                body="Export the local result once the quality gates pass."
                                action={
                                  <Button
                                    disabled={busy}
                                    {...(locked ? { disabledReason: APPROVALS_LOCKED } : {})}
                                    onClick={exportResult}
                                  >
                                    Export now
                                  </Button>
                                }
                              >
                                No approved local export yet.
                              </Empty>
                            )
                          }
                        </LoadState>
                      </Card>
                      <Card
                        title="Delivery summary"
                        term="Delivery report"
                        description="Markdown summary to paste into a ticket or pull request."
                        actions={
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              navigator.clipboard
                                .writeText(d.prDescription)
                                .then(
                                  () => notify("Delivery summary copied to the clipboard"),
                                  report,
                                )
                            }
                          >
                            Copy summary
                          </Button>
                        }
                      >
                        <section aria-label="Delivery description">
                          <pre
                            tabIndex={0}
                            className="max-h-80 overflow-auto rounded-md bg-sunken p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
                          >
                            {d.prDescription}
                          </pre>
                        </section>
                      </Card>
                    </Stack>
                  ),
                },
                {
                  value: "changes",
                  label: "Request changes",
                  content: <RequestChanges deliveryId={deliveryId} />,
                },
                {
                  value: "trace",
                  label: "Trace",
                  content: (
                    <Card
                      title="Trace"
                      term="Trace"
                      description="Ticket → spec → plan → mission → tasks, with their artifacts and events."
                    >
                      <LoadState state={trace.state} what="trace" onRetry={trace.reload}>
                        {(doc) => (
                          <ul aria-label="Trace" className="min-w-0 text-sm">
                            <TraceItem node={traceTree(doc)} />
                          </ul>
                        )}
                      </LoadState>
                    </Card>
                  ),
                },
              ]}
            />
          </div>
        );
      }}
    </LoadState>
  );
}

/**
 * A patch shown as plain text, with download and copy. The text is never changed here; the
 * text itself is collapsed by default because it can be thousands of lines.
 */
function PatchBlock(props: {
  title: string;
  note: string;
  patch: string;
  fileName: string;
  /** What the copy button and its confirmation call it. */
  name: string;
}) {
  const { dispatch } = useStore();
  const report = useReportError();
  const lines = props.patch.split("\n").length;
  return (
    <section
      aria-label={props.title}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-4"
    >
      <h4 className="text-sm font-semibold [overflow-wrap:anywhere]">{props.title}</h4>
      <p className="text-sm text-muted [overflow-wrap:anywhere]">{props.note}</p>
      <Cluster gap={2}>
        <Button
          onClick={() => {
            const url = URL.createObjectURL(new Blob([props.patch], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = props.fileName;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Download {props.fileName}
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            navigator.clipboard.writeText(props.patch).then(
              () =>
                dispatch({
                  type: "notice",
                  notice: { kind: "info", text: `Copied the ${props.name} to the clipboard` },
                }),
              report,
            )
          }
        >
          Copy {props.name}
        </Button>
      </Cluster>
      <Disclosure title={`Show ${props.fileName} (${lines} ${lines === 1 ? "line" : "lines"})`}>
        <pre
          tabIndex={0}
          className="max-h-96 overflow-auto rounded-md bg-sunken p-3 font-mono text-xs"
        >
          {props.patch}
        </pre>
      </Disclosure>
    </section>
  );
}

function TraceItem({ node }: { node: TraceNode }) {
  return (
    <li className="ml-3 min-w-0 py-0.5 [overflow-wrap:anywhere]">
      <Badge>{node.kind}</Badge> {node.label}
      {node.children.length ? (
        <ul className="border-l border-line pl-2">
          {node.children.map((c) => (
            <TraceItem key={`${c.kind}:${c.id}`} node={c} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

type Requirement = DeliveryReport["requirements"][number];
type ReportTask = DeliveryReport["tasks"][number];

const gateWord = (passed: boolean | null) =>
  passed === null ? "not run" : passed ? "passed" : "failed";

const requirementColumns: Column<Requirement>[] = [
  {
    key: "criterion",
    header: "Criterion",
    primary: true,
    cell: (q) => (
      <span className="[overflow-wrap:anywhere]">
        <span className="font-mono">{q.criterionId}</span> {q.text}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    cell: (q) => <Status value={q.status} domain="requirement" tooltip={false} />,
  },
  {
    key: "tasks",
    header: "Tasks",
    cell: (q) =>
      q.tasks.map((t) => `${t.planTaskId} (gate ${gateWord(t.gatePassed)})`).join(", ") || "None",
  },
  {
    key: "evidence",
    header: "Evidence",
    cell: (q) => (
      <span className="font-mono text-xs [overflow-wrap:anywhere]">
        {q.evidence.join(", ") || "None"}
      </span>
    ),
  },
];

const reportTaskColumns: Column<ReportTask>[] = [
  {
    key: "task",
    header: "Task",
    primary: true,
    cell: (t) => <span className="font-mono [overflow-wrap:anywhere]">{t.planTaskId}</span>,
  },
  { key: "role", header: "Role", cell: (t) => <Badge>{t.role}</Badge> },
  {
    key: "status",
    header: "Status",
    cell: (t) => <Status value={t.status} domain="task" tooltip={false} />,
  },
  {
    key: "harness",
    header: "Harness",
    cell: (t) => (
      <span className="font-mono text-xs [overflow-wrap:anywhere]">
        {t.harness.id}@{t.harness.version}
      </span>
    ),
  },
  {
    key: "brokkr",
    header: "Brokkr verdict",
    cell: (t) =>
      t.brokkr ? (
        <Status value={t.brokkr.verdict} domain="brokkr-verdict" tooltip={false} />
      ) : (
        <span className="text-muted">No report</span>
      ),
  },
  {
    key: "gate",
    header: "Quality gate",
    cell: (t) =>
      t.gate ? (
        <span className="flex min-w-0 flex-col gap-1">
          <Status value={t.gate.passed ? "passed" : "failed"} domain="gate" tooltip={false} />
          {t.gate.passed ? null : (
            <span className="text-xs text-muted [overflow-wrap:anywhere]">
              <GateFailureList failures={t.gate.failures} />
            </span>
          )}
        </span>
      ) : (
        <Status value="not_evaluated" domain="gate" tooltip={false} />
      ),
  },
];

function ListCard(props: { title: string; term?: string; count?: number; children: ReactNode }) {
  return (
    <Card
      title={props.title}
      dense
      {...(props.term ? { term: props.term } : {})}
      {...(props.count !== undefined ? { count: props.count } : {})}
    >
      {props.children}
    </Card>
  );
}

function Report({ report: r }: { report: DeliveryReport }) {
  return (
    <section aria-label="Delivery report" className="flex min-w-0 flex-col gap-4">
      <Card title="Requirements" term="Requirement" count={r.requirements.length} flush>
        <DataTable
          caption="Requirements"
          className="rounded-none border-0"
          columns={requirementColumns}
          rows={r.requirements}
          rowKey={(q) => q.criterionId}
          empty={<Empty>No requirements recorded.</Empty>}
        />
      </Card>
      <Card title="Tasks and quality gates" term="Quality gate" count={r.tasks.length} flush>
        <DataTable
          caption="Tasks and quality gates"
          className="rounded-none border-0"
          columns={reportTaskColumns}
          rows={r.tasks}
          rowKey={(t) => t.planTaskId}
          empty={<Empty>No tasks recorded.</Empty>}
        />
      </Card>
      <ListCard title="Summary" term="Citable passage">
        {r.summary.sentences.length === 0 ? (
          <Empty>No evidence-backed summary.</Empty>
        ) : (
          <ul className="ml-4 list-disc space-y-1 text-sm [overflow-wrap:anywhere]">
            {r.summary.sentences.map((sn) => (
              <li key={sn.text}>{sn.text}</li>
            ))}
          </ul>
        )}
        {r.summary.stripped.length > 0 ? (
          <p className="mt-3 text-xs text-muted">
            {r.summary.stripped.length} uncited sentence(s) were removed from the summary.
          </p>
        ) : null}
      </ListCard>
      <CardGroup min={300}>
        <ListCard title="Tests" count={r.testResults.length}>
          {r.testResults.length === 0 ? (
            <Empty>No test runs recorded.</Empty>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {r.testResults.map((t) => (
                <li key={t.eventId} className="flex flex-wrap items-center gap-2">
                  <Status value={t.passed ? "passed" : "failed"} domain="gate" tooltip={false} />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-mono">{t.command}</span> ({t.planTaskId ?? "unattributed"}
                    ){t.durationMs === null ? "" : ` in ${t.durationMs} ms`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ListCard>
        <ListCard title="Changed files" count={r.changedFiles.length}>
          {r.changedFiles.length === 0 ? (
            <Empty>No changed-file manifest recorded.</Empty>
          ) : (
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {r.changedFiles.map((c) => (
                <li
                  key={`${c.planTaskId ?? ""}:${c.path}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  {c.status ? <Badge>{c.status}</Badge> : null}
                  <span className="min-w-0 [overflow-wrap:anywhere]">{c.path}</span>
                </li>
              ))}
            </ul>
          )}
        </ListCard>
      </CardGroup>
      <ListCard title="Review findings" term="Reviewer finding" count={r.reviews.length}>
        {r.reviews.length === 0 ? (
          <Empty>No independent reviews recorded.</Empty>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {r.reviews.map((rv) => (
              <li key={rv.reviewId} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {rv.role} review of <span className="font-mono">{rv.planTaskId}</span>
                  </span>
                  {rv.verdict ? (
                    <Status value={rv.verdict} domain="review-verdict" tooltip={false} />
                  ) : (
                    <Badge>Pending</Badge>
                  )}
                </span>
                {rv.reason ? (
                  <span className="text-muted">
                    <ReasonCode reason={rv.reason} />
                  </span>
                ) : null}
                {rv.findings.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {rv.findings.map((fd, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-2">
                        <Status value={fd.severity} domain="severity" tooltip={false} />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{fd.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ListCard>
      <CardGroup min={300}>
        <ListCard title="Limitations" count={r.limitations.length}>
          {r.limitations.length === 0 ? (
            <Empty>None recorded.</Empty>
          ) : (
            <ul className="ml-4 list-disc text-sm [overflow-wrap:anywhere]">
              {r.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </ListCard>
        <ListCard title="Rollback" term="Rollback">
          <ul className="ml-4 list-disc text-sm [overflow-wrap:anywhere]">
            {r.rollback.branches.map((b) => (
              <li key={b.branch}>
                branch <span className="font-mono">{b.branch}</span> from {b.baseSha.slice(0, 12)}
              </li>
            ))}
            <li>{r.rollback.note}</li>
          </ul>
        </ListCard>
      </CardGroup>
    </section>
  );
}

/** Reviewer feedback on a delivery: drafts a follow-up specification that builds on its result. */
function RequestChanges({ deliveryId }: { deliveryId: string }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const reworks = useLoad(() => api.listReworks(deliveryId), [deliveryId]);
  // Drafting takes minutes: if the person has moved on, tell them but do not pull them away.
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on every mount: StrictMode unmounts and remounts effects in development.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <Stack gap={4}>
      <Card
        title="Request changes"
        term="Request changes"
        description="Describe what should change. Work continues from this delivery instead of starting over."
      >
        <form
          aria-label="Request changes to this delivery"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!feedback.trim() || busy) return;
            setBusy(true);
            api
              .requestRework(deliveryId, feedback.trim())
              .then(({ spec }) => {
                if (mounted.current) {
                  setFeedback("");
                  reworks.reload();
                }
                dispatch({
                  type: "notice",
                  notice: {
                    kind: "info",
                    text: "A specification was drafted from your feedback. Review and approve it to continue from this delivery.",
                  },
                });
                if (mounted.current) dispatch({ type: "spec/open", specId: spec.id });
              }, report)
              .finally(() => {
                if (mounted.current) setBusy(false);
              });
          }}
        >
          <Field
            label="What should change"
            id="rework-feedback"
            hint="A new specification is drafted from this. Once you approve it and its plan, work continues from this delivery's verified result instead of starting over."
          >
            <textarea
              id="rework-feedback"
              aria-describedby="rework-feedback-hint"
              rows={4}
              className={textareaClass}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              disabled={busy}
              {...(!busy && !feedback.trim()
                ? { disabledReason: "Describe what should change first." }
                : {})}
            >
              {busy ? "Drafting specification…" : "Request changes"}
            </Button>
          </div>
        </form>
      </Card>
      {reworks.state.status === "error" ? (
        <Callout
          tone="warning"
          title={`Could not load earlier change requests: ${reworks.state.error}`}
          action={
            <Button variant="secondary" onClick={reworks.reload}>
              Retry
            </Button>
          }
        />
      ) : null}
      {reworks.state.status === "ready" && reworks.state.data.length > 0 ? (
        <Card title="Earlier change requests" count={reworks.state.data.length}>
          <ul className="flex flex-col divide-y divide-line text-sm">
            {reworks.state.data.map((r) => {
              const latest = r.specs.reduce<(typeof r.specs)[number] | null>(
                (a, b) => (!a || b.version > a.version ? b : a),
                null,
              );
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <p className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="text-xs text-muted">
                      <Timestamp value={r.createdAt} />
                    </span>{" "}
                    {r.feedback}
                  </p>
                  {latest ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => dispatch({ type: "spec/open", specId: latest.id })}
                    >
                      Open spec v{latest.version} ({latest.status})
                      <span className="sr-only"> for the request from {r.createdAt}</span>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </Stack>
  );
}
