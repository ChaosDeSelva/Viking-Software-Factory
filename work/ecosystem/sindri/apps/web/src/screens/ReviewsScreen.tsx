import {
  Cluster,
  DataTable,
  InfoHint,
  KeyValue,
  Page,
  Progress,
  Stack,
  type Column,
} from "@factory/ui";
import { useState } from "react";
import type { EscalationDecision, ReviewsInbox } from "../api/delivery-types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { ReasonCode } from "../components/ReasonCode.js";
import {
  Badge,
  Button,
  Empty,
  Id,
  LoadState,
  ScreenHeader,
  Status,
  Timestamp,
  inputClass,
  Card,
} from "../components/ui.js";
import { APP_URLS, heimdallHref, mimirCrewHref } from "../config.js";
import { useApi, useLoad, useReportError, useStore } from "../store/context.js";

type GateFailure = ReviewsInbox["gateFailures"][number];
type Finding = ReviewsInbox["findings"][number];
type BudgetAlert = ReviewsInbox["budgetAlerts"][number];

const LOCKED = "Unlock approvals with the pairing code (bottom bar, Read-only)";

/**
 * Needs you: what waits on the operator in this project (gated actions,
 * escalations, budget blocks), then the verification record (gate failures, reviewer findings).
 */
export function ReviewsScreen() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const report = useReportError();
  const projectId = state.projectId;
  const inbox = useLoad(projectId ? () => api.reviews(projectId) : null, [projectId]);
  const [busy, setBusy] = useState(false);
  const [, setUnlockTick] = useState(0);
  // Typed reasons live here, per escalation: every decision reloads the inbox, which remounts
  // the list, and a reason typed for another task must survive that.
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const header = (
    <ScreenHeader
      screen="needs-you"
      title="Needs you"
      term="Needs attention"
      description="Decisions only you can make in this project: gated agent actions, escalated tasks and budget blocks. Gate failures and reviewer findings follow."
      {...(projectId
        ? {
            actions: (
              <Button variant="secondary" icon="refresh" onClick={inbox.reload}>
                Refresh
              </Button>
            ),
          }
        : {})}
    />
  );
  if (!projectId)
    return (
      <Page>
        {header}
        <Card>
          <Empty
            action={
              <Button onClick={() => dispatch({ type: "navigate", view: "projects" })}>
                Manage projects
              </Button>
            }
          >
            Create or select a project first.
          </Empty>
        </Card>
      </Page>
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
  const unlocked = api.hasApprovalSession();

  return (
    <Page>
      {header}
      <LoadState state={inbox.state} what="the review inbox" onRetry={inbox.reload}>
        {(r) => (
          <Stack gap={6}>
            <Cluster gap={2} aria-label="Summary">
              <Badge tone={r.approvals.length ? "warn" : "neutral"}>
                {r.approvals.length} approval{r.approvals.length === 1 ? "" : "s"}
              </Badge>
              <Badge tone={r.escalations.length ? "warn" : "neutral"}>
                {r.escalations.length} escalation{r.escalations.length === 1 ? "" : "s"}
              </Badge>
              <Badge tone={r.budgetAlerts.length ? "danger" : "neutral"}>
                {r.budgetAlerts.length} budget block{r.budgetAlerts.length === 1 ? "" : "s"}
              </Badge>
              <Badge>
                {r.gateFailures.length} gate failure{r.gateFailures.length === 1 ? "" : "s"}
              </Badge>
              <Badge>
                {r.findings.length} finding{r.findings.length === 1 ? "" : "s"}
              </Badge>
            </Cluster>
            <div className="grid gap-group lg:grid-cols-2">
              <Card title="Approvals awaiting you" term="Approval" count={r.approvals.length}>
                <Stack gap={4}>
                  {r.approvals.length === 0 ? (
                    <Empty>Nothing is waiting for your approval.</Empty>
                  ) : (
                    <ul className="flex flex-col divide-y divide-line text-sm">
                      {r.approvals.map((a) => (
                        <li
                          key={a.id}
                          className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                        >
                          <span className="min-w-0 [overflow-wrap:anywhere]">
                            <span className="font-mono">{a.action}</span> for{" "}
                            {a.planTaskId ?? "the mission"}
                            {a.reason ? `: ${a.reason}` : ""}
                          </span>
                          <span className="inline-flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              {...(!unlocked ? { disabledReason: LOCKED } : {})}
                              disabled={busy || !unlocked}
                              aria-label={`Approve ${a.action} for ${a.planTaskId ?? "mission"}`}
                              onClick={() =>
                                act(
                                  () =>
                                    api.decideApproval(
                                      a.executionId,
                                      a.mimirApprovalId,
                                      "approved",
                                    ),
                                  `Approved ${a.action}`,
                                )
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              {...(!unlocked ? { disabledReason: LOCKED } : {})}
                              disabled={busy || !unlocked}
                              aria-label={`Reject ${a.action} for ${a.planTaskId ?? "mission"}`}
                              onClick={() =>
                                act(
                                  () =>
                                    api.decideApproval(
                                      a.executionId,
                                      a.mimirApprovalId,
                                      "rejected",
                                    ),
                                  `Rejected ${a.action}`,
                                )
                              }
                            >
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                dispatch({ type: "execution/open", executionId: a.executionId })
                              }
                              aria-label={`Open run for ${a.action}`}
                            >
                              Open run
                            </Button>
                          </span>
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
                </Stack>
              </Card>
              <Card
                title="Escalations"
                term="Escalation"
                count={r.escalations.length + r.budgetAlerts.length}
              >
                <Stack gap={5}>
                  {r.escalations.length === 0 ? (
                    <Empty>No escalations.</Empty>
                  ) : (
                    <ul className="flex flex-col gap-5 text-sm">
                      {r.escalations.map((e) => {
                        const key = `${e.executionId}:${e.planTaskId}`;
                        return (
                          <Escalation
                            key={key}
                            item={e}
                            busy={busy}
                            reason={reasons[key] ?? ""}
                            onReason={(text) => setReasons((all) => ({ ...all, [key]: text }))}
                            onDecide={(decision, reason) =>
                              act(async () => {
                                await api.resolveEscalation(
                                  e.executionId,
                                  e.planTaskId,
                                  decision,
                                  reason,
                                );
                                setReasons((all) =>
                                  Object.fromEntries(
                                    Object.entries(all).filter(([k]) => k !== key),
                                  ),
                                );
                              }, `${decision} requested for ${e.planTaskId}`)
                            }
                          />
                        );
                      })}
                    </ul>
                  )}
                  {r.budgetAlerts.length > 0 ? (
                    <ul className="flex flex-col gap-3" aria-label="Budget alerts">
                      {r.budgetAlerts.map((b) => (
                        <BudgetBlock key={b.id} alert={b} projectId={projectId} />
                      ))}
                    </ul>
                  ) : null}
                </Stack>
              </Card>
            </div>
            <GateFailures rows={r.gateFailures} />
            <Findings rows={r.findings} />
          </Stack>
        )}
      </LoadState>
    </Page>
  );
}

/** The numbers Sindri recorded for a budget block; anything missing or odd is left out. */
export function budgetNumbers(detail: unknown): {
  reason: string;
  unit?: string;
  used?: number;
  limit?: number;
  budgetId?: string;
  crewId?: string;
} {
  const d = (typeof detail === "object" && detail !== null ? detail : {}) as Record<
    string,
    unknown
  >;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const out: ReturnType<typeof budgetNumbers> = { reason: str(d["reason"]) ?? "budget_exceeded" };
  const unit = str(d["unit"]);
  const used = num(d["used"]);
  const limit = num(d["limit"]);
  const budgetId = str(d["budgetId"]);
  const crewId = str(d["crewId"]);
  if (unit) out.unit = unit;
  if (used !== undefined) out.used = used;
  if (limit !== undefined) out.limit = limit;
  if (budgetId) out.budgetId = budgetId;
  if (crewId) out.crewId = crewId;
  return out;
}

/**
 * A task parked on its crew's hard budget: the numbers, what they mean, and where to raise the
 * budget (Mimir's crew page; Heimdall shows the same block). Sindri cannot raise it itself.
 */
function BudgetBlock({ alert, projectId }: { alert: BudgetAlert; projectId: string }) {
  const n = budgetNumbers(alert.detail);
  const task = alert.planTaskId ?? "the mission";
  const hasNumbers = n.used !== undefined && n.limit !== undefined;
  return (
    <li className="flex flex-col gap-3 rounded-md border border-warning-border bg-warning-bg/40 p-4 text-sm">
      <Cluster gap={2} justify="between">
        <span className="inline-flex min-w-0 items-center gap-2 font-medium">
          <span className="[overflow-wrap:anywhere]">Budget used up: {task}</span>
          <InfoHint term="Crew budget" />
        </span>
        <Status value={n.reason} domain="blocked-reason" />
      </Cluster>
      {hasNumbers ? (
        <>
          <Progress
            value={Math.min(n.used!, n.limit!)}
            max={Math.max(n.limit!, 1)}
            label={`Budget used for ${task}`}
          />
          <KeyValue
            items={[
              {
                label: "Used",
                value: `${n.used} of ${n.limit}${n.unit ? ` ${n.unit}` : ""}`,
                term: "Budget exceeded",
              },
              ...(n.budgetId ? [{ label: "Budget", value: <Id value={n.budgetId} /> }] : []),
              ...(n.crewId ? [{ label: "Crew", value: <Id value={n.crewId} /> }] : []),
            ]}
          />
        </>
      ) : (
        <p className="text-muted">
          {n.reason === "budget_uncertain"
            ? "Mimir cannot measure the crew's usage against its hard budget, so the task waits."
            : "The crew budget is used up; Mimir has not reported the numbers yet."}
        </p>
      )}
      <p className="text-muted">
        Raise the crew budget in Mimir; the task then continues on its own. Or answer the escalation
        above with skip, replan or abort.
      </p>
      <Cluster gap={2}>
        <a
          className="inline-flex h-control-sm items-center rounded-md bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-hover"
          href={n.crewId ? mimirCrewHref(n.crewId) : APP_URLS.mimir}
          target="_blank"
          rel="noreferrer noopener"
        >
          Raise it in Mimir
        </a>
        <a
          className="inline-flex h-control-sm items-center rounded-md border border-line px-3 text-sm font-medium hover:bg-hover"
          href={heimdallHref(projectId)}
          target="_blank"
          rel="noreferrer noopener"
        >
          See it in Heimdall
        </a>
      </Cluster>
    </li>
  );
}

function GateFailures({ rows }: { rows: GateFailure[] }) {
  const columns: Column<GateFailure>[] = [
    {
      key: "task",
      header: "Task",
      primary: true,
      cell: (g) => <span className="font-mono [overflow-wrap:anywhere]">{g.planTaskId}</span>,
    },
    { key: "gate", header: "Gate", cell: (g) => <Badge>{g.gateId}</Badge> },
    {
      key: "reason",
      header: "Reason",
      cell: (g) => (
        <span className="[overflow-wrap:anywhere]">
          <ReasonCode gateId={g.gateId} reason={g.reason} />
        </span>
      ),
    },
    {
      key: "when",
      header: "Evaluated",
      hideOnMobile: true,
      cell: (g) => <Timestamp value={g.evaluatedAt} />,
    },
  ];
  return (
    <Card
      title="Gate failures"
      term="Gate failure"
      count={rows.length}
      description="Gates are evaluated when a run is verified: Brokkr's engineering verdict first (never overridden), then product gates."
      flush
    >
      {rows.length === 0 ? (
        <div className="p-card">
          <Empty>No gate failures.</Empty>
        </div>
      ) : (
        <DataTable
          caption="Gate failures"
          columns={columns}
          rows={rows}
          rowKey={(g) => `${g.executionId}:${g.planTaskId}:${g.gateId}`}
          layout="stack"
          className="rounded-none border-0"
        />
      )}
    </Card>
  );
}

function Findings({ rows }: { rows: Finding[] }) {
  const columns: Column<Finding>[] = [
    {
      key: "verdict",
      header: "Verdict",
      cell: (f) => <Status value={f.verdict ?? "pending"} domain="review-verdict" />,
    },
    {
      key: "severity",
      header: "Severity",
      cell: (f) => <Status value={f.severity} domain="severity" />,
    },
    {
      key: "message",
      header: "Finding",
      primary: true,
      cell: (f) => (
        <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
          <span>{f.message}</span>
          <span className="text-xs text-muted">
            {f.role} review of {f.planTaskId}
            {f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}
          </span>
        </span>
      ),
    },
  ];
  return (
    <Card
      title="Reviewer findings"
      term="Reviewer finding"
      count={rows.length}
      description="From the independent review task's review.json."
      flush
    >
      {rows.length === 0 ? (
        <div className="p-card">
          <Empty>No reviewer findings.</Empty>
        </div>
      ) : (
        <DataTable
          caption="Reviewer findings"
          columns={columns}
          rows={rows}
          rowKey={(f) => `${f.reviewId}:${f.planTaskId}:${f.message}`}
          layout="stack"
          className="rounded-none border-0"
        />
      )}
    </Card>
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
  reason: string;
  onReason: (text: string) => void;
  onDecide: (decision: EscalationDecision, reason: string) => void;
}) {
  const e = props.item;
  const reason = props.reason;
  const id = `esc-${e.executionId}-${e.planTaskId}`;
  return (
    <li className="flex flex-col gap-2">
      <Cluster gap={2}>
        <span className="font-mono font-medium [overflow-wrap:anywhere]">{e.planTaskId}</span>
        <Status value={e.escalation} domain="escalation" />
        <span className="inline-flex items-center gap-1 text-muted">
          after {e.attempts} failed attempt(s)
          <InfoHint term="Failed attempts" />
        </span>
      </Cluster>
      {e.reason ? <p className="text-muted [overflow-wrap:anywhere]">{e.reason}</p> : null}
      <label htmlFor={id} className="text-sm font-medium">
        Reason for {e.planTaskId}
      </label>
      <input
        id={id}
        className={inputClass}
        value={reason}
        placeholder="Why you decide this (kept with the run)"
        onChange={(ev) => props.onReason(ev.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {DECISIONS.map((d) => (
          <Button
            key={d.decision}
            size="sm"
            variant={
              d.decision === "abort" ? "danger" : d.decision === "retry" ? "primary" : "secondary"
            }
            {...(reason.trim() === "" ? { disabledReason: "Give a reason first" } : {})}
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
