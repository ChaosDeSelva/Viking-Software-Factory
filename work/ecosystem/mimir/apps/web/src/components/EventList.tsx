import type { EventEnvelope, Task } from "@mimir/protocol";
import { Id, Timestamp } from "@factory/ui";
import { useMemo, type ReactNode } from "react";
import { taskName } from "../lib/names.js";
import { ProvenanceBadge } from "./Badges.js";
import { EmptyState } from "./StateViews.js";

function summarize(e: EventEnvelope): string {
  const p = e.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return "";
  if (typeof p["from"] === "string" && typeof p["to"] === "string")
    return `${p["from"]} → ${p["to"]}`;
  if (typeof p["text"] === "string") return (p["text"] as string).slice(0, 160);
  if (typeof p["reason"] === "string") return p["reason"] as string;
  if (typeof p["action"] === "string") return p["action"] as string;
  if (typeof p["command"] === "string")
    return `${p["command"]} → ${p["passed"] ? "passed" : "failed"}`;
  return "";
}

/**
 * Event rows, newest first: relative time (absolute in the tooltip), type, provenance as text,
 * a one-line summary and the task by name when `tasks` can resolve it. Payload text is rendered as
 * text, never HTML.
 */
export function EventList({
  events,
  empty = "No events yet.",
  emptyBody,
  emptyAction,
  tasks,
  maxHeight,
}: {
  events: readonly EventEnvelope[];
  empty?: string;
  emptyBody?: ReactNode;
  emptyAction?: ReactNode;
  /** Resolves `taskId` to a readable name. */
  tasks?: readonly Task[];
  /** Scroll inside the list (e.g. "28rem") instead of growing the page. */
  maxHeight?: string;
}) {
  const names = useMemo(
    () => new Map((tasks ?? []).map((t) => [t.id as string, taskName(t)])),
    [tasks],
  );
  if (events.length === 0)
    return (
      <EmptyState body={emptyBody} action={emptyAction} icon="clock">
        {empty}
      </EmptyState>
    );
  const rows = [...events].reverse();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        Newest first, by event time. Mimir orders events only within a stream; there is no global
        order.
      </p>
      <ol
        className="divide-y divide-line overflow-y-auto rounded-md border border-line"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {rows.map((e) => {
          const summary = summarize(e);
          const task = e.taskId ? names.get(e.taskId) : undefined;
          return (
            <li
              key={e.id}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]"
            >
              <Timestamp value={e.occurredAt} className="text-xs text-muted" />
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-medium">{e.type}</span>
                  <ProvenanceBadge provenance={e.provenance} />
                </div>
                {summary && (
                  <p className="break-words text-fg [overflow-wrap:anywhere]">{summary}</p>
                )}
                {e.taskId &&
                  (task ? (
                    <p className="truncate text-xs text-muted" title={task}>
                      Task: {task}
                    </p>
                  ) : (
                    <Id value={e.taskId} label="Task ID" />
                  ))}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
