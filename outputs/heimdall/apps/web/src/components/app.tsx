// Small Heimdall wrappers over @factory/ui so every screen shows statuses, raw records and
// blocked-action reasons the same way.
import { statusInfo, screenHref } from "@factory/docs";
import { Badge, CodeBlock, Disclosure, Link, StatusPill } from "@factory/ui";
import type { ReactNode } from "react";
import type { R } from "../lib/api";

/**
 * A status pill with the docs label and meaning. Unknown values keep their raw text (never throw):
 * Sindri and Mimir ship separately and may send a status this build does not know.
 */
export function Status({
  value,
  domain,
  size,
  tooltip,
}: {
  value: unknown;
  domain?: string | undefined;
  size?: "sm" | "md";
  tooltip?: boolean;
}) {
  const raw = value == null ? "unknown" : String(value);
  const info = statusInfo("heimdall", raw, domain);
  return (
    <StatusPill
      app="heimdall"
      value={raw}
      domain={domain}
      label={info?.label}
      description={info?.short}
      size={size}
      tooltip={tooltip}
    />
  );
}

/** The source record behind a view, collapsed: Heimdall shows what the source sent. */
export function Raw({
  data,
  title = "Source record",
}: {
  data: unknown;
  title?: string;
}) {
  return (
    <Disclosure title={title}>
      <CodeBlock
        code={JSON.stringify(data, null, 2) ?? "null"}
        maxHeight="420px"
      />
    </Disclosure>
  );
}

/** Why one or more controls are unavailable, said once below them (deduplicated). */
/**
 * An intake's status. A saved request has no tracker status ("Received"); once a spec is drafted
 * from it, the work continues there, so every list and the drawer say so the same way.
 */
export function IntakeStatus({
  row,
  specs,
  size,
}: {
  row: R;
  specs: readonly R[];
  size?: "sm" | "md";
}) {
  if (specs.some((s) => s.intakeId === row.id))
    return <Badge tone="info">Spec drafted</Badge>;
  return (
    <Status
      value={row.status ?? "received"}
      domain="intake"
      size={size}
      tooltip={false}
    />
  );
}

export function Reasons({
  reasons,
}: {
  reasons: (string | null | undefined | false)[];
}) {
  const list = [...new Set(reasons.filter(Boolean) as string[])];
  return list.length ? (
    <p className="text-sm text-muted">{list.join(" ")}</p>
  ) : null;
}

/**
 * "Learn more" link into this app's screen guide, for `PageHeader learnMore`: there it shares a
 * no-wrap run with the term's InfoHint, so the "?" never wraps onto a line of its own.
 */
export function LearnMore({ screen }: { screen: string }) {
  const href = screenHref("heimdall", screen);
  return href ? (
    <Link href={href} className="font-medium text-accent-fg hover:underline">
      Learn more
    </Link>
  ) : null;
}

export const when = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString() : "Not reported";

/** Display label for a source record: its title, objective, name, … in that order. */
export { recordLabel as label } from "../features/workflowState";
export type { R };
