import type { State, View } from "./reducer.js";

const VIEWS: readonly View[] = [
  "projects",
  "inbox",
  "director",
  "specs",
  "knowledge",
  "settings",
  "plans",
  "harnesses",
  "runs",
  "reviews",
  "deliveries",
];

/** The routable part of the state. */
export type Route = Pick<
  State,
  "view" | "projectId" | "specId" | "planId" | "executionId" | "deliveryId"
>;

const PARAMS: [keyof Route, string][] = [
  ["projectId", "project"],
  ["specId", "spec"],
  ["planId", "plan"],
  ["executionId", "execution"],
  ["deliveryId", "delivery"],
];

/** `#/<view>?project=…&spec=…&plan=…&execution=…&delivery=…` (only the set ones). */
export function routeHash(state: Route): string {
  const q = new URLSearchParams();
  for (const [key, name] of PARAMS) {
    const v = state[key];
    if (typeof v === "string" && v) q.set(name, v);
  }
  const qs = q.toString();
  return `#/${state.view}${qs ? `?${qs}` : ""}`;
}

/** The route in a hash, or `{}` when it names no known view. */
export function parseHash(hash: string): Partial<Route> {
  const m = /^#\/([a-z]+)(?:\?(.*))?$/.exec(hash);
  const view = m?.[1] as View | undefined;
  if (!view || !VIEWS.includes(view)) return {};
  const q = new URLSearchParams(m?.[2] ?? "");
  const out: Partial<Route> = { view };
  for (const [key, name] of PARAMS) (out as Record<string, string | null>)[key] = q.get(name);
  return out;
}
