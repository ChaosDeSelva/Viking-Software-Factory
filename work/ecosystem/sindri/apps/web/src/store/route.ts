import type { State, View } from "./reducer.js";

export const VIEW_IDS: readonly View[] = [
  "overview",
  "inbox",
  "director",
  "specs",
  "plans",
  "runs",
  "needs-you",
  "deliveries",
  "knowledge",
  "autonomy",
  "project-settings",
  "projects",
  "harnesses",
  "autonomy-all",
  "settings",
  "docs",
];

/** Old hashes keep working: bookmarks and Guide answers from before the redesign. */
const ALIASES: Readonly<Record<string, View>> = { reviews: "needs-you" };

/** The routable part of the state. */
export type Route = Pick<
  State,
  | "view"
  | "projectId"
  | "specId"
  | "planId"
  | "executionId"
  | "deliveryId"
  | "docsSlug"
  | "docsSection"
>;

const PARAMS: [keyof Route, string][] = [
  ["projectId", "project"],
  ["specId", "spec"],
  ["planId", "plan"],
  ["executionId", "execution"],
  ["deliveryId", "delivery"],
  ["docsSection", "section"],
];

/**
 * `#/<view>?project=…&spec=…&plan=…&execution=…&delivery=…` (only the set ones); the docs view
 * is `#/docs/<slug>?section=<anchor>`.
 */
export function routeHash(state: Route): string {
  const q = new URLSearchParams();
  for (const [key, name] of PARAMS) {
    if (key === "docsSection" && state.view !== "docs") continue;
    const v = state[key];
    if (typeof v === "string" && v) q.set(name, v);
  }
  const qs = q.toString();
  const slug = state.view === "docs" && state.docsSlug ? `/${state.docsSlug}` : "";
  return `#/${state.view}${slug}${qs ? `?${qs}` : ""}`;
}

/** The route in a hash, or `{}` when it names no known view. */
export function parseHash(hash: string): Partial<Route> {
  const m = /^#\/([a-z-]+)(?:\/([a-z0-9-]+))?(?:\?(.*))?$/.exec(hash);
  const name = m?.[1] ?? "";
  const view = ALIASES[name] ?? (VIEW_IDS as readonly string[]).find((v) => v === name);
  if (!view) return {};
  const q = new URLSearchParams(m?.[3] ?? "");
  const out: Partial<Route> = { view: view as View };
  for (const [key, name] of PARAMS) (out as Record<string, string | null>)[key] = q.get(name);
  out.docsSlug = view === "docs" ? (m?.[2] ?? null) : null;
  if (view !== "docs") out.docsSection = null;
  return out;
}

/**
 * Hash for an in-app href: `/docs/<slug>#<anchor>` (the `@factory/docs` link form) becomes the
 * docs route; `#/…` hashes pass through. Returns null for anything else (external links).
 */
export function appHref(href: string, projectId: string | null): string | null {
  const docs = /^\/docs(?:\/([a-z0-9-]+))?(?:#([^#\s]+))?$/.exec(href);
  if (docs) {
    const q = new URLSearchParams();
    if (projectId) q.set("project", projectId);
    if (docs[2]) q.set("section", docs[2]);
    const qs = q.toString();
    return `#/docs${docs[1] ? `/${docs[1]}` : ""}${qs ? `?${qs}` : ""}`;
  }
  if (href.startsWith("#/")) return href;
  return null;
}
