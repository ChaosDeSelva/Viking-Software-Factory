import type { Approval, EventEnvelope, EventPayloadMap, Provenance } from "@mimir/protocol";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Input,
  Link,
  Tabs,
  Timestamp,
  type Column,
} from "@factory/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError } from "../api/client.js";
import { ActionResult, type ActionOutcome } from "../components/ActionResult.js";
import { ProvenanceBadge, StatusBadge } from "../components/Badges.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { missionName, taskName } from "../lib/names.js";
import { useScoped } from "../lib/scope.js";
import { loadScopedHistory, mergeEvents } from "../lib/useEventHistory.js";
import { useStore } from "../store/StoreProvider.js";

const REVIEW_TYPES = ["test.run_completed", "artifact.recorded", "policy.denied"] as const;

type TestEvent = EventEnvelope & { payload: EventPayloadMap["test.run_completed"] };
type ArtifactEvent = EventEnvelope & { payload: EventPayloadMap["artifact.recorded"] };
type DeniedEvent = EventEnvelope & { payload: EventPayloadMap["policy.denied"] };

/** Mission and task names for rows; falls back to "—" for records outside the snapshot. */
function useNames() {
  const { state } = useStore();
  return useMemo(() => {
    const missions = new Map(state.missions.map((m) => [m.id as string, m]));
    const tasks = new Map(state.tasks.map((t) => [t.id as string, t]));
    return {
      mission: (id: string | null | undefined) => {
        const m = id ? missions.get(id) : undefined;
        return m ? missionName(m, state.tasks) : null;
      },
      task: (id: string | null | undefined) => {
        const t = id ? tasks.get(id) : undefined;
        return t ? taskName(t) : null;
      },
    };
  }, [state.missions, state.tasks]);
}

function MissionCell({ id, name }: { id: string | undefined; name: string | null }) {
  if (!id) return <span className="text-muted">—</span>;
  return (
    <Link href={`/missions/${id}`} className="line-clamp-2 text-sm text-fg hover:underline">
      {name ?? id}
    </Link>
  );
}

function ApprovalCard({ approval }: { approval: Approval }) {
  const { client, state, dispatch, reportError } = useStore();
  const names = useNames();
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const outcome = state.decisionOutcomes[approval.id] ?? null;
  // Kept in the store so the audit result survives this card unmounting on `approval.decided`.
  const decide = (decision: "approved" | "rejected") => {
    const r = reason.trim();
    if (decision === "rejected" && !r) {
      setInvalid("A reason is required to reject.");
      reasonRef.current?.focus();
      return;
    }
    setInvalid(null);
    setBusy(true);
    client.approvals
      .decide(approval.id, { decision, ...(r ? { reason: r } : {}) })
      .then(
        (res): ActionOutcome => ({
          kind: "ok",
          message: `${decision === "approved" ? "Approved" : "Rejected"} ${approval.id}`,
          operationId: res.operationId,
          commandId: res.commandId,
        }),
        (e: unknown): ActionOutcome => {
          reportError(e);
          return { kind: "error", error: describeError(e) };
        },
      )
      .then((o) => {
        dispatch({ type: "decision/outcome", approvalId: approval.id, outcome: o });
        setBusy(false);
      });
  };
  const task = approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  const missionLabel = names.mission(approval.missionId);
  const inputId = `reason-${approval.id}`;
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-waiting-border bg-surface p-card">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm font-semibold">{approval.action}</code>
        <StatusBadge status={approval.status} domain="approval" />
        {approval.expiry && (
          <span className="text-xs text-muted">
            expires <Timestamp value={approval.expiry} />
          </span>
        )}
      </div>
      {approval.reason && <p className="text-sm">{approval.reason}</p>}
      {(missionLabel || task) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {approval.missionId && missionLabel && (
            <>
              <dt className="text-muted">Mission</dt>
              <dd className="min-w-0 truncate">
                <Link href={`/missions/${approval.missionId}`} className="hover:underline">
                  {missionLabel}
                </Link>
              </dd>
            </>
          )}
          {task && (
            <>
              <dt className="text-muted">Task</dt>
              <dd className="min-w-0 truncate">
                <Link href={`/missions/${task.missionId}`} className="hover:underline">
                  {taskName(task)}
                </Link>
              </dd>
            </>
          )}
        </dl>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 flex-1 flex-col gap-label">
          <label htmlFor={inputId} className="text-sm font-medium">
            Reason (required to reject)<span className="sr-only"> for {approval.id}</span>
          </label>
          <Input
            id={inputId}
            ref={reasonRef}
            invalid={invalid !== null}
            aria-describedby={invalid ? `${inputId}-err` : undefined}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <Button
          variant="primary"
          disabled={busy}
          aria-label={`Approve ${approval.id}`}
          onClick={() => decide("approved")}
        >
          Approve
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          aria-label={`Reject ${approval.id}`}
          onClick={() => decide("rejected")}
        >
          Reject
        </Button>
      </div>
      {invalid && (
        <p id={`${inputId}-err`} role="alert" className="text-sm text-danger-fg">
          {invalid}
        </p>
      )}
      <ActionResult outcome={outcome} />
    </li>
  );
}

