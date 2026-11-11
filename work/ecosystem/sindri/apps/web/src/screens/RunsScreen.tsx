import {
  Cluster,
  DataTable,
  EmptyState,
  formatRelative,
  InfoHint,
  KeyValue,
  Link,
  LogView,
  Page,
  RecordList,
  RecordRow,
  SplitView,
  Stack,
  type Column,
  type LogEntry,
} from "@factory/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { GateFailureList } from "../components/ReasonCode.js";
import type {
  ExecutionDetail,
  ExecutionEvent,
  ExecutionSummary,
  ExecutionTask,
  TaskGate,
} from "../api/delivery-types.js";
import {
  Button,
  Callout,
  Card,
  DetailHeading,
  Empty,
  Field,
  Id,
  inputClass,
  LoadState,
  ScreenHeader,
  Status,
  Timestamp,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

const DELIVERED = new Set(["verified_pending_review", "delivered_pending_merge"]);
/** Statuses after which a run produces no more events, so a closed stream is not reopened. */
const FINAL = new Set([...DELIVERED, "replan_requested", "cancelled", "failed"]);
/** Statuses the server refuses to cancel: the run has finished. A requested replan has not. */
const ENDED = new Set([...DELIVERED, "cancelled", "failed"]);
/** Delays between attempts to reopen the event stream; the last one repeats. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];
export const APPROVALS_LOCKED =
  "Unlock approvals with the pairing code (bottom bar → Read-only), or enter it below.";

/** "Run 3": runs numbered by start order within the project, so people never read UUIDs. */
export function runNumbers(runs: readonly ExecutionSummary[]): Map<string, number> {
  const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return new Map(ordered.map((r, i) => [r.id, i + 1]));
}

export function RunsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const projectId = state.projectId;
  const list = useLoad(projectId ? () => api.listExecutions(projectId) : null, [projectId]);
  const numbers = useMemo(
    () => (list.state.status === "ready" ? runNumbers(list.state.data) : new Map<string, number>()),
    [list.state],
  );

  const header = (
    <ScreenHeader
      screen="runs"
      title="Runs"
      term="Run"
      description="Approved plans executing in Mimir: follow tasks, approve gated actions and read the events."
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

  const latest =
    list.state.status === "ready"
      ? [...list.state.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      : undefined;

  return (
    <Page>
      {header}
      <SplitView
        showDetail={state.executionId !== null}
        onBack={() => dispatch({ type: "route", route: { executionId: null } })}
        backLabel="All runs"
        list={
          <Card
            title="Runs"
            headingLevel={2}
            flush
            {...(list.state.status === "ready" ? { count: list.state.data.length } : {})}
          >
            <LoadState state={list.state} what="runs" onRetry={list.reload}>
              {(runs) =>
                runs.length === 0 ? (
                  <EmptyState
                    compact
                    className="m-4"
                    title="No runs yet."
                    body="Execute an approved plan from Plans to start one."
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => dispatch({ type: "navigate", view: "plans" })}
                      >
                        Open Plans
                      </Button>
                    }
                  />
                ) : (
                  <RecordList label="Runs">
                    {[...runs]
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                      .map((r) => (
                        <RecordRow
                          key={r.id}
                          title={`Run ${numbers.get(r.id) ?? "?"} · Plan v${r.planVersion}`}
                          meta={`Started ${formatRelative(new Date(r.createdAt))}`}
                          status={<Status value={r.status} domain="run" tooltip={false} />}
                          selected={state.executionId === r.id}
                          onClick={() => dispatch({ type: "execution/open", executionId: r.id })}
                        />
                      ))}
                  </RecordList>
                )
              }
            </LoadState>
          </Card>
        }
        detail={
          state.executionId ? (
            <RunDetail
              key={state.executionId}
              executionId={state.executionId}
              number={numbers.get(state.executionId) ?? null}
              onChanged={list.reload}
            />
          ) : (
            <Card>
              <EmptyState
                icon="clock"
                title="No run selected"
                body="Pick a run to follow its tasks, approvals and events."
                action={
                  latest ? (
                    <Button
                      onClick={() => dispatch({ type: "execution/open", executionId: latest.id })}
                    >
                      Open the most recent run
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

/** Info for routine events, warn/error where a person may need to act. */
const eventLevel = (type: string): LogEntry["level"] =>
  /fail|error|reject/.test(type)
    ? "error"
    : /block|escalat|cancel|replan/.test(type)
      ? "warn"
      : "info";

/** The task an event is about, when its payload names one; otherwise the type says it all. */
function eventMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  const task = p.planTaskId ?? p.taskId;
  return typeof task === "string" ? task : "";
}

function RunDetail({
  executionId,
  number,
  onChanged,
}: {
  executionId: string;
  number: number | null;
  onChanged: () => void;
}) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const loaded = useLoad(() => api.getExecution(executionId), [executionId]);
  const [live, setLive] = useState<ExecutionDetail | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [, setUnlockTick] = useState(0);
  const [disconnected, setDisconnected] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Latest known status, read by the stream loop when it decides whether to reconnect.
  const status = useRef<string | null>(null);
  const shown = live ?? (loaded.state.status === "ready" ? loaded.state.data : null);
  status.current = shown?.execution.status ?? null;

  // Refreshes can answer out of order: only a view newer than the one shown replaces it.
  const requested = useRef(0);
  const applied = useRef(0);
  const show = useCallback((d: ExecutionDetail, n = ++requested.current) => {
    if (n <= applied.current) return;
    applied.current = n;
    setLive(d);
  }, []);
  const refresh = useCallback(() => {
    const n = ++requested.current;
    api.getExecution(executionId).then(
      (d) => show(d, n),
      () => undefined,
    );
  }, [api, executionId, show]);

  // The stream ends when the server restarts or the connection drops. While the run can still
  // change, say so and reopen it with a capped backoff; unmounting stops everything.
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const isFinal = () => status.current !== null && FINAL.has(status.current);
    const connect = () => {
      api
        .streamExecution(
          executionId,
          (m) => {
            attempt = 0;
            setDisconnected(false);
            if (m.kind === "event")
              setEvents((es) =>
                es.some((e) => e.id === m.data.id) ? es : [...es.slice(-199), m.data],
              );
            if (
              m.kind === "notice" ||
              (m.kind === "event" && /^(task|approval|mission)\./.test(m.data.type))
            )
              refresh();
          },
          ctrl.signal,
        )
        .then(
          () => true,
          (err: unknown) => {
            // A rejected token ends the session; retrying would only repeat the 401.
            if (!(err instanceof ApiError && err.status === 401)) return true;
            report(err);
            return false;
          },
        )
        .then((retry) => {
          if (!retry || ctrl.signal.aborted || isFinal()) return;
          setDisconnected(true);
          refresh();
          const delay =
            RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
          attempt += 1;
          timer = setTimeout(() => {
            if (isFinal()) setDisconnected(false);
            else connect();
          }, delay);
        });
    };
    connect();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [api, executionId, refresh]);

  const decide = (mimirApprovalId: string, action: string, decision: "approved" | "rejected") => {
    setBusy(true);
    api
      .decideApproval(executionId, mimirApprovalId, decision)
      .then(() => {
        dispatch({
          type: "notice",
          notice: {
            kind: "info",
            text: `${decision === "approved" ? "Approved" : "Rejected"} ${action}`,
          },
        });
        refresh();
      }, report)
      .finally(() => setBusy(false));
  };

  const logEntries = useMemo<LogEntry[]>(
    () =>
      events.map((e) => ({
        id: e.id,
        time: e.occurredAt,
        type: e.type,
        level: eventLevel(e.type),
        message: eventMessage(e.payload),
      })),
    [events],
  );

  return (
    <LoadState state={loaded.state} what="run" onRetry={loaded.reload}>
      {(initial) => {
        const d = live ?? initial;
        const pending = d.approvals.filter(
          (a) => a.disposition === "inbox" && a.status === "pending",
        );
        const escalated = d.tasks.filter((t) => t.escalation);
        const plan = d.plan;
        const locked = !api.hasApprovalSession();
        const openPlan = plan ? (
          <Button
            variant="secondary"
            onClick={() => dispatch({ type: "plan/open", planId: plan.id })}
          >
            Open plan
          </Button>
        ) : undefined;
        return (
          <section aria-labelledby="run-title" className="flex min-w-0 flex-col gap-6">
            <Stack gap={3}>
              <Cluster gap={3} justify="between" align="start">
                <Cluster gap={3} className="min-w-0">
                  <DetailHeading id="run-title">
                    {number ? `Run ${number}` : "Run"} · Plan v{d.execution.planVersion}
                  </DetailHeading>
                  <Status value={d.execution.status} domain="run" size="md" />
                </Cluster>
                <Cluster gap={2}>
                  {DELIVERED.has(d.execution.status) ? (
                    <Button
                      onClick={() => dispatch({ type: "delivery/open", deliveryId: executionId })}
                    >
                      Open delivery
                    </Button>
                  ) : null}
                  {ENDED.has(d.execution.status) || cancelling ? null : (
                    <Button variant="danger" onClick={() => setCancelling(true)}>
                      Cancel run
                    </Button>
                  )}
                </Cluster>
              </Cluster>
              <KeyValue
                items={[
                  {
                    label: "Run",
                    term: "Run",
                    value: <Id value={d.execution.id} label="Run ID" />,
                  },
                  {
                    label: "Mission",
                    term: "Mission",
                    value: (
                      <Cluster gap={2}>
                        <Id value={d.execution.mimirMissionId} label="Mission ID" />
                        {d.links.mission ? (
                          <Link
                            href={d.links.mission}
                            target="_blank"
                            rel="noreferrer noopener"
                            aria-label={`Open mission ${d.execution.mimirMissionId} in Mimir`}
                            className="text-sm text-accent-fg underline underline-offset-2 hover:decoration-2"
                          >
                            Open in Mimir
                          </Link>
                        ) : null}
                      </Cluster>
                    ),
                  },
                  { label: "Started", value: <Timestamp value={d.execution.createdAt} /> },
                  {
                    label: "Finished",
                    value: d.execution.finishedAt ? (
                      <Timestamp value={d.execution.finishedAt} />
                    ) : (
                      "Not yet"
                    ),
                  },
                ]}
              />
            </Stack>
            {cancelling && !ENDED.has(d.execution.status) ? (
              <CancelRun
                executionId={executionId}
                onClose={() => setCancelling(false)}
                onCancelled={(cancelled) => {
                  setCancelling(false);
                  show(cancelled);
                  onChanged();
                }}
                onRefused={() => {
                  setCancelling(false);
                  refresh();
                }}
              />
            ) : null}
            {d.execution.status === "failed" || d.execution.status === "cancelled" ? (
              <Note
                label={d.execution.status === "failed" ? "Run failed" : "Run cancelled"}
                tone="warning"
                action={openPlan}
              >
                {d.execution.status === "failed"
                  ? "This run failed and will not continue. Revise the plan or execute it again."
                  : "This run was cancelled and will not continue. Execute the plan again to start over."}
              </Note>
            ) : null}
            {disconnected && !FINAL.has(d.execution.status) ? (
              <Note label="Live updates" tone="info">
                Live updates disconnected — retrying. What you see may be out of date.
              </Note>
            ) : null}
            {d.execution.status === "replan_requested" ? (
              <Note label="Replan requested" tone="warning" action={openPlan}>
                This run will not continue: a replan was requested. Revise the plan, approve it and
                execute it again.
              </Note>
            ) : null}
            {escalated.length > 0 ? (
              <Note
                label="Tasks need a decision"
                tone="warning"
                action={
                  <Button onClick={() => dispatch({ type: "navigate", view: "needs-you" })}>
                    Open Needs you
                  </Button>
                }
              >
                {escalated.length === 1 ? "A task is" : `${escalated.length} tasks are`} escalated
                and waiting for your decision: {escalated.map((t) => t.planTaskId).join(", ")}. The
                run does not continue until you decide in Needs you.
              </Note>
            ) : null}
            <Card title="Approvals awaiting you" term="Approval" count={pending.length}>
              {pending.length === 0 ? (
                <Empty>
                  {escalated.length > 0
                    ? "No gated actions are waiting, but escalated tasks need a decision in Needs you."
                    : "No gated actions are waiting."}
                </Empty>
              ) : (
                <Stack gap={4}>
                  <ul className="flex flex-col divide-y divide-line">
                    {pending.map((a) => (
                      <li
                        key={a.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                      >
                        <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                          <span className="font-mono">{a.action}</span> for{" "}
                          {a.planTaskId ?? "the mission"}
                          {a.reason ? `: ${a.reason}` : ""}
                        </span>
                        <Cluster gap={2}>
                          <Button
                            disabled={busy}
                            {...(locked ? { disabledReason: APPROVALS_LOCKED } : {})}
                            aria-label={`Approve ${a.action} for ${a.planTaskId ?? "mission"}`}
                            onClick={() => decide(a.mimirApprovalId, a.action, "approved")}
                          >
                            Approve
                          </Button>
                          <Button
                            variant="danger"
                            disabled={busy}
                            {...(locked ? { disabledReason: APPROVALS_LOCKED } : {})}
                            aria-label={`Reject ${a.action} for ${a.planTaskId ?? "mission"}`}
                            onClick={() => decide(a.mimirApprovalId, a.action, "rejected")}
                          >
                            Reject
                          </Button>
                        </Cluster>
                      </li>
                    ))}
                  </ul>
                  <ApprovalUnlock
                    id="run-approval-code"
                    onUnlocked={() => setUnlockTick((n) => n + 1)}
                  />
                </Stack>
              )}
            </Card>
            <Card title="Tasks" term="Task" count={d.tasks.length} flush>
              <DataTable
                caption="Tasks"
                className="rounded-none border-0"
                columns={taskColumns(d)}
                rows={d.tasks}
                rowKey={(t) => t.id}
                empty={<Empty>The mission has no tasks yet.</Empty>}
              />
            </Card>
            <Card title="Events" term="Event stream" count={events.length}>
              {events.length === 0 ? (
                <Empty body="New events from Mimir appear here as the run progresses.">
                  Waiting for events…
                </Empty>
              ) : (
                <LogView entries={logEntries} label="Events" maxHeight="320px" />
              )}
            </Card>
          </section>
        );
      }}
    </LoadState>
  );
}

/** Column header with its glossary hint; `label` keeps the phone layout readable. */
const termHeader = (text: string, term: string) => (
  <span className="inline-flex items-center gap-1">
    {text}
    <InfoHint term={term} />
  </span>
);

function taskColumns(d: ExecutionDetail): Column<ExecutionTask>[] {
  const objective = (id: string) => d.plan?.tasks.find((t) => t.id === id)?.objective;
  return [
    {
      key: "task",
      header: "Task",
      primary: true,
      cell: (t) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-mono text-sm [overflow-wrap:anywhere]">{t.planTaskId}</span>
          {objective(t.planTaskId) ? (
            <span className="text-xs font-normal text-muted">{objective(t.planTaskId)}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (t) => <Status value={t.status} domain="task" tooltip={false} />,
    },
    {
      key: "attempts",
      header: termHeader("Failed attempts", "Failed attempts"),
      label: "Failed attempts",
      align: "right",
      cell: (t) => t.attempts,
    },
    {
      key: "escalation",
      header: termHeader("Escalation", "Escalation"),
      label: "Escalation",
      cell: (t) =>
        t.escalation ? (
          <span className="flex min-w-0 flex-col gap-1">
            <Status value={t.escalation} domain="escalation" tooltip={false} />
            {t.escalationReason ? (
              <span className="text-xs text-muted [overflow-wrap:anywhere]">
                {t.escalationReason}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted">None</span>
        ),
    },
    {
      key: "gate",
      header: termHeader("Quality gate", "Quality gate"),
      label: "Quality gate",
      cell: (t) => <GateCell gate={d.gates.find((g) => g.planTaskId === t.planTaskId)} />,
    },
    {
      key: "agent",
      header: termHeader("Agent session", "Agent session"),
      label: "Agent session",
      cell: (t) => (
        <AgentLink
          agent={d.links.agents?.find((a) => a.planTaskId === t.planTaskId)}
          planTaskId={t.planTaskId}
        />
      ),
    },
  ];
}

function GateCell({ gate }: { gate: TaskGate | undefined }) {
  if (!gate) return <Status value="not_evaluated" domain="gate" tooltip={false} />;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <Status value={gate.passed ? "passed" : "failed"} domain="gate" tooltip={false} />
      {gate.passed ? null : (
        <span className="text-xs text-muted [overflow-wrap:anywhere]">
          <GateFailureList failures={gate.failures} />
        </span>
      )}
    </span>
  );
}

/**
 * A labelled callout: `role="note"` with an accessible name so screen readers (and tests) can
 * tell the run's notices apart. Callout itself carries no name.
 */
function Note(props: {
  label: string;
  tone: "info" | "warning";
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="note" aria-label={props.label}>
      <Callout tone={props.tone} action={props.action}>
        {props.children}
      </Callout>
    </div>
  );
}

/** Stops a run for good: the second step after "Cancel run", so one stray click does not end it. */
function CancelRun(props: {
  executionId: string;
  onClose: () => void;
  onCancelled: (d: ExecutionDetail) => void;
  /** The server refused, most likely because the run finished meanwhile. */
  onRefused: () => void;
}) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      aria-label="Cancel this run"
      className="flex max-w-xl flex-col gap-3 rounded-lg border border-line bg-surface p-card text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        api
          .cancelExecution(props.executionId, reason.trim() || undefined)
          .then(
            (d) => {
              dispatch({ type: "notice", notice: { kind: "info", text: "Run cancelled" } });
              props.onCancelled(d);
            },
            (err: unknown) => {
              report(err);
              props.onRefused();
            },
          )
          .finally(() => setBusy(false));
      }}
    >
      <p>
        Cancelling stops this run for good. It cannot be resumed; to continue, execute the plan
        again.
      </p>
      <Field label="Reason (optional)" id="cancel-reason">
        <input
          id="cancel-reason"
          className={inputClass}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <Cluster gap={2}>
        <Button type="submit" variant="danger" disabled={busy}>
          {busy ? "Cancelling…" : "Confirm cancel"}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={props.onClose}>
          Keep running
        </Button>
      </Cluster>
    </form>
  );
}

function AgentLink(props: {
  agent: { sessionId: string; url: string | null } | undefined;
  planTaskId: string;
}) {
  if (!props.agent) return <span className="text-muted">No session yet</span>;
  if (!props.agent.url) return <Id value={props.agent.sessionId} label="Session ID" />;
  return (
    <Link
      href={props.agent.url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open agent session for ${props.planTaskId} in Mimir`}
      className="font-mono text-xs text-accent-fg underline underline-offset-2 hover:decoration-2"
    >
      {props.agent.sessionId.length > 14
        ? `${props.agent.sessionId.slice(0, 10)}…${props.agent.sessionId.slice(-4)}`
        : props.agent.sessionId}
    </Link>
  );
}
