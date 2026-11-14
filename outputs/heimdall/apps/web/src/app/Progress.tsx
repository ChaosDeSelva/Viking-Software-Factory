// Commands that run for minutes show here instead of in a blocking dialog: what is running and
// for how long, so the operator can keep working and knows it has not stalled.
import { useEffect, useState } from "react";

export interface PendingCommand {
  key: string;
  label: string;
  startedAt: number;
}

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function Progress({ pending }: { pending: readonly PendingCommand[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pending.length) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);
  if (!pending.length) return null;
  return (
    <div
      role="status"
      aria-label="Work in progress"
      className="fixed top-20 left-4 z-[var(--z-toast)] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {pending.map((p) => (
        <div
          key={p.key}
          className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-sm shadow-lg"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-fg">{p.label}…</span>
            <span className="font-mono text-xs text-muted tabular-nums">
              {elapsed(now - p.startedAt)}
            </span>
          </div>
          <div
            className="h-1 overflow-hidden rounded-full bg-sunken"
            aria-hidden
          >
            <div className="h-full w-1/3 animate-[progress-slide_1.6s_ease-in-out_infinite] rounded-full bg-accent" />
          </div>
          <p className="text-xs text-muted">
            An agent is reading the repository; this usually takes a few
            minutes. You can keep working.
          </p>
        </div>
      ))}
    </div>
  );
}
