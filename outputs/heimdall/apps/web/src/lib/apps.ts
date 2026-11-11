// The app switcher. Project IDs are per app (Mimir `prj_…`, Sindri UUIDs), so links to the other
// apps carry no `?project=`: each opens on its own landing page and keeps its own selection.
export const FACTORY_APPS = [
  {
    id: "sindri",
    label: "Sindri",
    // Sindri routes in the hash; `#/overview` is its landing view.
    href: "http://127.0.0.1:4310/#/overview",
    description: "Plan: intake, specs, plans, runs",
  },
  {
    id: "heimdall",
    label: "Heimdall",
    href: "/",
    description: "Watch: every project and agent",
  },
  {
    id: "mimir",
    label: "Mimir",
    href: "http://127.0.0.1:7700/",
    description: "Execute: missions, crews, agents",
  },
] as const;

/** Switcher entries; only Heimdall's own link keeps the current project (`overview`). */
export const switcherApps = (overview: string) =>
  FACTORY_APPS.map((a) => ({
    ...a,
    href: a.id === "heimdall" ? overview : a.href,
  }));
