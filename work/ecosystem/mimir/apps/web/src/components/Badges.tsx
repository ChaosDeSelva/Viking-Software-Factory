import type { Provenance, UsageTotals } from "@mimir/protocol";
import { statusInfo } from "@factory/docs";
import { Badge, InfoHint, Progress, StatusPill, type BadgeTone } from "@factory/ui";
import type { Progress as TaskProgress } from "../lib/derive.js";

const PROVENANCE: Record<Provenance, { tone: BadgeTone; title: string }> = {
  observed: { tone: "forest", title: "Observed: reported directly by the runtime or Mimir" },
  derived: { tone: "info", title: "Derived: computed by Mimir from observed events" },
  summarized: { tone: "warning", title: "Summarized: an AI summary, not an observation" },
};

/** Where a fact came from, as text (never colour alone); the meaning is in the tooltip. */
export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  // A newer server may send a provenance this build does not know: show it neutral.
  const s = PROVENANCE[provenance] ?? {
    tone: "neutral" as const,
    title: `Provenance: ${provenance}`,
  };
  return (
    <Badge tone={s.tone} tooltip={s.title}>
      {provenance}
    </Badge>
  );
}

/**
 * Status pill with the shared docs label and meaning. `domain` picks the meaning when a value means
 * different things (a crew `running` vs a task `running`); unknown values render raw, never throw.
 */
export function StatusBadge({
  status,
  domain,
  size,
  tooltip,
}: {
  status: string;
  domain?: string | undefined;
  size?: "sm" | "md" | undefined;
  tooltip?: boolean | undefined;
}) {
  const info = statusInfo("mimir", status, domain);
  return (
    <StatusPill
      app="mimir"
      value={status}
      domain={domain}
      size={size}
      tooltip={tooltip}
      {...(info ? { label: info.label, description: info.short } : {})}
    />
  );
}

const numberFmt = new Intl.NumberFormat("en-US");
const costFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

export const formatTokens = (n: number) => numberFmt.format(n);
export const formatCost = (n: number) => costFmt.format(n);

/** Usage totals with per-source sample counts. Never fills in missing data. */
export function UsageChips({ totals }: { totals: UsageTotals }) {
  const { measured, estimated, unavailable } = totals.bySource;
  const incomplete = estimated > 0 || unavailable > 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums">
          {numberFmt.format(totals.tokens)} tokens
        </span>
        <span className="text-sm text-muted">
          {costFmt.format(totals.estimatedCost)} estimated cost · {totals.samples} samples
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Samples by source</span>
        <InfoHint term="Usage source" label="What are usage sources?">
          Measured: counted by the provider. Estimated: Mimir's estimate. Unavailable: the runtime
          reported no usage, so totals are a lower bound.
        </InfoHint>
        <Badge tone="forest">measured: {measured}</Badge>
        <Badge tone="warning">estimated: {estimated}</Badge>
        <Badge>unavailable: {unavailable}</Badge>
      </div>
      {incomplete && (
        <p className="text-xs text-muted">
          Totals are incomplete: some usage is estimated or unavailable.
        </p>
      )}
    </div>
  );
}

/** Completed/total tasks as a bar plus the counts in words (never a guessed percentage). */
export function ProgressText({ progress }: { progress: TaskProgress }) {
  const text = `${progress.completed} of ${progress.total} tasks completed`;
  return (
    <span className="flex min-w-36 items-center gap-2">
      <Progress
        value={progress.completed}
        max={Math.max(1, progress.total)}
        label={text}
        className="w-16 shrink-0"
      />
      <span className="text-sm whitespace-nowrap text-muted tabular-nums">{text}</span>
    </span>
  );
}
