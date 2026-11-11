import { useEffect, useState, type ReactNode } from "react";
import {
  Button,
  Card,
  Field,
  Input,
  Option,
  Select,
  StatusBadge,
  Textarea,
} from "../components/ui";
import { RecordRow } from "../components/factory";
import { actionBlock } from "./workflowState";
import {
  DECISION_STATUSES,
  DECISION_TYPES,
  STEWARD_MODES,
  acceptBody,
  acceptIsApproval,
  clearLinkBlock,
  confidenceLabel,
  decisionQuery,
  entryActions,
  feedbackGraphSummary,
  filterDecisions,
  filterNotes,
  linkBlock,
  linkLabel,
  modeBlock,
  modeLabel,
  runningLabel,
  statusLabel,
  trackRecord,
  typeLabel,
} from "./autonomyState";
type R = Record<string, any>;
type Propose = (action: string, id: string, body?: R, extra?: R) => void;
type Api = (path: string) => Promise<R>;

const when = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : "not reported");
/** The visible reason under a disabled control, as elsewhere in Heimdall. */
const Why = ({ children }: { children: string }) =>
  children ? <p className="muted">{children}</p> : null;
const errorOf = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : "";

export function Autonomy({
  api,
  session,
  propose,
  reloadKey,
  projectIds,
  projectName,
  sindriProjects,
}: {
  api: Api;
  session: R;
  propose: Propose;
  /** Changes after every confirmed command, so the page reads Sindri again. */
  reloadKey: number;
  /** Sindri projects in the app's project selection; null for all projects. */
  projectIds: string[] | null;
  projectName: string;
  sindriProjects: R[];
}) {
  const [status, setStatus] = useState<R | null>(null),
    [decisions, setDecisions] = useState<R[] | null>(null),
    [notes, setNotes] = useState<R[]>([]),
    [current, setCurrent] = useState<R | null>(null),
    [errors, setErrors] = useState<string[]>([]),
    [updated, setUpdated] = useState(""),
    [type, setType] = useState(""),
    [state, setState] = useState(""),
    [selectedId, setSelectedId] = useState(""),
    [version, setVersion] = useState(0),
    [answer, setAnswer] = useState<string | null>(null),
    [decisionNote, setDecisionNote] = useState(""),
    [note, setNote] = useState(""),
    [noteTarget, setNoteTarget] = useState("global");
  const filter = { projectIds, type, status: state };
  const query = decisionQuery(filter);
  const scope = projectIds?.join(",") ?? "";
  useEffect(() => {
    let closed = false,
      busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const results = await Promise.allSettled([
          api("details/steward/status"),
          api(query),
          api("details/steward/notes" + (projectIds?.length === 1 ? "?projectId=" + encodeURIComponent(projectIds[0]) : "")),
          selectedId ? api("details/steward/decisions/" + encodeURIComponent(selectedId)) : Promise.resolve(null),
        ]);
        if (closed) return;
        const [s, d, n, one] = results;
        if (s.status === "fulfilled") setStatus(s.value);
        if (d.status === "fulfilled") setDecisions(d.value.decisions ?? []);
        if (n.status === "fulfilled") setNotes(n.value.notes ?? []);
        setCurrent(one.status === "fulfilled" ? (one.value?.decision ?? null) : null);
        setErrors(results.map(errorOf).filter(Boolean));
        setUpdated(new Date().toLocaleTimeString());
      } finally {
        busy = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [api, query, scope, selectedId, reloadKey, version]);
  // A confirmed command consumed what was typed.
  useEffect(() => {
    setNote("");
    setDecisionNote("");
    setAnswer(null);
  }, [reloadKey]);
  useEffect(() => {
    setAnswer(null);
    setDecisionNote("");
  }, [selectedId]);
  useEffect(() => {
    if (noteTarget !== "global" && !projectIds?.includes(noteTarget) && projectIds !== null) setNoteTarget("global");
  }, [scope]);

  const shown = filterDecisions(decisions ?? [], filter);
  const detail = current?.id === selectedId ? current : (decisions ?? []).find((d) => d.id === selectedId) ?? null;
  const projectLabel = (id: unknown) =>
    id == null ? "All projects" : (sindriProjects.find((p) => p.id === id)?.name ?? String(id));
  const running = runningLabel(status);
  const pauseWhy = actionBlock("steward.pause", undefined, session);
  const types: R[] = Array.isArray(status?.types) ? status!.types : [];
  const seenTypes = [...new Set([...DECISION_TYPES, ...types.map((t) => String(t.type)), ...(decisions ?? []).map((d) => String(d.type))])];
  const noteProjects = sindriProjects.filter((p) => !projectIds || projectIds.includes(p.id));
  const noteWhy =
    actionBlock("steward.globalNote", undefined, session) || (note.trim() ? "" : "Write the note first.");

  return (
    <div className="grid gap-6 min-w-0 fleet-page autonomy-page">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="muted">
          The steward recommends decisions for the factory and, per type, may apply them on its own.
          Showing {projectName}; change it with the project filter at the top. Last observed {updated || "—"}.
        </p>
        <Button onClick={() => setVersion((v) => v + 1)}>Refresh autonomy</Button>
      </div>
      {errors.map((error, i) => (
        <Card key={i}>
          <p role="status" className="warning">
            Sindri did not answer: {error}
          </p>
        </Card>
      ))}
      <Card aria-labelledby="steward-heading">
        <div className="section-title">
          <h2 id="steward-heading">Steward</h2>
          <StatusBadge value={running ?? (status ? String(status.running) : "not reported")} />
        </div>
        <p>
          {running === "running"
            ? "The steward is looking at new work and recording decisions."
            : running === "paused"
              ? "The steward is paused: it records no new decisions until resumed."
              : "Sindri has not reported whether the steward runs."}
        </p>
        <div className="actions">
          {running === "paused" ? (
            <Button
              disabled={!!pauseWhy}
              title={pauseWhy || undefined}
              onClick={() => propose("steward.resume", "steward")}
            >
              Resume steward
            </Button>
          ) : (
            <Button
              disabled={!!pauseWhy || running === null}
              title={pauseWhy || undefined}
              onClick={() => propose("steward.pause", "steward")}
            >
              Pause steward
            </Button>
          )}
        </div>
        <Why>{pauseWhy}</Why>
      </Card>
      <Card aria-labelledby="types-heading">
        <h2 id="types-heading">Decision types</h2>
        <p className="muted">
          Each type starts as a recommendation you accept, change or reject. Switch a type to
          automatic once its track record is good. Approvals are never automatic.
        </p>
        {!types.length && <p className="empty">No decision types reported yet.</p>}
        {types.map((row) => (
          <ModeRow key={String(row.type)} row={row} session={session} propose={propose} />
        ))}
      </Card>
      <section className="grid gap-4 md:grid-cols-2">
        <Card aria-labelledby="log-heading">
          <div className="section-title">
            <h2 id="log-heading">Decision log</h2>
            <span>{decisions === null ? "Loading…" : `${shown.length} shown`}</span>
          </div>
          <div className="form-grid">
            <Field>
              Decision type
              <Select value={type} onValueChange={setType}>
                <Option value="">All types</Option>
                {seenTypes.map((t) => (
                  <Option key={t} value={t}>
                    {typeLabel(t)}
                  </Option>
                ))}
              </Select>
            </Field>
            <Field>
              Decision status
              <Select value={state} onValueChange={setState}>
                <Option value="">All statuses</Option>
                {DECISION_STATUSES.map((t) => (
                  <Option key={t} value={t}>
                    {statusLabel(t)}
                  </Option>
                ))}
              </Select>
            </Field>
          </div>
          {shown.length ? (
            <div className="rows" aria-label="Decisions">
              {shown.map((d) => (
                <RecordRow
                  key={d.id}
                  title={`${typeLabel(d.type)} · ${d.subject?.label ?? d.subject?.id ?? d.id}`}
                  description={`${statusLabel(d.status)} · ${modeLabel(d.mode)} · confidence ${confidenceLabel(d.confidence)} · ${projectLabel(d.projectId)} · ${when(d.createdAt)}`}
                  status={d.status}
                  onClick={() => setSelectedId(d.id)}
                />
              ))}
            </div>
          ) : (
            <p className="empty">{decisions === null ? "Loading decisions…" : "No decisions match these filters."}</p>
          )}
        </Card>
        <Card aria-labelledby="decision-heading">
          <h2 id="decision-heading">Decision detail</h2>
          {detail ? (
            <DecisionDetail
              d={detail}
              session={session}
              propose={propose}
              answer={answer}
              setAnswer={setAnswer}
              note={decisionNote}
              setNote={setDecisionNote}
              projectLabel={projectLabel}
            />
          ) : (
            <p className="empty">Select a decision to see its reasoning, inputs and actions.</p>
          )}
        </Card>
      </section>
      <Card aria-labelledby="notes-heading">
        <h2 id="notes-heading">Notes for the steward</h2>
        <p className="muted">
          Notes are guidance the steward retrieves for later decisions: for one project, or for all
          projects.
        </p>
        <div className="form-grid">
          <Field>
            Note applies to
            <Select value={noteTarget} onValueChange={setNoteTarget}>
              <Option value="global">All projects (global)</Option>
              {noteProjects.map((p) => (
                <Option key={p.id} value={p.id}>
                  {p.name ?? p.id}
                </Option>
              ))}
            </Select>
          </Field>
        </div>
        <Field>
          New note
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="actions">
          <Button
            disabled={!!noteWhy}
            title={noteWhy || undefined}
            onClick={() =>
              propose("steward.globalNote", "notes", {
                projectId: noteTarget === "global" ? null : noteTarget,
                text: note.trim(),
              })
            }
          >
            Review note
          </Button>
        </div>
        <Why>{noteWhy}</Why>
        <NoteList notes={filterNotes(notes, projectIds)} projectLabel={projectLabel} empty="No notes yet." />
      </Card>
    </div>
  );
}

function ModeRow({ row, session, propose }: { row: R; session: R; propose: Propose }) {
  const record = trackRecord(row.stats);
  const known = (STEWARD_MODES as readonly string[]).includes(row.mode);
  const reasons = STEWARD_MODES.map((mode) => modeBlock(row, mode, session)).filter(
    (r) => r && !r.startsWith("Already"),
  );
  return (
    <fieldset className="steward-type">
      <legend>
        {typeLabel(row.type)} <code>{String(row.type)}</code>
      </legend>
      <p>
        Mode <StatusBadge value={known ? modeLabel(row.mode) : String(row.mode ?? "not reported")} />
      </p>
      <div className="actions" role="group" aria-label={`Mode for ${typeLabel(row.type)}`}>
        {STEWARD_MODES.map((mode) => {
          const why = modeBlock(row, mode, session);
          return (
            <Button
              key={mode}
              aria-pressed={row.mode === mode}
              disabled={!!why}
              title={why || undefined}
              onClick={() => propose("steward.mode", "modes", { type: row.type, mode })}
            >
              {modeLabel(mode)}
            </Button>
          );
        })}
      </div>
      <Why>{[...new Set(reasons)].join(" ")}</Why>
      <div className="facts">
        <div>
          <small>Decided</small>
          {record.decided}
        </div>
        <div>
          <small>Accuracy</small>
          {record.accuracy}
        </div>
        <div>
          <small>Accepted / changed / rejected</small>
          {record.accepted} / {record.changed} / {record.rejected}
        </div>
        <div>
          <small>Rolled back / applied automatically</small>
          {record.rolledBack} / {record.autoApplied}
        </div>
      </div>
    </fieldset>
  );
}

function DecisionDetail({
  d,
  session,
  propose,
  answer,
  setAnswer,
  note,
  setNote,
  projectLabel,
}: {
  d: R;
  session: R;
  propose: Propose;
  answer: string | null;
  setAnswer: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  projectLabel: (id: unknown) => string;
}) {
  const can = entryActions(d, session);
  const approval = acceptIsApproval(d.type);
  const editable = d.type === "spec.answer";
  const shownAnswer = answer ?? String(d.recommendation?.value ?? "");
  const noteWhy = can.note || (note.trim() ? "" : "Write the note first.");
  const inputs: R[] = Array.isArray(d.inputs) ? d.inputs : [];
  const facts: [string, ReactNode][] = [
    ["Type", `${typeLabel(d.type)} (${d.type})`],
    ["Subject", `${d.subject?.label ?? "—"} · ${d.subject?.kind ?? "?"} ${d.subject?.id ?? ""}`],
    ["Project", projectLabel(d.projectId)],
    ["Mode", modeLabel(d.mode)],
    ["Confidence", confidenceLabel(d.confidence)],
    ["Reversible", d.reversible === true ? "Yes" : "No"],
    ["Created", when(d.createdAt)],
    ["Decided", when(d.decidedAt)],
    ["Outcome", d.outcome ? `${d.outcome.result}${d.outcome.detail ? ": " + d.outcome.detail : ""}` : "Not known yet"],
  ];
  return (
    <div className="decision-detail" aria-label="Selected decision">
      <p>
        <StatusBadge value={d.status} /> <span>{statusLabel(d.status)}</span> <span className="id">{d.id}</span>
      </p>
      <h3>Recommendation</h3>
      <p className="multiline">{String(d.recommendation?.value ?? "—")}</p>
      {d.recommendation?.detail && <p className="muted multiline">{String(d.recommendation.detail)}</p>}
      <h3>Reasoning</h3>
      <p className="multiline">{String(d.reasoning ?? "—")}</p>
      <div className="facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <small>{k}</small>
            {v}
          </div>
        ))}
      </div>
      <h3>What it looked at</h3>
      {inputs.length ? (
        <ul className="decision-inputs">
          {inputs.map((x, i) => (
            <li key={i}>
              <StatusBadge value={x.kind} /> <code>{String(x.ref ?? "")}</code> {String(x.summary ?? "")}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No inputs recorded.</p>
      )}
      <h3>Act on it</h3>
      {approval && (
        <p className="warning">
          Accepting this recommendation performs the approval itself, with Sindri's human approval check.
        </p>
      )}
      {editable && (
        <Field>
          Answer to send
          <Textarea value={shownAnswer} disabled={!!can.accept} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
      )}
      <div className="actions">
        <Button
          disabled={!!can.accept || (editable && !shownAnswer.trim())}
          title={can.accept || undefined}
          onClick={() =>
            propose("steward.accept", d.id, acceptBody(d, editable ? shownAnswer : null), { decisionType: d.type })
          }
        >
          {approval ? "Accept and approve" : editable && Object.keys(acceptBody(d, shownAnswer)).length ? "Accept with my answer" : "Accept"}
        </Button>
        <Button
          disabled={!!can.reject}
          title={can.reject || undefined}
          onClick={() => propose("steward.reject", d.id, { reason: "" })}
        >
          Reject
        </Button>
        <Button
          disabled={!!can.rollback}
          title={can.rollback || undefined}
          onClick={() => propose("steward.rollback", d.id, { reason: "" })}
        >
          Roll back
        </Button>
      </div>
      <Why>{[...new Set([can.accept, can.rollback].filter(Boolean))].join(" ")}</Why>
      <p className="muted">Rejecting or rolling back records your audit reason as the reason.</p>
      <h3>Notes on this decision</h3>
      <NoteList notes={Array.isArray(d.notes) ? d.notes : []} projectLabel={projectLabel} empty="No notes on this decision." />
      <Field>
        Note on this decision
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="actions">
        <Button
          disabled={!!noteWhy}
          title={noteWhy || undefined}
          onClick={() => propose("steward.note", d.id, { text: note.trim() })}
        >
          Add note
        </Button>
      </div>
      <Why>{noteWhy}</Why>
    </div>
  );
}

function NoteList({ notes, projectLabel, empty }: { notes: R[]; projectLabel: (id: unknown) => string; empty: string }) {
  if (!notes.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="steward-notes" aria-label="Notes">
      {notes.map((n, i) => (
        <li key={n.id ?? i}>
          <p className="multiline">{String(n.text ?? "")}</p>
          <small className="muted">
            {String(n.author ?? "unknown")} · {projectLabel(n.projectId)} · {when(n.createdAt)}
          </small>
        </li>
      ))}
    </ul>
  );
}

/** Sindri's Feedback Graph status, for the Connections page. */
export function FeedbackGraphStatus({ api }: { api: Api }) {
  const [status, setStatus] = useState<R | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    api("details/feedback-graph")
      .then((s) => !gone && (setStatus(s), setError("")))
      .catch((e) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
  }, [api]);
  const summary = feedbackGraphSummary(status);
  return (
    <Card className="panel">
      <div className="section-title">
        <h2>Feedback Graph</h2>
        <StatusBadge value={error ? "unavailable" : summary.badge} />
      </div>
      <p>{error ? `Sindri did not report Feedback Graph status: ${error}` : summary.text}</p>
      <p className="muted">
        Read through Sindri, read-only: lessons from your past feedback inform planning and the
        steward. Nothing is written back.
      </p>
    </Card>
  );
}

