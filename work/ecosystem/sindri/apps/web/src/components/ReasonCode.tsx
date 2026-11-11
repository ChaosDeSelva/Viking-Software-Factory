import { Tooltip, cn, focusRing } from "@factory/ui";
import { Fragment } from "react";
import { describeReason } from "../lib/reasonCodes.js";

/**
 * A reason code in plain words; the raw code sits in a tooltip (focusable, so keyboard users
 * reach it too) and in `data-reason-code`. Unknown codes render raw, without a tooltip.
 */
export function ReasonCode(props: { reason: string | null | undefined; gateId?: string }) {
  const r = describeReason(props.reason, props.gateId);
  if (!r.known) return <span data-reason-code={r.raw}>{r.words}</span>;
  return (
    <Tooltip content={<span className="font-mono break-all">Code: {r.raw}</span>}>
      <span
        tabIndex={0}
        data-reason-code={r.raw}
        className={cn("rounded-sm underline decoration-dotted underline-offset-2", focusRing)}
      >
        {r.words}
      </span>
    </Tooltip>
  );
}

/** A gate's failures, `; `-separated, each in plain words. */
export function GateFailureList(props: { failures: { gateId: string; reason: string }[] }) {
  return (
    <>
      {props.failures.map((f, i) => (
        <Fragment key={`${f.gateId}:${f.reason}:${i}`}>
          {i > 0 ? "; " : null}
          <ReasonCode gateId={f.gateId} reason={f.reason} />
        </Fragment>
      ))}
    </>
  );
}
