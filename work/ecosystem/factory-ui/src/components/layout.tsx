import { useId, type ComponentProps, type ReactNode } from "react";
import { Icon } from "../icons.js";
import { cn, focusRing, Link } from "../lib.js";
import { Button } from "./controls.js";
import { InfoHint } from "./overlay.js";

/** Content column: max 1280px, 24px gutters (16px ≤640px), 32px between sections. */
export function Page({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-page min-w-0 flex-col gap-section px-4 py-6 sm:px-6 sm:py-8",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface Crumb {
  label: ReactNode;
  href?: string | undefined;
}
export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1">
              {c.href && !last ? (
                <Link
                  href={c.href}
                  className={cn("truncate rounded-sm hover:text-fg hover:underline", focusRing)}
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  className={cn("truncate", last && "text-fg")}
                  aria-current={last ? "page" : undefined}
                >
                  {c.label}
                </span>
              )}
              {!last && <Icon name="chevronRight" size={14} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export type Scope = { project: string | null } | { global: true };
/** "hello-factory" for a project, "All projects" for an aggregate, "Global" for app-wide pages. */
export function ScopeChip({ scope }: { scope: Scope }) {
  const global = "global" in scope;
  const label = global ? "Global · all projects" : (scope.project ?? "All projects");
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        !global && scope.project
          ? "border-forest/30 bg-forest-soft text-forest"
          : "border-line bg-sunken text-muted",
      )}
    >
      <Icon name={global ? "settings" : "folder"} size={12} />
      <span className="truncate">
        <span className="sr-only">Scope: </span>
        {label}
      </span>
    </span>
  );
}