/** Feedback Graph link and lessons for one project, in the project inspector. */
export function FeedbackGraphSection({
  sindriProject,
  session,
  propose,
  api,
  reloadKey,
}: {
  sindriProject: R | undefined;
  session: R;
  propose: Propose;
  api: Api;
  reloadKey: number;
}) {
  const id: string | undefined = sindriProject?.id;
  const [data, setData] = useState<R | null>(null),
    [error, setError] = useState(""),
    [key, setKey] = useState("");
  useEffect(() => {
    if (!id) return;
    let gone = false;
    setError("");
    api("details/feedback-graph/" + id)
      .then((d) => {
        if (gone) return;
        setData(d);
        setKey("");
      })
      .catch((e) => !gone && (setData(null), setError(e.message)));
    return () => {
      gone = true;
    };
  }, [id, reloadKey]);
  if (!id)
    return (
      <>
        <h3>Feedback Graph</h3>
        <p className="muted">Lessons need the project registered in Sindri.</p>
      </>
    );
  const link: R | null = data?.link ?? null;
  const lessons: R[] = Array.isArray(data?.lessons) ? data!.lessons : [];
  const setWhy = linkBlock(key, link, session);
  const clearWhy = clearLinkBlock(link, session);
  return (
    <section aria-labelledby="fg-heading" className="feedback-graph">
      <h3 id="fg-heading">Feedback Graph</h3>
      {error && (
        <p role="alert" className="warning">
          The Feedback Graph link could not be read: {error}
        </p>
      )}
      {link && (
        <p>
          <StatusBadge value={link.source} /> {linkLabel(link.source)}
          {link.projectKey ? (
            <>
              : <code>{String(link.projectKey)}</code>
            </>
          ) : (
            "."
          )}
        </p>
      )}
      {data?.error && <p className="warning">Feedback Graph: {String(data.error)}</p>}
      <Field>
        Feedback Graph project key
        <Input value={key} placeholder={link?.projectKey ?? "project key"} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <div className="actions">
        <Button
          disabled={!!setWhy}
          title={setWhy || undefined}
          onClick={() => propose("project.feedbackGraph", id, { projectKey: key.trim() })}
        >
          Review link override
        </Button>
        <Button
          disabled={!!clearWhy}
          title={clearWhy || undefined}
          onClick={() => propose("project.feedbackGraph", id, { projectKey: null })}
        >
          Clear override
        </Button>
      </div>
      <Why>{[...new Set([setWhy, clearWhy].filter(Boolean))].join(" ")}</Why>
      <h4>Approved lessons ({lessons.length})</h4>
      {lessons.length ? (
        <ul className="fg-lessons" aria-label="Feedback Graph lessons">
          {lessons.map((l, i) => (
            <li key={l.id ?? i}>
              <strong>{String(l.title || l.id)}</strong> <StatusBadge value={l.status} />
              <p className="multiline">{String(l.rule ?? "")}</p>
              {l.appliesWhen && <p className="muted">Applies when: {String(l.appliesWhen)}</p>}
              {Array.isArray(l.paths) && l.paths.length > 0 && (
                <p className="muted">Paths: {l.paths.map(String).join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{link?.projectKey ? "No approved lessons for this project." : "Link a Feedback Graph project to see its lessons."}</p>
      )}
    </section>
  );
}
