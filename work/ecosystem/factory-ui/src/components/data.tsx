import * as TabsPrimitive from "@radix-ui/react-tabs";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { cn, focusRing, Link, useUrlState } from "../lib.js";
import { Button, IconButton, SegmentedControl, Switch } from "./controls.js";
import { InfoHint, Tooltip } from "./overlay.js";
import { EmptyState, ErrorState, Skeleton } from "./status.js";

/* ------------------------------------------------------------------ DataTable */

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Text label for the stacked mobile layout when `header` is not a string. */
  label?: string | undefined;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center" | undefined;
  width?: string | undefined;
  sortable?: boolean | undefined;
  /** The row's title: becomes the link/button target and the card heading on phones. */
  primary?: boolean | undefined;
  hideOnMobile?: boolean | undefined;
}
export type SortState = { key: string; direction: "asc" | "desc" };

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption = false,
  loading = false,
  error,
  onRetry,
  empty,
  sort,
  onSortChange,
  onRowClick,
  rowHref,
  rowLabel,
  selectedKey,
  maxHeight,
  layout = "stack",
  dense = false,
  className,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Required accessible name; hidden unless `showCaption`. */
  caption: string;
  showCaption?: boolean | undefined;
  loading?: boolean | undefined;
  error?: unknown | undefined;
  onRetry?: (() => void) | undefined;
  /** Rendered when there are no rows (use EmptyState with an action). */
  empty?: ReactNode | undefined;
  sort?: SortState | undefined;
  onSortChange?: ((sort: SortState) => void) | undefined;
  onRowClick?: ((row: T) => void) | undefined;
  rowHref?: ((row: T) => string) | undefined;
  /** Accessible name of the row action, e.g. row => `Open ${row.name}`. */
  rowLabel?: ((row: T) => string) | undefined;
  selectedKey?: string | undefined;
  /** Scroll vertically inside the table with a sticky header (e.g. "420px"). */
  maxHeight?: string | undefined;
  /** ≤640px: "stack" turns rows into labelled cards; "scroll" keeps the grid and scrolls. */
  layout?: "stack" | "scroll" | undefined;
  dense?: boolean | undefined;
  className?: string | undefined;
}) {
  const cellPad = dense ? "px-3 py-1.5" : "px-3 py-2.5";
  const alignClass = (a: Column<T>["align"]) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
  const hasRowAction = Boolean(onRowClick || rowHref);
  const primaryKey = columns.find((c) => c.primary)?.key ?? columns[0]?.key;
  const span = columns.length;
  const errorMessage = error ? (error instanceof Error ? error.message : String(error)) : null;

  const body = () => {
    if (errorMessage)
      return (
        <tr>
          <td colSpan={span} className="p-4">
            <ErrorState
              title="Could not load this table"
              message={errorMessage}
              {...(onRetry ? { onRetry } : {})}
            />
          </td>
        </tr>
      );
    if (loading)
      return Array.from({ length: 5 }, (_, i) => (
        <tr key={i} className="border-b border-line last:border-0">
          {columns.map((c) => (
            <td key={c.key} className={cellPad}>
              <Skeleton className={c.align === "right" ? "ml-auto w-12" : "w-3/4"} />
            </td>
          ))}
        </tr>
      ));
    if (!rows.length)
      return (
        <tr>
          <td colSpan={span} data-primary className="p-0">
            {empty ?? (
              <EmptyState title="No rows" body="Nothing matches yet." compact className="m-4" />
            )}
          </td>
        </tr>
      );
    return rows.map((row) => {
      const key = rowKey(row);
      const selected = selectedKey === key;
      return (
        <tr
          key={key}
          aria-selected={selectedKey !== undefined ? selected : undefined}
          className={cn(
            "relative border-b border-line transition-colors last:border-0",
            hasRowAction && "cursor-pointer hover:bg-hover",
            selected && "bg-accent-soft/60 hover:bg-accent-soft",
          )}
        >
          {columns.map((c) => {
            const content = c.cell(row);
            const isPrimary = c.key === primaryKey;
            const label = typeof c.header === "string" ? c.header : (c.label ?? c.key);
            return (
              <td
                key={c.key}
                data-label={label}
                data-primary={isPrimary || undefined}
                className={cn(
                  cellPad,
                  "align-middle",
                  alignClass(c.align),
                  c.align === "right" && "tabular-nums",
                  c.hideOnMobile && "max-sm:hidden!",
                )}
              >
                {isPrimary && rowHref ? (
                  <Link
                    href={rowHref(row)}
                    aria-label={rowLabel?.(row)}
                    className={cn(
                      "font-medium text-fg after:absolute after:inset-0 hover:underline",
                      focusRing,
                    )}
                  >
                    {content}
                  </Link>
                ) : isPrimary && onRowClick ? (
                  <button
                    type="button"
                    onClick={() => onRowClick(row)}
                    aria-label={rowLabel?.(row)}
                    className={cn(
                      "cursor-pointer text-left font-medium text-fg after:absolute after:inset-0",
                      focusRing,
                    )}
                  >
                    {content}
                  </button>
                ) : (
                  // Other cells sit above the stretched row target so their own controls work.
                  <div
                    className={cn(
                      hasRowAction && "relative z-[1] inline-flex max-w-full",
                      isPrimary && "font-medium",
                    )}
                  >
                    {content}
                  </div>
                )}
              </td>
            );
          })}
        </tr>
      );
    });
  };

  return (
    <div
      className={cn(
        "min-w-0 overflow-auto rounded-lg border border-line bg-surface",
        layout === "stack" && "max-sm:overflow-visible",
        className,
      )}
      style={maxHeight ? { maxHeight } : undefined}
      {...(layout === "scroll" ? { role: "region", "aria-label": caption, tabIndex: 0 } : {})}
    >
      <table
        aria-busy={loading || undefined}
        className={cn("w-full border-collapse text-sm", layout === "stack" && "fui-table-stack")}
      >
        <caption className={showCaption ? "px-3 py-2 text-left text-sm font-medium" : "sr-only"}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const ariaSort = active
                ? sort.direction === "asc"
                  ? "ascending"
                  : "descending"
                : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={c.sortable ? (ariaSort ?? "none") : undefined}
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    "sticky top-0 z-[var(--z-sticky)] border-b border-line bg-sunken text-xs font-semibold whitespace-nowrap text-muted",
                    cellPad,
                    alignClass(c.align),
                  )}
                >
                  {c.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() =>
                        onSortChange({
                          key: c.key,
                          direction: active && sort.direction === "asc" ? "desc" : "asc",
                        })
                      }
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1 rounded-sm hover:text-fg",
                        active && "text-fg",
                        focusRing,
                      )}
                    >
                      {c.header}
                      <Icon
                        name={active && sort.direction === "desc" ? "chevronDown" : "chevronUp"}
                        size={12}
                        className={cn("shrink-0", !active && "opacity-40")}
                      />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{body()}</tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- Pagination */

