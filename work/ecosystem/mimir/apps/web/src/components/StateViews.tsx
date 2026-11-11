import {
  EmptyState as UiEmptyState,
  ErrorState as UiErrorState,
  SkeletonCard,
  type IconName,
} from "@factory/ui";
import type { ReactNode } from "react";

/** Skeleton lines plus a polite "Loading …" announcement (never zeros rendered as data). */
export function LoadingState({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div role="status" className="flex flex-col gap-2">
      <span className="sr-only">Loading {label}…</span>
      <SkeletonCard lines={lines} />
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  title,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
  title?: string | undefined;
}) {
  return (
    <UiErrorState
      title={title ?? "Could not load this"}
      message={message}
      {...(onRetry ? { onRetry, retryLabel: "Retry" } : {})}
    />
  );
}

/**
 * Nothing to show: `children` is the headline, `body` why it is empty, `action` what to do next.
 * Compact by default, since it usually sits inside a card.
 */
export function EmptyState({
  children,
  body,
  action,
  icon,
  compact = true,
}: {
  children: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
  compact?: boolean;
}) {
  return (
    <UiEmptyState
      title={children}
      compact={compact}
      {...(body ? { body } : {})}
      {...(action ? { action } : {})}
      {...(icon ? { icon } : {})}
    />
  );
}