interface TestGroup {
  key: string;
  missionId: string | undefined;
  taskId: string | undefined;
  command: string;
  latest: TestEvent;
  runs: number;
  passed: number;
  failed: number;
}

/**
 * The same command reruns on every verification attempt; one row per (mission, task, command)
 * with the latest result and the run counts replaces N identical rows.
 */
export function groupTestRuns(events: readonly TestEvent[]): TestGroup[] {
  const groups = new Map<string, TestGroup>();
  for (const e of events) {
    const key = `${e.missionId ?? ""}|${e.taskId ?? ""}|${e.payload.command}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        key,
        missionId: e.missionId,
        taskId: e.taskId,
        command: e.payload.command,
        latest: e,
        runs: 1,
        passed: e.payload.passed ? 1 : 0,
        failed: e.payload.passed ? 0 : 1,
      });
      continue;
    }
    g.runs += 1;
    if (e.payload.passed) g.passed += 1;
    else g.failed += 1;
    if (e.occurredAt >= g.latest.occurredAt) g.latest = e;
  }
  return [...groups.values()].sort((a, b) => (a.latest.occurredAt < b.latest.occurredAt ? 1 : -1));
}

interface DiffGroup {
  key: string;
  missionId: string | undefined;
  taskId: string | undefined;
  count: number;
  kinds: string[];
  latest: string;
  provenance: Provenance;
}

export function groupDiffs(events: readonly ArtifactEvent[]): DiffGroup[] {
  const groups = new Map<string, DiffGroup>();
  for (const e of events) {
    const taskId = e.taskId ?? e.payload.taskId;
    const key = `${e.missionId ?? ""}|${taskId ?? ""}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        key,
        missionId: e.missionId,
        taskId,
        count: 1,
        kinds: [e.payload.kind],
        latest: e.occurredAt,
        provenance: e.provenance,
      });
      continue;
    }
    g.count += 1;
    if (!g.kinds.includes(e.payload.kind)) g.kinds.push(e.payload.kind);
    if (e.occurredAt > g.latest) g.latest = e.occurredAt;
  }
  return [...groups.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1));
}

function TestRuns({ tests }: { tests: TestEvent[] }) {
  const names = useNames();
  const rows = useMemo(() => groupTestRuns(tests), [tests]);
  const columns: Column<TestGroup>[] = [
    {
      key: "command",
      header: "Command",
      primary: true,
      cell: (g) => <code className="font-mono text-sm">{g.command}</code>,
    },
    {
      key: "result",
      header: "Latest result",
      cell: (g) => (
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge status={g.latest.payload.passed ? "passed" : "failed"} domain="test" />
          {g.latest.payload.total !== undefined && (
            <span className="text-xs text-muted">
              {g.latest.payload.failed ?? 0} of {g.latest.payload.total} failed
            </span>
          )}
        </span>
      ),
    },
    {
      key: "runs",
      header: "Runs",
      cell: (g) => (
        <span className="text-sm whitespace-nowrap tabular-nums">
          ×{g.runs} {g.runs === 1 ? "run" : "runs"}
          {g.runs > 1 && (
            <span className="block text-xs text-muted">
              {g.passed} passed · {g.failed} failed
            </span>
          )}
        </span>
      ),
    },
    {
      key: "task",
      header: "Mission / task",
      cell: (g) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <MissionCell id={g.missionId} name={names.mission(g.missionId)} />
          {names.task(g.taskId) && (
            <span className="line-clamp-1 text-xs text-muted">{names.task(g.taskId)}</span>
          )}
        </span>
      ),
    },
    {
      key: "when",
      header: "Last run",
      cell: (g) => <Timestamp value={g.latest.occurredAt} className="text-sm text-muted" />,
      hideOnMobile: true,
    },
    {
      key: "provenance",
      header: "Source",
      cell: (g) => <ProvenanceBadge provenance={g.latest.provenance} />,
      hideOnMobile: true,
    },
  ];
  return (
    <Section title="Test results" term="Verification" count={rows.length} flush>
      <DataTable
        caption="Test results, one row per task and command"
        columns={columns}
        rows={rows}
        rowKey={(g) => g.key}
        empty={
          <EmptyState
            body="Results appear when a task's tests run during verification."
            action={<Link href="/missions">Open Missions</Link>}
          >
            No test runs recorded
          </EmptyState>
        }
      />
    </Section>
  );
}

