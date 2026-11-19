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

type AppOrigins = { mimir?: string; sindri?: string };

export const switcherApps = (overview: string, origins: AppOrigins = {}) =>
  FACTORY_APPS.map((app) => {
    if (app.id === "heimdall") return { ...app, href: overview };
    const page = new URL(app.href);
    return {
      ...app,
      href: new URL(page.pathname + page.hash, origins[app.id] ?? page).href,
    };
  });

/** Sindri's delivery view (its hash route); Sindri project and execution IDs. */
export const sindriDeliveryHref = (
  projectId: string | null | undefined,
  executionId: string,
  origins: AppOrigins = {},
) => {
  const q = new URLSearchParams({
    ...(projectId ? { project: projectId } : {}),
    delivery: executionId,
  });
  return new URL(`/#/deliveries?${q}`, origins.sindri ?? FACTORY_APPS[0].href)
    .href;
};

export function sindriDecisionLogHref(
  projectId: string,
  origins: AppOrigins = {},
) {
  const q = new URLSearchParams({ project: projectId });
  return new URL(`/#/autonomy?${q}`, origins.sindri ?? FACTORY_APPS[0].href)
    .href;
}
