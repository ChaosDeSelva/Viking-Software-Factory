import { useEffect, useId, useState, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import {
  acceptNeedsApproval,
  type Decision,
  type FeedbackGraphStatus,
  type StewardType,
} from "../api/steward-types.js";
import { Callout, Cluster, InfoHint, Page, Stack, Toolbar } from "@factory/ui";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import {
  Badge,
  Button,
  Empty,
  Field,
  inputClass,
  LoadState,
  ScreenHeader,
  Status,
  textareaClass,
  Card,
} from "../components/ui.js";
import { useApi, useLoad, useReportError, useStore, type Loadable } from "../store/context.js";
import type { Action } from "../store/reducer.js";

/** How often the decision log refreshes while the page is visible. */
export const POLL_MS = 5000;

const TYPE_LABELS: Record<string, string> = {
  "spec.answer": "Answer spec questions",
  "escalation.resolve": "Resolve escalations",
  "rework.suggest": "Suggest rework",
  "spec.approve": "Approve specs",
  "plan.approve": "Approve plans",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  accepted: "Accepted",
  changed: "Changed",
  rejected: "Rejected",
  applied: "Applied",
  rolled_back: "Rolled back",
  expired: "Expired",
};
const MODE_LABELS: Record<string, string> = { off: "Off", recommend: "Recommend", auto: "Auto" };
const OUTCOME_LABELS: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  reworked: "Reworked",
  unknown: "Unknown",
};
const INPUT_LABELS: Record<string, string> = {
  spec: "Spec",
  question: "Question",
  run: "Run",
  gate: "Gate",
  review: "Review",
  note: "Note",
  guidance: "Guidance",
  lesson: "Lesson",
  past_decision: "Past decision",
  feedback: "Feedback",
};
/** Statuses whose effect was carried out, so a reversible decision can be rolled back. */
const APPLIED = ["applied", "accepted", "changed"];

/** A known value's label, or the raw value (the server may send values this build lacks). */
const label = (map: Record<string, string>, v: string) =>
  Object.prototype.hasOwnProperty.call(map, v) ? map[v]! : v;
const typeLabel = (t: string) => label(TYPE_LABELS, t);
const pct = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";
const when = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Navigation for a decision's subject or input, or null when there is nowhere to go. */
function openAction(kind: string, id: string): Action | null {
  switch (kind) {
    case "spec":
      return { type: "spec/open", specId: id };
    case "plan":
      return { type: "plan/open", planId: id };
    case "execution":
    case "run":
      return { type: "execution/open", executionId: id };
    case "delivery":
      return { type: "delivery/open", deliveryId: id };
    default:
      return null;
  }
}

