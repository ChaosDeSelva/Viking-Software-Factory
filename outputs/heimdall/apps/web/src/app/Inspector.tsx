// The inspector drawer: one record (`?inspect=kind:id`) with its details, the raw source record and
// the actions that apply to it. Every action proposes a command; the command dialog asks for the
// audit reason. A disabled action says why in its tooltip and once in a line below the buttons.
import {
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  Cluster,
  Disclosure,
  Drawer,
  Field,
  Id,
  KeyValue,
  Stack,
  Textarea,
  Timestamp,
} from "@factory/ui";
import { useEffect, useState, type ReactNode } from "react";
import { useHeimdall } from "./context";
import { Raw, Reasons, Status, label } from "../components/app";
import { download, type R } from "../lib/api";
import { RaiseBudgetForm } from "../features/Budget";
import { eventSubject, eventTitle } from "../features/events";
import { ExecutionProfile } from "../features/ExecutionProfile";
import { FeedbackGraphSection } from "../features/Autonomy";
import { LiveSession } from "../features/LiveSession";
import { canControlMission } from "../features/missionState";
import {
  escalationBlock,
  isFinalExecution,
  sindriProjectOf,
} from "../features/profileForm";
import {
  ACTIVE,
  blockedText,
  isBudgetBlocked,
  scopeOf,
} from "../features/scope";
import { PlanEditor, SpecEditor } from "../features/Workflow";
import {
  actionBlock,
  deliveryTitle,
  intakeRequest,
  missionSpecTitle,
  orderedQuestions,
  projectKey,
  runTitle,
  sameRepo,
  statusBadge,
} from "../features/workflowState";

const KIND_LABEL: Record<string, string> = {
  tasks: "Task",
  missions: "Mission",
  crews: "Crew",
  agents: "Agent",
  approvals: "Approval",
  specs: "Specification",
  plans: "Plan",
  intakes: "Intake",
  deliveries: "Delivery",
  execution: "Run",
  escalation: "Escalation",
  gate: "Quality gate",
  artifact: "Evidence",
  event: "Event",
  projects: "Project",
};
const STATUS_DOMAIN: Record<string, string> = {
  tasks: "task",
  missions: "mission",
  crews: "crew",
  agents: "agent",
  execution: "run",
  specs: "spec",
  plans: "plan",
};

