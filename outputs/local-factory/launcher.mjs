// Decisions the launcher makes, kept free of service imports so they can be tested alone.
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_FLEET = { version: 1, workers: [{ id: 'local-mac', runtime: 'cli', capacity: 2, agentKinds: ['codex', 'claude', 'opencode', 'gemini', 'pi'] }] };

/** The fleet file Mimir reads, created with one local worker only when the fleet runtime needs one and none exists. */
export function ensureFleetConfig(env, root, runtime, fs = { existsSync, writeFileSync }) {
  const path = env.MIMIR_FLEET_CONFIG || join(root, 'fleet.json');
  if (runtime === 'fleet' && !fs.existsSync(path)) fs.writeFileSync(path, JSON.stringify(DEFAULT_FLEET, null, 2), { mode: 0o600 });
  return path;
}

// A slow CLI on a busy machine is not a signed-out CLI: say which it was.
const slow = error => error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM';

/**
 * Codex is checked only when it runs locally (not for the ssh runtime); Claude Code always plans and
 * reviews, so it is always checked. Throws the operator-facing message for the first failure.
 */
export function checkLogins(runtime, { codex, claude }, exec) {
  try { if (runtime !== 'ssh') exec(codex, ['login', 'status'], { stdio: 'pipe', timeout: 30000 }); }
  catch (error) { throw new Error(slow(error) ? 'Codex did not answer its login check within 30 seconds. Try starting the factory again.' : 'Codex is unavailable or signed out. Open Codex and sign in, then restart the factory.'); }
  try { if (!JSON.parse(exec(claude, ['auth', 'status'], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 })).loggedIn) throw Error(); }
  catch (error) { throw new Error(slow(error) ? 'Claude Code did not answer its login check within 30 seconds. Try starting the factory again.' : 'Claude Code is unavailable or signed out. Run claude auth login in Terminal, then restart the factory.'); }
}

export const FIRST_RUN_DEFAULTS = { provider: 'claude-cli', model: 'default', localOnly: false, workerAgent: 'codex', reviewerAgent: 'claude', brokkrEnabled: true };

/**
 * Settings written on every start. The agent defaults replace Sindri's own `null` default only on
 * the first run: after that `null` is the operator's choice and is kept. Mimir's address always follows the launcher.
 */
export function launcherSettings(saved, { firstRun, mimirPort }) {
  return { ...saved, ...(firstRun && saved.provider === 'null' ? FIRST_RUN_DEFAULTS : {}), mimirUrl: `http://127.0.0.1:${mimirPort}`, mimirTokenSecret: 'local.mimir.token' };
}

/** Present once the launcher has applied its first-run settings to this Sindri data directory. */
export const defaultsMarker = sindriDataDir => join(sindriDataDir, '.launcher-defaults-applied');

/**
 * One shutdown shared by every signal and by a failed start: a second call waits for the first.
 * The access file goes first, then Heimdall, Sindri and Mimir; one step failing never skips the rest.
 */
export function createShutdown({ accessFile, services, report = message => console.error(message), fs = { existsSync, unlinkSync } }) {
  let shutdown;
  return () => shutdown ??= (async () => {
    try { if (accessFile && fs.existsSync(accessFile)) fs.unlinkSync(accessFile); }
    catch (error) { report('Shutdown error: ' + error.message); }
    for (const service of services()) { try { await service?.close(); } catch (error) { report('Shutdown error: ' + error.message); } }
  })();
}