export function PageHeader({
  title,
  description,
  term,
  info,
  scope,
  meta,
  actions,
  breadcrumbs,
  learnMore,
}: {
  title: ReactNode;
  description?: ReactNode | undefined;
  /** Glossary term for the InfoHint next to the description. */
  term?: string | undefined;
  info?: ReactNode | undefined;
  scope?: Scope | undefined;
  /** e.g. <Timestamp value=… prefix="Updated" />. */
  meta?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  breadcrumbs?: readonly Crumb[] | undefined;
  /**
   * Trailing link after the description (the app's "Learn more", rendered with its router
   * link). It and the InfoHint share one no-wrap run, so the hint never wraps alone.
   */
  learnMore?: ReactNode | undefined;
}) {
  const hint = (term || info) && (
    <span className="ml-1.5 inline-flex align-[-3px]">
      <InfoHint {...(term ? { term } : {})}>{info}</InfoHint>
    </span>
  );
  return (
    <header className="flex flex-col gap-3">
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
              {title}
            </h1>
            {scope && <ScopeChip scope={scope} />}
          </div>
          {(description || learnMore || hint) && (
            <p className="max-w-[72ch] text-md text-muted">
              {description}
              {learnMore ? (
                <>
                  {description ? " " : null}
                  <span className="whitespace-nowrap">
                    {learnMore}
                    {hint}
                  </span>
                </>
              ) : (
                hint
              )}
            </p>
          )}
          {meta && <div className="text-xs text-muted">{meta}</div>}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

export function Section({
  title,
  description,
  term,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode | undefined;
  term?: string | undefined;
  actions?: ReactNode | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-group", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          {/* The hint sits beside, not inside, the h2 so its label stays out of the heading name. */}
          <div className="flex items-center gap-1.5">
            <h2 id={id} className="text-xl font-semibold tracking-tight">
              {title}
            </h2>
            {term && <InfoHint term={term} />}
          </div>
          {description && <p className="max-w-[72ch] text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Bordered surface. `flush` drops body padding and draws a separator under the header, for
 * bodies that are a list or a table. Other section props (aria-label, role, aria-*, id, data-*)
 * pass through; an explicit aria-label replaces the title as the region name.
 */
export function Card({
  title,
  description,
  count,
  term,
  actions,
  footer,
  dense = false,
  flush = false,
  children,
  className,
  headingLevel = 3,
  ...rest
}: Omit<ComponentProps<"section">, "title" | "children" | "className"> & {
  title?: ReactNode | undefined;
  description?: ReactNode | undefined;
  count?: number | undefined;
  term?: string | undefined;
  actions?: ReactNode | undefined;
  footer?: ReactNode | undefined;
  dense?: boolean | undefined;
  flush?: boolean | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
  headingLevel?: 2 | 3 | 4 | undefined;
}) {
  const id = useId();
  const H = `h${headingLevel}` as const;
  const pad = dense ? "p-card-dense" : "p-card";
  const hasHeader = title != null || actions != null;
  const labelled = title != null && rest["aria-label"] == null;
  return (
    <section
      aria-labelledby={labelled ? id : undefined}
      {...rest}
      className={cn("flex min-w-0 flex-col rounded-lg border border-line bg-surface", className)}
    >
      {hasHeader && (
        <div
          className={cn(
            "flex flex-wrap items-start justify-between gap-x-4 gap-y-2",
            pad,
            children != null && (flush ? "border-b border-line" : "pb-0"),
          )}
        >
          <div className="flex min-w-0 flex-col gap-1">
            {title != null && (
              // Count badge and hint are siblings of the heading: inside it they would be read
              // as part of its name ("Reviews 2 What is a review?").
              <div className="flex items-center gap-2">
                <H id={id} className="text-lg font-semibold">
                  {title}
                </H>
                {count != null && (
                  <span className="rounded-full bg-sunken px-2 text-xs font-medium text-muted tabular-nums">
                    {count}
                  </span>
                )}
                {term && <InfoHint term={term} />}
              </div>
            )}
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children != null && (
        // space-y (not flex gap) spaces block children evenly without stretching inline ones.
        <div
          className={cn(
            "min-w-0 flex-1 space-y-group",
            !flush && pad,
            !flush && hasHeader && "pt-4",
          )}
        >
          {children}
        </div>
      )}
      {footer && (
        <div className={cn("border-t border-line", dense ? "px-4 py-3" : "px-5 py-3")}>
          {footer}
        </div>
      )}
    </section>
  );
}

/** Responsive card grid: as many ≥`min` px columns as fit, 16px gaps. */
export function CardGroup({
  min = 320,
  children,
  className,
}: {
  min?: number | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn("grid gap-group", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))` }}
    >
      {children}
    </div>
  );
}

export type SpaceStep = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;
const gapClass: Record<SpaceStep, string> = {
  0: "gap-0",
  1: "gap-1",
  2: "gap-2",
  3: "gap-3",
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
  8: "gap-8",
  10: "gap-10",
  12: "gap-12",
  16: "gap-16",
};

export function Stack({
  gap = 4,
  className,
  ...props
}: ComponentProps<"div"> & { gap?: SpaceStep }) {
  return <div className={cn("flex min-w-0 flex-col", gapClass[gap], className)} {...props} />;
}

export function Cluster({
  gap = 2,
  align = "center",
  justify = "start",
  className,
  ...props
}: ComponentProps<"div"> & {
  gap?: SpaceStep | undefined;
  align?: "start" | "center" | "end" | "baseline" | undefined;
  justify?: "start" | "between" | "end" | undefined;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap",
        gapClass[gap],
        {
          start: "items-start",
          center: "items-center",
          end: "items-end",
          baseline: "items-baseline",
        }[align],
        { start: "justify-start", between: "justify-between", end: "justify-end" }[justify],
        className,
      )}
      {...props}
    />
  );
}

/** 12-column grid; children use GridItem spans from 768px up and stack below. */
export function Grid({
  gap = 4,
  className,
  ...props
}: ComponentProps<"div"> & { gap?: SpaceStep }) {
  return (
    <div className={cn("grid grid-cols-1 md:grid-cols-12", gapClass[gap], className)} {...props} />
  );
}
const spanClass: Record<number, string> = {
  1: "md:col-span-1",
  2: "md:col-span-2",
  3: "md:col-span-3",
  4: "md:col-span-4",
  5: "md:col-span-5",
  6: "md:col-span-6",
  7: "md:col-span-7",
  8: "md:col-span-8",
  9: "md:col-span-9",
  10: "md:col-span-10",
  11: "md:col-span-11",
  12: "md:col-span-12",
};
export function GridItem({
  span = 12,
  className,
  ...props
}: ComponentProps<"div"> & { span?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 }) {
  return <div className={cn("min-w-0", spanClass[span], className)} {...props} />;
}

/** Filters left, actions right; every control shares the 40px control height. */
export function Toolbar({
  children,
  actions,
  label = "Filters",
  className,
}: {
  children?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  label?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3 [&>*]:min-w-0">
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * List and detail side by side (list 280–360px). ≤640px only one pane shows: the list, or the
 * detail with a Back button when `showDetail` is true.
 */
export function SplitView({
  list,
  detail,
  showDetail = false,
  onBack,
  backLabel = "Back to list",
  className,
}: {
  list: ReactNode;
  detail: ReactNode;
  showDetail?: boolean | undefined;
  onBack?: (() => void) | undefined;
  backLabel?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4 md:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] md:gap-6",
        className,
      )}
    >
      <div className={cn("min-w-0", showDetail && "max-md:hidden")}>{list}</div>
      <div className={cn("min-w-0", !showDetail && "max-md:hidden")}>
        {onBack && (
          <Button
            variant="ghost"
            size="sm"
            icon="chevronLeft"
            onClick={onBack}
            className="mb-3 -ml-2 md:hidden"
          >
            {backLabel}
          </Button>
        )}
        {detail}
      </div>
    </div>
  );
}

/** Save/cancel bar that sticks above the bottom bar while a long form scrolls. */
export function StickyActionBar({
  children,
  status,
  className,
}: {
  children: ReactNode;
  status?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-[calc(var(--bottombar-height)+env(safe-area-inset-bottom))] z-[var(--z-sticky)] -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border",
        className,
      )}
    >
      <div className="min-w-0 text-sm text-muted" aria-live="polite">
        {status}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  term?: string | undefined;
}
/** Definition list; two columns from 640px up, label above value below. */
export function KeyValue({
  items,
  columns = 1,
  className,
}: {
  items: readonly KeyValueItem[];
  columns?: 1 | 2 | undefined;
  className?: string | undefined;
}) {
  return (
    <dl className={cn("grid gap-x-8 gap-y-3", columns === 2 && "sm:grid-cols-2", className)}>
      {items.map((item, i) => (
        <div
          key={i}
          className="grid min-w-0 gap-1 sm:grid-cols-[minmax(120px,160px)_minmax(0,1fr)] sm:gap-4"
        >
          <dt className="flex items-center gap-1 text-sm text-muted">
            {item.label}
            {item.term && <InfoHint term={item.term} />}
          </dt>
          <dd className="min-w-0 text-sm [overflow-wrap:anywhere]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