/** A link-styled button that opens `kind`/`id` (in the decision's project), or plain text. */
function OpenLink(props: { kind: string; id: string; projectId: string; children: ReactNode }) {
  const { state, dispatch } = useStore();
  const action = openAction(props.kind, props.id);
  if (!action) return <>{props.children}</>;
  return (
    <button
      type="button"
      className="text-left text-accent-fg underline underline-offset-2 hover:decoration-2 [overflow-wrap:anywhere]"
      onClick={() => {
        if (
          props.projectId !== state.projectId &&
          state.projects.some((p) => p.id === props.projectId)
        )
          dispatch({ type: "project/select", projectId: props.projectId });
        dispatch(action);
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * Project tab: the steward's decisions and notes for the selected project only. Modes, the
 * steward itself and every project's log are global (Autonomy (all), bottom bar).
 */
export function AutonomyScreen() {
  const { state, dispatch } = useStore();
  const projectId = state.projectId;
  return (
    <Page>
      <ScreenHeader
        screen="autonomy"
        title="Autonomy"
        term="Steward"
        description="What the steward recommended or decided in this project, and the notes it reads before it decides."
        actions={
          <Button
            variant="secondary"
            onClick={() => dispatch({ type: "navigate", view: "autonomy-all" })}
          >
            Modes and steward
          </Button>
        }
      />
      <div className="grid gap-group lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <DecisionLog projectId={projectId} />
        <NotesFeed projectId={projectId} />
      </div>
    </Page>
  );
}

/** Global: steward state, per-type modes and track record, every project's decisions. */
export function AutonomyAllScreen() {
  return (
    <Page>
      <ScreenHeader
        screen="autonomy-all"
        title="Autonomy (all)"
        global
        term="Autonomy"
        description="The steward and its modes apply to every project. Each decision type starts by recommending; switch it to automatic once its track record is good."
      />
      <StewardPanel />
      <div className="grid gap-group lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <DecisionLog projectId={null} allProjects />
        <NotesFeed projectId={null} />
      </div>
    </Page>
  );
}

/** Feedback Graph connection as a status (for the pill) and a sentence (with the detail). */
function fgLine(fg: FeedbackGraphStatus | undefined): { text: string; status: string } {
  if (!fg) return { text: "Unknown", status: "unknown" };
  if (!fg.configured)
    return { text: "Not configured (set it up in Settings)", status: "not_configured" };
  if (!fg.enabled) return { text: "Disabled in Settings", status: "disabled" };
  if (fg.reachable === true)
    return { text: `Connected${fg.url ? ` to ${fg.url}` : ""}`, status: "connected" };
  if (fg.reachable === false)
    return { text: `Unreachable${fg.error ? `: ${fg.error}` : ""}`, status: "unreachable" };
  return { text: "Not checked yet", status: "not_checked" };
}

function StewardPanel() {
  const api = useApi();
  const report = useReportError();
  const [tick, setTick] = useState(0);
  // useLoad also refreshes it quietly when Sindri reports a change.
  const statusLoad = useLoad(() => api.stewardStatus(), [api, tick]);
  const status = statusLoad.state;
  const setStatus = statusLoad.setState;
  const [busy, setBusy] = useState(false);
  const [, setUnlockTick] = useState(0);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch(report)
      .finally(() => setBusy(false));
  };
  const setTypes = (types: StewardType[]) =>
    setStatus((s) => (s.status === "ready" ? { status: "ready", data: { ...s.data, types } } : s));

  return (
    <Card title="Steward" term="Steward">
      <LoadState state={status} what="steward status" onRetry={() => setTick((t) => t + 1)}>
        {(s) => {
          const fg = fgLine(s.feedbackGraph);
          const unlocked = api.hasApprovalSession();
          return (
            <Stack gap={5}>
              <div
                className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm"
                aria-label="Steward status"
              >
                <span className="inline-flex items-center gap-2">
                  Steward <Status value={s.running ? "running" : "paused"} domain="steward-state" />
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={() =>
                    run(async () => {
                      const next = s.running ? await api.pauseSteward() : await api.resumeSteward();
                      setStatus({ status: "ready", data: next });
                    })
                  }
                >
                  {s.running ? "Pause" : "Resume"}
                </Button>
                <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
                  Feedback Graph <Status value={fg.status} domain="fg-connection" />
                  <span className="text-muted [overflow-wrap:anywhere]">{fg.text}</span>
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="flex items-center gap-1.5 text-md font-semibold">
                  Decision types <InfoHint term="Decision type" />
                </h3>
                <p className="text-sm text-muted">
                  Every type starts by recommending; you accept, change or reject. Switch a type to
                  automatic once its track record is good. Approvals are never automatic. Changing a
                  mode needs the approval pairing code.
                </p>
              </div>
              {unlocked ? null : (
                <Callout tone="info" title="Modes are locked">
                  <ApprovalUnlock
                    id="steward-mode-approval"
                    onUnlocked={() => setUnlockTick((n) => n + 1)}
                  />
                </Callout>
              )}
              {s.types.length === 0 ? (
                <Empty>The steward reports no decision types.</Empty>
              ) : (
                <div className="overflow-x-auto rounded-md border border-line">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-sunken text-xs font-semibold text-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2">
                          Type
                        </th>
                        <th scope="col" className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            Mode <InfoHint term="Steward mode" />
                          </span>
                        </th>
                        {["Accepted", "Changed", "Rejected", "Rolled back", "Auto-applied"].map(
                          (h) => (
                            <th key={h} scope="col" className="px-3 py-2 text-right">
                              {h}
                            </th>
                          ),
                        )}
                        <th scope="col" className="px-3 py-2 text-right">
                          <span className="inline-flex items-center gap-1">
                            Accuracy <InfoHint term="Accuracy" />
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.types.map((t) => (
                        <TypeRow
                          key={t.type}
                          t={t}
                          disabled={busy || !unlocked}
                          onMode={(mode) =>
                            run(async () => setTypes(await api.setStewardMode(t.type, mode)))
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Stack>
          );
        }}
      </LoadState>
    </Card>
  );
}

function TypeRow(props: { t: StewardType; disabled: boolean; onMode: (mode: string) => void }) {
  const { t } = props;
  const id = useId();
  const stats = t.stats ?? ({} as Partial<StewardType["stats"]>);
  const known = ["off", "recommend", "auto"].includes(t.mode);
  return (
    <tr className="border-t border-line align-top">
      <th scope="row" className="px-3 py-2.5 font-medium">
        {typeLabel(t.type)}
      </th>
      <td className="px-3 py-2">
        <label htmlFor={id} className="sr-only">
          Mode for {typeLabel(t.type)}
        </label>
        <select
          id={id}
          className={inputClass.replace("w-full", "w-40")}
          value={t.mode}
          disabled={props.disabled}
          aria-describedby={t.autoAllowed ? undefined : `${id}-hint`}
          onChange={(e) => props.onMode(e.target.value)}
        >
          {known ? null : <option value={t.mode}>{t.mode}</option>}
          <option value="off">Off</option>
          <option value="recommend">Recommend</option>
          <option value="auto" disabled={!t.autoAllowed}>
            Auto
          </option>
        </select>
        {t.autoAllowed ? null : (
          <p id={`${id}-hint`} className="mt-1 max-w-48 text-xs text-muted">
            Auto is not available: this is an approval, which always needs you.
          </p>
        )}
      </td>
      {[stats.accepted, stats.changed, stats.rejected, stats.rolledBack, stats.autoApplied].map(
        (n, i) => (
          <td key={i} className="px-3 py-2.5 text-right tabular-nums">
            {n ?? 0}
          </td>
        ),
      )}
      <td className="px-3 py-2.5 text-right tabular-nums">{pct(stats.accuracy)}</td>
    </tr>
  );
}

function DecisionLog({
  projectId,
  allProjects = false,
}: {
  projectId: string | null;
  allProjects?: boolean;
}) {
  const { state } = useStore();
  const api = useApi();
  const report = useReportError();
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [log, setLog] = useState<Loadable<Decision[]>>({ status: "loading" });
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Polls with a timer re-armed after each answer (never overlapping), only while the tab is
  // visible; unmount and a filter change end the loop.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const arm = () => {
      clearTimeout(timer);
      timer = live && !hidden() ? setTimeout(poll, POLL_MS) : undefined;
    };
    function poll() {
      timer = undefined;
      if (!live || inFlight) return;
      inFlight = true;
      api
        .listDecisions({
          ...(projectId ? { projectId } : {}),
          ...(type ? { type } : {}),
          ...(status ? { status } : {}),
          limit: 50,
        })
        .then(
          (data) => {
            if (!live) return;
            setLog({ status: "ready", data });
            setRefreshError(null);
          },
          (e: unknown) => {
            if (!live) return;
            if (e instanceof ApiError && e.status === 401) report(e);
            // A failed refresh keeps the list it has; only a first load turns into an error.
            setLog((l) => (l.status === "ready" ? l : { status: "error", error: message(e) }));
            setRefreshError(message(e));
          },
        )
        .finally(() => {
          inFlight = false;
          arm();
        });
    }
    const onVisibility = () => {
      if (hidden()) {
        clearTimeout(timer);
        timer = undefined;
      } else if (!inFlight && timer === undefined) poll();
    };
    setLog({ status: "loading" });
    setRefreshError(null);
    poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, projectId, type, status, tick]);

  const replace = (d: Decision) =>
    setLog((l) =>
      l.status === "ready"
        ? { status: "ready", data: l.data.map((x) => (x.id === d.id ? d : x)) }
        : l,
    );

  return (
    <Card
      title="Decision log"
      description={allProjects ? "Every project, newest first." : "This project, newest first."}
    >
      <Stack gap={4}>
        <Toolbar label="Filter decisions">
          <Field label="Type" id="decision-type-filter" term="Decision type">
            <select
              id="decision-type-filter"
              className={inputClass}
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">All types</option>
              {Object.entries(TYPE_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Status" id="decision-status-filter">
            <select
              id="decision-status-filter"
              className={inputClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </Toolbar>
        {refreshError && log.status === "ready" ? (
          <p className="text-xs text-danger-fg">Could not refresh: {refreshError}</p>
        ) : null}
        <LoadState state={log} what="decisions" onRetry={() => setTick((t) => t + 1)}>
          {(decisions) =>
            decisions.length === 0 ? (
              <Empty
                body={
                  type || status
                    ? "Clear the filters to see every decision."
                    : "The steward records a decision when a spec question, escalation, rework or approval comes up."
                }
              >
                No decisions match.
              </Empty>
            ) : (
              <ol className="flex flex-col gap-3" aria-label="Decisions">
                {decisions.map((d) => (
                  <DecisionEntry
                    key={d.id}
                    d={d}
                    onChange={replace}
                    {...(allProjects
                      ? {
                          project:
                            state.projects.find((p) => p.id === d.projectId)?.name ?? d.projectId,
                        }
                      : {})}
                  />
                ))}
              </ol>
            )
          }
        </LoadState>
      </Stack>
    </Card>
  );
}

function DecisionEntry({
  d,
  onChange,
  project,
}: {
  d: Decision;
  onChange: (d: Decision) => void;
  /** Shown on the all-projects log. */
  project?: string;
}) {
  const api = useApi();
  const report = useReportError();
  const { dispatch } = useStore();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState(d.recommendation?.value ?? "");
  const [rejectReason, setRejectReason] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [note, setNote] = useState("");
  const [, setUnlockTick] = useState(0);

  const run = (fn: () => Promise<Decision>, done: string, after?: () => void) => {
    setBusy(true);
    fn()
      .then((next) => {
        onChange(next);
        after?.();
        dispatch({ type: "notice", notice: { kind: "info", text: done } });
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const subject = d.subject ?? { kind: "", id: "", label: "" };
  const recommended = d.recommendation?.value ?? "";
  const editable = d.type === "spec.answer";
  const changed = editable && value !== recommended;
  const gated = acceptNeedsApproval(d.type);
  const locked = gated && !api.hasApprovalSession();
  const pending = d.status === "pending";
  const canRollback = d.reversible && APPLIED.includes(d.status);
  const name = subject.label || subject.id;

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Cluster gap={2}>
            <Status value={d.status} domain="steward-decision" />
            <Badge>{typeLabel(d.type)}</Badge>
            {project ? <Badge tone="info">{project}</Badge> : null}
          </Cluster>
          <p className="line-clamp-2 font-medium [overflow-wrap:anywhere]">
            <OpenLink kind={subject.kind} id={subject.id} projectId={d.projectId}>
              {name}
            </OpenLink>
          </p>
          <p className="text-sm [overflow-wrap:anywhere]">
            <span className="text-muted">Recommendation:</span> {recommended}
          </p>
          <p className="text-xs text-muted">
            Confidence {pct(d.confidence)} · Mode {label(MODE_LABELS, d.mode)}
            {d.outcome ? ` · Outcome ${label(OUTCOME_LABELS, d.outcome.result)}` : ""}
            {d.outcome?.detail ? ` (${d.outcome.detail})` : ""} · {when(d.createdAt)}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconRight={open ? "chevronUp" : "chevronDown"}
          aria-expanded={open}
          aria-controls={`${id}-details`}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide details" : "Details"} <span className="sr-only">for {name}</span>
        </Button>
      </div>
      {open ? (
        <div id={`${id}-details`} className="flex flex-col gap-4 border-t border-line pt-3">
          {d.recommendation?.detail ? <p className="text-sm">{d.recommendation.detail}</p> : null}
          <div>
            <h4 className="text-sm font-semibold">Reasoning</h4>
            <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{d.reasoning}</p>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Inputs considered</h4>
            {(d.inputs ?? []).length === 0 ? (
              <Empty>None recorded.</Empty>
            ) : (
              <ul className="flex flex-col gap-1 text-sm" aria-label="Inputs considered">
                {d.inputs.map((input, i) => (
                  <li key={`${input.kind}:${input.ref}:${i}`}>
                    <Badge>{label(INPUT_LABELS, input.kind)}</Badge>{" "}
                    <OpenLink kind={input.kind} id={input.ref} projectId={d.projectId}>
                      <span className="font-mono text-xs break-all">{input.ref}</span>
                    </OpenLink>{" "}
                    {input.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(d.notes ?? []).length > 0 ? (
            <div>
              <h4 className="text-sm font-semibold">Notes</h4>
              <ul className="flex flex-col gap-1 text-sm" aria-label="Decision notes">
                {d.notes.map((n) => (
                  <li key={n.id}>
                    <span className="font-medium">{n.author}</span>: {n.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pending ? (
            <div className="flex flex-col gap-3">
              {gated ? (
                <ApprovalUnlock
                  id={`${id}-approval`}
                  onUnlocked={() => setUnlockTick((n) => n + 1)}
                />
              ) : null}
              <form
                aria-label={`Accept ${name}`}
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(
                    () =>
                      api.acceptDecision({ id: d.id, type: d.type }, changed ? value : undefined),
                    changed ? "Accepted with your change" : "Recommendation accepted",
                  );
                }}
              >
                {editable ? (
                  <Field
                    label="Answer"
                    id={`${id}-value`}
                    hint="Edit it to accept a changed answer."
                  >
                    <textarea
                      id={`${id}-value`}
                      aria-describedby={`${id}-value-hint`}
                      className={textareaClass}
                      rows={2}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </Field>
                ) : null}
                <Button
                  type="submit"
                  {...(locked
                    ? { disabledReason: "Unlock approvals with the pairing code first" }
                    : editable && !value.trim()
                      ? { disabledReason: "Enter an answer" }
                      : {})}
                  disabled={busy || locked || (editable && !value.trim())}
                >
                  {changed ? "Accept changed answer" : "Accept"}
                </Button>
              </form>
              <form
                aria-label={`Reject ${name}`}
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(
                    () => api.rejectDecision(d.id, rejectReason.trim() || undefined),
                    "Recommendation rejected",
                    () => setRejectReason(""),
                  );
                }}
              >
                <Field label="Reason for rejecting (optional)" id={`${id}-reject`}>
                  <input
                    id={`${id}-reject`}
                    className={inputClass}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={busy}>
                  Reject
                </Button>
              </form>
            </div>
          ) : null}

          {canRollback ? (
            <form
              aria-label={`Roll back ${name}`}
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!rollbackReason.trim()) return;
                run(
                  () => api.rollbackDecision(d.id, rollbackReason.trim()),
                  "Decision rolled back",
                  () => setRollbackReason(""),
                );
              }}
            >
              <Field label="Reason for rolling back" id={`${id}-rollback`}>
                <input
                  id={`${id}-rollback`}
                  className={inputClass}
                  value={rollbackReason}
                  onChange={(e) => setRollbackReason(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="danger"
                {...(!rollbackReason.trim() ? { disabledReason: "Give a reason first" } : {})}
                disabled={busy || !rollbackReason.trim()}
              >
                Roll back
              </Button>
            </form>
          ) : null}

          <form
            aria-label={`Add a note to ${name}`}
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!note.trim()) return;
              run(
                () => api.addDecisionNote(d.id, note.trim()),
                "Note added",
                () => setNote(""),
              );
            }}
          >
            <Field label="Note on this decision" id={`${id}-note`}>
              <input
                id={`${id}-note`}
                className={inputClass}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="secondary"
              {...(!note.trim() ? { disabledReason: "Write the note first" } : {})}
              disabled={busy || !note.trim()}
            >
              Add note
            </Button>
          </form>
        </div>
      ) : null}
    </li>
  );
}

function NotesFeed({ projectId }: { projectId: string | null }) {
  const api = useApi();
  const report = useReportError();
  const { state, dispatch } = useStore();
  const [tick, setTick] = useState(0);
  const notesLoad = useLoad(() => api.listStewardNotes(projectId), [api, projectId, tick]);
  const notes = notesLoad.state;
  const setNotes = notesLoad.setState;
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"project" | "global">(projectId ? "project" : "global");
  const [busy, setBusy] = useState(false);
  const noteProject = target === "project" ? (projectId ?? state.projectId) : null;

  return (
    <Card title="Notes for the steward" term="Notes for the steward">
      <Stack gap={4}>
        <form
          aria-label="Add a note for the steward"
          className="flex flex-col gap-field"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setBusy(true);
            api
              .addStewardNote(noteProject, text.trim())
              .then((note) => {
                setText("");
                setNotes((n) =>
                  n.status === "ready" ? { status: "ready", data: [note, ...n.data] } : n,
                );
                dispatch({ type: "notice", notice: { kind: "info", text: "Note added" } });
              })
              .catch(report)
              .finally(() => setBusy(false));
          }}
        >
          <Field
            label="New note"
            id="steward-note"
            hint="Guidance the steward reads before it decides, for example a rule it should follow."
          >
            <textarea
              id="steward-note"
              aria-describedby="steward-note-hint"
              className={textareaClass}
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <Field label="Applies to" id="steward-note-scope">
            <select
              id="steward-note-scope"
              className={inputClass}
              value={target}
              onChange={(e) => setTarget(e.target.value === "global" ? "global" : "project")}
            >
              <option value="project" disabled={!(projectId ?? state.projectId)}>
                This project
              </option>
              <option value="global">All projects (global)</option>
            </select>
          </Field>
          <div>
            <Button
              type="submit"
              {...(!text.trim() ? { disabledReason: "Write the note first" } : {})}
              disabled={busy || !text.trim()}
            >
              Add note
            </Button>
          </div>
        </form>
        <LoadState state={notes} what="notes" onRetry={() => setTick((t) => t + 1)}>
          {(list) =>
            list.length === 0 ? (
              <Empty>No notes yet.</Empty>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Notes">
                {list.map((n) => (
                  <li
                    key={n.id}
                    className="flex flex-col gap-1.5 rounded-md border border-line p-3 text-sm"
                  >
                    <Cluster gap={2}>
                      <Badge>{n.projectId === null ? "Global" : "Project"}</Badge>
                      {n.decisionId ? <Badge>On a decision</Badge> : null}
                    </Cluster>
                    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{n.text}</p>
                    <p className="text-xs text-muted">
                      {n.author} · {when(n.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )
          }
        </LoadState>
      </Stack>
    </Card>
  );
}
