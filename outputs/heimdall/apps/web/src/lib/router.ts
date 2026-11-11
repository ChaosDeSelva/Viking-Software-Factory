// URL routing without a router dependency: each page has a path, the project and an open record
// live in the query (`?project=`, `?inspect=kind:id`), and history entries make Back work. The
// server answers every non-API path with index.html, so any of these URLs can be bookmarked.
import { useSyncExternalStore, type MouseEvent } from "react";

export type PageId =
  | "overview"
  | "new-work"
  | "pipeline"
  | "crews-agents"
  | "execution-graph"
  | "activity"
  | "quality-approvals"
  | "autonomy"
  | "notifications"
  | "projects"
  | "connections"
  | "fleet"
  | "autonomy-all"
  | "docs";

export const PATHS: Record<PageId, string> = {
  overview: "/",
  "new-work": "/new-work",
  pipeline: "/pipeline",
  "crews-agents": "/crews",
  "execution-graph": "/graph",
  activity: "/activity",
  "quality-approvals": "/quality",
  autonomy: "/autonomy",
  notifications: "/notifications",
  projects: "/projects",
  connections: "/connections",
  fleet: "/fleet",
  "autonomy-all": "/autonomy/all",
  docs: "/docs",
};

/** Pages that show every project; the picker is disabled on them. */
export const GLOBAL_PAGES: readonly PageId[] = [
  "notifications",
  "projects",
  "connections",
  "fleet",
  "autonomy-all",
  "docs",
];

export interface Route {
  page: PageId;
  /** Connections section or docs page slug; "" when the path has none. */
  sub: string;
  params: URLSearchParams;
  hash: string;
}

/** Path + query → route. Unknown paths land on the Overview. */
export function parseRoute(pathname: string, search: string, hash = ""): Route {
  const params = new URLSearchParams(search);
  // Old links: `?view=fleet` opened the fleet page, `?task=` a task (Hulder links still use it).
  if (params.get("view") === "fleet")
    return { page: "fleet", sub: "", params, hash };
  const task = params.get("task");
  if (task && !params.has("inspect")) {
    params.delete("task");
    params.set("inspect", "tasks:" + task);
  }
  const parts = pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const [first = "", second = ""] = parts;
  if (first === "autonomy" && second === "all")
    return { page: "autonomy-all", sub: "", params, hash };
  const page = (Object.keys(PATHS) as PageId[]).find(
    (id) => PATHS[id] === "/" + first,
  );
  return { page: page ?? "overview", sub: page ? second : "", params, hash };
}

/** `?project=` and other params on a page path; empty values are left out. */
export function hrefFor(
  page: PageId,
  params: Record<string, string | null | undefined> = {},
  sub = "",
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const path =
    PATHS[page] +
    (sub ? (PATHS[page] === "/" ? "" : "/") + encodeURIComponent(sub) : "");
  const query = q.toString();
  return path + (query ? "?" + query : "");
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}
const snapshot = () => location.pathname + location.search + location.hash;

/** The current route; re-renders on navigate() and Back/Forward. */
export function useRoute(): Route {
  const key = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(key, location.origin);
  return parseRoute(url.pathname, url.search, url.hash.slice(1));
}

/** Same-origin navigation; `replace` keeps Back from collecting filter changes. */
export function navigate(href: string, { replace = false } = {}) {
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) {
    location.href = url.href;
    return;
  }
  if (url.pathname + url.search + url.hash === snapshot()) return;
  history[replace ? "replaceState" : "pushState"](null, "", url);
  notify();
  // A docs link jumps to its heading once the page rendered it.
  if (url.hash)
    requestAnimationFrame(() =>
      document
        .getElementById(decodeURIComponent(url.hash.slice(1)))
        ?.scrollIntoView(),
    );
}

/** Changes query params on the current URL (null removes one). */
export function setParams(
  changes: Record<string, string | null>,
  options = { replace: false },
) {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(changes))
    if (v == null || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  navigate(url.pathname + url.search + url.hash, options);
}

/** True for a plain left click the app should handle itself (not a new tab or download). */
export const isPlainClick = (e: MouseEvent) =>
  e.button === 0 &&
  !e.metaKey &&
  !e.ctrlKey &&
  !e.shiftKey &&
  !e.altKey &&
  !e.defaultPrevented;
