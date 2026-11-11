import * as Menu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { cn, focusRing, Link, useTheme, type ThemePreference } from "../lib.js";
import { ProjectPicker, type ProjectOption } from "./combobox.js";
import { Button, SegmentedControl } from "./controls.js";
import {
  Drawer,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToastProvider,
  Tooltip,
} from "./overlay.js";

export interface AppLink {
  id: string;
  label: string;
  href: string;
  description?: string | undefined;
}
export interface NavTab {
  id: string;
  label: string;
  href: string;
  /** Tabs with the same group sit together, separated from other groups. */
  group?: string | undefined;
  count?: number | undefined;
}
export interface GlobalLink {
  id: string;
  label: string;
  href: string;
  icon?: IconName | undefined;
  count?: number | undefined;
}
export type ConnectionState = "live" | "connecting" | "reconnecting" | "offline";
export interface ConnectionStatus {
  state: ConnectionState;
  /** Tooltip detail, e.g. "Local · 127.0.0.1:4320 · last event 3 s ago". */
  detail?: string | undefined;
  onReconnect?: (() => void) | undefined;
}
export interface SessionStatus {
  mode: "read-only" | "operator";
  /** Popover body for the session control (e.g. the operator-code unlock form). */
  content?: ReactNode | undefined;
}

const connectionCopy: Record<
  ConnectionState,
  { label: string; long: string; tone: string; dot: string }
> = {
  live: { label: "Live", long: "Live", tone: "text-success-fg", dot: "bg-success-fg" },
  connecting: {
    label: "Connecting",
    long: "Connecting…",
    tone: "text-progress-fg",
    dot: "bg-progress-fg fui-pulse",
  },
  reconnecting: {
    label: "Reconnecting",
    long: "Reconnecting · data may be delayed",
    tone: "text-warning-fg",
    dot: "bg-warning-fg fui-pulse",
  },
  offline: {
    label: "Offline",
    long: "Offline · showing the last snapshot",
    tone: "text-danger-fg",
    dot: "bg-danger-fg",
  },
};

/* ------------------------------------------------------------------- TopBar */

function AppSwitcher({ apps, currentApp }: { apps: readonly AppLink[]; currentApp: string }) {
  const current = apps.find((a) => a.id === currentApp);
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Switch app (current: ${current?.label ?? currentApp})`}
        className={cn(
          "flex h-control-sm shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-semibold hover:bg-hover data-[state=open]:bg-hover",
          focusRing,
        )}
      >
        <span
          aria-hidden
          className="flex size-6 items-center justify-center rounded-sm bg-accent text-xs font-bold text-on-accent"
        >
          {(current?.label ?? currentApp).slice(0, 1).toUpperCase()}
        </span>
        <span className="max-sm:hidden">{current?.label ?? currentApp}</span>
        <Icon name="chevronDown" size={14} className="text-muted" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={8}
          className="fui-anim-pop z-[var(--z-dropdown)] min-w-64 rounded-md border border-line bg-raised p-1 text-fg shadow-1"
        >
          <Menu.Label className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-muted">
            Factory apps
          </Menu.Label>
          {apps.map((a) => (
            <Menu.Item key={a.id} asChild>
              <Link
                href={a.href}
                aria-current={a.id === currentApp ? "page" : undefined}
                className="flex cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-hover"
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm bg-sunken text-[11px] font-bold text-muted"
                >
                  {a.label.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{a.label}</span>
                  {a.description && (
                    <span className="block text-xs text-muted">{a.description}</span>
                  )}
                </span>
                {a.id === currentApp && <Icon name="check" className="mt-0.5 text-accent-fg" />}
              </Link>
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function TabStrip({
  tabs,
  activeTabId,
}: {
  tabs: readonly NavTab[];
  activeTabId?: string | undefined;
}) {
  return (
    <nav aria-label="Project pages" className="min-w-0 flex-1 self-stretch max-sm:hidden">
      <ul className="flex h-full items-stretch gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t, i) => {
          const active = t.id === activeTabId;
          const newGroup = i > 0 && t.group !== tabs[i - 1]!.group;
          return (
            <li key={t.id} className="flex items-stretch">
              {newGroup && <span aria-hidden className="mx-2 my-4 w-px bg-line" />}
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-sm px-3 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "text-fg" : "text-muted hover:text-fg",
                  "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full",
                  active && "after:bg-accent",
                  focusRing,
                  "focus-visible:-outline-offset-2",
                )}
              >
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="rounded-full bg-waiting-bg px-1.5 text-xs font-semibold text-waiting-fg tabular-nums">
                    {t.count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** ≤640px replacement for the tab strip: one button showing the current page. */
function PageMenu({
  tabs,
  activeTabId,
}: {
  tabs: readonly NavTab[];
  activeTabId?: string | undefined;
}) {
  const active = tabs.find((t) => t.id === activeTabId);
  return (
    <div className="ml-auto sm:hidden">
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Project pages (current: ${active?.label ?? "none"})`}
          className={cn(
            "flex h-control-sm max-w-36 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-sm font-medium",
            focusRing,
          )}
        >
          <span className="truncate">{active?.label ?? "Pages"}</span>
          <Icon name="chevronDown" size={14} className="text-muted" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            align="end"
            sideOffset={8}
            collisionPadding={8}
            className="fui-anim-pop z-[var(--z-dropdown)] max-h-[70dvh] min-w-56 overflow-y-auto rounded-md border border-line bg-raised p-1 text-fg shadow-1"
          >
            {tabs.map((t, i) => (
              <div key={t.id}>
                {t.group && t.group !== tabs[i - 1]?.group && (
                  <Menu.Label className="px-2.5 pt-2 pb-1 text-xs font-semibold text-muted">
                    {t.group}
                  </Menu.Label>
                )}
                <Menu.Item asChild>
                  <Link
                    href={t.href}
                    aria-current={t.id === activeTabId ? "page" : undefined}
                    className="flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-sm px-2.5 text-sm outline-none data-[highlighted]:bg-hover aria-[current=page]:font-semibold aria-[current=page]:text-accent-fg"
                  >
                    {t.label}
                    {t.count != null && t.count > 0 && (
                      <span className="rounded-full bg-waiting-bg px-1.5 text-xs font-semibold text-waiting-fg">
                        {t.count}
                      </span>
                    )}
                  </Link>
                </Menu.Item>
              </div>
            ))}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

