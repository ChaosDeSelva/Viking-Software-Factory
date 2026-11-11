import { screenHref, statusInfo } from "@factory/docs";
import {
  Badge as FactoryBadge,
  Button as FactoryButton,
  Card as FactoryCard,
  EmptyState,
  ErrorState,
  InfoHint,
  Link,
  PageHeader,
  SkeletonCard,
  StatusPill,
  type ButtonProps,
  type Crumb,
} from "@factory/ui";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import type { Loadable } from "../store/context.js";
import { useStore } from "../store/context.js";
import type { View } from "../store/reducer.js";

/**
 * Sindri's thin layer over `@factory/ui`: Button, Card, Field, Empty, Badge, LoadState and
 * DetailHeading keep Sindri's props (screens and tests rely on them) but render the shared
 * components and tokens; ScreenHeader and Status are the screen chrome.
 */

export { Callout, Id, Timestamp } from "@factory/ui";

/** `@factory/ui` Card whose (non-flush) body stacks its children 16px apart. */
export function Card({ children, ...props }: ComponentProps<typeof FactoryCard>) {
  return (
    <FactoryCard {...props}>
      {children == null || props.flush ? (
        children
      ) : (
        <div className="flex flex-col gap-4">{children}</div>
      )}
    </FactoryCard>
  );
}

export function Button({ variant = "primary", type = "button", ...rest }: ButtonProps) {
  return <FactoryButton variant={variant} type={type} {...rest} />;
}

/** Native input/select/textarea look on the shared tokens (native keeps forms testable). */
export const inputClass =
  "block h-control-md w-full min-w-0 rounded-md border border-line bg-raised px-3 text-sm text-fg transition-colors placeholder:text-subtle hover:border-line-strong focus:border-focus focus:outline-2 focus:outline-offset-0 focus:outline-focus/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger-fg";
/** Multi-line variant: auto height, vertical padding. */
export const textareaClass = inputClass.replace("h-control-md", "min-h-24 py-2 leading-5");

/** Label + control + hint (`{id}-hint`, for aria-describedby); `term`/`info` add an InfoHint. */
export function Field(props: {
  label: string;
  id: string;
  hint?: ReactNode;
  term?: string;
  info?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-label">
      <div className="flex items-center gap-1.5">
        <label htmlFor={props.id} className="text-sm font-medium text-fg">
          {props.label}
        </label>
        {props.term || props.info ? (
          <InfoHint {...(props.term ? { term: props.term } : {})} label={`About ${props.label}`}>
            {props.info}
          </InfoHint>
        ) : null}
      </div>
      {props.children}
      {props.hint ? (
        <p id={`${props.id}-hint`} className="text-xs text-muted">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

/** In-card "nothing here" note: compact EmptyState (never italic), optional next action. */
export function Empty(props: { children: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return <EmptyState compact title={props.children} body={props.body} action={props.action} />;
}

/** Neutral metadata tag. Statuses use `Status`; `tone` maps onto badge tones. */
export function Badge(props: {
  children: ReactNode;
  tone?: "neutral" | "warn" | "ok" | "danger" | "info";
  tooltip?: ReactNode;
}) {
  const tone = (
    { neutral: "neutral", warn: "warning", ok: "forest", danger: "danger", info: "info" } as const
  )[props.tone ?? "neutral"];
  return (
    <FactoryBadge tone={tone} tooltip={props.tooltip}>
      {props.children}
    </FactoryBadge>
  );
}

/** `@factory/docs` status domains that `@factory/ui` names differently (colour by context). */
const UI_DOMAIN: Readonly<Record<string, string>> = {
  "steward-decision": "decision",
  "steward-mode": "stewardMode",
  "steward-state": "stewardState",
};

/**
 * Status pill with the plain-words meaning from `@factory/docs` (label, tooltip, "Learn more").
 * Unknown values render their raw text with the unknown role; nothing throws.
 */
export function Status(props: {
  value: string | null | undefined;
  domain?: string;
  size?: "sm" | "md";
  tooltip?: boolean;
}) {
  const raw = props.value ?? "unknown";
  const info = statusInfo("sindri", raw, props.domain);
  return (
    <StatusPill
      app="sindri"
      value={raw}
      {...(props.domain ? { domain: UI_DOMAIN[props.domain] ?? props.domain } : {})}
      {...(info ? { label: info.label, description: info.short } : {})}
      {...(props.size ? { size: props.size } : {})}
      {...(props.tooltip === false ? { tooltip: false } : {})}
    />
  );
}

/** Loading / error / ready switch with consistent copy. */
export function LoadState<T>(props: {
  state: Loadable<T>;
  what: string;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}) {
  if (props.state.status === "loading")
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading {props.what}…</span>
        <SkeletonCard lines={3} />
      </div>
    );
  if (props.state.status === "error")
    return (
      <ErrorState
        title={`Could not load ${props.what}: ${props.state.error}`}
        retryLabel="Retry"
        {...(props.onRetry ? { onRetry: props.onRetry } : {})}
      />
    );
  return <>{props.children(props.state.data)}</>;
}

/**
 * A detail-view heading that takes focus when it first appears, so keyboard and screen-reader
 * users land on what they opened (review I4).
 */
export function DetailHeading(props: { id?: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h2
      ref={ref}
      id={props.id}
      tabIndex={-1}
      className={`min-w-0 break-words outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${props.className ?? "text-xl font-semibold"}`}
    >
      {props.children}
    </h2>
  );
}

/** Scope chip: the selected project on project tabs, "Global" on app-wide pages. */
export function useScope(global = false) {
  const { state } = useStore();
  if (global) return { global: true } as const;
  return { project: state.projects.find((p) => p.id === state.projectId)?.name ?? null };
}

/**
 * Page header for a screen: H1, one-line description with "Learn more" into the screen's docs
 * section, scope chip and actions. `screen` is the `@factory/docs` NAV id (= the route view).
 */
export function ScreenHeader(props: {
  screen: View | "run-detail" | "delivery-detail";
  title: string;
  description: ReactNode;
  term?: string;
  global?: boolean;
  /** "All projects" pages (aggregate views). */
  allProjects?: boolean;
  actions?: ReactNode;
  meta?: ReactNode;
  breadcrumbs?: readonly Crumb[];
}) {
  const scope = useScope(props.global);
  const href = screenHref("sindri", props.screen);
  return (
    <PageHeader
      title={props.title}
      description={props.description}
      // learnMore keeps the link and the term's InfoHint on one line (no lone wrapped "?").
      learnMore={
        href ? (
          <Link
            href={href}
            className="text-accent-fg underline underline-offset-2 hover:decoration-2"
          >
            Learn more
          </Link>
        ) : undefined
      }
      {...(props.term ? { term: props.term } : {})}
      scope={props.allProjects ? { project: null } : scope}
      {...(props.actions ? { actions: props.actions } : {})}
      {...(props.meta ? { meta: props.meta } : {})}
      {...(props.breadcrumbs ? { breadcrumbs: props.breadcrumbs } : {})}
    />
  );
}
