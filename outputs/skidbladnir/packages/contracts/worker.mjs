// Factory project ids (Sindri slugs or UUIDs): one path-safe token, so it can sit in `?project=`.
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function workerInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a worker specification.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$/.test(name))
    throw new Error('Use a name of 1–64 letters, numbers, spaces, underscores or dashes.');
  if (!['node', 'python', 'general'].includes(input.template)) throw new Error('Select a supported template.');
  if (!Number.isInteger(input.minutes) || input.minutes < 5 || input.minutes > 240)
    throw new Error('Lifetime must be 5–240 minutes.');
  const project = projectInput(input.project);
  return { name, template: input.template, minutes: input.minutes, ...(project ? { project } : {}) };
}

/** Optional factory project label; blank means none. Kept off the record entirely when absent. */
export function projectInput(value) {
  if (value === undefined || value === null) return undefined;
  const project = typeof value === 'string' ? value.trim() : value;
  if (project === '') return undefined;
  if (typeof project !== 'string' || !PROJECT.test(project))
    throw new Error('Project must be 1–100 letters, numbers, dots, underscores or dashes.');
  return project;
}

/**
 * The part of a snapshot that belongs to one project: its workers and the events, commands,
 * terminals and artifacts of those workers. Capacity (`maxWorkers`) stays fleet-wide because the
 * limit is shared, so `fleetActive` carries the fleet-wide active count alongside it.
 */
export function projectSnapshot(snapshot, project) {
  if (!project) return snapshot;
  const workers = snapshot.workers.filter((w) => w.project === project),
    ids = new Set(workers.map((w) => w.id));
  const mine = (list) => (list ?? []).filter((x) => ids.has(x.workerId));
  return {
    ...snapshot,
    project,
    workers,
    events: mine(snapshot.events),
    commands: mine(snapshot.commands),
    terminals: mine(snapshot.terminals),
    artifacts: mine(snapshot.artifacts),
    fleetActive: activeCount(snapshot.workers),
  };
}

/** Workers that hold a slot against `maxWorkers`. */
export const isActive = (worker) => !['terminated', 'failed'].includes(worker.state);
export const activeCount = (workers) => workers.filter(isActive).length;

export const actions = new Set(['start', 'stop', 'reboot', 'terminate']);
