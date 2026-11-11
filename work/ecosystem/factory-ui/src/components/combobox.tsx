import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "../icons.js";
import { cn, focusRing } from "../lib.js";
import { useFieldControl } from "./controls.js";

export interface ComboOption {
  value: string;
  label: string;
  description?: string | undefined;
  group?: string | undefined;
  keywords?: string | undefined;
  icon?: IconName | undefined;
}
interface ListAction {
  label: string;
  icon?: IconName | undefined;
  onSelect: () => void;
}

const ACTION = "__action__";
const matches = (o: ComboOption, q: string) =>
  !q ||
  `${o.label} ${o.description ?? ""} ${o.keywords ?? ""} ${o.group ?? ""}`
    .toLowerCase()
    .includes(q);

/**
 * Search input + listbox using aria-activedescendant; focus stays in the input. Shared by
 * Combobox (in a popover) and CommandPalette (in a dialog).
 */
function SearchList({
  options,
  selected,
  onSelect,
  action,
  placeholder,
  label,
  emptyText,
  limit,
}: {
  options: readonly ComboOption[];
  selected?: string | null | undefined;
  onSelect: (value: string) => void;
  action?: ListAction | undefined;
  placeholder: string;
  label: string;
  emptyText: string;
  limit?: number | undefined;
}) {
  const base = useId();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = options.filter((o) => matches(o, q));
    return limit ? list.slice(0, limit) : list;
  }, [options, q, limit]);
  const flat = useMemo(
    () => [...filtered.map((o) => o.value), ...(action ? [ACTION] : [])],
    [filtered, action],
  );
  const [active, setActive] = useState<string | undefined>(() =>
    selected && flat.includes(selected) ? selected : flat[0],
  );
  useEffect(() => {
    if (!active || !flat.includes(active)) setActive(flat[0]);
  }, [flat, active]);
  const listRef = useRef<HTMLUListElement>(null);
  const optionId = (v: string) => `${base}-o-${flat.indexOf(v)}`;
  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (v: string) => (v === ACTION ? action?.onSelect() : onSelect(v));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const i = active ? flat.indexOf(active) : -1;
    const move = (to: number) => {
      e.preventDefault();
      if (flat.length) setActive(flat[(to + flat.length) % flat.length]);
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home" && e.ctrlKey) move(0);
    else if (e.key === "End" && e.ctrlKey) move(flat.length - 1);
    else if (e.key === "Enter" && active) {
      e.preventDefault();
      choose(active);
    }
  };

  const groups: { name: string | undefined; items: ComboOption[] }[] = [];
  for (const o of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.name === o.group) last.items.push(o);
    else groups.push({ name: o.group, items: [o] });
  }
  const listId = `${base}-list`;
  const item = (v: string, content: ReactNode, extra?: string) => (
    <li
      key={v}
      id={optionId(v)}
      role="option"
      aria-selected={v === active}
      data-active={v === active || undefined}
      onMouseMove={() => setActive(v)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => choose(v)}
      className={cn(
        "flex min-h-control-sm cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm data-[active]:bg-hover",
        extra,
      )}
    >
      {content}
    </li>
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative border-b border-line p-2">
        <span className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-subtle">
          <Icon name="search" />
        </span>
        <input
          autoFocus
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-control-sm w-full rounded-sm border-0 bg-transparent pr-2 pl-9 text-sm text-fg placeholder:text-subtle focus:outline-none"
        />
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        className="min-h-0 flex-1 overflow-y-auto p-1"
      >
        {groups.map((g, gi) =>
          g.name ? (
            <li key={`g${gi}`} role="presentation">
              <div
                id={`${base}-g${gi}`}
                className="px-2.5 pt-2 pb-1 text-xs font-semibold text-muted"
              >
                {g.name}
              </div>
              <ul role="group" aria-labelledby={`${base}-g${gi}`}>
                {g.items.map((o) =>
                  item(o.value, <OptionBody option={o} selected={o.value === selected} />),
                )}
              </ul>
            </li>
          ) : (
            g.items.map((o) =>
              item(o.value, <OptionBody option={o} selected={o.value === selected} />),
            )
          ),
        )}
        {filtered.length === 0 && (
          <li role="presentation" className="px-3 py-6 text-center text-sm text-muted">
            {emptyText}
          </li>
        )}
        {action && (
          <>
            <li role="presentation" className="my-1 border-t border-line" />
            {item(
              ACTION,
              <>
                <Icon name={action.icon ?? "settings"} />
                <span>{action.label}</span>
              </>,
              "text-accent-fg",
            )}
          </>
        )}
      </ul>
    </div>
  );
}

