import type { AgentId, SessionId } from "@mimir/protocol";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { describeError, type TerminalReadResponse } from "../api/client.js";
import { ActionResult } from "../components/ActionResult.js";
import { ProvenanceBadge, StatusBadge, UsageChips } from "../components/Badges.js";
import { EventList } from "../components/EventList.js";
import { PageTitle, Section } from "../components/Section.js";
import { EmptyState, ErrorState, LoadingState } from "../components/StateViews.js";
import { StoreGate } from "../components/StoreGate.js";
import { useAction } from "../lib/useAction.js";
import { useAsync } from "../lib/useAsync.js";
import { useStore } from "../store/StoreProvider.js";

/** Terminal reads are on demand; refresh is never allowed faster than this. */
export const TERMINAL_MIN_INTERVAL_MS = 2000;
const TERMINAL_LINES = 200;

function Terminal({ sessionId }: { sessionId: SessionId }) {
  const { client } = useStore();
  const [data, setData] = useState<TerminalReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!cooling) return;
    const t = setTimeout(() => setCooling(false), TERMINAL_MIN_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [cooling]);

  const caps = useAsync(() => client.capabilities(), "caps");
  if (caps.status === "ready" && !caps.data.runtime?.features.terminalRead) {
    return <EmptyState>The runtime does not support terminal reads.</EmptyState>;
  }
  const load = async () => {
    setBusy(true);
    setCooling(true);
    setError(null);
    try {
      setData(await client.sessions.terminal(sessionId, { lines: TERMINAL_LINES }));
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        {data === null ? (
          <button
            type="button"
            className="btn"
            disabled={busy || cooling}
            onClick={() => void load()}
          >
            Read terminal
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy || cooling}
            onClick={() => void load()}
          >
            Refresh terminal
          </button>
        )}
        <span className="text-sm text-zinc-700 dark:text-zinc-300">
          Last {TERMINAL_LINES} lines, read on demand (at most every{" "}
          {TERMINAL_MIN_INTERVAL_MS / 1000} s). Terminal text is never used as agent state.
        </span>
      </div>
      {error && <ErrorState message={error} />}
      {data && (
        <>
          <p className="mb-1 flex items-center gap-2 text-xs">
            {data.provenance && <ProvenanceBadge provenance={data.provenance} />}
            {data.capturedAt && <span>captured {data.capturedAt}</span>}
          </p>
          <pre
            data-testid="terminal"
            tabIndex={0}
            aria-label="Terminal output"
            className="max-h-96 overflow-auto rounded bg-zinc-950 p-2 font-mono text-xs whitespace-pre text-zinc-100"
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
  const forceRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const refocusForce = useRef(false);
  useEffect(() => {
    if (confirmForce) confirmRef.current?.focus();
    else if (refocusForce.current) {
      refocusForce.current = false;
      forceRef.current?.focus();
    }
  }, [confirmForce]);
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
      <Section title="Inputs">
        <form onSubmit={(e) => void send(e)} className="grid max-w-xl gap-2">
          <label className="grid gap-1">
            <span className="font-medium">Instruction</span>
            <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <div>
            <button type="submit" className="btn btn-primary" disabled={input.busy}>
              Send instruction
            </button>
          </div>
          <ActionResult outcome={input.outcome} />
        </form>
      </Section>
      <Section title="Controls">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={stop.busy}
            onClick={() =>
              void stop.run(
                () => client.sessions.stop(sessionId, { mode: "soft" }),
                () => "Soft stop requested",
              )
            }
          >
            Soft stop
          </button>
          {!confirmForce ? (
            <button
              ref={forceRef}
              type="button"
              className="btn btn-danger"
              onClick={() => setConfirmForce(true)}
            >
              Force stop…
            </button>
          ) : (
            <>
              <button
                ref={confirmRef}
                type="button"
                className="btn btn-danger"
                disabled={stop.busy}
                onClick={() => {
                  refocusForce.current = true;
                  setConfirmForce(false);
                  void stop.run(
                    () => client.sessions.stop(sessionId, { mode: "force" }),
                    () => "Force stop requested",
                  );
                }}
              >
                Confirm force stop
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  refocusForce.current = true;
                  setConfirmForce(false);
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
          Force stop requires an approved runtime.force_stop request; without it the server refuses
          (403).
        </p>
        <ActionResult outcome={stop.outcome} />
        {denied && (
          <p className="mt-1 text-sm">
            Request or decide the approval in{" "}
            <Link className="underline" to="/reviews">
              Reviews
            </Link>
            .
          </p>
        )}
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
      <>
        <PageTitle>Agent</PageTitle>
        <EmptyState>
          No agent is bound to session <code>{sessionId}</code>. It may have exited or not started
          yet. <Link to="/missions">Back to missions</Link>
        </EmptyState>
      </>
    );
  }
  const boundSession = agent?.runtimeSessionId ?? null;
  const task = agent?.taskId ? state.tasks.find((t) => t.id === agent.taskId) : undefined;
  const worktree = task ? state.worktrees.find((w) => w.taskId === task.id) : undefined;
  const timeline = state.events.filter(
    (e) => e.sessionId === sessionId || (agent?.taskId != null && e.taskId === agent.taskId),
  );
  return (
    <StoreGate label="agent">
      {agent && boundSession && (
        <>
          <PageTitle>
            Agent {agent.role} ({agent.agentKind})
          </PageTitle>
          <Section title="State">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="font-medium">Runtime state</dt>
              <dd className="flex items-center gap-2">
                <StatusBadge status={agent.status} />
                {agent.status === "unknown" ? (
                  <span>not reported</span>
                ) : (
                  <ProvenanceBadge provenance="observed" />
                )}
              </dd>
              <dt className="font-medium">Task</dt>
              <dd>
                {task ? (
                  <Link className="underline" to={`/missions/${task.missionId}`}>
                    {task.title}
                  </Link>
                ) : (
                  "none"
                )}
                {task ? ` (${task.status})` : ""}
              </dd>
              <dt className="font-medium">Session</dt>
              <dd className="font-mono">{sessionId}</dd>
              {worktree && (
                <>
                  <dt className="font-medium">Worktree</dt>
                  <dd className="font-mono">
                    {worktree.path} ({worktree.branch})
                  </dd>
                </>
              )}
            </dl>
          </Section>
          <Section title="Terminal">
            <Terminal sessionId={boundSession} />
          </Section>
          <Controls sessionId={boundSession} />
          <Section title="Timeline">
            <EventList
              events={timeline}
              empty="No events for this session since this page loaded."
            />
          </Section>
          <Section title="Cost">
            <Cost agentId={agent.id} />
          </Section>
        </>
      )}
    </StoreGate>
  );
}
