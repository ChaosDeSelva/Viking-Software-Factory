import type { AppLink } from "@factory/ui";

const env = import.meta.env as Record<string, string | undefined>;

/** Where the other factory apps are served; overridable at build time (`VITE_*_URL`). */
export const APP_URLS = {
  sindri: env["VITE_SINDRI_URL"] ?? "http://127.0.0.1:4310",
  heimdall: env["VITE_HEIMDALL_URL"] ?? "http://127.0.0.1:4320",
  mimir: env["VITE_MIMIR_URL"] ?? "http://127.0.0.1:7700",
  /** Not served by default; the switcher lists it only when this is set. */
  skidbladnir: env["VITE_SKIDBLADNIR_URL"],
} as const;

/** App switcher entries; see `switcherApps` for which carry the project. */
export const FACTORY_APPS: readonly AppLink[] = [
  {
    id: "sindri",
    label: "Sindri",
    href: APP_URLS.sindri,
    description: "Plan: intake, specs, plans, runs",
  },
  {
    id: "mimir",
    label: "Mimir",
    href: APP_URLS.mimir,
    description: "Execute: missions, crews, agents",
  },
  {
    id: "heimdall",
    label: "Heimdall",
    href: APP_URLS.heimdall,
    description: "Watch: the whole factory",
  },
  ...(APP_URLS.skidbladnir
    ? [
        {
          id: "skidbladnir",
          label: "Skidbladnir",
          href: APP_URLS.skidbladnir,
          description: "Workers: the fleet",
        },
      ]
    : []),
];

/** Mimir crew page, where a crew's hard budget is raised. */
export const mimirCrewHref = (crewId: string) =>
  `${APP_URLS.mimir}/crews/${encodeURIComponent(crewId)}`;
export const heimdallHref = (projectId: string | null) =>
  projectId ? `${APP_URLS.heimdall}/?project=${encodeURIComponent(projectId)}` : APP_URLS.heimdall;

/**
 * Switcher entries for the selected project. Project ids are per app: Mimir drops an unknown
 * `?project=` and resets its own choice, so only Heimdall (which resolves Sindri ids) gets one.
 */
export const switcherApps = (projectId: string | null): AppLink[] =>
  FACTORY_APPS.map((a) => (a.id === "heimdall" ? { ...a, href: heimdallHref(projectId) } : a));
