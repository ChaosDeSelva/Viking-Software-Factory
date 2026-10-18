import type { Provenance, UsageTotals } from "@mimir/protocol";
import type { Progress } from "../lib/derive.js";

const chip = "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium border";

const PROVENANCE_STYLE: Record<Provenance, { cls: string; title: string }> = {
  observed: {
    cls: "bg-emerald-50 text-emerald-900 border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-400",
    title: "Observed: reported directly by the runtime or Mimir",
  },
  derived: {
    cls: "bg-sky-50 text-sky-900 border-sky-700 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-400",
    title: "Derived: computed by Mimir from observed events",
  },
  summarized: {
    cls: "bg-violet-50 text-violet-900 border-violet-700 dark:bg-violet-950 dark:text-violet-100 dark:border-violet-400",
    title: "Summarized: an AI summary, not an observation",
  },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const s = PROVENANCE_STYLE[provenance];
  return (
    <span className={`${chip} ${s.cls}`} title={s.title}>
      {provenance}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  completed:
    "bg-emerald-50 text-emerald-900 border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-400",
  approved:
    "bg-emerald-50 text-emerald-900 border-emerald-700 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-400",
  running:
    "bg-sky-50 text-sky-900 border-sky-700 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-400",
  active:
    "bg-sky-50 text-sky-900 border-sky-700 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-400",
  leased:
    "bg-sky-50 text-sky-900 border-sky-700 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-400",
  verifying:
    "bg-indigo-50 text-indigo-900 border-indigo-700 dark:bg-indigo-950 dark:text-indigo-100 dark:border-indigo-400",
  blocked:
    "bg-amber-50 text-amber-900 border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-400",
  pending:
    "bg-amber-50 text-amber-900 border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-400",
  failed:
    "bg-red-50 text-red-900 border-red-700 dark:bg-red-950 dark:text-red-100 dark:border-red-400",
  rejected:
    "bg-red-50 text-red-900 border-red-700 dark:bg-red-950 dark:text-red-100 dark:border-red-400",
  unknown:
    "bg-zinc-100 text-zinc-900 border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:border-zinc-400",
};
const NEUTRAL =
  "bg-zinc-50 text-zinc-900 border-zinc-500 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-400";

export function StatusBadge({ status }: { status: string }) {
  return <span className={`${chip} ${STATUS_TONE[status] ?? NEUTRAL}`}>{status}</span>;
}

const numberFmt = new Intl.NumberFormat("en-US");
const costFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

/** Usage totals with per-source sample counts. Never fills in missing data. */
export function UsageChips({ totals }: { totals: UsageTotals }) {
  const { measured, estimated, unavailable } = totals.bySource;
  const incomplete = estimated > 0 || unavailable > 0;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>
        {numberFmt.format(totals.tokens)} tokens, {costFmt.format(totals.estimatedCost)} (
        {totals.samples} samples)
      </span>
      <span className={`${chip} ${STATUS_TONE["completed"]}`}>measured: {measured}</span>
      <span className={`${chip} ${STATUS_TONE["pending"]}`}>estimated: {estimated}</span>
      <span className={`${chip} ${STATUS_TONE["unknown"]}`}>unavailable: {unavailable}</span>
      {incomplete && (
        <span className="text-xs text-zinc-700 dark:text-zinc-300">
          Totals are incomplete: some usage is estimated or unavailable.
        </span>
      )}
    </div>
  );
}

export function ProgressText({ progress }: { progress: Progress }) {
  return (
    <span>
      {progress.completed} of {progress.total} tasks completed
    </span>
  );
}
