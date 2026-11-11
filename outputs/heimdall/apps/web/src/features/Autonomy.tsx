// The steward on two pages: Autonomy (decision log, decision detail and notes for the selected
// project) and Autonomy (all) (steward state, per-type modes, Feedback Graph status). Plus the
// Feedback Graph pieces Connections and the project inspector reuse. Sindri stays authoritative.
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Cluster,
  DataTable,
  EmptyState,
  Field,
  Id,
  InfoHint,
  Input,
  KeyValue,
  Page,
  PageHeader,
  RecordList,
  RecordRow,
  SegmentedControl,
  Select,
  SplitView,
  Stack,
  Textarea,
  Timestamp,
  Toolbar,
  type Column,
} from "@factory/ui";
import { useHeimdall } from "../app/context";
import { LearnMore, Reasons, Status } from "../components/app";
import type { R } from "../lib/api";
import { AccessCallout, ownReasons } from "./AccessCallout";
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
  modeBlock,
  modeLabel,
  runningLabel,
  statusLabel,
  stewardProjects,
  trackRecord,
  typeLabel,
} from "./autonomyState";

const errorOf = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected"
    ? String((r.reason as Error)?.message ?? r.reason)
    : "";
const At = ({ value }: { value: unknown }) =>
  value ? (
    <Timestamp value={String(value)} />
  ) : (
    <span className="text-muted">Not reported</span>
  );
/** Header with a glossary hint; give the column a string `label` too, for the stacked phone layout. */
const termHeader = (text: string, term: string) => (
  <span className="inline-flex items-center gap-1">
    {text} <InfoHint term={term} />
  </span>
);
const SindriErrors = ({ errors }: { errors: string[] }) =>
  errors.map((error, i) => (
    <Callout key={i} tone="danger" title="Sindri did not answer">
      {error}
    </Callout>
  ));