/** A heading and its content, with the drawer's spacing. */
function Block({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-md font-semibold">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Clickable rows for related records (tasks of a mission, agents of a crew, …). */
function RecordLinks({
  kind,
  rows,
  empty,
}: {
  kind: string;
  rows: R[];
  empty: string;
}) {
  const { open } = useHeimdall();
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
      {rows.map((r, i) => (
        <li key={r.id ?? i}>
          <button
            type="button"
            onClick={() => open(kind, r)}
            className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="min-w-0">
              <span className="line-clamp-2 text-sm font-medium">
                {String(label(r))}
              </span>
              <span className="block truncate font-mono text-xs text-muted">
                {["specs", "plans"].includes(kind) && r.version != null
                  ? `v${r.version} · `
                  : ""}
                {r.id}
                {r.blockedReason ? ` · ${r.blockedReason}` : ""}
              </span>
            </span>
            {(r.status ?? r.role) && (
              <Status
                value={r.status ?? r.role}
                domain={STATUS_DOMAIN[kind]}
                tooltip={false}
              />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Events about one record, newest first, each opening its own inspector. */
function EventList({ events }: { events: R[] }) {
  const { open } = useHeimdall();
  if (!events.length)
    return (
      <p className="text-sm text-muted">
        No recorded activity yet. Events appear here as the source publishes
        them.
      </p>
    );
  return (
    <ul className="flex max-h-80 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line">
      {events.map((e, i) => (
        <li key={e.source + e.eventId + ":" + i}>
          <button
            type="button"
            aria-label={`${eventTitle(e.type)} (${e.type})`}
            onClick={() => open("event", e)}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="min-w-0">
              <span className="block text-sm">{eventTitle(e.type)}</span>
              <code className="block truncate text-xs text-muted">
                {e.type}
              </code>
            </span>
            <span className="text-xs text-muted">
              {e.timestamp ? <Timestamp value={e.timestamp} /> : "Unreported"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PatchBlock({
  title,
  note,
  file,
  patch,
  exact,
}: {
  title: string;
  note?: string;
  file: string;
  patch: string;
  /** False when Heimdall had to hide one of its own source tokens in the text. */
  exact: boolean;
}) {
  return (
    <Block title={title}>
      {note && <p className="text-sm text-muted">{note}</p>}
      {exact ? (
        <div>
          <Button variant="secondary" onClick={() => download(file, patch)}>
            Download {file}
          </Button>
        </div>
      ) : (
        <Callout tone="warning">
          Preview only: this text contains a Mimir or Sindri access token, which
          Heimdall replaced, so it will not apply as a patch. Use the commands
          above to take the verified commit.
        </Callout>
      )}
      <Disclosure title={exact ? `Show ${file}` : `Preview of ${file}`}>
        <CodeBlock code={patch} maxHeight="420px" />
      </Disclosure>
    </Block>
  );
}

/** Reviewer feedback on a delivery; Sindri drafts a follow-up specification from it. */
function RequestChanges({
  reason,
  submit,
}: {
  reason: string;
  submit: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  return (
    <Disclosure title="Request changes to this delivery">
      <Stack gap={3}>
        <p className="text-sm text-muted">
          Describe what should be different. A new specification is drafted from
          your feedback and, once you approve it and its plan, the work
          continues from this delivery's verified result instead of starting
          over.
        </p>
        <Field label="What should change">
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
        </Field>
        <div>
          <Button
            variant="secondary"
            disabledReason={
              reason ||
              (!feedback.trim() ? "Describe the change first." : undefined)
            }
            onClick={() => submit(feedback.trim())}
          >
            Review change request
          </Button>
        </div>
        <Reasons reasons={[reason]} />
      </Stack>
    </Disclosure>
  );
}

function Question({
  question: q,
  answer,
  disabled,
}: {
  question: R;
  answer: (a: string) => void;
  disabled: string;
}) {
  const [text, setText] = useState("");
  return (
    <div className="question flex flex-col gap-3 rounded-md border border-line p-4">
      {typeof q.blocking === "boolean" && (
        <span>
          <Status
            value={q.blocking ? "blocking" : "non-blocking"}
            domain="question"
          />
        </span>
      )}
      <p className="text-sm">{q.question ?? q.text ?? JSON.stringify(q)}</p>
      {q.recommendation && (
        <div className="flex flex-col gap-2 rounded-md bg-sunken p-3">
          <p className="text-sm">
            <strong>Recommended answer:</strong> {q.recommendation}
          </p>
          {q.rationale && (
            <p className="text-xs text-muted">Why: {q.rationale}</p>
          )}
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabledReason={disabled || undefined}
              onClick={() => setText(String(q.recommendation))}
            >
              Use recommendation
            </Button>
          </div>
        </div>
      )}
      <Field label="Your answer">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div>
        <Button
          variant="secondary"
          disabledReason={
            disabled || (!text.trim() ? "Write an answer first." : undefined)
          }
          onClick={() => answer(text)}
        >
          Review answer
        </Button>
      </div>
    </div>
  );
}

export function Inspector({
  inspect,
  cached,
  onClose,
}: {
  inspect: string;
  cached: R | undefined;
  onClose: () => void;
}) {
  const { state, session, propose, open, api, reloadKey, notify } =
    useHeimdall();
  const [kind = "", ...rest] = inspect.split(":");
  const id = rest.join(":");
  const [details, setDetails] = useState<R | null>(null),
    [detailError, setDetailError] = useState(""),
    [history, setHistory] = useState<R[]>([]),
    [acknowledge, setAcknowledge] = useState(false);
  const m: R = state?.mimir ?? {},
    s: R = state?.sindri ?? {};
  const executions: R[] = s.executions ?? [];
  const specsAll: R[] = s.specs ?? [];
  const all = scopeOf(state, "all");
  const live =
    kind === "execution"
      ? executions.find((e) => e.execution.id === id)?.execution
      : kind === "projects"
        ? all.allProjects.find((p) => p.id === id)
        : kind === "event"
          ? (state?.events ?? []).find((e: R) => e.eventId === id)
          : (m[kind] ?? s[kind] ?? []).find?.((r: R) => r.id === id);
  const fetched = [
    "specs",
    "plans",
    "intakes",
    "deliveries",
    "artifact",
  ].includes(kind);
  const row: R | null = live ?? cached ?? (fetched ? { id } : null);

  useEffect(() => {
    let gone = false;
    setDetails(null);
    setDetailError("");
    setHistory([]);
    setAcknowledge(false);
    const endpoint =
      kind === "artifact"
        ? `artifacts/${id}`
        : ["specs", "plans", "intakes", "deliveries"].includes(kind)
          ? `details/${kind}/${id}`
          : null;
    if (endpoint)
      api(endpoint)
        .then((d) => !gone && setDetails(d))
        .catch((e) => !gone && setDetailError(e.message));
    const taskId =
      kind === "tasks" ? id : kind === "agents" ? row?.taskId : null;
    if (taskId)
      api("events?taskId=" + encodeURIComponent(taskId) + "&limit=500")
        .then((d) => !gone && setHistory(d.events))
        .catch((e) => !gone && setDetailError(e.message));
    return () => {
      gone = true;
    };
  }, [inspect, reloadKey]);
  // Re-read the record after a confirmed command, without dropping the acknowledgement.
  useEffect(() => {
    setAcknowledge(false);
  }, [inspect]);

  if (!row)
    return (
      <Drawer
        open
        onOpenChange={(o) => !o && onClose()}
        title={`${KIND_LABEL[kind] ?? "Record"} unavailable`}
        description="Inspector"
      >
        <Callout tone="warning">
          This record is not in the latest snapshot. It may have finished, moved
          to another project, or the link is out of date.
        </Callout>
      </Drawer>
    );

  const sourceOffline = Object.values(state?.sources ?? {}).some(
    (v: any) => v.status === "disconnected",
  );
  const missing =
    ["tasks", "missions", "crews", "agents", "approvals"].includes(kind) &&
    state?.sources?.mimir?.status === "connected" &&
    !live;
  const sindriWhy = (action: string, status?: unknown) =>
    actionBlock(action, status, session);
  const operatorWhy = session.operator
    ? ""
    : "Unlock operator controls under Connections first.";
  const currentTask =
    kind === "tasks"
      ? row
      : kind === "agents"
        ? (m.tasks ?? []).find((t: R) => t.id === row.taskId)
        : null;
  const taskExecution = currentTask
    ? executions.find((e) =>
        e.tasks?.some((t: R) => t.mimirTaskId === currentTask.id),
      )
    : null;
  const mappedTask = taskExecution?.tasks?.find(
    (t: R) => t.mimirTaskId === currentTask?.id,
  );
  const taskPlan = taskExecution?.plan?.tasks?.find(
    (t: R) => t.id === mappedTask?.planTaskId,
  );
  const taskAgent = currentTask
    ? ((m.agents ?? []).find((a: R) => a.id === currentTask.agentId) ??
      (m.agents ?? []).find(
        (a: R) => a.taskId === currentTask.id && a.runtimeSessionId,
      ))
    : null;
  const relatedEvents = currentTask
    ? [
        ...new Map(
          [...(state?.events ?? []), ...history]
            .filter(
              (e: R) =>
                e.taskId === currentTask.id ||
                e.payload?.taskId === currentTask.id,
            )
            .map((e: R) => [e.source + e.eventId, e]),
        ).values(),
      ]
    : [];
  const openSpec: R | null = kind === "specs" ? (details?.spec ?? row) : null;
  const acknowledgeWhy =
    kind === "specs" &&
    details?.meta?.untrustedInstructionDetected &&
    !acknowledge
      ? "Acknowledge the flagged source instructions below first."
      : "";
  const approvalWhy =
    kind === "approvals" &&
    executions.some((e) => e.execution.mimirMissionId === row.missionId)
      ? sindriWhy("approval.decide")
      : operatorWhy;
  const versioned = details?.spec ?? details?.plan ?? row;
  const title =
    kind === "tasks" && taskPlan
      ? taskPlan.id.replaceAll("-", " ")
      : kind === "missions"
        ? (missionSpecTitle(row, executions, specsAll) ?? String(label(row)))
        : kind === "execution"
          ? runTitle(
              executions.find((e) => e.execution.id === id) ?? {
                execution: row,
              },
              specsAll,
            )
          : kind === "deliveries" && deliveryTitle(row, executions, specsAll)
            ? deliveryTitle(row, executions, specsAll)
            : kind === "event"
              ? eventTitle(row.type)
              : String(label(versioned)).length > 180
                ? String(label(versioned)).slice(0, 177) + "…"
                : String(label(versioned));
  const status =
    kind === "specs" || kind === "plans"
      ? statusBadge(kind, versioned)
      : statusBadge(kind, row);
  const liveAgent =
    taskAgent?.runtimeSessionId && ACTIVE.includes(taskAgent.status)
      ? taskAgent
      : null;

  const sections: ReactNode[] = [];
  const add = (key: string, node: ReactNode) =>
    sections.push(<div key={key}>{node}</div>);

  if (kind === "projects") {
    const sindri = sindriProjectOf(row, all.sindriProjects);
    add(
      "repo",
      <KeyValue
        items={[
          {
            label: "Repository",
            value: (
              <span className="break-all font-mono text-xs">
                {row.repoPath ?? "Not reported"}
              </span>
            ),
          },
        ]}
      />,
    );
    add(
      "profile",
      <ExecutionProfile key={projectKey(row)} sindriProject={sindri} />,
    );
    add(
      "fg",
      <FeedbackGraphSection
        key={"fg:" + projectKey(row)}
        sindriProject={sindri}
      />,
    );
    add(
      "missions",
      <Block title="Missions">
        <RecordLinks
          kind="missions"
          rows={(m.missions ?? []).filter((x: R) => x.projectId === row.id)}
          empty="No missions yet."
        />
      </Block>,
    );
    add(
      "specs",
      <Block title="Specifications">
        <RecordLinks
          kind="specs"
          rows={specsAll.filter(
            (sp) =>
              sp.projectId === row.id ||
              sameRepo(
                all.sindriProjects.find((p) => p.id === sp.projectId)?.repoPath,
                row.repoPath,
              ),
          )}
          empty="No specifications yet."
        />
      </Block>,
    );
  }

  if (kind === "crews") {
    add(
      "crew",
      <Block title="Scheduling">
        <p className="text-sm text-muted">
          Scheduling is {row.schedulingPaused ? "paused" : "enabled"}. Existing
          sessions continue; use graceful stop in an agent's inspector to stop
          one.
        </p>
        <Cluster gap={2}>
          <Button
            variant="secondary"
            disabledReason={
              operatorWhy ||
              (row.schedulingPaused
                ? "Scheduling is already paused."
                : undefined)
            }
            onClick={() =>
              propose("crew.pause", row.id, { expectedVersion: row.version })
            }
          >
            Pause crew scheduling
          </Button>
          <Button
            variant="secondary"
            disabledReason={
              operatorWhy ||
              (!row.schedulingPaused ? "Scheduling is not paused." : undefined)
            }
            onClick={() =>
              propose("crew.resume", row.id, { expectedVersion: row.version })
            }
          >
            Resume crew scheduling
          </Button>
        </Cluster>
        <Reasons reasons={[operatorWhy]} />
      </Block>,
    );
    add(
      "agents",
      <Block title="Agents">
        <RecordLinks
          kind="agents"
          rows={(m.agents ?? []).filter((a: R) => a.crewId === row.id)}
          empty="No agents yet."
        />
      </Block>,
    );
    add(
      "tasks",
      <Block title="Tasks">
        <RecordLinks
          kind="tasks"
          rows={(m.tasks ?? []).filter((t: R) => t.crewId === row.id)}
          empty="No tasks yet."
        />
      </Block>,
    );
  }

  if (kind === "missions") {
    const why = (action: string) =>
      operatorWhy ||
      (sourceOffline
        ? "A source is disconnected; check Connections before acting."
        : "") ||
      (missing ? "This mission is no longer in Mimir's snapshot." : "") ||
      (!canControlMission(row.status, action)
        ? `A ${row.status} mission cannot be ${action === "cancel" ? "cancelled" : action + "d"}.`
        : "");
    add(
      "controls",
      <Block title="Mission controls">
        <p className="text-sm text-muted">
          Mission controls affect every crew in this mission. A pause controls
          scheduling; inspect agent state to confirm what is still running.
        </p>
        <Cluster gap={2}>
          {["pause", "resume", "cancel"].map((action) => (
            <Button
              key={action}
              variant={action === "cancel" ? "danger" : "secondary"}
              disabledReason={why(action) || undefined}
              onClick={() =>
                propose("mission." + action, row.id, {
                  expectedVersion: row.version,
                  ...(action === "cancel"
                    ? {
                        reason: "Operator requested cancellation from Heimdall",
                      }
                    : {}),
                })
              }
            >
              {action.charAt(0).toUpperCase() + action.slice(1)} mission
            </Button>
          ))}
        </Cluster>
        <Reasons reasons={[operatorWhy]} />
      </Block>,
    );
    add(
      "tasks",
      <Block title="Tasks">
        <RecordLinks
          kind="tasks"
          rows={(m.tasks ?? []).filter((t: R) => t.missionId === row.id)}
          empty="No tasks yet."
        />
      </Block>,
    );
  }

  if (kind === "agents") {
    if (row.runtimeSessionId)
      add(
        "live",
        <LiveSession
          agent={row}
          load={() => api(`agents/${row.id}/telemetry`)}
        />,
      );
    else
      add(
        "nolive",
        <Callout tone="info" title="No live session">
          This agent has no runtime session yet, so there is no output to watch.
          It appears here once the session starts.
        </Callout>,
      );
    add(
      "facts",
      <Block title="Agent">
        <KeyValue
          columns={2}
          items={[
            {
              label: "Runtime",
              value: row.agentKind ?? "Not reported",
              term: "Agent kind",
            },
            { label: "Role", value: row.role ?? "Not reported", term: "Role" },
            {
              label: "Last source update",
              value: row.updatedAt ? (
                <Timestamp value={row.updatedAt} />
              ) : (
                "Not reported"
              ),
            },
            {
              label: "Session",
              value: row.runtimeSessionId ? (
                <Id value={row.runtimeSessionId} />
              ) : (
                "Not started"
              ),
              term: "Agent session",
            },
          ]}
        />
        <p className="text-xs text-muted">
          Model and heartbeats are shown only when the runtime reports them. No
          heartbeat means freshness is unknown.
        </p>
        {row.runtimeSessionId && (
          <div>
            <Button
              variant="secondary"
              disabledReason={operatorWhy || undefined}
              onClick={() =>
                propose("session.stop", row.runtimeSessionId, {
                  mode: "graceful",
                })
              }
            >
              Request graceful stop
            </Button>
          </div>
        )}
      </Block>,
    );
  }

  if (currentTask) {
    const budget = isBudgetBlocked(currentTask);
    if (budget)
      add(
        "budget",
        <Card title="Raise budget" term="Budget exceeded" dense>
          <RaiseBudgetForm task={currentTask} />
        </Card>,
      );
    else if (currentTask.blockedReason)
      add(
        "blocked",
        <Callout tone="warning" title="Blocked">
          {blockedText(currentTask.blockedReason)}
        </Callout>,
      );
    if (kind === "tasks" && taskAgent?.runtimeSessionId) {
      const session = (
        <LiveSession
          agent={taskAgent}
          load={() => api(`agents/${taskAgent.id}/telemetry`)}
        />
      );
      add(
        "live",
        liveAgent ? (
          <Stack gap={2}>
            {session}
            <Button variant="link" onClick={() => open("agents", taskAgent)}>
              Open the agent's inspector
            </Button>
          </Stack>
        ) : (
          <Disclosure title="Agent session output">{session}</Disclosure>
        ),
      );
    }
    add(
      "objective",
      <Block title="Task objective">
        <p className="text-sm whitespace-pre-wrap">
          {taskPlan?.objective ?? currentTask.title}
        </p>
      </Block>,
    );
    add(
      "acceptance",
      <Block title="Acceptance criteria">
        <p className="text-sm whitespace-pre-wrap">
          {String(currentTask.acceptance || "Not supplied by source.")
            .split("\n")
            .map((line) => {
              const c = specsAll
                .find((sp) => sp.id === taskExecution?.plan?.specId)
                ?.body?.acceptanceCriteria?.find(
                  (a: R) => a.id === line.trim(),
                );
              return c ? `${c.id}: ${c.text}` : line;
            })
            .join("\n\n")}
        </p>
      </Block>,
    );
    add(
      "facts",
      <KeyValue
        columns={2}
        items={[
          {
            label: "Attempt / retries",
            value: `${currentTask.attempt} / ${currentTask.maxAttempts}`,
            term: "Failed attempts",
          },
          {
            label: "Updated",
            value: currentTask.updatedAt ? (
              <Timestamp value={currentTask.updatedAt} />
            ) : (
              "Not reported"
            ),
          },
          {
            label: "Agent",
            value: (
              <Button
                size="sm"
                variant="link"
                disabledReason={
                  taskAgent
                    ? undefined
                    : currentTask.agentId
                      ? "This agent is no longer in the source snapshot."
                      : "No agent is assigned to this task yet."
                }
                onClick={() => taskAgent && open("agents", taskAgent)}
              >
                {currentTask.agentId ?? "Not assigned"}
              </Button>
            ),
          },
          {
            label: "Result commit",
            value: currentTask.resultCommit ? (
              <Id value={currentTask.resultCommit} />
            ) : (
              "Not verified yet"
            ),
          },
        ]}
      />,
    );
    add(
      "deps",
      <Block title="Dependencies">
        <RecordLinks
          kind="tasks"
          rows={(m.taskDependencies ?? [])
            .filter((d: R) => d.taskId === currentTask.id)
            .map(
              (d: R) =>
                (m.tasks ?? []).find((t: R) => t.id === d.dependsOnId) ?? {
                  id: d.dependsOnId,
                  title: "Dependency unavailable",
                },
            )}
          empty="No prerequisite tasks."
        />
      </Block>,
    );
    for (const g of taskExecution?.gates?.filter(
      (g: R) => g.planTaskId === mappedTask?.planTaskId,
    ) ?? [])
      add(
        "gate:" + g.planTaskId,
        <Block
          title="Verification gate"
          actions={
            <Status value={g.passed ? "passed" : "failed"} domain="gate" />
          }
        >
          <Raw data={g} title="Gate evidence & failures" />
        </Block>,
      );
    const artifacts = relatedEvents.filter(
      (e) => e.type === "artifact.recorded",
    );
    add(
      "evidence",
      <Block title="Evidence & artifacts">
        {artifacts.length ? (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {artifacts.map((e) => (
              <li key={e.eventId}>
                <button
                  type="button"
                  className="flex w-full flex-col px-3 py-2 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={() =>
                    open("artifact", {
                      id: e.payload.artifactId,
                      title: e.payload.name ?? e.payload.kind,
                      ...e.payload,
                    })
                  }
                >
                  <span className="text-sm">
                    {e.payload.name ?? e.payload.kind}
                  </span>
                  <span className="text-xs text-muted">
                    {e.payload.bytes?.toLocaleString()} bytes · hash checked
                    before preview
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            No evidence recorded for this task yet.
          </p>
        )}
      </Block>,
    );
    add(
      "activity",
      <Block title="Activity & agent output">
        <EventList events={relatedEvents} />
      </Block>,
    );
    const verifyWhy =
      operatorWhy ||
      (!["completed", "failed"].includes(currentTask.status)
        ? `Only a completed or failed task can be verified again (status is ${currentTask.status}).`
        : "");
    const retryWhy =
      operatorWhy ||
      (!["failed", "blocked"].includes(currentTask.status)
        ? `Only a failed or blocked task can be retried (status is ${currentTask.status}).`
        : "");
    add(
      "actions",
      <Block title="Task actions">
        <Cluster gap={2}>
          <Button
            variant="secondary"
            disabledReason={verifyWhy || undefined}
            onClick={() =>
              propose("task.verify", currentTask.id, {
                expectedVersion: currentTask.version,
              })
            }
          >
            Re-run verification only
          </Button>
          <Button
            variant="secondary"
            disabledReason={retryWhy || undefined}
            onClick={() =>
              propose("task.retry", currentTask.id, {
                expectedVersion: currentTask.version,
              })
            }
          >
            Retry task
          </Button>
        </Cluster>
        <Reasons reasons={[operatorWhy]} />
      </Block>,
    );
    if (taskPlan)
      add("plan", <Raw data={taskPlan} title="Plan & dependency details" />);
    if (mappedTask)
      add(
        "mapped",
        <Raw data={mappedTask} title="Execution state & escalation" />,
      );
    add(
      "worktree",
      <Raw
        data={(m.worktrees ?? []).filter((w: R) => w.taskId === currentTask.id)}
        title="Worktree & branch"
      />,
    );
  }

  if (kind === "approvals") {
    add(
      "approval",
      <Block title="Requested action">
        <p className="text-sm font-medium">{row.action}</p>
        <p className="text-sm text-muted">{row.reason}</p>
        <Raw data={row} title="Review full approval request" />
        <Cluster gap={2}>
          {["approved", "rejected"].map((decision) => (
            <Button
              key={decision}
              variant={decision === "approved" ? "primary" : "danger"}
              disabledReason={approvalWhy || undefined}
              onClick={() =>
                propose("approval.decide", row.id, {
                  decision,
                  reason: "Operator decision from Heimdall",
                })
              }
            >
              {decision === "approved" ? "Approve" : "Reject"}
            </Button>
          ))}
        </Cluster>
        <Reasons reasons={[approvalWhy]} />
      </Block>,
    );
  }

  if (kind === "intakes") {
    const why = sindriWhy("spec.draft");
    add(
      "intake",
      <Block title="Request">
        <p className="text-sm whitespace-pre-wrap">
          {details?.intake?.body ?? row.body}
        </p>
        <div>
          <Button
            variant="primary"
            disabledReason={why || undefined}
            onClick={() =>
              propose("spec.draft", "new", {
                projectId: row.projectId,
                intakeId: row.id,
                request: intakeRequest(row),
              })
            }
          >
            Draft specification from intake
          </Button>
        </div>
        <Reasons reasons={[why]} />
      </Block>,
    );
  }

  if (kind === "specs" || kind === "plans") {
    const resource = kind === "specs" ? "spec" : "plan";
    const record = details?.spec ?? details?.plan ?? row;
    const submitWhy = sindriWhy(resource + ".submit", record.status);
    const approveWhy =
      sindriWhy(resource + ".approve", record.status) || acknowledgeWhy;
    add(
      "review",
      <Block title="Review">
        <Cluster gap={2}>
          <Button
            variant="secondary"
            disabledReason={submitWhy || undefined}
            onClick={() => propose(resource + ".submit", record.id)}
          >
            Submit for review
          </Button>
          <Button
            variant="primary"
            disabledReason={approveWhy || undefined}
            onClick={() =>
              propose(
                resource + ".approve",
                record.id,
                kind === "specs" && acknowledge
                  ? { acknowledgeUntrusted: true }
                  : {},
              )
            }
          >
            Approve {kind === "specs" ? "specification" : "plan"}
          </Button>
        </Cluster>
        <Reasons reasons={[submitWhy, approveWhy]} />
        {kind === "specs" && details?.meta?.untrustedInstructionDetected && (
          <Callout tone="warning" title="Flagged source instructions">
            <Checkbox
              checked={acknowledge}
              onChange={(e) => setAcknowledge(e.target.checked)}
              label="I have reviewed the flagged source instructions and explicitly acknowledge them for this specification."
            />
          </Callout>
        )}
      </Block>,
    );
    if (kind === "specs" && record.body)
      add("edit", <SpecEditor key={record.id} spec={record} />);
    if (kind === "specs") {
      const why = sindriWhy("plan.propose", record.status);
      add(
        "propose",
        <div className="flex flex-col gap-2">
          <div>
            <Button
              variant="secondary"
              disabledReason={why || undefined}
              onClick={() =>
                propose("plan.propose", "new", { specId: record.id })
              }
            >
              Propose implementation plan
            </Button>
          </div>
          <Reasons reasons={[why]} />
        </div>,
      );
    }
    if (kind === "plans" && record.tasks)
      add("edit", <PlanEditor key={record.id} plan={record} />);
    if (kind === "plans") {
      const why = sindriWhy("execution.create", record.status);
      add(
        "start",
        <div className="flex flex-col gap-2">
          <div>
            <Button
              variant="primary"
              disabledReason={why || undefined}
              onClick={() =>
                propose("execution.create", "new", { planId: record.id })
              }
            >
              Start approved plan
            </Button>
          </div>
          <Reasons reasons={[why]} />
        </div>,
      );
    }
    const questions = orderedQuestions(openSpec);
    if (questions.length)
      add(
        "questions",
        <Block title="Open questions">
          {questions.map((q: R) => (
            <Question
              key={q.id}
              question={q}
              disabled={sindriWhy("spec.answer")}
              answer={(answer) =>
                propose("spec.answer", openSpec!.id, {
                  questionId: q.id,
                  answer,
                })
              }
            />
          ))}
          <Reasons reasons={[sindriWhy("spec.answer")]} />
        </Block>,
      );
    const spec = details?.spec ?? (kind === "specs" ? row : null);
    if (spec?.body)
      add(
        "body",
        <Block title="Problem">
          <p className="text-sm whitespace-pre-wrap">{spec.body.problem}</p>
          {(spec.body.acceptanceCriteria ?? []).length > 0 && (
            <>
              <h4 className="text-sm font-semibold">Acceptance criteria</h4>
              <ul className="flex flex-col gap-2">
                {(spec.body.acceptanceCriteria ?? []).map((a: R) => (
                  <li
                    key={a.id}
                    className="rounded-md border border-line p-3 text-sm"
                  >
                    <strong className="font-mono text-xs">{a.id}</strong>
                    <p>{a.text ?? a.description}</p>
                    {a.verification && (
                      <p className="text-xs text-muted">{a.verification}</p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Block>,
      );
    const plan = details?.plan ?? (kind === "plans" ? row : null);
    if (plan?.tasks)
      add(
        "tasks",
        <Block title="Plan tasks">
          <RecordLinks kind="plan-task" rows={plan.tasks} empty="No tasks." />
        </Block>,
      );
    add("raw", <Raw data={details ?? row} title="Full specification / plan" />);
  }

  if (kind === "escalation") {
    const view = executions.find((e) => e.execution.id === row.executionId);
    const resolveWhy =
      sindriWhy("execution.resolve") || escalationBlock(view, row.planTaskId);
    const mimirTask = (m.tasks ?? []).find(
      (t: R) =>
        t.id ===
        (view?.tasks ?? []).find((t: R) => t.planTaskId === row.planTaskId)
          ?.mimirTaskId,
    );
    if (isBudgetBlocked(mimirTask))
      add(
        "budget",
        <Card title="Raise budget" term="Budget exceeded" dense>
          <RaiseBudgetForm task={mimirTask} />
          <p className="mt-3 text-xs text-muted">
            Then answer retry below; a budget retry does not use up an attempt.
          </p>
        </Card>,
      );
    add(
      "escalation",
      <Block title="Decide">
        <Raw
          data={row.escalation}
          title="Why operator intervention is required"
        />
        <Cluster gap={2}>
          {["retry", "skip", "replan", "abort"].map((decision) => (
            <Button
              key={decision}
              variant={decision === "abort" ? "danger" : "secondary"}
              disabledReason={resolveWhy || undefined}
              onClick={() =>
                propose(
                  "execution.resolve",
                  row.executionId,
                  { decision, reason: "Operator recovery decision" },
                  { taskId: row.planTaskId },
                )
              }
            >
              {decision.charAt(0).toUpperCase() + decision.slice(1)}
            </Button>
          ))}
        </Cluster>
        <Reasons reasons={[resolveWhy]} />
      </Block>,
    );
  }

  if (kind === "execution") {
    const view = executions.find((e) => e.execution.id === id);
    const cancelWhy =
      sindriWhy("execution.cancel") ||
      (isFinalExecution(row.status)
        ? `This run has ended (status is ${row.status}); there is nothing to cancel.`
        : "");
    const runTasks: R[] = (view?.tasks ?? [])
      .map((t: R) => (m.tasks ?? []).find((x: R) => x.id === t.mimirTaskId))
      .filter(Boolean);
    const watching = runTasks
      .map((t) => ({
        t,
        a: (m.agents ?? []).find(
          (a: R) =>
            (a.id === t.agentId || a.taskId === t.id) &&
            a.runtimeSessionId &&
            ACTIVE.includes(a.status),
        ),
      }))
      .filter((x) => x.a);
    if (watching.length)
      add(
        "live",
        <Callout
          tone="info"
          title={`${watching.length} agent${watching.length > 1 ? "s" : ""} working now`}
        >
          <ul className="mt-2 flex flex-col gap-2">
            {watching.map(({ t, a }) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="min-w-0 truncate text-sm">{t.title}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="monitor"
                  onClick={() => open("agents", a!)}
                >
                  Watch live
                </Button>
              </li>
            ))}
          </ul>
        </Callout>,
      );
    add(
      "cancel",
      <Block title="Run">
        <p className="text-sm text-muted">
          {cancelWhy ||
            "Cancelling stops the run for good and cancels its mission. The reason you give is recorded with the run."}
        </p>
        <div>
          <Button
            variant="danger"
            disabledReason={cancelWhy || undefined}
            onClick={() => propose("execution.cancel", id, { reason: "" })}
          >
            Cancel run
          </Button>
        </div>
      </Block>,
    );
    if (runTasks.length)
      add(
        "tasks",
        <Block title="Tasks">
          <RecordLinks kind="tasks" rows={runTasks} empty="" />
        </Block>,
      );
  }

  if (kind === "deliveries") {
    const assessWhy = sindriWhy("execution.assess");
    const exportWhy = sindriWhy("execution.export", row.status);
    add(
      "delivery",
      <Block title="Delivery">
        <Cluster gap={2}>
          <Button
            variant="secondary"
            disabledReason={assessWhy || undefined}
            onClick={() => propose("execution.assess", row.id)}
          >
            Reassess quality gates
          </Button>
          <Button
            variant="primary"
            disabledReason={exportWhy || undefined}
            onClick={() => propose("execution.export", row.id)}
          >
            Request local export
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void api("details/local/" + row.id)
                .then((d) => {
                  if (!d.result)
                    throw Error("No local export is available yet.");
                  setDetails((old) => ({ ...old, ...d }));
                })
                .catch((e) => notify(e.message, "warning"))
            }
          >
            View local delivery
          </Button>
        </Cluster>
        <Reasons reasons={[assessWhy, exportWhy]} />
        <RequestChanges
          key={row.id}
          reason={sindriWhy("delivery.rework")}
          submit={(feedback) =>
            propose("delivery.rework", row.id, { feedback })
          }
        />
      </Block>,
    );
    if (details?.result) {
      const r = details.result;
      add(
        "local",
        <Block title="Local delivery">
          <KeyValue
            items={[
              {
                label: "Result commit",
                value: (
                  <span className="font-mono text-xs">{r.resultCommit}</span>
                ),
              },
              {
                label: "Repository",
                value: (
                  <span className="break-all font-mono text-xs">
                    {r.repoPath}
                  </span>
                ),
              },
            ]}
          />
          <h4 className="text-sm font-semibold">Apply</h4>
          <CodeBlock code={String(r.apply ?? "")} />
          <h4 className="text-sm font-semibold">Undo</h4>
          <CodeBlock code={String(r.undo ?? "")} />
        </Block>,
      );
      if (r.followUp?.patch)
        add(
          "follow",
          <PatchBlock
            title="Follow-up only — use this if you already applied the earlier delivery"
            note={`Changes since ${r.followUp.baseSha}, the earlier delivery's result.`}
            file="follow-up.patch"
            patch={r.followUp.patch}
            exact={r.followUp.patchExact}
          />,
        );
      if (r.patch)
        add(
          "patch",
          <PatchBlock
            title={
              r.followUp?.patch
                ? "Full patch — everything since the original base"
                : "Patch"
            }
            file="result.patch"
            patch={r.patch}
            exact={r.patchExact}
          />,
        );
    }
    add(
      "raw",
      <Raw
        data={details ?? row}
        title="Delivery report, requirements & evidence"
      />,
    );
  }

  if (kind === "artifact" && details) {
    add(
      "artifact",
      <Block title="Evidence">
        <Callout tone="success">
          Integrity verified ·{" "}
          <span className="break-all font-mono text-xs">
            {details.verifiedHash}
          </span>
        </Callout>
        {details.image && (
          <img
            className="max-w-full rounded-md border border-line"
            src={details.image}
            alt="Verification evidence"
          />
        )}
        {details.content && (
          <CodeBlock code={String(details.content)} maxHeight="60vh" />
        )}
      </Block>,
    );
  }

  if (kind === "event") {
    add(
      "event",
      <Block title="Event">
        <KeyValue
          columns={2}
          items={[
            {
              label: "Type",
              value: <code className="text-xs">{row.type}</code>,
            },
            {
              label: "Source",
              value:
                row.source === "mimir"
                  ? "Mimir"
                  : row.source === "sindri"
                    ? "Sindri"
                    : String(row.source),
            },
            {
              label: "Time",
              value: row.timestamp ? (
                <Timestamp value={row.timestamp} />
              ) : (
                "Unreported"
              ),
            },
            {
              label: "Record",
              value: eventSubject(row) ? (
                <Id value={String(eventSubject(row))} />
              ) : (
                "—"
              ),
            },
          ]}
        />
        <CodeBlock
          code={JSON.stringify(row.payload, null, 2) ?? "null"}
          title="Payload"
          wrap
          maxHeight="420px"
        />
        {row.payload?.artifactId && (
          <div>
            <Button
              variant="secondary"
              onClick={() =>
                open("artifact", {
                  id: row.payload.artifactId,
                  title: row.payload.kind,
                })
              }
            >
              Open evidence artifact
            </Button>
          </div>
        )}
      </Block>,
    );
  }

  if (!["artifact", "specs", "plans", "deliveries"].includes(kind))
    add("raw", <Raw data={row} />);

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={`${KIND_LABEL[kind] ?? "Record"} inspector`}
      className="max-w-[720px]"
    >
      <Stack gap={6}>
        <div className="flex flex-wrap items-center gap-2">
          {status != null && (
            <Status value={status} domain={STATUS_DOMAIN[kind]} />
          )}
          {["specs", "plans"].includes(kind) && versioned.version != null ? (
            <span className="font-mono text-xs text-muted">{`v${versioned.version} · ${versioned.id}`}</span>
          ) : (
            <Id value={id} />
          )}
        </div>
        {missing && (
          <Callout tone="warning">
            This record is absent from the latest source snapshot. These
            retained details are historical.
          </Callout>
        )}
        {sourceOffline && (
          <Callout tone="warning">
            A source is disconnected. Details may be stale; check Connections
            before acting.
          </Callout>
        )}
        {detailError && <Callout tone="danger">{detailError}</Callout>}
        {sections}
      </Stack>
    </Drawer>
  );
}
