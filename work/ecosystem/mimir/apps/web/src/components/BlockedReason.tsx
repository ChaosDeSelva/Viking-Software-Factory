import { Tooltip, cn, focusRing } from "@factory/ui";
import { describeBlockedReason } from "../lib/blockedReason.js";

/**
 * Why a task is blocked, in plain words; the raw `blockedReason` sits in a tooltip (focusable)
 * and in `data-blocked-reason`. Unknown values render raw, without a tooltip.
 */
export function BlockedReason({ reason, className }: { reason: string; className?: string }) {
  const r = describeBlockedReason(reason);
  if (!r.known)
    return (
      <span data-blocked-reason={r.raw} className={className}>
        {r.words}
      </span>
    );
  return (
    <Tooltip content={<span className="font-mono break-all">Reason code: {r.raw}</span>}>
      <span
        tabIndex={0}
        data-blocked-reason={r.raw}
        className={cn(
          "rounded-sm underline decoration-dotted underline-offset-2",
          focusRing,
          className,
        )}
      >
        {r.words}
      </span>
    </Tooltip>
  );
}