function Diffs({ diffs }: { diffs: ArtifactEvent[] }) {
  const names = useNames();
  const rows = useMemo(() => groupDiffs(diffs), [diffs]);
  const columns: Column<DiffGroup>[] = [
    {
      key: "mission",
      header: "Mission",
      primary: true,
      label: "Mission",
      cell: (g) => <MissionCell id={g.missionId} name={names.mission(g.missionId)} />,
    },
    {
      key: "task",
      header: "Task",
      cell: (g) => (
        <span className="line-clamp-2 text-sm">{names.task(g.taskId) ?? g.taskId ?? "—"}</span>
      ),
    },
    {
      key: "count",
      header: "Diffs",
      cell: (g) => (
        <span className="flex flex-wrap items-center gap-1">
          <span className="tabular-nums">{g.count}</span>
          {g.kinds.map((k) => (
            <Badge key={k}>{k}</Badge>
          ))}
        </span>
      ),
    },
    {
      key: "when",
      header: "Latest",
      cell: (g) => <Timestamp value={g.latest} className="text-sm text-muted" />,
      hideOnMobile: true,
    },
    {
      key: "open",
      header: <span className="sr-only">Open</span>,
      label: "Open",
      cell: (g) =>
        g.missionId ? (
          <Link
            href={`/missions/${g.missionId}?tab=files`}
            className="text-sm font-medium text-accent-fg hover:underline"
          >
            Open files
          </Link>
        ) : null,
    },
  ];
  return (
    <Section title="Diffs" term="Artifact" count={rows.length} flush>
      <DataTable
        caption="Diffs by mission and task"
        columns={columns}
        rows={rows}
        rowKey={(g) => g.key}
        empty={
          <EmptyState body="Each completed task records its change as a diff artifact.">
            No diffs recorded
          </EmptyState>
        }
      />
    </Section>
  );
}

interface RiskRow {
  id: string;
  kind: "denied" | "approval";
  action: string;
  status: string;
  reason: string | null;
  at: string;
}

function HighRisk({ denied, approvals }: { denied: DeniedEvent[]; approvals: Approval[] }) {
  const rows: RiskRow[] = [
    ...[...denied].reverse().map((e) => ({
      id: e.id,
      kind: "denied" as const,
      action: e.payload.action,
      status: "denied",
      reason: e.payload.reason,
      at: e.occurredAt,
    })),
    ...approvals.map((a) => ({
      id: a.id,
      kind: "approval" as const,
      action: a.action,
      status: a.status,
      reason: a.reason,
      at: a.updatedAt,
    })),
  ];
  const columns: Column<RiskRow>[] = [
    {
      key: "action",
      header: "Command",
      primary: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          {r.kind === "denied" && <span className="text-sm">Denied</span>}
          <code className="font-mono text-sm">{r.action}</code>
        </span>
      ),
    },
    {
      key: "status",
      header: "Outcome",
      cell: (r) => (
        <StatusBadge status={r.status} domain={r.kind === "denied" ? "policy" : "approval"} />
      ),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (r) => <span className="text-sm">{r.reason ?? "—"}</span>,
    },
    {
      key: "when",
      header: "When",
      cell: (r) => <Timestamp value={r.at} className="text-sm text-muted" />,
      hideOnMobile: true,
    },
  ];
  return (
    <Section title="High-risk commands" term="High-risk command" count={rows.length} flush>
      <DataTable
        caption="Denied and approval-gated commands"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState body="Commands the policy denies, or that need an approval, show up here.">
            No high-risk commands recorded
          </EmptyState>
        }
      />
    </Section>
  );
}

