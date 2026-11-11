import type { Agent, Task } from "@mimir/protocol";
import { Icon, Link } from "@factory/ui";
import { useState } from "react";
import { taskHeadline } from "../lib/names.js";

const ACTIVE_TASK = new Set(["leased", "running", "verifying"]);

/** The agent session working on a task right now (newest when a retry started another). */
export function liveSession(task: Task, agents: readonly Agent[]): string | null {
  if (!ACTIVE_TASK.has(task.status)) return null;
  const mine = agents
    .filter((a) => a.taskId === task.id && a.runtimeSessionId !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return mine[0]?.runtimeSessionId ?? null;
}

/** Link to the agent inspector with its terminal already following (`?follow=1`), for a running task. */
export function LiveOutputLink({ sessionId, taskLabel }: { sessionId: string; taskLabel: string }) {
  return (
    <Link
      href={`/agents/${sessionId}?follow=1`}
      aria-label={`Live output of ${taskLabel}`}
      className="inline-flex items-center gap-1 rounded-sm text-xs font-medium whitespace-nowrap text-accent-fg hover:underline"
    >
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-progress-fg" />
      Live output
      <Icon name="arrowRight" size={12} />
    </Link>
  );
}

/**
 * A task as a reader wants it: the planner key, the first sentence of its prompt (clamped), and
 * the whole prompt plus acceptance criteria behind a "Prompt" disclosure.
 */
export function TaskTitle({ task, clamp = 2 }: { task: Task; clamp?: 1 | 2 | 3 }) {
  const h = taskHeadline(task.title);
  const clampClass = clamp === 1 ? "line-clamp-1" : clamp === 3 ? "line-clamp-3" : "line-clamp-2";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {h.key && <span className="font-mono text-xs font-semibold text-muted">{h.key}</span>}
      <span className={`${clampClass} text-sm [overflow-wrap:anywhere]`} title={h.summary}>
        {h.summary}
      </span>
      <PromptDisclosure task={task} />
    </div>
  );
}

/**
 * Native details: the full prompt and acceptance, kept out of the way until asked for. The body
 * renders only while open (prompts are long; a board can hold dozens).
 */
export function PromptDisclosure({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group text-xs"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="inline-flex cursor-pointer list-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus items-center gap-1 rounded-sm text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <Icon name="chevronRight" size={12} className="transition-transform group-open:rotate-90" />
        Prompt
      </summary>
      {open && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-line bg-sunken p-3">
          <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{task.title}</p>
          {task.acceptance.trim() && (
            <div>
              <p className="font-semibold text-muted">Acceptance</p>
              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{task.acceptance}</p>
            </div>
          )}
        </div>
      )}
    </details>
  );
}
