import { useEffect, useId, useState, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import {
  acceptNeedsApproval,
  type Decision,
  type FeedbackGraphStatus,
  type StewardNote,
  type StewardStatus,
  type StewardType,
} from "../api/steward-types.js";
import { ApprovalUnlock } from "../components/ApprovalUnlock.js";
import { Badge, Button, Card, Empty, Field, inputClass, LoadState } from "../components/ui.js";
import { useApi, useReportError, useStore, type Loadable } from "../store/context.js";
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
const STATUS_TONES: Record<string, "warn" | "ok"> = {
  pending: "warn",
  accepted: "ok",
  changed: "ok",
  applied: "ok",
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
      className="text-left text-indigo-700 underline hover:text-indigo-900 dark:text-indigo-300"
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

export function AutonomyScreen() {
  const { state } = useStore();
  const [scope, setScope] = useState<"project" | "all">(state.projectId ? "project" : "all");
  const projectId = scope === "project" ? state.projectId : null;
  const project = state.projects.find((p) => p.id === state.projectId);
  return (
    <div className="space-y-4">
      <StewardPanel />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Show" id="autonomy-scope">
          <select
            id="autonomy-scope"
            className={`${inputClass} w-64`}
            value={scope}
            onChange={(e) => setScope(e.target.value === "all" ? "all" : "project")}
          >
            <option value="project" disabled={!state.projectId}>
              {project ? `This project (${project.name})` : "This project"}
            </option>
            <option value="all">All projects</option>
          </select>
        </Field>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DecisionLog projectId={projectId} />
        </div>
        <NotesFeed projectId={projectId} />
      </div>
    </div>
  );
}

function fgLine(fg: FeedbackGraphStatus | undefined): {
  text: string;
  tone: "ok" | "warn" | "neutral";
} {
  if (!fg) return { text: "Unknown", tone: "neutral" };
  if (!fg.configured) return { text: "Not configured (set it up in Settings)", tone: "neutral" };
  if (!fg.enabled) return { text: "Disabled in Settings", tone: "neutral" };
  if (fg.reachable === true)
    return { text: `Connected${fg.url ? ` to ${fg.url}` : ""}`, tone: "ok" };
  if (fg.reachable === false)
    return { text: `Unreachable${fg.error ? `: ${fg.error}` : ""}`, tone: "warn" };
  return { text: "Not checked yet", tone: "neutral" };
}

function StewardPanel() {
  const api = useApi();
  const report = useReportError();
  const [status, setStatus] = useState<Loadable<StewardStatus>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [, setUnlockTick] = useState(0);

  useEffect(() => {
    let live = true;
    setStatus({ status: "loading" });
    api.stewardStatus().then(
      (data) => live && setStatus({ status: "ready", data }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) report(e);
        setStatus({ status: "error", error: message(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [api, tick]);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch(report)
      .finally(() => setBusy(false));
  };
  const setTypes = (types: StewardType[]) =>
    setStatus((s) => (s.status === "ready" ? { status: "ready", data: { ...s.data, types } } : s));

  return (
    <Card title="Steward">
      <LoadState state={status} what="steward status" onRetry={() => setTick((t) => t + 1)}>
        {(s) => {
          const fg = fgLine(s.feedbackGraph);
          const unlocked = api.hasApprovalSession();
          return (
            <>
              <div
                className="flex flex-wrap items-center gap-3 text-sm"
                aria-label="Steward status"
              >
                <span>
                  Steward:{" "}
                  <Badge tone={s.running ? "ok" : "warn"}>{s.running ? "Running" : "Paused"}</Badge>
                </span>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const next = s.running ? await api.pauseSteward() : await api.resumeSteward();
                      setStatus({ status: "ready", data: next });
                    })
                  }
                >
                  {s.running ? "Pause" : "Resume"}
                </Button>
                <span>
                  Feedback Graph: <Badge tone={fg.tone}>{fg.text}</Badge>
                </span>
              </div>
              <h3 className="font-semibold">Decision types</h3>
              <p className="text-sm">
                Every type starts by recommending; you accept, change or reject. Switch a type to
                automatic once its track record is good. Approvals are never automatic. Changing a
                mode needs the approval pairing code.
              </p>
              <ApprovalUnlock
                id="steward-mode-approval"
                onUnlocked={() => setUnlockTick((n) => n + 1)}
              />
              {s.types.length === 0 ? (
                <Empty>The steward reports no decision types.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th scope="col">Type</th>
                        <th scope="col">Mode</th>
                        <th scope="col">Accepted</th>
                        <th scope="col">Changed</th>
                        <th scope="col">Rejected</th>
                        <th scope="col">Rolled back</th>
                        <th scope="col">Auto-applied</th>
                        <th scope="col">Accuracy</th>
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
            </>
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
    <tr className="border-t border-slate-200 align-top dark:border-slate-700">
      <th scope="row" className="py-2 pr-2 font-medium">
        {typeLabel(t.type)}
      </th>
      <td className="py-2 pr-2">
        <label htmlFor={id} className="sr-only">
          Mode for {typeLabel(t.type)}
        </label>
        <select
          id={id}
          className={inputClass}
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
          <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600 dark:text-slate-300">
            Auto is not available: this is an approval, which always needs you.
          </p>
        )}
      </td>
      <td className="py-2 pr-2">{stats.accepted ?? 0}</td>
      <td className="py-2 pr-2">{stats.changed ?? 0}</td>
      <td className="py-2 pr-2">{stats.rejected ?? 0}</td>
      <td className="py-2 pr-2">{stats.rolledBack ?? 0}</td>
      <td className="py-2 pr-2">{stats.autoApplied ?? 0}</td>
      <td className="py-2 pr-2">{pct(stats.accuracy)}</td>
    </tr>
  );
}

function DecisionLog({ projectId }: { projectId: string | null }) {
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
    <Card title="Decision log">
      <div className="flex flex-wrap gap-2">
        <Field label="Type" id="decision-type-filter">
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
      </div>
      {refreshError && log.status === "ready" ? (
        <p className="text-xs text-red-800 dark:text-red-300">Could not refresh: {refreshError}</p>
      ) : null}
      <LoadState state={log} what="decisions" onRetry={() => setTick((t) => t + 1)}>
        {(decisions) =>
          decisions.length === 0 ? (
            <Empty>No decisions match.</Empty>
          ) : (
            <ol className="space-y-2" aria-label="Decisions">
              {decisions.map((d) => (
                <DecisionEntry key={d.id} d={d} onChange={replace} />
              ))}
            </ol>
          )
        }
      </LoadState>
    </Card>
  );
}

function DecisionEntry({ d, onChange }: { d: Decision; onChange: (d: Decision) => void }) {
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
    <li className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="font-medium">
            <OpenLink kind={subject.kind} id={subject.id} projectId={d.projectId}>
              {name}
            </OpenLink>{" "}
            <Badge>{typeLabel(d.type)}</Badge>{" "}
            <Badge tone={STATUS_TONES[d.status] ?? "neutral"}>
              {label(STATUS_LABELS, d.status)}
            </Badge>
          </p>
          <p className="text-sm">
            <span className="font-semibold">Recommendation:</span> {recommended}
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Confidence {pct(d.confidence)} · Mode {label(MODE_LABELS, d.mode)}
            {d.outcome ? ` · Outcome ${label(OUTCOME_LABELS, d.outcome.result)}` : ""}
            {d.outcome?.detail ? ` (${d.outcome.detail})` : ""} · {when(d.createdAt)}
          </p>
        </div>
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-controls={`${id}-details`}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide details" : "Details"} <span className="sr-only">for {name}</span>
        </Button>
      </div>
      {open ? (
        <div
          id={`${id}-details`}
          className="space-y-3 border-t border-slate-200 pt-2 dark:border-slate-700"
        >
          {d.recommendation?.detail ? <p className="text-sm">{d.recommendation.detail}</p> : null}
          <div>
            <h4 className="text-sm font-semibold">Reasoning</h4>
            <p className="whitespace-pre-wrap text-sm">{d.reasoning}</p>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Inputs considered</h4>
            {(d.inputs ?? []).length === 0 ? (
              <Empty>None recorded.</Empty>
            ) : (
              <ul className="space-y-1 text-sm" aria-label="Inputs considered">
                {d.inputs.map((input, i) => (
                  <li key={`${input.kind}:${input.ref}:${i}`}>
                    <Badge>{label(INPUT_LABELS, input.kind)}</Badge>{" "}
                    <OpenLink kind={input.kind} id={input.ref} projectId={d.projectId}>
                      <span className="font-mono text-xs">{input.ref}</span>
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
              <ul className="space-y-1 text-sm" aria-label="Decision notes">
                {d.notes.map((n) => (
                  <li key={n.id}>
                    <span className="font-medium">{n.author}</span>: {n.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {pending ? (
            <div className="space-y-2">
              {gated ? (
                <ApprovalUnlock
                  id={`${id}-approval`}
                  onUnlocked={() => setUnlockTick((n) => n + 1)}
                />
              ) : null}
              <form
                aria-label={`Accept ${name}`}
                className="space-y-2"
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
                      className={inputClass}
                      rows={2}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </Field>
                ) : null}
                <Button type="submit" disabled={busy || locked || (editable && !value.trim())}>
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
              <Button type="submit" variant="danger" disabled={busy || !rollbackReason.trim()}>
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
            <Button type="submit" variant="secondary" disabled={busy || !note.trim()}>
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
  const [notes, setNotes] = useState<Loadable<StewardNote[]>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"project" | "global">(projectId ? "project" : "global");
  const [busy, setBusy] = useState(false);
  const noteProject = target === "project" ? (projectId ?? state.projectId) : null;

  useEffect(() => {
    let live = true;
    setNotes({ status: "loading" });
    api.listStewardNotes(projectId).then(
      (data) => live && setNotes({ status: "ready", data }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) report(e);
        setNotes({ status: "error", error: message(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [api, projectId, tick]);

  return (
    <Card title="Notes for the steward">
      <form
        aria-label="Add a note for the steward"
        className="space-y-2"
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
            className={inputClass}
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
        <Button type="submit" disabled={busy || !text.trim()}>
          Add note
        </Button>
      </form>
      <LoadState state={notes} what="notes" onRetry={() => setTick((t) => t + 1)}>
        {(list) =>
          list.length === 0 ? (
            <Empty>No notes yet.</Empty>
          ) : (
            <ul className="space-y-2" aria-label="Notes">
              {list.map((n) => (
                <li
                  key={n.id}
                  className="rounded border border-slate-200 p-2 text-sm dark:border-slate-700"
                >
                  <p>
                    <Badge>{n.projectId === null ? "Global" : "Project"}</Badge>{" "}
                    {n.decisionId ? <Badge>On a decision</Badge> : null}
                  </p>
                  <p className="whitespace-pre-wrap">{n.text}</p>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {n.author} · {when(n.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )
        }
      </LoadState>
    </Card>
  );
}