export interface TopBarProps {
  apps: readonly AppLink[];
  currentApp: string;
  projects: readonly ProjectOption[];
  projectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  recentProjectIds?: readonly string[] | undefined;
  /** Offer "All projects" (only where an aggregate view makes sense). */
  allowAllProjects?: boolean | undefined;
  onManageProjects?: (() => void) | undefined;
  /** Global pages: the picker is disabled with this reason. */
  projectPickerDisabledReason?: string | undefined;
  tabs: readonly NavTab[];
  activeTabId?: string | undefined;
  /** e.g. "New work" for the selected project. */
  primaryAction?: ReactNode | undefined;
}

export function TopBar({
  apps,
  currentApp,
  projects,
  projectId,
  onProjectChange,
  recentProjectIds,
  allowAllProjects,
  onManageProjects,
  projectPickerDisabledReason,
  tabs,
  activeTabId,
  primaryAction,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-[var(--z-bar)] border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
      <div className="flex h-topbar items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <AppSwitcher apps={apps} currentApp={currentApp} />
        <span aria-hidden className="h-6 w-px bg-line max-sm:hidden" />
        <div className="w-40 min-w-0 shrink sm:w-48">
          <ProjectPicker
            projects={projects}
            value={projectId}
            onChange={onProjectChange}
            {...(recentProjectIds ? { recentIds: recentProjectIds } : {})}
            {...(allowAllProjects ? { allowAll: allowAllProjects } : {})}
            {...(onManageProjects ? { onManage: onManageProjects } : {})}
            disabledReason={projectPickerDisabledReason}
          />
        </div>
        <TabStrip tabs={tabs} activeTabId={activeTabId} />
        <PageMenu tabs={tabs} activeTabId={activeTabId} />
        {primaryAction && <div className="shrink-0 max-sm:hidden">{primaryAction}</div>}
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- BottomBar */

const themeIcon: Record<ThemePreference, IconName> = {
  light: "sun",
  dark: "moon",
  system: "monitor",
};
const themeLabel: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function ThemeMenu() {
  const [theme, setTheme] = useTheme();
  return (
    <Menu.Root>
      <Tooltip content={`Theme: ${themeLabel[theme]}`}>
        <Menu.Trigger
          aria-label={`Theme: ${themeLabel[theme]}`}
          className={cn(
            "inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover",
            focusRing,
          )}
        >
          <Icon name={themeIcon[theme]} />
        </Menu.Trigger>
      </Tooltip>
      <Menu.Portal>
        <Menu.Content
          side="top"
          align="end"
          sideOffset={8}
          className="fui-anim-pop z-[var(--z-dropdown)] min-w-40 rounded-md border border-line bg-raised p-1 text-fg shadow-1"
        >
          <Menu.Label className="px-2.5 pt-1.5 pb-1 text-xs font-semibold text-muted">
            Theme
          </Menu.Label>
          <Menu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePreference)}>
            {(["light", "dark", "system"] as const).map((t) => (
              <Menu.RadioItem
                key={t}
                value={t}
                className="flex h-control-sm cursor-pointer items-center gap-2 rounded-sm px-2.5 text-sm outline-none data-[highlighted]:bg-hover"
              >
                <Icon name={themeIcon[t]} className="text-muted" />
                <span className="flex-1">{themeLabel[t]}</span>
                <Menu.ItemIndicator>
                  <Icon name="check" className="text-accent-fg" />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

const barButton = cn(
  "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-medium whitespace-nowrap text-muted transition-colors hover:bg-hover hover:text-fg",
  focusRing,
);

function ConnectionIndicator({
  connection,
  inSheet = false,
}: {
  connection: ConnectionStatus;
  inSheet?: boolean;
}) {
  const c = connectionCopy[connection.state];
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip content={connection.detail ?? c.long}>
        <span
          role="status"
          tabIndex={0}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium",
            c.tone,
            focusRing,
          )}
        >
          <span aria-hidden className={cn("size-2 rounded-full", c.dot)} />
          <span className="sr-only">Connection: </span>
          {inSheet ? (
            c.long
          ) : (
            // Phones show only the dot (label stays for screen readers); wide screens the full text.
            <>
              <span className="max-sm:sr-only xl:hidden">{c.label}</span>
              <span className="max-xl:hidden">{c.long}</span>
            </>
          )}
        </span>
      </Tooltip>
      {connection.onReconnect &&
        connection.state !== "live" &&
        connection.state !== "connecting" && (
          <button
            type="button"
            onClick={connection.onReconnect}
            className={cn(barButton, "text-fg", !inSheet && "max-sm:hidden")}
          >
            <Icon name="refresh" size={14} />
            Reconnect
          </button>
        )}
    </div>
  );
}

function SessionIndicator({ session }: { session: SessionStatus }) {
  const operator = session.mode === "operator";
  const label = operator ? "Operator unlocked" : "Read-only";
  const trigger = (
    <button
      type="button"
      aria-label={`Session: ${label}`}
      className={cn(barButton, operator ? "text-success-fg" : "text-waiting-fg")}
    >
      <Icon name={operator ? "unlock" : "lock"} size={14} />
      <span className="max-sm:sr-only">{label}</span>
    </button>
  );
  if (!session.content)
    return (
      <Tooltip content={operator ? "Operator controls are available" : "You can look but not act"}>
        {trigger}
      </Tooltip>
    );
  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 max-w-[calc(100vw-24px)]">
        {session.content}
      </PopoverContent>
    </Popover>
  );
}

export interface BottomBarProps {
  connection: ConnectionStatus;
  session?: SessionStatus | undefined;
  globalLinks?: readonly GlobalLink[] | undefined;
  docsHref: string;
  onAsk?: (() => void) | undefined;
  onShortcuts?: (() => void) | undefined;
  onSignOut?: (() => void) | undefined;
  /** Extra items for the right side (e.g. a notifications bell). */
  extra?: ReactNode | undefined;
}

export function BottomBar({
  connection,
  session,
  globalLinks = [],
  docsHref,
  onAsk,
  onShortcuts,
  onSignOut,
  extra,
}: BottomBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const hasMore = globalLinks.length > 0 || onAsk || onSignOut || onShortcuts;
  return (
    <footer
      aria-label="Status and global"
      className="fixed inset-x-0 bottom-0 z-[var(--z-bar)] border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex h-bottombar items-center gap-1 px-2 sm:px-3">
        <ConnectionIndicator connection={connection} />
        {session && (
          <>
            <span aria-hidden className="mx-1 h-4 w-px bg-line max-sm:hidden" />
            <SessionIndicator session={session} />
          </>
        )}

        {globalLinks.length > 0 && (
          <nav aria-label="Global pages" className="ml-2 min-w-0 flex-1 max-lg:hidden">
            <ul className="flex items-center gap-0.5">
              {globalLinks.map((l) => (
                <li key={l.id}>
                  <Link href={l.href} className={barButton}>
                    {l.icon && <Icon name={l.icon} size={14} />}
                    {l.label}
                    {l.count != null && l.count > 0 && (
                      <span className="rounded-full bg-waiting-bg px-1.5 text-xs font-semibold text-waiting-fg">
                        {l.count}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {extra}
          <Link href={docsHref} className={barButton}>
            <Icon name="book" size={14} />
            Docs
          </Link>
          {onAsk && (
            <button type="button" onClick={onAsk} className={cn(barButton, "max-sm:hidden")}>
              <Icon name="guide" size={14} />
              Ask
            </button>
          )}
          <span className="max-sm:hidden">
            <ThemeMenu />
          </span>
          {onSignOut && (
            <button type="button" onClick={onSignOut} className={cn(barButton, "max-sm:hidden")}>
              <Icon name="logOut" size={14} />
              Sign out
            </button>
          )}
          {hasMore && (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              className={cn(barButton, globalLinks.length ? "lg:hidden" : "sm:hidden")}
            >
              <Icon name="more" size={16} />
              More
            </button>
          )}
        </div>
      </div>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen} side="bottom" title="More">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <ConnectionIndicator connection={connection} inSheet />
            {connection.detail && <p className="px-2 text-xs text-muted">{connection.detail}</p>}
          </div>
          {globalLinks.length > 0 && (
            <nav aria-label="Global pages (more)" className="flex flex-col gap-1">
              <p className="px-2 text-xs font-semibold tracking-wide text-muted uppercase">
                Global
              </p>
              {globalLinks.map((l) => (
                <Link
                  key={l.id}
                  href={l.href}
                  onClick={() => setMoreOpen(false)}
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-md px-2 text-md hover:bg-hover",
                    focusRing,
                  )}
                >
                  <Icon name={l.icon ?? "arrowRight"} className="text-muted" />
                  <span className="flex-1">{l.label}</span>
                  {l.count != null && l.count > 0 && (
                    <span className="rounded-full bg-waiting-bg px-1.5 text-xs font-semibold text-waiting-fg">
                      {l.count}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          )}
          <div className="flex flex-col gap-1">
            <p className="px-2 text-xs font-semibold tracking-wide text-muted uppercase">Help</p>
            {onAsk && (
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  onAsk();
                }}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-left text-md hover:bg-hover",
                  focusRing,
                )}
              >
                <Icon name="guide" className="text-muted" />
                Ask the guide
              </button>
            )}
            {onShortcuts && (
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  onShortcuts();
                }}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-left text-md hover:bg-hover",
                  focusRing,
                )}
              >
                <Icon name="help" className="text-muted" />
                Keyboard shortcuts
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <p className="px-2 text-xs font-semibold tracking-wide text-muted uppercase">Theme</p>
            <SegmentedControl
              label="Theme"
              value={theme}
              onValueChange={(v) => setTheme(v as ThemePreference)}
              className="w-full [&>*]:flex-1 [&>*]:justify-center"
              options={(["light", "dark", "system"] as const).map((t) => ({
                value: t,
                label: themeLabel[t],
                icon: themeIcon[t],
              }))}
            />
          </div>
          {onSignOut && (
            <Button
              variant="secondary"
              icon="logOut"
              size="lg"
              onClick={() => {
                setMoreOpen(false);
                onSignOut();
              }}
            >
              Sign out
            </Button>
          )}
        </div>
      </Drawer>
    </footer>
  );
}

/* ----------------------------------------------------------------- AppShell */

export interface AppShellProps extends TopBarProps, BottomBarProps {
  /** Shown in document.title as "{page} · {project} · {app}". */
  appName: string;
  pageTitle?: string | undefined;
  /** Change on navigation to move focus to the page H1 (skipped on first render). */
  routeKey?: string | undefined;
  children: ReactNode;
}

/**
 * The shared frame: sticky top bar (project-scoped navigation), main content, fixed 40px bottom
 * bar (connection, session, global pages, help, theme, sign out). Includes the skip link and the
 * toast region.
 */
export function AppShell({ appName, pageTitle, routeKey, children, ...props }: AppShellProps) {
  const projectName =
    props.projectId == null
      ? props.allowAllProjects
        ? "All projects"
        : undefined
      : props.projects.find((p) => p.id === props.projectId)?.name;
  useEffect(() => {
    document.title = [pageTitle, projectName, appName].filter(Boolean).join(" · ");
  }, [pageTitle, projectName, appName]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.querySelector<HTMLElement>("main h1")?.focus();
  }, [routeKey]);

  return (
    <ToastProvider>
      <div className="flex min-h-dvh flex-col bg-canvas text-fg">
        <a
          href="#main"
          className="sr-only z-[var(--z-tooltip)] rounded-md bg-accent px-4 py-2 font-semibold text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <TopBar {...props} />
        <main
          id="main"
          tabIndex={-1}
          className="flex-1 pb-[calc(var(--bottombar-height)+env(safe-area-inset-bottom))] outline-none"
        >
          {children}
        </main>
        <BottomBar {...props} />
      </div>
    </ToastProvider>
  );
}
