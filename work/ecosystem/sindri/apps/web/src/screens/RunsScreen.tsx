import { useCallback, useEffect, useState } from "react";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import type { ExecutionDetail, ExecutionEvent, TaskGate } from "../api/delivery-types.js";
import { Badge, Button, Card, DetailHeading, Empty, LoadState } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

const gateText = (g: TaskGate | undefined) =>
  !g
    ? "not evaluated"
    : g.passed
      ? "passed"
      : `failed: ${g.failures.map((f) => `${f.gateId} ${f.reason}`).join("; ")}`;

const DELIVERED = new Set(["verified_pending_review", "delivered_pending_merge"]);
const tone = (status: string) =>
  DELIVERED.has(status)
    ? "ok"
    : status === "awaiting_human" || status === "blocked"
      ? "warn"
      : "neutral";

export function RunsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const projectId = state.projectId;
  const list = useLoad(projectId ? () => api.listExecutions(projectId) : null, [projectId]);

  if (!projectId)
    return (
      <Card title="Runs">
        <Empty>Create or select a project first.</Empty>
      </Card>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Runs">
        <LoadState state={list.state} what="runs" onRetry={list.reload}>
          {(runs) =>
            runs.length === 0 ? (
              <Empty>No runs yet. Execute an approved plan from Plans.</Empty>
            ) : (
              <ul className="space-y-1">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      aria-pressed={state.executionId === r.id}
                      onClick={() => dispatch({ type: "execution/open", executionId: r.id })}
                      className="w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 dark:focus-visible:outline-indigo-300 dark:hover:bg-slate-800"
                    >
                      <span className="block font-mono text-xs">{r.id}</span>
                      <span className="text-xs">
                        Plan v{r.planVersion} <Badge tone={tone(r.status)}>{r.status}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadState>
      </Card>
      <div className="lg:col-span-2">
        {state.executionId ? (
          <RunDetail key={state.executionId} executionId={state.executionId} />
        ) : (
          <Card title="Run detail">
            <Empty>Select a run to follow its tasks, approvals and events.</Empty>
          </Card>
        )}
      </div>
    </div>
  );
}

function RunDetail({ executionId }: { executionId: string }) {
  const api = useApi();
  const { dispatch } = useStore();
  const report = useReportError();
  const loaded = useLoad(() => api.getExecution(executionId), [executionId]);
  const [live, setLive] = useState<ExecutionDetail | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [, setUnlockTick] = useState(0);

  const refresh = useCallback(() => {
    api.getExecution(executionId).then(setLive, () => undefined);
  }, [api, executionId]);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .streamExecution(
        executionId,
        (m) => {
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
      .catch(() => undefined);
    return () => ctrl.abort();
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

  return (
    <LoadState state={loaded.state} what="run" onRetry={loaded.reload}>
      {(initial) => {
        const d = live ?? initial;
        const pending = d.approvals.filter(
          (a) => a.disposition === "inbox" && a.status === "pending",
        );
        return (
          <section aria-labelledby="run-title" className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <DetailHeading id="run-title">Run of plan v{d.execution.planVersion}</DetailHeading>
              <Badge tone={tone(d.execution.status)}>{d.execution.status}</Badge>
              {d.links.mission ? (
                <a
                  href={d.links.mission}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm text-indigo-800 underline dark:text-indigo-300"
                >
                  Open mission {d.execution.mimirMissionId} in Mimir
                </a>
              ) : null}
              {DELIVERED.has(d.execution.status) ? (
                <Button
                  onClick={() => dispatch({ type: "delivery/open", deliveryId: executionId })}
                >
                  Open delivery
                </Button>
              ) : null}
            </div>
            <Card title="Approvals awaiting you" headingLevel={3}>
              {pending.length === 0 ? (
                <Empty>No gated actions are waiting.</Empty>
              ) : (
                <ul className="space-y-2">
                  {pending.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span>
                        <span className="font-mono">{a.action}</span> for{" "}
                        {a.planTaskId ?? "the mission"}
                        {a.reason ? `: ${a.reason}` : ""}
                      </span>
                      <Button
                        disabled={busy || !api.hasApprovalSession()}
                        aria-label={`Approve ${a.action} for ${a.planTaskId ?? "mission"}`}
                        onClick={() => decide(a.mimirApprovalId, a.action, "approved")}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy || !api.hasApprovalSession()}
                        aria-label={`Reject ${a.action} for ${a.planTaskId ?? "mission"}`}
                        onClick={() => decide(a.mimirApprovalId, a.action, "rejected")}
                      >
                        Reject
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {pending.length > 0 ? (
                <ApprovalUnlock
                  id="run-approval-code"
                  onUnlocked={() => setUnlockTick((n) => n + 1)}
                />
              ) : null}
            </Card>
            <Card title="Tasks" headingLevel={3}>
              <table aria-label="Tasks" className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Status</th>
                    <th scope="col">Failed attempts</th>
                    <th scope="col">Escalation</th>
                    <th scope="col">Quality gate</th>
                    <th scope="col">Agent</th>
                  </tr>
                </thead>
                <tbody>
                  {d.tasks.map((t) => (
                    <tr key={t.id}>
                      <td className="font-mono">{t.planTaskId}</td>
                      <td>{t.status}</td>
                      <td>{t.attempts}</td>
                      <td>
                        {t.escalation ? `${t.escalation}: ${t.escalationReason ?? ""}` : "none"}
                      </td>
                      <td>{gateText(d.gates.find((g) => g.planTaskId === t.planTaskId))}</td>
                      <td>
                        <AgentLink
                          agent={d.links.agents?.find((a) => a.planTaskId === t.planTaskId)}
                          planTaskId={t.planTaskId}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Events" headingLevel={3}>
              {events.length === 0 ? (
                <Empty>Waiting for events…</Empty>
              ) : (
                <div
                  role="log"
                  aria-label="Events"
                  tabIndex={0}
                  className="max-h-64 overflow-auto font-mono text-xs"
                >
                  <ol className="space-y-0.5">
                    {events.map((e) => (
                      <li key={e.id}>
                        {e.occurredAt} {e.type}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </Card>
          </section>
        );
      }}
    </LoadState>
  );
}

function AgentLink(props: {
  agent: { sessionId: string; url: string | null } | undefined;
  planTaskId: string;
}) {
  if (!props.agent) return <>no session yet</>;
  if (!props.agent.url) return <span className="font-mono">{props.agent.sessionId}</span>;
  return (
    <a
      href={props.agent.url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open agent session for ${props.planTaskId} in Mimir`}
      className="text-indigo-800 underline dark:text-indigo-300"
    >
      {props.agent.sessionId}
    </a>
  );
}