/** Top-bar page: the steward's decisions and notes for the selected project. */
export function AutonomyPage() {
  const { api, session, propose, reloadKey, scope, projectName } =
    useHeimdall();
  const projectIds = stewardProjects(scope.filter, scope.sindriProjects);
  const sindriProjects = scope.sindriProjects;
  const [status, setStatus] = useState<R | null>(null),
    [decisions, setDecisions] = useState<R[] | null>(null),
    [notes, setNotes] = useState<R[]>([]),
    [current, setCurrent] = useState<R | null>(null),
    [errors, setErrors] = useState<string[]>([]),
    [updated, setUpdated] = useState<Date | null>(null),
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
  const scopeKey = projectIds?.join(",") ?? "";
  // Polls every 5 s; the open decision is read on its own so its notes and outcome stay current.
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
          api(
            "details/steward/notes" +
              (projectIds?.length === 1
                ? "?projectId=" + encodeURIComponent(projectIds[0])
                : ""),
          ),
          selectedId
            ? api("details/steward/decisions/" + encodeURIComponent(selectedId))
            : Promise.resolve(null),
        ]);
        if (closed) return;
        const [s, d, n, one] = results;
        if (s.status === "fulfilled") setStatus(s.value);
        if (d.status === "fulfilled") setDecisions(d.value.decisions ?? []);
        if (n.status === "fulfilled") setNotes(n.value.notes ?? []);
        setCurrent(
          one.status === "fulfilled" ? (one.value?.decision ?? null) : null,
        );
        setErrors(results.map(errorOf).filter(Boolean));
        setUpdated(new Date());
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
  }, [api, query, scopeKey, selectedId, reloadKey, version]);
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
    if (
      noteTarget !== "global" &&
      projectIds !== null &&
      !projectIds.includes(noteTarget)
    )
      setNoteTarget("global");
  }, [scopeKey]);

  const shown = filterDecisions(decisions ?? [], filter);
  const detail =
    current?.id === selectedId
      ? current
      : ((decisions ?? []).find((d) => d.id === selectedId) ?? null);
  const projectLabel = (id: unknown) =>
    id == null
      ? "All projects"
      : (sindriProjects.find((p) => p.id === id)?.name ?? String(id));
  const types: R[] = Array.isArray(status?.types) ? status!.types : [];
  const seenTypes = [
    ...new Set([
      ...DECISION_TYPES,
      ...types.map((t) => String(t.type)),
      ...(decisions ?? []).map((d) => String(d.type)),
    ]),
  ];
  const noteProjects = sindriProjects.filter(
    (p) => !projectIds || projectIds.includes(p.id),
  );
  const noteWhy =
    actionBlock("steward.globalNote", undefined, session) ||
    (note.trim() ? "" : "Write the note first.");

  const log = (
    <Card
      title="Decision log"
      term="Recommendation"
      description={decisions === null ? "Loading…" : `${shown.length} shown`}
      flush
    >
      <div className="border-b border-line p-4">
        <Toolbar label="Decision filters">
          <Field
            label="Decision type"
            term="Decision type"
            className="min-w-0 sm:w-56"
          >
            <Select
              value={type}
              onValueChange={setType}
              options={[
                { value: "", label: "All types" },
                ...seenTypes.map((t) => ({ value: t, label: typeLabel(t) })),
              ]}
            />
          </Field>
          <Field label="Decision status" className="min-w-0 sm:w-56">
            <Select
              value={state}
              onValueChange={setState}
              options={[
                { value: "", label: "All statuses" },
                ...DECISION_STATUSES.map((t) => ({
                  value: t,
                  label: statusLabel(t),
                })),
              ]}
            />
          </Field>
        </Toolbar>
      </div>
      {shown.length ? (
        <RecordList label="Decisions">
          {shown.map((d) => (
            <RecordRow
              key={d.id}
              selected={d.id === selectedId}
              title={`${typeLabel(d.type)} · ${d.subject?.label ?? d.subject?.id ?? d.id}`}
              meta={
                <>
                  {modeLabel(d.mode)} · confidence{" "}
                  {confidenceLabel(d.confidence)} · {projectLabel(d.projectId)}
                  {d.createdAt && (
                    <>
                      {" · "}
                      <Timestamp value={String(d.createdAt)} />
                    </>
                  )}
                </>
              }
              status={
                <Status
                  value={d.status}
                  domain="steward-decision"
                  size="sm"
                  tooltip={false}
                />
              }
              onClick={() => setSelectedId(d.id)}
            />
          ))}
        </RecordList>
      ) : (
        <EmptyState
          compact
          className="m-4"
          title={
            decisions === null
              ? "Loading decisions…"
              : "No decisions match these filters."
          }
          body={
            decisions === null
              ? undefined
              : "The steward records a decision when new work needs one."
          }
          action={
            (type || state) && (
              <Button
                size="sm"
                onClick={() => {
                  setType("");
                  setState("");
                }}
              >
                Clear filters
              </Button>
            )
          }
        />
      )}
    </Card>
  );

  return (
    <Page>
      <PageHeader
        title="Autonomy"
        description={
          <>
            What the steward recommended or decided for this project, and the
            notes it learns from.
          </>
        }
        learnMore={<LearnMore screen="autonomy" />}
        term="Steward"
        scope={{ project: projectName }}
        meta={updated && <Timestamp value={updated} prefix="Updated" />}
        actions={
          <Button onClick={() => setVersion((v) => v + 1)}>
            Refresh autonomy
          </Button>
        }
      />
      <AccessCallout pairing />
      <SindriErrors errors={errors} />
      <SplitView
        list={log}
        showDetail={!!detail}
        onBack={() => setSelectedId("")}
        backLabel="Back to the decision log"
        detail={
          <Card title="Decision detail">
            {detail ? (
              <DecisionDetail
                d={detail}
                answer={answer}
                setAnswer={setAnswer}
                note={decisionNote}
                setNote={setDecisionNote}
                projectLabel={projectLabel}
              />
            ) : (
              <EmptyState
                compact
                title="No decision selected"
                body="Select a decision in the log to see its reasoning, inputs and actions."
              />
            )}
          </Card>
        }
      />
      <Card title="Notes for the steward" term="Notes for the steward">
        <Stack gap={4}>
          <p className="text-sm text-muted">
            Guidance the steward retrieves for later decisions: for one project,
            or for all projects.
          </p>
          <Field label="Note applies to" className="sm:max-w-sm">
            <Select
              value={noteTarget}
              onValueChange={setNoteTarget}
              options={[
                { value: "global", label: "All projects (global)" },
                ...noteProjects.map((p) => ({
                  value: p.id,
                  label: p.name ?? p.id,
                })),
              ]}
            />
          </Field>
          <Field label="New note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Cluster gap={3}>
            <Button
              variant="primary"
              disabledReason={noteWhy || undefined}
              onClick={() =>
                propose("steward.globalNote", "notes", {
                  projectId: noteTarget === "global" ? null : noteTarget,
                  text: note.trim(),
                })
              }
            >
              Review note
            </Button>
            <Reasons reasons={ownReasons(noteWhy)} />
          </Cluster>
          <NoteList
            notes={filterNotes(notes, projectIds)}
            projectLabel={projectLabel}
            empty="No notes yet."
          />
        </Stack>
      </Card>
    </Page>
  );
}