export function Reviews() {
  const { state, client, reportError } = useStore();
  const scoped = useScoped();
  const [history, setHistory] = useState<EventEnvelope[]>([]);
  const [histStatus, setHistStatus] = useState<"loading" | "ready" | "error">("loading");
  const [histError, setHistError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reloadHistory = useCallback(() => setTick((n) => n + 1), []);
  const pendingRegion = useRef<HTMLDivElement>(null);
  const prevPending = useRef(0);
  // Re-run the replay when the project (its mission set) changes, not on every snapshot.
  const scopeKey = scoped.missionIds === null ? "*" : [...scoped.missionIds].sort().join(",");
  const missionIds = scoped.missionIds;
  useEffect(() => {
    const ctrl = new AbortController();
    setHistStatus("loading");
    setHistError(null);
    loadScopedHistory(client, missionIds, { types: [...REVIEW_TYPES] }, ctrl.signal).then(
      (r) => {
        if (ctrl.signal.aborted) return;
        setHistory(r.events);
        setHistStatus("ready");
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        reportError(e);
        setHistError(describeError(e).message);
        setHistStatus("error");
      },
    );
    return () => ctrl.abort();
    // Keyed by the mission set (scopeKey), not the Set instance.
  }, [client, reportError, tick, scopeKey]);

  const events = useMemo(
    () =>
      mergeEvents(
        history,
        scoped.events.filter((e) => (REVIEW_TYPES as readonly string[]).includes(e.type)),
      ),
    [history, scoped.events],
  );
  const pending = scoped.approvals.filter((a) => a.status === "pending");
  // A decided card unmounts under the focused button; park focus on the section heading.
  useEffect(() => {
    if (pending.length < prevPending.current) {
      const active = document.activeElement;
      const heading = pendingRegion.current?.querySelector<HTMLElement>("h2");
      if (heading && (!active || active === document.body)) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
    prevPending.current = pending.length;
  }, [pending.length]);
  const decided = scoped.approvals
    .filter((a) => a.status !== "pending")
    .slice(-20)
    .reverse();
  const tests = events.filter((e): e is TestEvent => e.type === "test.run_completed");
  const diffs = events.filter(
    (e): e is ArtifactEvent =>
      e.type === "artifact.recorded" && /diff|patch/i.test((e.payload as { kind: string }).kind),
  );
  const denied = events.filter((e): e is DeniedEvent => e.type === "policy.denied");
  const riskyApprovals = scoped.approvals.filter((a) => a.action.startsWith("shell."));

  return (
    <Screen
      screen="reviews"
      title="Reviews"
      term="Approval"
      description="Approvals waiting on you, then the evidence: test runs, diffs and high-risk commands."
    >
      <StoreGate label="reviews">
        <div ref={pendingRegion} className="contents [&_h2]:outline-none">
          <Card
            title="Pending approvals"
            headingLevel={2}
            count={pending.length}
            term="Approval"
            description="An agent asked to do something the policy gates. Approve, or reject with a reason."
          >
            {pending.length === 0 ? (
              <EmptyState body="When an agent needs permission for a gated action, it waits here.">
                No pending approvals
              </EmptyState>
            ) : (
              <ul className="flex flex-col gap-3">
                {pending.map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              </ul>
            )}
          </Card>
        </div>
        <Section title="Recent decisions" count={decided.length} flush>
          {decided.length === 0 ? (
            <div className="p-card">
              <EmptyState body="Approvals you or the policy decided appear here with their audit ids.">
                No decisions yet
              </EmptyState>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {decided.map((a) => (
                <li key={a.id} className="flex flex-col gap-2 px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-mono">{a.action}</code>
                    <StatusBadge status={a.status} domain="approval" />
                    {a.actor && <span className="text-muted">by {a.actor}</span>}
                    {a.reason && <span>{a.reason}</span>}
                    <Timestamp value={a.updatedAt} className="ml-auto text-xs text-muted" />
                  </div>
                  <ActionResult outcome={state.decisionOutcomes[a.id] ?? null} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        {histStatus === "loading" && <LoadingState label="review history" />}
        {histStatus === "error" && (
          <ErrorState
            title="Could not load the review history"
            message={histError ?? "failed"}
            onRetry={reloadHistory}
          />
        )}
        <Tabs
          label="Review evidence"
          urlParam="view"
          items={[
            {
              value: "tests",
              label: "Test runs",
              count: groupTestRuns(tests).length,
              content: <TestRuns tests={tests} />,
            },
            {
              value: "diffs",
              label: "Diffs",
              count: groupDiffs(diffs).length,
              content: <Diffs diffs={diffs} />,
            },
            {
              value: "risk",
              label: "High-risk commands",
              count: denied.length + riskyApprovals.length,
              content: <HighRisk denied={denied} approvals={riskyApprovals} />,
            },
          ]}
        />
      </StoreGate>
    </Screen>
  );
}