function pageList(page: number, count: number): (number | "gap")[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const set = new Set([1, count, page - 1, page, page + 1].filter((p) => p >= 1 && p <= count));
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i && p - sorted[i - 1]! > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  className,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  className?: string | undefined;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav
      aria-label="Pagination"
      className={cn("flex items-center justify-between gap-3", className)}
    >
      <Button
        size="sm"
        icon="chevronLeft"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      <ol className="hidden items-center gap-1 sm:flex">
        {pageList(page, pageCount).map((p, i) =>
          p === "gap" ? (
            <li key={`g${i}`} aria-hidden className="px-1 text-muted">
              …
            </li>
          ) : (
            <li key={p}>
              <button
                type="button"
                aria-current={p === page ? "page" : undefined}
                aria-label={`Page ${p}`}
                onClick={() => onPageChange(p)}
                className={cn(
                  "inline-flex size-control-sm cursor-pointer items-center justify-center rounded-md text-sm tabular-nums",
                  p === page
                    ? "bg-accent-soft font-semibold text-accent-fg"
                    : "text-muted hover:bg-hover hover:text-fg",
                  focusRing,
                )}
              >
                {p}
              </button>
            </li>
          ),
        )}
      </ol>
      <span className="text-sm text-muted sm:hidden">
        Page {page} of {pageCount}
      </span>
      <Button
        size="sm"
        iconRight="chevronRight"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}

