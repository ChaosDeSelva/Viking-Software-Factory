import type { ReactNode } from "react";
import { Button, StatusBadge, cn } from "../ui";
export function RecordRow({
  title,
  description,
  status,
  onClick,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: unknown;
  onClick: () => void;
}) {
  return (
    <Button
      variant="unstyled"
      className="row group flex w-full items-center gap-4 border-0 px-4 py-4 text-left hover:bg-accent/5"
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">
        <strong className="line-clamp-2 text-base font-medium leading-relaxed">
          {title}
        </strong>
        {description && (
          <small className="mt-1 block truncate text-xs text-muted">
            {description}
          </small>
        )}
      </span>
      {status != null && <StatusBadge value={status} />}
      <span
        aria-hidden
        className="text-muted transition-transform group-hover:translate-x-1 group-hover:text-accent"
      >
        ↗
      </span>
    </Button>
  );
}
export function TaskCard({
  title,
  crew,
  status,
  detail,
  onClick,
}: {
  title: string;
  crew: string;
  status: unknown;
  detail: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="unstyled"
      className="task-card group flex w-full flex-col items-start gap-3 rounded-xl border border-line bg-panel p-5 text-left transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-lg motion-reduce:transform-none"
      onClick={onClick}
    >
      <span className="text-xs font-medium tracking-wider text-violet uppercase">
        {crew}
      </span>
      <strong className="line-clamp-3 text-base leading-relaxed">
        {title}
      </strong>
      <StatusBadge value={status} />
      <small className="text-xs leading-relaxed text-muted">{detail}</small>
    </Button>
  );
}
export function MetricCard({
  name,
  value,
  description,
  onClick,
  index = 0,
}: {
  name: string;
  value: string;
  description: string;
  onClick: () => void;
  index?: number;
}) {
  return (
    <Button
      variant="unstyled"
      className={cn(
        "metric group relative overflow-hidden rounded-2xl border border-line bg-surface p-6 text-left transition hover:-translate-y-1 hover:border-accent/40 motion-reduce:transform-none",
        index === 3 && "border-violet/25",
      )}
      onClick={onClick}
    >
      <small className="flex justify-between text-sm text-muted">
        {name}
        <span aria-hidden className="text-accent">
          ↗
        </span>
      </small>
      <strong className="my-4 block text-5xl font-medium tracking-tight text-foreground tabular-nums">
        {value}
      </strong>
      <span className="text-xs text-muted">{description}</span>
    </Button>
  );
}
export function FactoryPulse({
  tasks,
  sources,
  onInspect,
}: {
  tasks: { status: string }[];
  sources: Record<string, { status: string }>;
  onInspect: () => void;
}) {
  const completed = tasks.filter((t) => t.status === "completed").length;
  const running = tasks.filter((t) =>
    ["running", "starting", "leased", "verifying"].includes(t.status),
  ).length;
  const blocked = tasks.filter((t) =>
    ["blocked", "failed"].includes(t.status),
  ).length;
  const percent = tasks.length
    ? Math.round((completed / tasks.length) * 100)
    : 0;
  return (
    <section
      aria-label="Factory pulse"
      className="factory-pulse relative mb-7 overflow-hidden rounded-xl border border-line bg-surface p-6"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 -right-24 size-96 rounded-full bg-violet/8 blur-3xl"
      />
      <div className="relative grid items-center gap-8 xl:grid-cols-[1fr_auto]">
        <div>
          <p className="mb-3 text-xs font-semibold tracking-[0.08em] text-accent uppercase">
            Operational intelligence
          </p>
          <h2 className="mb-3 text-2xl font-semibold tracking-tight sm:text-3xl">
            {running
              ? "Your factory is in motion."
              : blocked
                ? "Your factory needs attention."
                : tasks.length && completed === tasks.length
                  ? "Work completed. Evidence preserved."
                  : tasks.length
                    ? "Work is waiting."
                  : "Ready for your next idea."}
          </h2>
          <p className="max-w-2xl text-base leading-relaxed text-muted">
            {running
              ? `${running} tasks executing. Inspect the work, follow the evidence, and intervene when needed.`
              : blocked
                ? `${blocked} tasks are blocked or failed. Open the pipeline to inspect their source-reported reasons.`
                : tasks.length
                  ? `${completed} of ${tasks.length} tasks completed. Review verification and delivery before accepting the result.`
                  : "Connect an idea to an approved plan, then watch the agents build it."}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {["mimir", "sindri"].map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-2 rounded-md bg-input/50 px-3 py-1.5 text-xs"
              >
                <span className="font-medium capitalize">{name}</span>
                <StatusBadge
                  value={sources[name]?.status ?? "not configured"}
                />
              </span>
            ))}
          </div>
        </div>
        <Button
          variant="unstyled"
          onClick={onInspect}
          className="flex items-center gap-5 rounded-lg border border-transparent bg-input/50 p-5 text-left hover:border-accent/50"
          aria-label="Inspect factory pipeline"
        >
          <svg aria-hidden viewBox="0 0 100 100" className="size-24 -rotate-90">
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="var(--line)"
              strokeWidth="5"
            />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={`${percent * 2.639} 264`}
            />
          </svg>
          <span>
            <strong className="block text-3xl font-medium tabular-nums">
              {tasks.length ? percent + "%" : "—"}
            </strong>
            <span className="mt-1 block text-sm text-muted">
              Task completion
            </span>
            <span className="mt-2 block text-xs text-accent">
              Inspect pipeline ↗
            </span>
          </span>
        </Button>
      </div>
    </section>
  );
}
