// Links to the other factory apps. Project IDs are per app (Skidbladnir's are worker labels,
// Mimir's `prj_…`, Sindri's UUIDs), so none is carried over: each app opens on its landing page.
import { withProject } from '@factory/ui';

/** Sindri routes in the hash; its Overview hosts the "Ask the factory" Guide. */
export const SINDRI_OVERVIEW = 'http://127.0.0.1:4310/#/overview';

/** Switcher entries; only Skidbladnir's own link (`here`) keeps the selected project. */
export const switcherApps = (here, project) => [
  { id: 'sindri', label: 'Sindri', href: SINDRI_OVERVIEW, description: 'Plan: intake, specs, plans, runs' },
  { id: 'mimir', label: 'Mimir', href: 'http://127.0.0.1:7700/', description: 'Execute: missions, crews, agents' },
  { id: 'heimdall', label: 'Heimdall', href: 'http://127.0.0.1:4320/', description: 'Watch: the whole factory' },
  { id: 'skidbladnir', label: 'Skidbladnir', href: withProject(here, project), description: 'Workers: the fleet' },
];
