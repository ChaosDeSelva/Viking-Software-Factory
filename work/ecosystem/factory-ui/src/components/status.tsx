import type { ComponentProps, ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { cn, focusRing } from "../lib.js";
import { statusRole, type FactoryApp, type StatusRole } from "../status.js";
import { Button } from "./controls.js";
import { Tooltip } from "./overlay.js";

export const roleClass: Record<StatusRole, string> = {
  neutral: "bg-neutral-bg text-neutral-fg border-neutral-border",
  progress: "bg-progress-bg text-progress-fg border-progress-border",
  waiting: "bg-waiting-bg text-waiting-fg border-waiting-border",
  success: "bg-success-bg text-success-fg border-success-border",
  warning: "bg-warning-bg text-warning-fg border-warning-border",
  danger: "bg-danger-bg text-danger-fg border-danger-border",
  ended: "bg-ended-bg text-ended-fg border-ended-border",
  unknown: "bg-unknown-bg text-unknown-fg border-unknown-border border-dashed",
};

export function StatusDot({ role, className }: { role: StatusRole; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        role === "ended" || role === "unknown" ? "border-[1.5px] border-current" : "bg-current",
        role === "progress" && "fui-pulse",
        className,
      )}
    />
  );
}

/**
 * Human label + dot coloured by role; tooltip holds the meaning and the raw value.
 * Unknown values never throw: they render the raw text with a dashed outline.
 */
export function StatusPill({
  app,
  value,
  domain,
  size = "md",
  tooltip = true,
  label,
  description,
  className,
}: {
  app: FactoryApp;
  value: unknown;
  domain?: string | undefined;
  /** Overrides the built-in label (e.g. from `@factory/docs` statusInfo). */
  label?: string | undefined;
  /** Overrides the tooltip meaning (e.g. docs `short` plus a "Learn more" link). */
  description?: ReactNode | undefined;
  size?: "sm" | "md" | undefined;
  /** Set false in dense tables to drop the tab stop; the label stays readable. */
  tooltip?: boolean | undefined;
  className?: string | undefined;
}) {
  const resolved = statusRole(app, value, domain);
  const s = { ...resolved, label: label ?? resolved.label };
  const pill = (
    <span
      role="img"
      aria-label={`Status: ${s.label}`}
      tabIndex={tooltip ? 0 : undefined}
      data-role={s.role}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "sm" ? "h-5 px-2 text-xs" : "h-6 px-2.5 text-xs",
        roleClass[s.role],
        tooltip ? focusRing : undefined,
        className,
      )}
    >
      <StatusDot role={s.role} />
      <span className="truncate">{s.label}</span>
    </span>
  );
  if (!tooltip) return pill;
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          <span>{description ?? s.meaning}</span>
          <span className="font-mono opacity-75">{s.raw}</span>
        </span>
      }
    >
      {pill}
    </Tooltip>
  );
}

export type BadgeTone = "neutral" | "accent" | "forest" | "info" | "warning" | "danger";
const badgeTone: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-muted border-line",
  accent: "bg-accent-soft text-accent-fg border-transparent",
  forest: "bg-forest-soft text-forest border-transparent",
  info: roleClass.progress,
  warning: roleClass.warning,
  danger: roleClass.danger,
};
/** Neutral metadata (role, kind, provenance, counts). Not for statuses: use StatusPill. */
export function Badge({
  tone = "neutral",
  tooltip,
  children,
  className,
}: {
  tone?: BadgeTone | undefined;
  tooltip?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  const badge = (
    <span
      tabIndex={tooltip ? 0 : undefined}
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1 rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap",
        badgeTone[tone],
        tooltip ? focusRing : undefined,
        className,
      )}
    >
      {children}
    </span>
  );
  return tooltip ? <Tooltip content={tooltip}>{badge}</Tooltip> : badge;
}
export const Tag = Badge;

