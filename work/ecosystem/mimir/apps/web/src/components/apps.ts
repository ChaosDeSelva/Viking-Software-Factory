import type { AppLink } from "@factory/ui";

/** The other factory apps on this machine (fixed local ports). */
export const SINDRI_URL = "http://127.0.0.1:4310";
export const HEIMDALL_URL = "http://127.0.0.1:4320";

/**
 * App switcher entries. Project ids are per app (Mimir `prj_…`, Sindri UUIDs), so the selected
 * project is not carried over with `?project=`.
 */
export const FACTORY_APPS: readonly AppLink[] = [
  { id: "sindri", label: "Sindri", href: SINDRI_URL, description: "Plans: intake, specs and runs" },
  { id: "mimir", label: "Mimir", href: "/", description: "Executes missions with crews of agents" },
  {
    id: "heimdall",
    label: "Heimdall",
    href: HEIMDALL_URL,
    description: "Watches the whole factory",
  },
];
