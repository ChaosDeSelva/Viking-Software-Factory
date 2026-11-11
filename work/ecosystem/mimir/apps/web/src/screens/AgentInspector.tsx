import type { AgentId, SessionId } from "@mimir/protocol";
import {
  Button,
  ConfirmDialog,
  Field,
  Id,
  KeyValue,
  Link,
  Switch,
  Textarea,
  Timestamp,
} from "@factory/ui";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useParams } from "react-router";
import { describeError, type TerminalReadResponse } from "../api/client.js";
import { ActionResult } from "../components/ActionResult.js";
import { ProvenanceBadge, StatusBadge, UsageChips } from "../components/Badges.js";
import { EventList } from "../components/EventList.js";
import { Screen } from "../components/Screen.js";
import { Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { crewLabel, missionName, taskName } from "../lib/names.js";
import { useAction } from "../lib/useAction.js";
import { useAsync } from "../lib/useAsync.js";
import { useStore } from "../store/StoreProvider.js";

/** Terminal reads are on demand; refresh is never allowed faster than this. */
export const TERMINAL_MIN_INTERVAL_MS = 2000;
/** While "Follow" is on, the terminal is re-read this often. */
export const TERMINAL_FOLLOW_MS = 5000;
const TERMINAL_LINES = 200;

const LIVE = new Set(["starting", "running", "waiting", "idle"]);

function Terminal({ sessionId, live }: { sessionId: SessionId; live: boolean }) {
  const { client, reportError } = useStore();
  const [data, setData] = useState<TerminalReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const [busy, setBusy] = useState(false);
  // Arriving from a "Live output" link (?follow=1) starts following right away.
  const { search } = useLocation();
  const [follow, setFollow] = useState(
    () => live && new URLSearchParams(search).get("follow") === "1",
  );
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!cooling) return;
    const t = setTimeout(() => setCooling(false), TERMINAL_MIN_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [cooling]);

  const load = useCallback(async () => {
    setBusy(true);
    setCooling(true);
    setError(null);
    try {
      setData(await client.sessions.terminal(sessionId, { lines: TERMINAL_LINES }));
    } catch (e) {
      reportError(e);
      setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  }, [client, reportError, sessionId]);

  // Follow: one read now, then every TERMINAL_FOLLOW_MS (well above the 2 s floor) until off.
  useEffect(() => {
    if (!follow) return;
    void load();
    const t = setInterval(() => void load(), TERMINAL_FOLLOW_MS);
    return () => clearInterval(t);
  }, [follow, load]);

  useEffect(() => {
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [data]);

  const caps = useAsync(() => client.capabilities(), "caps");
  if (caps.status === "ready" && !caps.data.runtime?.features.terminalRead) {
    return (
      <EmptyState body="Use the timeline below and the agent's events instead.">
        The runtime does not support terminal reads
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          icon="refresh"
          disabled={busy || cooling || follow}
          onClick={() => void load()}
        >
          {data === null ? "Read terminal" : "Refresh terminal"}
        </Button>
        {live && (
          <Switch
            checked={follow}
            onCheckedChange={setFollow}
            label="Follow"
            description={`Re-read every ${TERMINAL_FOLLOW_MS / 1000} s`}
          />
        )}
      </div>
      <p className="text-xs text-muted">
        Last {TERMINAL_LINES} lines, read on demand (at most every {TERMINAL_MIN_INTERVAL_MS / 1000}{" "}
        s). Terminal text is never used as agent state.
      </p>
      {error && <ErrorState title="Could not read the terminal" message={error} />}
      {data && (
        <>
          <p className="flex items-center gap-2 text-xs text-muted">
            {data.provenance && <ProvenanceBadge provenance={data.provenance} />}
            {data.capturedAt && <Timestamp value={data.capturedAt} prefix="Captured" />}
          </p>
          <pre
            ref={preRef}
            data-testid="terminal"
            tabIndex={0}
            aria-label="Terminal output"
            className="max-h-[28rem] overflow-auto rounded-md bg-zinc-950 p-4 font-mono text-xs leading-relaxed whitespace-pre text-zinc-100"
          >
            {data.text}
          </pre>
        </>
      )}
    </div>
  );
}

function Controls({ sessionId }: { sessionId: SessionId }) {
  const { client } = useStore();
  const [text, setText] = useState("");
  const [confirmForce, setConfirmForce] = useState(false);
  const input = useAction();
  const stop = useAction();
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await input.run(
      () => client.sessions.input(sessionId, { text: text.trim() }),
      () => "Instruction sent",
    );
    if (r) setText("");
  };
  const denied = stop.outcome?.kind === "error" && stop.outcome.error.code === "policy_denied";
  return (
    <>
      <Section title="Inputs" description="Typed into the agent's session as if at its prompt.">
        <form onSubmit={(e) => void send(e)} className="flex max-w-2xl flex-col gap-field">
          <Field label="Instruction">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          </Field>
          <div>
            <Button type="submit" variant="primary" loading={input.busy}>
              Send instruction
            </Button>
          </div>
          <ActionResult outcome={input.outcome} />
        </form>
      </Section>
      <Section
        title="Controls"
        description="Soft stop asks the agent to finish; force stop kills it."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={stop.busy}
              onClick={() =>
                void stop.run(
                  () => client.sessions.stop(sessionId, { mode: "soft" }),
                  () => "Soft stop requested",
                )
              }
            >
              Soft stop
            </Button>
            <Button variant="danger" onClick={() => setConfirmForce(true)}>
              Force stop…
            </Button>
          </div>
          <p className="text-sm text-muted">
            Force stop requires an approved runtime.force_stop request; without it the server
            refuses (403).
          </p>
          <ActionResult outcome={stop.outcome} />
          {denied && (
            <p className="text-sm">
              Request or decide the approval in{" "}
              <Link href="/reviews" className="font-medium text-accent-fg underline">
                Reviews
              </Link>
              .
            </p>
          )}
        </div>
        <ConfirmDialog
          open={confirmForce}
          onOpenChange={setConfirmForce}
          title="Force stop this agent?"
          description="The session is killed at once; unsaved work in it is lost."
          confirmLabel="Confirm force stop"
          tone="danger"
          onConfirm={() => {
            setConfirmForce(false);
            void stop.run(
              () => client.sessions.stop(sessionId, { mode: "force" }),
              () => "Force stop requested",
            );
          }}
        />
      </Section>
    </>
  );
}

function Cost({ agentId }: { agentId: AgentId }) {
  const { client } = useStore();
  const usage = useAsync(() => client.usage.get({ agentId }), agentId);
  if (usage.status === "loading") return <LoadingState label="cost" />;
  if (usage.status === "error") return <ErrorState message={usage.error} onRetry={usage.reload} />;
  return <UsageChips totals={usage.data.totals} />;
}

export function AgentInspector() {
  const { sessionId = "" } = useParams();
  const { state } = useStore();
  const agent = state.agents.find((a) => a.runtimeSessionId === sessionId);
  if (state.status === "ready" && !agent) {
    return (
      <Screen screen="agent" title="Agent">
        <EmptyState
          compact={false}
          body={
            <>
              No agent is bound to session <code className="font-mono">{sessionId}</code>. It may
              have exited or not started yet.
            </>
          }
          action={<Link href="/missions">Back to missions</Link>}
        >
          Agent not found
        </EmptyState>
      </Screen>
    );
  }
  const boundSession = agent?.runtimeSessionId ?? null;
  const task = agent?.taskId ? state.tasks.find((t) => t.id === agent.taskId) : undefined;
  const crew = agent ? state.crews.find((c) => c.id === agent.crewId) : undefined;
  const missionId = task?.missionId ?? crew?.missionId;
  const mission = missionId ? state.missions.find((m) => m.id === missionId) : undefined;
  const project = mission ? state.projects.find((p) => p.id === mission.projectId) : undefined;
  const worktree = task ? state.worktrees.find((w) => w.taskId === task.id) : undefined;
  const timeline = state.events.filter(
    (e) => e.sessionId === sessionId || (agent?.taskId != null && e.taskId === agent.taskId),
  );
  const title = agent ? `Agent ${agent.role} (${agent.agentKind})` : "Agent";
  const live = agent ? LIVE.has(agent.status) : false;

  const terminal = boundSession && (
    <Section
      title="Terminal"
      term="Agent session"
      description="What the agent's terminal shows now: the live output of the session."
    >
      <Terminal sessionId={boundSession} live={live} />
    </Section>
  );

  return (
    <Screen
      screen="agent"
      title={title}
      breadcrumbs={[
        ...(project ? [{ label: project.name }] : []),
        ...(mission
          ? [{ label: missionName(mission, state.tasks), href: `/missions/${mission.id}` }]
          : [{ label: "Missions", href: "/missions" }]),
        { label: title },
      ]}
      description={
        agent ? (
          <span className="inline-flex flex-wrap items-center gap-2 align-middle">
            <StatusBadge status={agent.status} domain="session" />
            {task ? taskName(task) : "No task assigned"}
          </span>
        ) : undefined
      }
    >
      <StoreGate label="agent">
        {agent && boundSession && (
          <>
            {live && terminal}
            <Section title="State">
              <KeyValue
                items={[
                  {
                    label: "Runtime state",
                    value: (
                      <span className="flex items-center gap-2">
                        <StatusBadge status={agent.status} domain="session" />
                        {agent.status === "unknown" ? (
                          <span className="text-muted">not reported</span>
                        ) : (
                          <ProvenanceBadge provenance="observed" />
                        )}
                      </span>
                    ),
                  },
                  {
                    label: "Task",
                    term: "Task",
                    value: task ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/missions/${task.missionId}`}
                          className="text-accent-fg hover:underline"
                        >
                          {taskName(task)}
                        </Link>
                        <StatusBadge status={task.status} domain="task" size="sm" />
                      </span>
                    ) : (
                      "none"
                    ),
                  },
                  ...(crew
                    ? [
                        {
                          label: "Crew",
                          term: "Crew",
                          value: (
                            <Link
                              href={`/crews/${crew.id}`}
                              className="text-accent-fg hover:underline"
                            >
                              {crewLabel(crew)}
                            </Link>
                          ),
                        },
                      ]
                    : []),
                  {
                    label: "Session",
                    term: "Agent session",
                    value: <span className="font-mono text-xs break-all">{sessionId}</span>,
                  },
                  ...(worktree
                    ? [
                        {
                          label: "Worktree",
                          term: "Worktree",
                          value: (
                            <span className="font-mono text-xs break-all">
                              {worktree.path} ({worktree.branch})
                            </span>
                          ),
                        },
                      ]
                    : []),
                  { label: "Agent ID", value: <Id value={agent.id} label="Agent ID" /> },
                ]}
              />
            </Section>
            {!live && terminal}
            <Controls sessionId={boundSession} />
            <Section title="Timeline">
              <EventList
                events={timeline}
                tasks={task ? [task] : []}
                maxHeight="28rem"
                empty="No events for this session since this page loaded"
                emptyBody="Older events are in the mission's Timeline tab."
              />
            </Section>
            <Section title="Cost">
              <Cost agentId={agent.id} />
            </Section>
          </>
        )}
      </StoreGate>
    </Screen>
  );
}