function DecisionDetail({
  d,
  answer,
  setAnswer,
  note,
  setNote,
  projectLabel,
}: {
  d: R;
  answer: string | null;
  setAnswer: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  projectLabel: (id: unknown) => string;
}) {
  const { session, propose } = useHeimdall();
  const can = entryActions(d, session);
  const approval = acceptIsApproval(d.type);
  const editable = d.type === "spec.answer";
  const shownAnswer = answer ?? String(d.recommendation?.value ?? "");
  const acceptWhy =
    can.accept ||
    (editable && !shownAnswer.trim() ? "Enter the answer to send first." : "");
  const noteWhy = can.note || (note.trim() ? "" : "Write the note first.");
  const inputs: R[] = Array.isArray(d.inputs) ? d.inputs : [];
  const H = ({ children }: { children: string }) => (
    <h3 className="text-sm font-semibold text-fg">{children}</h3>
  );
  return (
    <Stack
      gap={5}
      className="decision-detail min-w-0"
      role="group"
      aria-label="Selected decision"
    >
      <Cluster gap={2}>
        <Status value={d.status} domain="steward-decision" />
        <Id value={String(d.id)} label="Decision ID" />
      </Cluster>
      <Stack gap={2}>
        <H>Recommendation</H>
        <p className="text-sm break-words whitespace-pre-wrap">
          {String(d.recommendation?.value ?? "—")}
        </p>
        {d.recommendation?.detail && (
          <p className="text-sm break-words whitespace-pre-wrap text-muted">
            {String(d.recommendation.detail)}
          </p>
        )}
      </Stack>
      <Stack gap={2}>
        <H>Reasoning</H>
        <p className="text-sm break-words whitespace-pre-wrap">
          {String(d.reasoning ?? "—")}
        </p>
      </Stack>
      <KeyValue
        items={[
          {
            label: "Type",
            term: "Decision type",
            value: (
              <span className="break-words">
                {typeLabel(d.type)}{" "}
                <code className="text-xs text-muted">{String(d.type)}</code>
              </span>
            ),
          },
          {
            label: "Subject",
            value: (
              <span className="break-words">
                {`${d.subject?.label ?? "—"} · ${d.subject?.kind ?? "?"} ${d.subject?.id ?? ""}`}
              </span>
            ),
          },
          { label: "Project", value: projectLabel(d.projectId) },
          {
            label: "Mode",
            term: "Steward mode",
            value: <Status value={d.mode} domain="steward-mode" size="sm" />,
          },
          { label: "Confidence", value: confidenceLabel(d.confidence) },
          {
            label: "Reversible",
            term: "Rollback",
            value: d.reversible === true ? "Yes" : "No",
          },
          { label: "Created", value: <At value={d.createdAt} /> },
          { label: "Decided", value: <At value={d.decidedAt} /> },
          {
            label: "Outcome",
            term: "Decision outcome",
            value: d.outcome ? (
              <span className="break-words">
                <Status
                  value={d.outcome.result}
                  domain="steward-outcome"
                  size="sm"
                />
                {d.outcome.detail ? " " + d.outcome.detail : ""}
              </span>
            ) : (
              "Not known yet"
            ),
          },
        ]}
      />
      <Stack gap={2}>
        <H>What it looked at</H>
        {inputs.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {inputs.map((x, i) => (
              <li key={i} className="min-w-0 break-words">
                <Badge>{String(x.kind ?? "input")}</Badge>{" "}
                <code className="text-xs">{String(x.ref ?? "")}</code>{" "}
                {String(x.summary ?? "")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No inputs recorded.</p>
        )}
      </Stack>
      <Stack gap={3}>
        <H>Act on it</H>
        {approval && (
          <Callout tone="warning">
            Accepting this recommendation performs the approval itself, with
            Sindri's human approval check.
          </Callout>
        )}
        {editable && (
          <Field label="Answer to send">
            <Textarea
              value={shownAnswer}
              disabled={!!can.accept}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </Field>
        )}
        <Cluster gap={2}>
          <Button
            variant="primary"
            disabledReason={acceptWhy || undefined}
            onClick={() =>
              propose(
                "steward.accept",
                d.id,
                acceptBody(d, editable ? shownAnswer : null),
                {
                  decisionType: d.type,
                },
              )
            }
          >
            {approval
              ? "Accept and approve"
              : editable && Object.keys(acceptBody(d, shownAnswer)).length
                ? "Accept with my answer"
                : "Accept"}
          </Button>
          <Button
            disabledReason={can.reject || undefined}
            onClick={() => propose("steward.reject", d.id, { reason: "" })}
          >
            Reject
          </Button>
          <Button
            disabledReason={can.rollback || undefined}
            onClick={() => propose("steward.rollback", d.id, { reason: "" })}
          >
            Roll back
          </Button>
        </Cluster>
        <Reasons reasons={ownReasons(can.accept, can.rollback)} />
        <p className="text-sm text-muted">
          Rejecting or rolling back records your audit reason as the reason.
        </p>
      </Stack>
      <Stack gap={3}>
        <H>Notes on this decision</H>
        <NoteList
          notes={Array.isArray(d.notes) ? d.notes : []}
          projectLabel={projectLabel}
          empty="No notes on this decision."
        />
        <Field label="Note on this decision">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Cluster gap={3}>
          <Button
            disabledReason={noteWhy || undefined}
            onClick={() => propose("steward.note", d.id, { text: note.trim() })}
          >
            Add note
          </Button>
          <Reasons reasons={ownReasons(noteWhy)} />
        </Cluster>
      </Stack>
    </Stack>
  );
}

function NoteList({
  notes,
  projectLabel,
  empty,
}: {
  notes: R[];
  projectLabel: (id: unknown) => string;
  empty: string;
}) {
  if (!notes.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul
      aria-label="Notes"
      className="flex flex-col divide-y divide-line rounded-md border border-line"
    >
      {notes.map((n, i) => (
        <li key={n.id ?? i} className="flex min-w-0 flex-col gap-1 px-4 py-3">
          <p className="text-sm break-words whitespace-pre-wrap">
            {String(n.text ?? "")}
          </p>
          <p className="text-xs text-muted">
            {String(n.author ?? "unknown")} · {projectLabel(n.projectId)}
            {n.createdAt && (
              <>
                {" · "}
                <Timestamp value={String(n.createdAt)} />
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Bottom-bar page: the steward itself, its per-type modes and track record, Feedback Graph. */
export function AutonomyAllPage() {
  const { api, session, propose, reloadKey } = useHeimdall();
  const [status, setStatus] = useState<R | null>(null),
    [error, setError] = useState(""),
    [updated, setUpdated] = useState<Date | null>(null),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let closed = false,
      busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const s = await api("details/steward/status");
        if (closed) return;
        setStatus(s);
        setError("");
        setUpdated(new Date());
      } catch (e) {
        if (!closed) setError((e as Error).message);
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
  }, [api, reloadKey, version]);

  const running = runningLabel(status);
  const pauseWhy =
    actionBlock("steward.pause", undefined, session) ||
    (running === null
      ? "Sindri has not reported whether the steward runs."
      : "");
  const types: R[] = Array.isArray(status?.types) ? status!.types : [];
  const columns: Column<R>[] = [
    {
      key: "type",
      header: termHeader("Type", "Decision type"),
      label: "Type",
      primary: true,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span>{typeLabel(row.type)}</span>
          <code className="text-xs font-normal break-all text-muted">
            {String(row.type)}
          </code>
        </span>
      ),
    },
    {
      key: "mode",
      header: termHeader("Mode", "Steward mode"),
      label: "Mode",
      cell: (row) => {
        const known = (STEWARD_MODES as readonly string[]).includes(row.mode);
        // "Already …" names the selected option; access reasons sit in the callout above.
        const reasons = ownReasons(
          ...STEWARD_MODES.map((mode) => modeBlock(row, mode, session)).filter(
            (r) => !r.startsWith("Already"),
          ),
        );
        return (
          <Stack gap={1} className="min-w-0">
            <SegmentedControl
              size="sm"
              label={`Mode for ${typeLabel(row.type)}`}
              value={known ? String(row.mode) : ""}
              onValueChange={(mode) =>
                propose("steward.mode", "modes", { type: row.type, mode })
              }
              options={STEWARD_MODES.map((mode) => ({
                value: mode,
                label: modeLabel(mode),
                disabled: !!modeBlock(row, mode, session),
              }))}
            />
            {!known && (
              <span className="text-xs text-muted">
                Sindri reports{" "}
                <Status
                  value={row.mode ?? "not reported"}
                  domain="steward-mode"
                  size="sm"
                />
              </span>
            )}
            <Reasons reasons={reasons} />
          </Stack>
        );
      },
    },
    {
      key: "decided",
      header: "Decided",
      align: "right",
      cell: (row) => trackRecord(row.stats).decided,
    },
    {
      key: "accuracy",
      header: termHeader("Accuracy", "Accuracy"),
      label: "Accuracy",
      align: "right",
      cell: (row) => trackRecord(row.stats).accuracy,
    },
    {
      key: "outcomes",
      header: "Accepted / changed / rejected",
      align: "right",
      cell: (row) => {
        const r = trackRecord(row.stats);
        return `${r.accepted} / ${r.changed} / ${r.rejected}`;
      },
    },
    {
      key: "rollbacks",
      header: termHeader("Rolled back / auto-applied", "Rollback"),
      label: "Rolled back / auto-applied",
      align: "right",
      cell: (row) => {
        const r = trackRecord(row.stats);
        return `${r.rolledBack} / ${r.autoApplied}`;
      },
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Autonomy (all)"
        description={
          <>
            The steward for every project: whether it runs, and how far it may
            decide each type on its own.
          </>
        }
        learnMore={<LearnMore screen="autonomy-all" />}
        term="Autonomy"
        scope={{ global: true }}
        meta={updated && <Timestamp value={updated} prefix="Updated" />}
        actions={
          <Button onClick={() => setVersion((v) => v + 1)}>
            Refresh autonomy
          </Button>
        }
      />
      <AccessCallout pairing />
      <SindriErrors errors={error ? [error] : []} />
      <Card
        title="Steward"
        term="Steward"
        actions={
          <Status
            value={
              running ?? (status ? String(status.running) : "not reported")
            }
            domain="steward-state"
          />
        }
      >
        <Stack gap={4}>
          <p className="text-sm">
            {running === "running"
              ? "The steward is looking at new work and recording decisions."
              : running === "paused"
                ? "The steward is paused: it records no new decisions until resumed."
                : "Sindri has not reported whether the steward runs."}
          </p>
          <Cluster gap={3}>
            {running === "paused" ? (
              <Button
                disabledReason={pauseWhy || undefined}
                onClick={() => propose("steward.resume", "steward")}
              >
                Resume steward
              </Button>
            ) : (
              <Button
                disabledReason={pauseWhy || undefined}
                onClick={() => propose("steward.pause", "steward")}
              >
                Pause steward
              </Button>
            )}
          </Cluster>
        </Stack>
      </Card>
      <Card
        title="Decision types"
        term="Decision type"
        description="Each type starts as a recommendation you accept, change or reject. Switch a type to automatic once its track record is good. Approvals are never automatic."
        flush
      >
        <DataTable
          caption="Decision types and their modes"
          columns={columns}
          rows={types}
          rowKey={(row) => String(row.type)}
          layout="stack"
          empty={
            <EmptyState
              compact
              className="m-4"
              title="No decision types reported yet."
              body="Sindri lists the types once the steward has started."
              action={
                <Button size="sm" onClick={() => setVersion((v) => v + 1)}>
                  Refresh autonomy
                </Button>
              }
            />
          }
        />
      </Card>
      <FeedbackGraphStatus />
    </Page>
  );
}

/** Sindri's Feedback Graph status (Connections › Services and Autonomy (all)). */
export function FeedbackGraphStatus() {
  const { api } = useHeimdall();
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
    <Card
      title="Feedback Graph"
      term="Feedback Graph"
      actions={
        <Status
          value={error ? "unknown" : summary.badge.replaceAll(" ", "_")}
          domain="fg-connection"
        />
      }
    >
      <Stack gap={2}>
        <p className="text-sm break-words">
          {error
            ? `Sindri did not report Feedback Graph status: ${error}`
            : summary.text}
        </p>
        <p className="text-sm text-muted">
          Read through Sindri, read-only: lessons from your past feedback inform
          planning and the steward. Nothing is written back.
        </p>
      </Stack>
    </Card>
  );
}

/** Feedback Graph link and lessons for one project, in the project inspector. */
export function FeedbackGraphSection({
  sindriProject,
}: {
  sindriProject: R | undefined;
}) {
  const { api, session, propose, reloadKey } = useHeimdall();
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
  const heading = (
    <h3
      id="fg-heading"
      className="inline-flex items-center gap-1 text-base font-semibold text-fg"
    >
      Feedback Graph <InfoHint term="Feedback Graph" />
    </h3>
  );
  if (!id)
    return (
      <Stack gap={2}>
        {heading}
        <p className="text-sm text-muted">
          Lessons need the project registered in Sindri.
        </p>
      </Stack>
    );
  const link: R | null = data?.link ?? null;
  const lessons: R[] = Array.isArray(data?.lessons) ? data!.lessons : [];
  const setWhy = linkBlock(key, link, session);
  const clearWhy = clearLinkBlock(link, session);
  return (
    <section
      aria-labelledby="fg-heading"
      className="flex min-w-0 flex-col gap-4"
    >
      {heading}
      {error && (
        <Callout
          tone="danger"
          title="The Feedback Graph link could not be read"
        >
          {error}
        </Callout>
      )}
      {link && (
        <Cluster gap={2}>
          <Status value={link.source} domain="fg-link" />
          {link.projectKey && (
            <code className="text-sm break-all">{String(link.projectKey)}</code>
          )}
        </Cluster>
      )}
      {data?.error && (
        <Callout tone="warning">Feedback Graph: {String(data.error)}</Callout>
      )}
      <Field label="Feedback Graph project key">
        <Input
          value={key}
          placeholder={link?.projectKey ?? "project key"}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <Cluster gap={2}>
        <Button
          disabledReason={setWhy || undefined}
          onClick={() =>
            propose("project.feedbackGraph", id, { projectKey: key.trim() })
          }
        >
          Review link override
        </Button>
        <Button
          disabledReason={clearWhy || undefined}
          onClick={() =>
            propose("project.feedbackGraph", id, { projectKey: null })
          }
        >
          Clear override
        </Button>
      </Cluster>
      <Reasons reasons={[setWhy, clearWhy]} />
      <h4 className="inline-flex items-center gap-1 text-sm font-semibold text-fg">
        Approved lessons ({lessons.length}) <InfoHint term="Lesson" />
      </h4>
      {lessons.length ? (
        <ul
          aria-label="Feedback Graph lessons"
          className="flex flex-col divide-y divide-line rounded-md border border-line"
        >
          {lessons.map((l, i) => (
            <li
              key={l.id ?? i}
              className="flex min-w-0 flex-col gap-1 px-4 py-3 text-sm"
            >
              <Cluster gap={2}>
                <strong className="break-words">
                  {String(l.title || l.id)}
                </strong>
                <Status value={l.status} size="sm" />
              </Cluster>
              <p className="break-words whitespace-pre-wrap">
                {String(l.rule ?? "")}
              </p>
              {l.appliesWhen && (
                <p className="text-muted">
                  Applies when: {String(l.appliesWhen)}
                </p>
              )}
              {Array.isArray(l.paths) && l.paths.length > 0 && (
                <p className="break-words text-muted">
                  Paths: {l.paths.map(String).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {link?.projectKey
            ? "No approved lessons for this project."
            : "Link a Feedback Graph project to see its lessons."}
        </p>
      )}
    </section>
  );
}