function OptionBody({ option, selected }: { option: ComboOption; selected: boolean }) {
  return (
    <>
      {option.icon && <Icon name={option.icon} className="text-muted" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{option.label}</span>
        {option.description && (
          <span className="truncate text-xs text-muted">{option.description}</span>
        )}
      </span>
      {selected && <Icon name="check" className="text-accent-fg" />}
    </>
  );
}

/** Searchable single select in a popover; options may carry a `group` (e.g. Recent, All). */
export function Combobox({
  options,
  value,
  onValueChange,
  label,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches",
  action,
  disabled,
  disabledReason,
  id,
  className,
  triggerClassName,
  renderValue,
}: {
  options: readonly ComboOption[];
  value: string | null;
  onValueChange: (value: string) => void;
  /** Accessible name; also labels the search input. */
  label: string;
  placeholder?: string | undefined;
  searchPlaceholder?: string | undefined;
  emptyText?: string | undefined;
  /** Footer row, e.g. "Manage projects…". */
  action?: ListAction | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
  id?: string | undefined;
  className?: string | undefined;
  triggerClassName?: string | undefined;
  renderValue?: (option: ComboOption | undefined) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const control = useFieldControl({ id });
  const current = options.find((o) => o.value === value);
  const isDisabled = disabled || Boolean(disabledReason);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        {...control}
        disabled={isDisabled}
        aria-haspopup="listbox"
        aria-label={control.id ? undefined : `${label}: ${current?.label ?? placeholder}`}
        title={disabledReason}
        className={cn(
          "flex h-control-md w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-line bg-raised px-3 text-left text-sm text-fg transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-60",
          focusRing,
          triggerClassName,
        )}
      >
        <span className={cn("min-w-0 truncate", !current && "text-subtle")}>
          {renderValue ? renderValue(current) : (current?.label ?? placeholder)}
        </span>
        <Icon name="chevronDown" className="text-muted" />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "fui-anim-pop z-[var(--z-dropdown)] flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-[max(var(--radix-popover-trigger-width),300px)] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-md border border-line bg-raised text-fg shadow-1",
            className,
          )}
        >
          <SearchList
            options={options}
            selected={value}
            label={label}
            placeholder={searchPlaceholder}
            emptyText={emptyText}
            action={
              action && {
                ...action,
                onSelect: () => {
                  setOpen(false);
                  action.onSelect();
                },
              }
            }
            onSelect={(v) => {
              onValueChange(v);
              setOpen(false);
            }}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export interface ProjectOption {
  id: string;
  name: string;
  description?: string | undefined;
}
export const ALL_PROJECTS = "__all__";

/**
 * Project picker: Recent first, then All; "All projects" only where an aggregate makes sense
 * (`allowAll`). `value` null means All projects.
 */
export function ProjectPicker({
  projects,
  value,
  onChange,
  recentIds = [],
  allowAll = false,
  onManage,
  disabledReason,
  className,
  triggerClassName,
}: {
  projects: readonly ProjectOption[];
  value: string | null;
  onChange: (projectId: string | null) => void;
  recentIds?: readonly string[] | undefined;
  allowAll?: boolean | undefined;
  onManage?: (() => void) | undefined;
  /** e.g. "This page covers all projects" on global pages. */
  disabledReason?: string | undefined;
  /** Popover content class (Combobox `className`). */
  className?: string | undefined;
  triggerClassName?: string | undefined;
}) {
  const options = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const recent = recentIds
      .map((id) => byId.get(id))
      .filter((p): p is ProjectOption => Boolean(p))
      .slice(0, 5);
    const toOpt = (p: ProjectOption, group: string): ComboOption => ({
      value: p.id,
      label: p.name,
      group,
      icon: "folder",
      ...(p.description ? { description: p.description } : {}),
    });
    return [
      ...(allowAll
        ? [
            {
              value: ALL_PROJECTS,
              label: "All projects",
              icon: "apps" as const,
              keywords: "everything aggregate",
            },
          ]
        : []),
      ...recent.map((p) => toOpt(p, "Recent")),
      ...projects
        .filter((p) => !recent.includes(p))
        .map((p) => toOpt(p, recent.length ? "All projects" : "Projects")),
    ];
  }, [projects, recentIds, allowAll]);
  return (
    <Combobox
      label="Project"
      options={options}
      value={value ?? (allowAll ? ALL_PROJECTS : null)}
      onValueChange={(v) => onChange(v === ALL_PROJECTS ? null : v)}
      placeholder={allowAll ? "All projects" : "Choose a project"}
      searchPlaceholder="Find a project…"
      emptyText="No project matches"
      {...(onManage
        ? { action: { label: "Manage projects…", icon: "settings" as const, onSelect: onManage } }
        : {})}
      {...(disabledReason ? { disabledReason } : {})}
      {...(className ? { className } : {})}
      // Capped at 16rem so a long name cannot push the tab strip (10 tabs at 1440px) to overflow;
      // the name truncates and its full text is the span's tooltip (and in the trigger's name).
      triggerClassName={cn("h-control-sm max-w-64 bg-surface", triggerClassName)}
      renderValue={(o) => {
        const text = o?.label ?? (allowAll ? "All projects" : "Choose a project");
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              name={o?.value === ALL_PROJECTS || !o ? "apps" : "folder"}
              className="text-muted"
            />
            <span className="truncate font-medium" title={text}>
              {text}
            </span>
          </span>
        );
      }}
    />
  );
}

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  description?: string | undefined;
  keywords?: string | undefined;
  icon?: IconName | undefined;
  run: () => void;
}

