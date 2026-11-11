import type { AppId } from "./types.js";

/**
 * Screen names and places as each app builds them. This is the one place to change when a screen
 * is renamed or moved: the docs write `{{screen:app.id}}` (name with its place) or
 * `{{label:app.id}}` (name only) and are rendered from this table, so the walkthrough and
 * per-screen guides follow. Sindri reads its tab labels and groups from here; the other apps
 * hard-code theirs, so keep labels identical to their shells.
 *
 * `top`: project tab. `action`: top-bar button (Heimdall's New work). `bottom`: global item in the
 * fixed bottom bar. `detail`: opens from a list. `entry`: before sign-in.
 */
export type Placement = "top" | "action" | "bottom" | "detail" | "entry";

export interface NavScreen {
  id: string;
  label: string;
  placement: Placement;
  /** Top-bar group; null for ungrouped tabs and for every non-top screen. */
  group: string | null;
}

/** Top-bar tab groups per app, left to right; empty when the app's tabs are not grouped. */
export const NAV_GROUPS: Readonly<Record<AppId, readonly string[]>> = {
  sindri: ["Intake", "Define", "Execute", "Ship & learn"],
  mimir: [],
  heimdall: ["Watch", "Decide"],
  skidbladnir: [],
};

/** Sindri's groups; kept for 0.1.0 consumers. */
export const TOP_GROUPS = ["Intake", "Define", "Execute", "Ship & learn"] as const;

const make =
  (placement: Placement) =>
  (id: string, label: string, group: string | null = null): NavScreen => ({
    id,
    label,
    placement,
    group,
  });
const top = make("top");
const action = make("action");
const bottom = make("bottom");
const detail = make("detail");
const entry = make("entry");

export const NAV: Readonly<Record<AppId, readonly NavScreen[]>> = {
  sindri: [
    entry("sign-in", "Sign in"),
    top("overview", "Overview"),
    top("inbox", "Inbox", "Intake"),
    top("director", "Director", "Intake"),
    top("specs", "Specs", "Define"),
    top("plans", "Plans", "Define"),
    top("runs", "Runs", "Execute"),
    detail("run-detail", "Run detail"),
    top("needs-you", "Needs you", "Execute"),
    top("deliveries", "Deliveries", "Ship & learn"),
    detail("delivery-detail", "Delivery detail"),
    top("knowledge", "Knowledge", "Ship & learn"),
    top("autonomy", "Autonomy", "Ship & learn"),
    top("project-settings", "Project settings"),
    bottom("projects", "Projects"),
    bottom("harnesses", "Harnesses"),
    bottom("autonomy-all", "Autonomy (all)"),
    bottom("settings", "Settings"),
    bottom("docs", "Docs"),
    bottom("ask", "Ask"),
  ],
  mimir: [
    entry("sign-in", "Sign in"),
    top("overview", "Overview"),
    top("missions", "Missions"),
    detail("mission-detail", "Mission detail"),
    top("crews", "Crews"),
    detail("crew-detail", "Crew detail"),
    detail("agent", "Agent"),
    top("reviews", "Reviews"),
    top("activity", "Activity"),
    bottom("projects", "Projects"),
    bottom("settings", "Settings"),
    bottom("docs", "Docs"),
    bottom("ask", "Ask"),
  ],
  heimdall: [
    entry("sign-in", "Sign in"),
    top("overview", "Overview", "Watch"),
    top("pipeline", "Pipeline", "Watch"),
    top("crews-agents", "Crews & agents", "Watch"),
    top("execution-graph", "Execution graph", "Watch"),
    top("activity", "Activity", "Watch"),
    top("quality-approvals", "Quality & approvals", "Decide"),
    top("autonomy", "Autonomy", "Decide"),
    action("new-work", "New work"),
    bottom("notifications", "Notifications"),
    bottom("projects", "Projects"),
    bottom("connections", "Connections"),
    bottom("fleet", "Fleet"),
    bottom("autonomy-all", "Autonomy (all)"),
    bottom("docs", "Docs"),
    bottom("ask", "Ask"),
  ],
  skidbladnir: [
    top("fleet", "Worker fleet"),
    detail("worker-detail", "Worker detail"),
    top("launch", "Launch"),
    top("history", "Event history"),
    bottom("setup-guide", "Setup guide"),
    bottom("docs", "Docs"),
    bottom("ask", "Ask"),
  ],
};

/**
 * Bottom-bar items, left to right, as the shared shell draws them. An app leaves out what it has
 * no use for (Skidbladnir: no session, no sign-out). Shortcuts sit in the narrow-screen More sheet
 * and behind the `?` key, not in the bar.
 */
export const BOTTOM_BAR_CONTROLS = [
  "Connection status (Live / Reconnecting / Offline)",
  "Session state (Read-only / Operator unlocked)",
  "Global pages",
  "App extras (Mimir help, Skidbladnir mode)",
  "Docs, Ask",
  "Theme, Sign out",
] as const;

/**
 * Screen ids that resolve to another screen, per app (`alias → id`): a renamed id, or the URL
 * path segment where it differs from the id, so a "Learn more" link built either way resolves.
 */
export const SCREEN_ALIASES: Readonly<Record<AppId, Readonly<Record<string, string>>>> = {
  sindri: { reviews: "needs-you" },
  mimir: {},
  heimdall: { crews: "crews-agents", graph: "execution-graph", quality: "quality-approvals" },
  skidbladnir: {},
};

export const APP_NAMES: Readonly<Record<AppId, string>> = {
  sindri: "Sindri",
  mimir: "Mimir",
  heimdall: "Heimdall",
  skidbladnir: "Skidbladnir",
};

/** The screen with this id, or the one its alias in SCREEN_ALIASES points to. */
export function navScreen(app: AppId, id: string): NavScreen | undefined {
  const real = SCREEN_ALIASES[app][id] ?? id;
  return NAV[app].find((s) => s.id === real);
}

/** "Execute › Runs (top bar)", "New work (top-bar button)", "Settings (bottom bar)", "Run detail". */
export function screenPlace(app: AppId, screen: NavScreen): string {
  const name = APP_NAMES[app];
  switch (screen.placement) {
    case "top":
      return `${name} › ${screen.group ? `${screen.group} › ` : ""}${screen.label} (top bar)`;
    case "action":
      return `${name} › ${screen.label} (top-bar button)`;
    case "bottom":
      return `${name} › ${screen.label} (bottom bar)`;
    default:
      return `${name} › ${screen.label}`;
  }
}
