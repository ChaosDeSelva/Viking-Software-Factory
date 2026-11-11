// The agent's live session: terminal output, tool calls and runtime facts, polled every 2 s from
// Mimir through Heimdall (`/api/agents/:id/telemetry`). This is the view the operator opens to
// watch an agent work, so it leads the agent inspector and follows the end of the output.
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  Disclosure,
  KeyValue,
  Timestamp,
  Callout,
} from "@factory/ui";
import { useEffect, useRef, useState } from "react";
import type { R } from "../lib/api";
import { Status } from "../components/app";
import { poller } from "./poll";

/** Tool calls and results found in the terminal's JSON lines (Codex items, Claude content blocks). */
export function toolCalls(text: string): { model?: string; tools: R[] } {
  const tools: R[] = [];
  let model: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      model ??= event.model ?? event.message?.model;
      if (
        event.item?.type?.includes("command") ||
        event.item?.type?.includes("tool")
      )
        tools.push(event.item);
      for (const c of event.message?.content ?? [])
        if (c.type === "tool_use" || c.type === "tool_result") tools.push(c);
    } catch {
      // Plain output lines are not events.
    }
  }
  return { model, tools };
}

export function LiveSession({
  agent,
  load,
}: {
  agent: R;
  load: () => Promise<R>;
}) {
  const [data, setData] = useState<R | null>(null),
    [error, setError] = useState(""),
    [paused, setPaused] = useState(false);
  const output = useRef<HTMLPreElement>(null);
  // Follow the end of the output unless the operator scrolled up to read.
  const following = useRef(true);
  useEffect(() => {
    if (paused) return;
    const poll = poller(
      load,
      (d) => {
        setData(d);
        setError("");
      },
      (e) => setError(e.message),
    );
    poll.tick();
    const timer = setInterval(poll.tick, 2000);
    return () => {
      poll.stop();
      clearInterval(timer);
    };
  }, [agent.id, paused]);
  const text: string = data?.terminal?.text ?? "";
  useEffect(() => {
    const el = output.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const { model: seenModel, tools } = toolCalls(text);
  const model = data?.info?.model ?? seenModel;
  const observed = data?.info?.observedAt;
  const stale = observed ? Date.now() - Date.parse(observed) > 30000 : null;
  const ended = ["completed", "failed", "stopped"].includes(agent.status);
  const elapsed = agent.createdAt
    ? Math.max(
        0,
        Math.floor(
          ((ended ? Date.parse(agent.updatedAt) : Date.now()) -
            Date.parse(agent.createdAt)) /
            1000,
        ),
      )
    : null;
  return (
    <Card
      title="Live session"
      term="Agent session"
      description={
        paused
          ? "Display frozen. Resume to keep following the agent."
          : "Updates every 2 seconds while this inspector is open."
      }
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={paused ? "refresh" : "clock"}
          onClick={() => setPaused(!paused)}
        >
          {paused ? "Resume updates" : "Freeze display"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <Callout tone="warning" title="The session could not be read">
            <span role="status">{error}</span>
          </Callout>
        )}
        <KeyValue
          columns={2}
          items={[
            {
              label: "Session state",
              value: (
                <Status value={data?.info?.session?.state ?? agent.status} />
              ),
            },
            {
              label: "Model reported by runtime",
              value: model ?? "Not reported",
            },
            {
              label: "Runtime observation",
              value: observed ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Timestamp value={observed} />
                  {stale !== null && (
                    <Badge tone={stale ? "warning" : "forest"}>
                      {stale ? "stale" : "fresh"}
                    </Badge>
                  )}
                </span>
              ) : (
                "Not available"
              ),
            },
            {
              label: "Elapsed session time",
              value: elapsed === null ? "Not reported" : `${elapsed} seconds`,
            },
          ]}
        />
        {(data?.errors ?? []).map((e: string) => (
          <p key={e} className="text-sm text-muted">
            {e}
          </p>
        ))}
        <section aria-label="Live output" className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">
            Live output · last 500 lines
          </h4>
          <pre
            ref={output}
            role="log"
            aria-label="Agent terminal output"
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget;
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="terminal-output max-h-[60vh] min-h-40 overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-xs"
          >
            {text ||
              "No terminal output available. Historical session.output events remain in the task timeline."}
          </pre>
        </section>
        <Disclosure title={`Tool calls and results (${tools.length})`}>
          {tools.length ? (
            <div className="flex flex-col gap-2">
              {tools.slice(-30).map((tool, i) => (
                <Disclosure
                  key={i}
                  title={`${tool.name ?? tool.type} · ${tool.status ?? "recorded"}`}
                >
                  <CodeBlock
                    code={JSON.stringify(tool, null, 2)}
                    maxHeight="320px"
                  />
                </Disclosure>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">
              No structured tool calls in the current terminal window.
            </p>
          )}
        </Disclosure>
      </div>
    </Card>
  );
}