export function LoadMore({
  onLoadMore,
  hasMore,
  loading = false,
  shown,
  total,
}: {
  onLoadMore: () => void;
  hasMore: boolean;
  loading?: boolean | undefined;
  shown?: number | undefined;
  total?: number | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-2">
      {shown != null && (
        <p className="text-xs text-muted" aria-live="polite">
          Showing {shown}
          {total != null ? ` of ${total}` : ""}
        </p>
      )}
      {hasMore && (
        <Button size="sm" loading={loading} onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Id, Timestamp */

export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(
        () => setCopied(true),
        () => setCopied(false),
      );
    },
  ];
}

/** Mono, truncated identifier with a copy button; the full value is in the tooltip. */
export function Id({
  value,
  head = 8,
  tail = 4,
  label = "ID",
  className,
}: {
  value: string;
  head?: number | undefined;
  tail?: number | undefined;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const [copied, copy] = useCopy();
  // `slice(-0)` is the whole string, so a zero tail must drop the tail part explicitly.
  const short =
    value.length > head + tail + 1
      ? `${value.slice(0, head)}…${tail > 0 ? value.slice(-tail) : ""}`
      : value;
  return (
    <span className={cn("inline-flex max-w-full items-center gap-0.5 align-middle", className)}>
      <Tooltip content={<span className="font-mono break-all">{value}</span>}>
        <span
          tabIndex={0}
          aria-label={`${label} ${value}`}
          className={cn("truncate rounded-sm font-mono text-xs text-muted", focusRing)}
        >
          {short}
        </span>
      </Tooltip>
      <IconButton
        icon={copied ? "check" : "copy"}
        label={copied ? "Copied" : `Copy ${label}`}
        size="sm"
        tooltip={false}
        className="size-6"
        onClick={() => copy(value)}
      />
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
export function formatRelative(date: Date, now: Date = new Date()): string {
  const diff = (date.getTime() - now.getTime()) / 1000;
  if (Math.abs(diff) < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secs] of units)
    if (Math.abs(diff) >= secs || unit === "minute")
      return rtf.format(Math.round(diff / secs), unit);
  return "just now";
}
export const formatAbsolute = (date: Date) =>
  date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** Relative time ("3 minutes ago") with the absolute time in a tooltip; re-renders every 30 s. */
export function Timestamp({
  value,
  now,
  prefix,
  className,
}: {
  value: string | number | Date;
  /** Fixed "now" for tests and server snapshots; omit to tick live. */
  now?: Date | undefined;
  prefix?: string | undefined;
  className?: string | undefined;
}) {
  const date = value instanceof Date ? value : new Date(value);
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    if (now) return;
    const t = setInterval(() => setTick(new Date()), 30_000);
    return () => clearInterval(t);
  }, [now]);
  if (Number.isNaN(date.getTime())) return <span className={className}>—</span>;
  return (
    <Tooltip content={formatAbsolute(date)}>
      <time
        tabIndex={0}
        dateTime={date.toISOString()}
        className={cn("rounded-sm whitespace-nowrap", focusRing, className)}
      >
        {prefix ? `${prefix} ` : ""}
        {formatRelative(date, now ?? tick)}
      </time>
    </Tooltip>
  );
}

/* -------------------------------------------------------------- Code and logs */

export function CodeBlock({
  code,
  title,
  wrap: initialWrap = true,
  maxHeight = "420px",
  className,
}: {
  code: string;
  title?: ReactNode | undefined;
  wrap?: boolean | undefined;
  maxHeight?: string | undefined;
  className?: string | undefined;
}) {
  const [wrap, setWrap] = useState(initialWrap);
  const [copied, copy] = useCopy();
  return (
    <figure
      className={cn("min-w-0 overflow-hidden rounded-md border border-line bg-sunken", className)}
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-line py-1 pr-1 pl-3">
        <span className="truncate text-xs font-medium text-muted">{title ?? "Code"}</span>
        <span className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            Wrap
          </Button>
          <IconButton
            icon={copied ? "check" : "copy"}
            label={copied ? "Copied" : "Copy code"}
            size="sm"
            className="size-7"
            onClick={() => copy(code)}
          />
        </span>
      </figcaption>
      <pre
        tabIndex={0}
        style={{ maxHeight }}
        className={cn(
          "overflow-auto p-3 font-mono text-xs leading-5",
          wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre",
          focusRing,
        )}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogEntry {
  id: string;
  time: string | number | Date;
  level?: LogLevel | undefined;
  /** Machine event type, e.g. "session.output". */
  type?: string | undefined;
  message: string;
}
const levelClass: Record<LogLevel, string> = {
  debug: "text-subtle",
  info: "text-progress-fg",
  warn: "text-warning-fg",
  error: "text-danger-fg",
};

/** Event/log list: level filter, collapses consecutive repeats ("×14"), optional follow-tail. */
export function LogView({
  entries,
  now,
  maxHeight = "360px",
  label = "Event log",
  className,
}: {
  entries: readonly LogEntry[];
  now?: Date | undefined;
  maxHeight?: string | undefined;
  label?: string | undefined;
  className?: string | undefined;
}) {
  const [level, setLevel] = useState<"all" | LogLevel>("all");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const out: { entry: LogEntry; count: number }[] = [];
    for (const e of entries) {
      if (level !== "all" && (e.level ?? "info") !== level) continue;
      const last = out[out.length - 1];
      if (last && last.entry.type === e.type && last.entry.message === e.message) {
        last.count += 1;
        last.entry = { ...e };
      } else out.push({ entry: e, count: 1 });
    }
    return out;
  }, [entries, level]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [groups, follow]);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-2">
        <SegmentedControl
          size="sm"
          label="Log level"
          value={level}
          onValueChange={(v) => setLevel(v as typeof level)}
          options={[
            { value: "all", label: "All" },
            { value: "info", label: "Info" },
            { value: "warn", label: "Warnings" },
            { value: "error", label: "Errors" },
          ]}
        />
        <div className="w-36">
          <Switch checked={follow} onCheckedChange={setFollow} label="Follow" />
        </div>
      </div>
      {/* role="log" sits on the scroll wrapper: on the <ol> it would replace the list role and
          orphan the <li>s (axe listitem). */}
      <div
        ref={scroller}
        role="log"
        aria-label={label}
        tabIndex={0}
        style={{ maxHeight }}
        className={cn("overflow-auto", focusRing)}
      >
        <ol className="font-mono text-xs leading-5">
          {groups.length === 0 && (
            <li className="px-3 py-6 text-center font-sans text-sm text-muted">
              No events match this filter.
            </li>
          )}
          {groups.map(({ entry, count }) => (
            <li
              key={entry.id}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-b border-line/60 px-3 py-1.5 last:border-0 sm:grid-cols-[96px_minmax(0,1fr)]"
            >
              <span className="text-subtle">
                <Timestamp value={entry.time} {...(now ? { now } : {})} />
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
                {entry.level && entry.level !== "info" && (
                  <span className={cn("mr-2 font-semibold uppercase", levelClass[entry.level])}>
                    {entry.level}
                  </span>
                )}
                {entry.type && <span className="mr-2 text-muted">{entry.type}</span>}
                {entry.message}
                {count > 1 && (
                  <span
                    className="ml-2 rounded-sm bg-sunken px-1 font-sans text-muted"
                    aria-label={`repeated ${count} times`}
                  >
                    ×{count}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Timeline */

export interface TimelineItem {
  id: string;
  time: string | number | Date;
  title: ReactNode;
  body?: ReactNode | undefined;
  icon?: IconName | undefined;
  /** Raw machine type, shown in a tooltip on the icon. */
  rawType?: string | undefined;
  meta?: ReactNode | undefined;
}
function dayLabel(date: Date, now: Date) {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Events grouped by day, newest first as given. */
export function Timeline({ items, now }: { items: readonly TimelineItem[]; now?: Date }) {
  const ref = now ?? new Date();
  const days: { label: string; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(new Date(item.time), ref);
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }
  return (
    <div className="flex flex-col gap-6">
      {days.map((d) => (
        <section key={d.label} aria-label={d.label} className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{d.label}</h3>
          <ol className="flex flex-col">
            {d.items.map((item, i) => (
              <li
                key={item.id}
                className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-3 pb-4 last:pb-0"
              >
                {i < d.items.length - 1 && (
                  <span aria-hidden className="absolute top-8 bottom-0 left-[13px] w-px bg-line" />
                )}
                <Tooltip content={item.rawType}>
                  <span
                    tabIndex={item.rawType ? 0 : undefined}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full border border-line bg-surface text-muted",
                      focusRing,
                    )}
                  >
                    <Icon name={item.icon ?? "clock"} size={14} />
                  </span>
                </Tooltip>
                <div className="min-w-0 pt-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <p className="text-sm font-medium">{item.title}</p>
                    <span className="text-xs text-muted">
                      <Timestamp value={item.time} {...(now ? { now } : {})} />
                    </span>
                  </div>
                  {item.body && <div className="mt-1 text-sm text-muted">{item.body}</div>}
                  {item.meta && <div className="mt-2">{item.meta}</div>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/* -------------------------------------------------- Disclosure, Stepper, etc. */

export function Disclosure({
  title,
  children,
  defaultOpen = false,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <details
      open={defaultOpen}
      className={cn("group rounded-md border border-line bg-surface", className)}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 rounded-md px-4 py-3 text-sm font-medium select-none hover:bg-hover [&::-webkit-details-marker]:hidden",
          focusRing,
        )}
      >
        <Icon
          name="chevronRight"
          size={14}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        {title}
      </summary>
      <div className="border-t border-line px-4 py-3 text-sm">{children}</div>
    </details>
  );
}

export interface Step {
  id: string;
  label: ReactNode;
  description?: ReactNode | undefined;
}
export function Stepper({
  steps,
  current,
  className,
}: {
  steps: readonly Step[];
  current: number;
  className?: string;
}) {
  return (
    <ol className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-0", className)}>
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "upcoming";
        return (
          <li
            key={step.id}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-1 items-start gap-3 sm:flex-col sm:gap-2"
          >
            <div className="flex w-full items-center gap-2 max-sm:w-auto">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                  state === "done" && "border-forest bg-forest text-surface",
                  state === "current" && "border-accent bg-accent-soft text-accent-fg",
                  state === "upcoming" && "border-line bg-surface text-muted",
                )}
              >
                {state === "done" ? <Icon name="check" size={14} label="Done" /> : i + 1}
              </span>
              {i < steps.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    "hidden h-px flex-1 sm:block",
                    i < current ? "bg-forest" : "bg-line",
                  )}
                />
              )}
            </div>
            <div className="min-w-0 sm:pr-4">
              <p className={cn("text-sm font-medium", state === "upcoming" && "text-muted")}>
                {step.label}
              </p>
              {step.description && <p className="text-xs text-muted">{step.description}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Progress({
  value,
  max = 100,
  label,
  showValue = false,
  className,
}: {
  value: number;
  max?: number | undefined;
  label: string;
  showValue?: boolean | undefined;
  className?: string | undefined;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-[var(--duration-base)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      {showValue && <span className="text-xs text-muted tabular-nums">{Math.round(pct)}%</span>}
    </div>
  );
}

/** Label (+ InfoHint), big number, optional delta; the whole card links when `href` is set. */
export function MetricCard({
  label,
  value,
  description,
  term,
  delta,
  href,
  loading = false,
}: {
  label: string;
  value: ReactNode;
  description?: ReactNode | undefined;
  term?: string | undefined;
  delta?: { value: string; tone?: "success" | "danger" | "neutral" };
  href?: string | undefined;
  loading?: boolean | undefined;
}) {
  return (
    <div
      className={cn(
        "group relative flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-card",
        href && "transition-colors hover:border-line-strong hover:bg-hover",
      )}
    >
      <span className="flex items-center justify-between gap-2 text-sm text-muted">
        <span className="flex items-center gap-1">
          {href ? (
            <Link
              href={href}
              className={cn("rounded-sm after:absolute after:inset-0 after:rounded-lg", focusRing)}
            >
              {label}
            </Link>
          ) : (
            label
          )}
          {term && (
            <span className="relative z-[1]">
              <InfoHint term={term} />
            </span>
          )}
        </span>
        {href && (
          <Icon
            name="arrowRight"
            size={14}
            className="text-subtle transition-transform group-hover:translate-x-0.5"
          />
        )}
      </span>
      {loading ? (
        <Skeleton className="my-1 h-9 w-16" />
      ) : (
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight tabular-nums">{value}</span>
          {delta && (
            <span
              className={cn(
                "text-xs font-medium",
                delta.tone === "success"
                  ? "text-success-fg"
                  : delta.tone === "danger"
                    ? "text-danger-fg"
                    : "text-muted",
              )}
            >
              {delta.value}
            </span>
          )}
        </span>
      )}
      {description && <span className="text-xs text-muted">{description}</span>}
    </div>
  );
}

/** List row: title, meta line, trailing status, chevron; a link or a button. */
export function RecordRow({
  title,
  meta,
  status,
  href,
  onClick,
  selected = false,
}: {
  title: ReactNode;
  meta?: ReactNode | undefined;
  status?: ReactNode | undefined;
  href?: string | undefined;
  onClick?: (() => void) | undefined;
  selected?: boolean | undefined;
}) {
  const inner = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="line-clamp-2 text-sm font-medium text-fg">{title}</span>
        {meta && <span className="truncate text-xs text-muted">{meta}</span>}
        {/* Phones: status drops under the text so the title keeps its width. */}
        {status && <span className="mt-1 sm:hidden">{status}</span>}
      </span>
      {status && <span className="shrink-0 max-sm:hidden">{status}</span>}
      <Icon name="chevronRight" size={16} className="shrink-0 text-subtle" />
    </>
  );
  const cls = cn(
    "flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover",
    selected && "bg-accent-soft/60 shadow-[inset_3px_0_0_var(--accent)]",
    focusRing,
    "focus-visible:-outline-offset-2",
  );
  if (href)
    return (
      <Link href={href} aria-current={selected ? "true" : undefined} className={cls}>
        {inner}
      </Link>
    );
  return (
    <button
      type="button"
      aria-pressed={onClick ? selected : undefined}
      onClick={onClick}
      className={cls}
    >
      {inner}
    </button>
  );
}
/** Wrap RecordRows: divided list inside a Card (use Card flush). */
export function RecordList({ children, label }: { children: ReactNode; label?: string }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {items.map((c, i) => (
        <li key={i}>{c}</li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------------- Tabs */

export interface TabItem {
  value: string;
  label: ReactNode;
  count?: number | undefined;
  content: ReactNode;
}
/**
 * WAI-ARIA tabs. With `urlParam`, the selected tab lives in `?{urlParam}=` so it can be deep-linked
 * and survives reloads; otherwise pass value/onValueChange or let it manage itself.
 */
export function Tabs({
  items,
  label,
  urlParam,
  value: controlled,
  onValueChange,
  defaultValue,
  className,
}: {
  items: readonly TabItem[];
  label: string;
  urlParam?: string | undefined;
  value?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  defaultValue?: string | undefined;
  className?: string | undefined;
}) {
  const first = defaultValue ?? items[0]?.value ?? "";
  const [urlValue, setUrlValue] = useUrlState(urlParam ?? "", first);
  const [local, setLocal] = useState(first);
  const raw = controlled ?? (urlParam ? urlValue : local);
  const value = items.some((i) => i.value === raw) ? raw : first;
  const change = (v: string) => {
    if (urlParam) setUrlValue(v);
    else if (controlled === undefined) setLocal(v);
    onValueChange?.(v);
  };
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={change}
      className={cn("flex min-w-0 flex-col gap-5", className)}
    >
      <TabsPrimitive.List
        aria-label={label}
        className="flex gap-1 overflow-x-auto border-b border-line"
      >
        {items.map((t) => (
          <TabsPrimitive.Trigger
            key={t.value}
            value={t.value}
            className={cn(
              "relative -mb-px inline-flex h-control-md shrink-0 cursor-pointer items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-muted hover:text-fg",
              "data-[state=active]:border-accent data-[state=active]:text-fg",
              focusRing,
              "focus-visible:-outline-offset-2",
            )}
          >
            {t.label}
            {t.count != null && (
              <span className="rounded-full bg-sunken px-1.5 text-xs text-muted tabular-nums">
                {t.count}
              </span>
            )}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((t) => (
        <TabsPrimitive.Content
          key={t.value}
          value={t.value}
          className={cn("min-w-0 outline-none", focusRing)}
        >
          {t.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
