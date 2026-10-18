import type { EventEnvelope } from "@mimir/protocol";
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

/** Event rows, newest first. Every row carries its provenance as text. */
export function EventList({
  events,
  empty = "No events yet.",
}: {
  events: readonly EventEnvelope[];
  empty?: string;
}) {
  if (events.length === 0) return <EmptyState>{empty}</EmptyState>;
  const rows = [...events].reverse();
  return (
    <>
      <p className="mb-1 text-xs text-zinc-700 dark:text-zinc-300">
        Newest first, by event time. Mimir orders events only within a stream; there is no global
        order.
      </p>
      <ol className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline gap-2 py-1 text-sm">
            <time
              dateTime={e.occurredAt}
              className="font-mono text-xs text-zinc-700 dark:text-zinc-300"
            >
              {e.occurredAt.slice(11, 19)}
            </time>
            <span className="font-mono">{e.type}</span>
            <ProvenanceBadge provenance={e.provenance} />
            <span className="text-zinc-800 dark:text-zinc-200">{summarize(e)}</span>
            {e.taskId && (
              <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{e.taskId}</span>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}
