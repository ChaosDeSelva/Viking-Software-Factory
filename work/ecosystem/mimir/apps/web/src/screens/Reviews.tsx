import type { Approval, EventEnvelope, EventPayloadMap } from "@mimir/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ActionResult, type ActionOutcome } from "../components/ActionResult.js";
import { ProvenanceBadge, StatusBadge } from "../components/Badges.js";
import { PageTitle, Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { describeError } from "../api/client.js";
import { loadHistory, mergeEvents } from "../lib/useEventHistory.js";
import { useStore } from "../store/StoreProvider.js";

const REVIEW_TYPES = ["test.run_completed", "artifact.recorded", "policy.denied"] as const;

function ApprovalCard({ approval }: { approval: Approval }) {
  const { client, state, dispatch, reportError } = useStore();
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
  const mission = approval.missionId
    ? state.missions.find((m) => m.id === approval.missionId)
    : undefined;
  const inputId = `reason-${approval.id}`;
  return (
    <li className="rounded border border-amber-700 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-semibold">{approval.action}</code>
        <StatusBadge status={approval.status} />
        {approval.reason && <span>{approval.reason}</span>}
      </div>
      <div className="text-sm">
        {mission && (
          <>
            Mission:{" "}
            <Link className="underline" to={`/missions/${mission.id}`}>
              {mission.objective}
            </Link>{" "}
          </>
        )}
        {task && (
          <>
            Task:{" "}
            <Link className="underline" to={`/missions/${task.missionId}`}>
              {task.title}
            </Link>
          </>
        )}
        {approval.expiry && <span> · expires {approval.expiry}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label htmlFor={inputId} className="grid gap-1 text-sm">
          <span>
            Reason (required to reject)<span className="sr-only"> for {approval.id}</span>
          </span>
          <input
            id={inputId}
            ref={reasonRef}
            className="input"
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? `${inputId}-err` : undefined}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          aria-label={`Approve ${approval.id}`}
          onClick={() => decide("approved")}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          aria-label={`Reject ${approval.id}`}
          onClick={() => decide("rejected")}
        >
          Reject
        </button>
      </div>
      {invalid && (
        <p id={`${inputId}-err`} role="alert" className="mt-1 text-red-800 dark:text-red-200">
          {invalid}
        </p>
      )}
      <ActionResult outcome={outcome} />
    </li>
  );
}

export function Reviews() {
  const { state, client } = useStore();
  const [history, setHistory] = useState<EventEnvelope[]>([]);
  const [histStatus, setHistStatus] = useState<"loading" | "ready" | "error">("loading");
  const [histError, setHistError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reloadHistory = useCallback(() => setTick((n) => n + 1), []);
  const pendingHeading = useRef<HTMLHeadingElement>(null);
  const prevPending = useRef(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setHistStatus("loading");
    setHistError(null);
    loadHistory(client, { types: [...REVIEW_TYPES] }, ctrl.signal).then(
      (r) => {
        if (ctrl.signal.aborted) return;
        setHistory(r.events);
        setHistStatus("ready");
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setHistError(describeError(e).message);
        setHistStatus("error");
      },
    );
    return () => ctrl.abort();
  }, [client, tick]);

  const events = useMemo(
    () =>
      mergeEvents(
        history,
        state.events.filter((e) => (REVIEW_TYPES as readonly string[]).includes(e.type)),
      ),
    [history, state.events],
  );
  const pending = state.approvals.filter((a) => a.status === "pending");
  // A decided card unmounts under the focused button; park focus on the section heading.
  useEffect(() => {
    if (pending.length < prevPending.current) {
      const active = document.activeElement;
      if (!active || active === document.body) pendingHeading.current?.focus();
    }
    prevPending.current = pending.length;
  }, [pending.length]);
  const decided = state.approvals
    .filter((a) => a.status !== "pending")
    .slice(-20)
    .reverse();
  const tests = events.filter(
    (e): e is EventEnvelope & { payload: EventPayloadMap["test.run_completed"] } =>
      e.type === "test.run_completed",
  );
  const diffs = events.filter(
    (e): e is EventEnvelope & { payload: EventPayloadMap["artifact.recorded"] } =>
      e.type === "artifact.recorded" && /diff|patch/i.test((e.payload as { kind: string }).kind),
  );
  const denied = events.filter(
    (e): e is EventEnvelope & { payload: EventPayloadMap["policy.denied"] } =>
      e.type === "policy.denied",
  );
  const riskyApprovals = state.approvals.filter((a) => a.action.startsWith("shell."));

  return (
    <>
      <PageTitle>Reviews</PageTitle>
      <StoreGate label="reviews">
        <Section title="Pending approvals" headingRef={pendingHeading}>
          {pending.length === 0 ? (
            <EmptyState>No pending approvals.</EmptyState>
          ) : (
            <ul className="space-y-2">
              {pending.map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
            </ul>
          )}
        </Section>
        {histStatus === "loading" && <LoadingState label="review history" />}
        {histStatus === "error" && (
          <ErrorState message={histError ?? "failed"} onRetry={reloadHistory} />
        )}
        <Section title="Test results">
          {tests.length === 0 ? (
            <EmptyState>No test runs recorded.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {[...tests].reverse().map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <code>{e.payload.command}</code>
                  <StatusBadge status={e.payload.passed ? "completed" : "failed"} />
                  {e.payload.total !== undefined && (
                    <span>
                      {e.payload.failed ?? 0} of {e.payload.total} failed
                    </span>
                  )}
                  {e.missionId && (
                    <Link className="underline" to={`/missions/${e.missionId}`}>
                      mission
                    </Link>
                  )}
                  <ProvenanceBadge provenance={e.provenance} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Diffs">
          {diffs.length === 0 ? (
            <EmptyState>No diffs recorded.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {[...diffs].reverse().map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{e.payload.kind}</span>
                  <code>{e.payload.artifactId}</code>
                  {e.missionId && (
                    <Link className="underline" to={`/missions/${e.missionId}`}>
                      open mission files
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="High-risk commands">
          {denied.length === 0 && riskyApprovals.length === 0 ? (
            <EmptyState>No high-risk commands recorded.</EmptyState>
          ) : (
            <ul className="space-y-1 text-sm">
              {[...denied].reverse().map((e) => (
                <li key={e.id}>
                  Denied <code>{e.payload.action}</code>: {e.payload.reason}
                </li>
              ))}
              {riskyApprovals.map((a) => (
                <li key={a.id}>
                  <code>{a.action}</code> ({a.status}){a.reason ? `: ${a.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Recent decisions">
          {decided.length === 0 ? (
            <EmptyState>No decisions yet.</EmptyState>
          ) : (
            <ul className="space-y-1 text-sm">
              {decided.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <code>{a.action}</code>
                  <StatusBadge status={a.status} />
                  {a.actor && <span>by {a.actor}</span>}
                  {a.reason && <span>{a.reason}</span>}
                  <ActionResult outcome={state.decisionOutcomes[a.id] ?? null} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </StoreGate>
    </>
  );
}
