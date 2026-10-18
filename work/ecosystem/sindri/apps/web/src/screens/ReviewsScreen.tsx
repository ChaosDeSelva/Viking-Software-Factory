import { useState } from "react";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import type { EscalationDecision, ReviewsInbox } from "../api/delivery-types.js";
import { Badge, Button, Card, Empty, LoadState } from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

export function ReviewsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const inbox = useLoad(projectId ? () => api.reviews(projectId) : null, [projectId]);
  const [busy, setBusy] = useState(false);
  const [, setUnlockTick] = useState(0);

  if (!projectId)
    return (
      <Card title="Reviews">
        <Empty>Create or select a project first.</Empty>
      </Card>
    );

  const act = (fn: () => Promise<unknown>, text: string) => {
    setBusy(true);
    fn()
      .then(() => {
        dispatch({ type: "notice", notice: { kind: "info", text } });
        inbox.reload();
      }, report)
      .finally(() => setBusy(false));
  };

  return (
    <LoadState state={inbox.state} what="the review inbox" onRetry={inbox.reload}>
      {(r) => (
        <div className="space-y-4">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            Gates are evaluated when a run is verified: Brokkr&apos;s engineering verdict first
            (never overridden), then product gates. Findings come from the independent review
            task&apos;s review.json.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Approvals awaiting you">
              {r.approvals.length === 0 ? (
                <Empty>Nothing is waiting for your approval.</Empty>
              ) : (
                <ul className="space-y-2 text-sm">
                  {r.approvals.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <span>
                        <span className="font-mono">{a.action}</span> for{" "}
                        {a.planTaskId ?? "the mission"}
                        {a.reason ? `: ${a.reason}` : ""}
                      </span>
                      <Button
                        disabled={busy || !api.hasApprovalSession()}
                        aria-label={`Approve ${a.action} for ${a.planTaskId ?? "mission"}`}
                        onClick={() =>
                          act(
                            () => api.decideApproval(a.executionId, a.mimirApprovalId, "approved"),
                            `Approved ${a.action}`,
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy || !api.hasApprovalSession()}
                        aria-label={`Reject ${a.action} for ${a.planTaskId ?? "mission"}`}
                        onClick={() =>
                          act(
                            () => api.decideApproval(a.executionId, a.mimirApprovalId, "rejected"),
                            `Rejected ${a.action}`,
                          )
                        }
                      >
                        Reject
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          dispatch({ type: "execution/open", executionId: a.executionId })
                        }
                        aria-label={`Open run for ${a.action}`}
                      >
                        Open run
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {r.approvals.length > 0 ? (
                <ApprovalUnlock
                  id="inbox-approval-code"
                  onUnlocked={() => setUnlockTick((n) => n + 1)}
                />
              ) : null}
            </Card>
            <Card title="Escalations">
              {r.escalations.length === 0 ? (
                <Empty>No escalations.</Empty>
              ) : (
                <ul className="space-y-3 text-sm">
                  {r.escalations.map((e) => (
                    <Escalation
                      key={`${e.executionId}:${e.planTaskId}`}
                      item={e}
                      busy={busy}
                      onDecide={(decision, reason) =>
                        act(
                          () =>
                            api.resolveEscalation(e.executionId, e.planTaskId, decision, reason),
                          `${decision} requested for ${e.planTaskId}`,
                        )
                      }
                    />
                  ))}
                </ul>
              )}
              {r.budgetAlerts.length > 0 ? (
                <ul className="space-y-1 text-sm" aria-label="Budget alerts">
                  {r.budgetAlerts.map((b) => (
                    <li key={b.id}>
                      <Badge tone="warn">budget exceeded</Badge> {b.planTaskId ?? "mission"}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
            <Card title="Gate failures">
              {r.gateFailures.length === 0 ? (
                <Empty>No gate failures.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {r.gateFailures.map((g) => (
                    <li key={`${g.executionId}:${g.planTaskId}:${g.gateId}`}>
                      <span className="font-mono">{g.planTaskId}</span> · {g.gateId}: {g.reason}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Reviewer findings">
              {r.findings.length === 0 ? (
                <Empty>No reviewer findings.</Empty>
              ) : (
                <ul className="space-y-1 text-sm">
                  {r.findings.map((fd, i) => (
                    <li key={`${fd.reviewId}:${i}`}>
                      <Badge tone={fd.verdict === "approve" ? "ok" : "warn"}>
                        {fd.verdict ?? "pending"}
                      </Badge>{" "}
                      <Badge>{fd.severity}</Badge> {fd.role} review of {fd.planTaskId}: {fd.message}
                      {fd.file ? ` (${fd.file}${fd.line ? `:${fd.line}` : ""})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </LoadState>
  );
}

const DECISIONS: { decision: EscalationDecision; label: string }[] = [
  { decision: "retry", label: "Retry" },
  { decision: "skip", label: "Skip" },
  { decision: "replan", label: "Replan" },
  { decision: "abort", label: "Abort" },
];

function Escalation(props: {
  item: ReviewsInbox["escalations"][number];
  busy: boolean;
  onDecide: (decision: EscalationDecision, reason: string) => void;
}) {
  const e = props.item;
  const [reason, setReason] = useState("");
  const id = `esc-${e.executionId}-${e.planTaskId}`;
  return (
    <li className="space-y-1">
      <p>
        <span className="font-mono">{e.planTaskId}</span> <Badge tone="warn">{e.escalation}</Badge>{" "}
        after {e.attempts} failed attempt(s){e.reason ? `: ${e.reason}` : ""}
      </p>
      <label htmlFor={id} className="block text-xs font-medium">
        Reason for {e.planTaskId}
      </label>
      <input
        id={id}
        className="block w-full rounded border border-slate-400 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100"
        value={reason}
        onChange={(ev) => setReason(ev.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {DECISIONS.map((d) => (
          <Button
            key={d.decision}
            variant={
              d.decision === "abort" ? "danger" : d.decision === "retry" ? "primary" : "secondary"
            }
            disabled={props.busy || reason.trim() === ""}
            aria-label={`${d.label} ${e.planTaskId}`}
            onClick={() => props.onDecide(d.decision, reason.trim())}
          >
            {d.label}
          </Button>
        ))}
      </div>
    </li>
  );
}