/** ⌘K jump list: a dialog wrapping the same accessible search list as Combobox. */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  title = "Jump to",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly CommandItem[];
  title?: string | undefined;
}) {
  const options = useMemo(
    () =>
      items.map((i) => ({
        value: i.id,
        label: i.label,
        group: i.group,
        ...(i.description ? { description: i.description } : {}),
        ...(i.keywords ? { keywords: i.keywords } : {}),
        ...(i.icon ? { icon: i.icon } : {}),
      })),
    [items],
  );
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fui-anim-fade fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fui-anim-pop fixed top-[12vh] left-1/2 z-[var(--z-dialog)] flex max-h-[70vh] w-[calc(100%-32px)] max-w-[600px] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-raised text-fg shadow-2"
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <SearchList
            options={options}
            label={title}
            placeholder="Search pages, runs, projects…"
            emptyText="No matching pages or records"
            limit={50}
            onSelect={(id) => {
              onOpenChange(false);
              items.find((i) => i.id === id)?.run();
            }}
          />
          <p className="border-t border-line px-3 py-2 text-xs text-muted">
            <kbd className="font-sans">↑↓</kbd> to move · <kbd className="font-sans">Enter</kbd> to
            open · <kbd className="font-sans">Esc</kbd> to close
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Opens the palette on ⌘K / Ctrl+K. */
export function useCommandShortcut(open: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, enabled]);
}