export type CalloutTone = "info" | "success" | "warning" | "danger";
const calloutIcon: Record<CalloutTone, IconName> = {
  info: "info",
  success: "check",
  warning: "alert",
  danger: "alert",
};
const calloutRole: Record<CalloutTone, StatusRole> = {
  info: "progress",
  success: "success",
  warning: "warning",
  danger: "danger",
};
/**
 * Inline banner; one style for every tone. Other div props (aria-label, role, aria-*, id,
 * data-*) pass through, so a caller can name it or swap the default alert/note role.
 */
export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
  ...rest
}: Omit<ComponentProps<"div">, "title" | "children" | "className"> & {
  tone?: CalloutTone | undefined;
  title?: ReactNode | undefined;
  children?: ReactNode | undefined;
  action?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      {...rest}
      className={cn(
        "flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-start",
        roleClass[calloutRole[tone]],
        className,
      )}
    >
      <span className="mt-0.5 hidden sm:block">
        <Icon name={calloutIcon[tone]} />
      </span>
      <div className="min-w-0 flex-1 text-sm">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn("text-fg", title ? "mt-1" : undefined)}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Nothing to show yet: what this is, why it's empty, and what to do. Never italic. */
export function EmptyState({
  title,
  body,
  icon = "inbox",
  action,
  secondaryAction,
  compact = false,
  className,
}: {
  title: ReactNode;
  body?: ReactNode | undefined;
  icon?: IconName | undefined;
  action?: ReactNode | undefined;
  secondaryAction?: ReactNode | undefined;
  compact?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center text-center",
        compact
          ? "gap-2 rounded-md border border-dashed border-line px-4 py-6"
          : "gap-3 px-6 py-12",
        className,
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center rounded-full bg-sunken text-muted",
          compact ? "size-8" : "size-11",
        )}
      >
        <Icon name={icon} size={compact ? 16 : 20} />
      </span>
      <div className="flex max-w-[48ch] flex-col gap-1">
        <p className={cn("font-semibold text-fg", compact ? "text-sm" : "text-md")}>{title}</p>
        {body && <p className="text-sm text-muted">{body}</p>}
      </div>
      {(action || secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  details,
  onRetry,
  retryLabel = "Try again",
  className,
}: {
  title?: ReactNode | undefined;
  message?: ReactNode | undefined;
  details?: string | undefined;
  onRetry?: (() => void) | undefined;
  retryLabel?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-3 rounded-md border border-danger-border bg-danger-bg p-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-danger-fg">
          <Icon name="alert" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-danger-fg">{title}</p>
          {message && <p className="mt-1 text-fg">{message}</p>}
        </div>
      </div>
      {details && (
        <details className="group ml-7 text-sm">
          <summary className={cn("cursor-pointer rounded-sm text-muted hover:text-fg", focusRing)}>
            Technical details
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-sm bg-sunken p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
            {details}
          </pre>
        </details>
      )}
      {onRetry && (
        <div className="ml-7">
          <Button size="sm" icon="refresh" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("fui-skeleton block h-4 rounded-sm bg-hover", className)} />
  );
}

/** Placeholder lines while the first snapshot loads (never render zeros as data). */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-line bg-surface p-card",
        className,
      )}
    >
      <Skeleton className="h-5 w-2/5" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={i === lines - 1 ? "w-3/5" : "w-full"} />
      ))}
    </div>
  );
}

/** Loading → error → empty → content, with one announcement for screen readers. */
export function LoadState({
  loading,
  error,
  onRetry,
  empty,
  emptyState,
  skeleton,
  label = "Loading",
  children,
}: {
  loading: boolean;
  error?: unknown | undefined;
  onRetry?: (() => void) | undefined;
  empty?: boolean | undefined;
  emptyState?: ReactNode | undefined;
  skeleton?: ReactNode | undefined;
  label?: string | undefined;
  children: ReactNode;
}) {
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <ErrorState message={message} {...(onRetry ? { onRetry } : {})} />;
  }
  if (loading)
    return (
      <div role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">{label}…</span>
        {skeleton ?? <SkeletonCard />}
      </div>
    );
  if (empty) return <>{emptyState ?? <EmptyState title="Nothing here yet" compact />}</>;
  return <>{children}</>;
}
