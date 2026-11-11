// The one place a page says its controls are locked. Each disabled control then carries only its
// own reason (Button `disabledReason`), instead of repeating the access sentence under every one.
import { Callout, Link } from "@factory/ui";
import { useHeimdall } from "../app/context";

/** The access reasons `actionBlock` returns; the callout covers them, so lists below leave them out. */
const ACCESS_REASONS = [
  "Unlock operator controls under Connections first.",
  "Pair with Sindri under Connections first.",
];
/** Control-specific reasons only (empty and access reasons dropped), for a `Reasons` line. */
export const ownReasons = (...reasons: (string | null | undefined | false)[]) =>
  reasons.filter((r): r is string => !!r && !ACCESS_REASONS.includes(r));

/**
 * Shown when the session cannot act: read-only, or (with `pairing`) not paired with Sindri.
 * Links to Connections › Access, where both are fixed.
 */
export function AccessCallout({
  pairing = false,
  children,
}: {
  pairing?: boolean;
  children?: string;
}) {
  const { session, href } = useHeimdall();
  const locked = !session.operator;
  if (!locked && (!pairing || session.pairedSindri)) return null;
  const text =
    children ??
    (locked
      ? "This session is read-only. Unlock operator controls to act here."
      : "Pair Sindri's approval session to act here.");
  return (
    <Callout
      tone="warning"
      title={locked ? "Read-only session" : "Sindri is not paired"}
      action={
        <Link
          href={href("connections", {}, "access")}
          className="text-sm font-medium text-accent-fg hover:underline"
        >
          {locked ? "Unlock controls" : "Pair Sindri"}
        </Link>
      }
    >
      {text}
    </Callout>
  );
}
