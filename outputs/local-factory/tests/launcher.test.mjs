import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ensureFleetConfig, checkLogins, launcherSettings, defaultsMarker, launcherDefaults, createShutdown, DEFAULT_FLEET, FIRST_RUN_DEFAULTS } from '../launcher.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'local-factory-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('the fleet runtime gets a private one-worker fleet file only when none exists', t => {
  const root = temporary(t), path = join(root, 'fleet.json');
  assert.equal(ensureFleetConfig({}, root, 'fleet'), path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), DEFAULT_FLEET);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, '{"operator":"edited"}');
  ensureFleetConfig({}, root, 'fleet');
  assert.equal(readFileSync(path, 'utf8'), '{"operator":"edited"}');
  const chosen = join(root, 'chosen.json');
  assert.equal(ensureFleetConfig({ MIMIR_FLEET_CONFIG: chosen }, root, 'fleet'), chosen);
  assert.deepEqual(JSON.parse(readFileSync(chosen, 'utf8')), DEFAULT_FLEET);
  const other = temporary(t);
  for (const runtime of ['cli', 'ssh']) assert.equal(ensureFleetConfig({}, other, runtime), join(other, 'fleet.json'));
  assert.equal(existsSync(join(other, 'fleet.json')), false);
});

test('login checks apply Codex only to local runtimes and always check Claude Code', () => {
  const run = (runtime, answers) => {
    const calls = [];
    const exec = (file, args, options) => { calls.push([file, ...args]); assert.equal(options.timeout, 30000); assert.equal(options.stdio, 'pipe'); const answer = answers[file]; if (answer instanceof Error) throw answer; return answer; };
    let error; try { checkLogins(runtime, { codex: 'codex-bin', claude: 'claude-bin' }, exec); } catch (caught) { error = caught; }
    return { calls, error: error?.message };
  };
  const signedIn = { 'codex-bin': '', 'claude-bin': '{"loggedIn":true}' };
  for (const runtime of ['fleet', 'cli']) assert.deepEqual(run(runtime, signedIn), { calls: [['codex-bin', 'login', 'status'], ['claude-bin', 'auth', 'status']], error: undefined });
  assert.deepEqual(run('ssh', { ...signedIn, 'codex-bin': Error('absent') }), { calls: [['claude-bin', 'auth', 'status']], error: undefined });
  const timeout = Object.assign(Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), killed = Object.assign(Error('killed'), { signal: 'SIGTERM' });
  assert.match(run('fleet', { ...signedIn, 'codex-bin': Error('not logged in') }).error, /^Codex is unavailable or signed out/);
  assert.match(run('fleet', { ...signedIn, 'codex-bin': timeout }).error, /^Codex did not answer its login check within 30 seconds/);
  assert.match(run('fleet', { ...signedIn, 'codex-bin': killed }).error, /^Codex did not answer/);
  const failedCodex = run('fleet', { ...signedIn, 'codex-bin': Error('no') });
  assert.equal(failedCodex.calls.length, 1, 'Claude is not checked after Codex fails');
  for (const answer of ['{"loggedIn":false}', '{}', 'not json', Error('absent')]) assert.match(run('ssh', { 'claude-bin': answer }).error, /^Claude Code is unavailable or signed out/, String(answer));
  assert.match(run('ssh', { 'claude-bin': timeout }).error, /^Claude Code did not answer its login check within 30 seconds/);
});

test('agent defaults replace Sindri\'s null provider on the first run only', () => {
  const fresh = { provider: 'null', model: 'claude-x', localOnly: true };
  assert.deepEqual(launcherSettings(fresh, { firstRun: true, mimirPort: '7700' }), { ...FIRST_RUN_DEFAULTS, mimirUrl: 'http://127.0.0.1:7700', mimirTokenSecret: 'local.mimir.token' });
  // An operator who later chose the null provider keeps it across restarts.
  assert.deepEqual(launcherSettings({ ...fresh, mimirUrl: 'http://127.0.0.1:1' }, { firstRun: false, mimirPort: '47700' }), { ...fresh, mimirUrl: 'http://127.0.0.1:47700', mimirTokenSecret: 'local.mimir.token' });
  const chosen = { provider: 'codex-cli', model: 'm', localOnly: false, workerAgent: 'claude', connectors: { linear: { apiKeySecret: 'k' } } };
  assert.deepEqual(launcherSettings(chosen, { firstRun: true, mimirPort: '7700' }), { ...chosen, mimirUrl: 'http://127.0.0.1:7700', mimirTokenSecret: 'local.mimir.token' });
  assert.equal(defaultsMarker('/data/sindri'), '/data/sindri/.launcher-defaults-applied');
});

test('defaults apply only when there is neither a marker nor a saved settings row', t => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-defaults-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Sindri's settings table, as its migration creates it.
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE server_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const marker = defaultsMarker(dir);
  const fresh = launcherDefaults(db, dir);
  assert.equal(fresh.firstRun, true); assert.equal(existsSync(marker), false, 'marked only after the settings are saved');
  fresh.markApplied(); assert.equal(existsSync(marker), true); assert.equal(statSync(marker).mode & 0o777, 0o600);
  assert.equal(launcherDefaults(db, dir).firstRun, false);
  // A data directory from the launcher before the marker existed: settings saved, no marker.
  rmSync(marker);
  db.prepare("INSERT INTO server_settings VALUES (1, ?, '2026-01-01')").run(JSON.stringify({ provider: 'null', model: 'm', localOnly: true }));
  const upgraded = launcherDefaults(db, dir);
  assert.equal(upgraded.firstRun, false, 'an existing operator\'s settings are not reset');
  upgraded.markApplied(); assert.equal(existsSync(marker), true);
  const before = readFileSync(marker, 'utf8'); launcherDefaults(db, dir).markApplied(); assert.equal(readFileSync(marker, 'utf8'), before, 'an existing marker is left alone');
});

test('shutdown removes the access file, closes every service in order once, and survives failures', async t => {
  const dir = temporary(t), accessFile = join(dir, 'access.json'), order = [], reports = [];
  writeFileSync(accessFile, '{}');
  const service = (name, fail) => ({ close: async () => { order.push(name); if (fail) throw Error(name + ' would not close'); } });
  const services = [service('heimdall'), service('sindri', true), service('mimir')];
  const close = createShutdown({ accessFile, services: () => services, report: m => reports.push(m) });
  const [first, second] = [close(), close()];
  assert.equal(first, second);
  await first;
  assert.deepEqual(order, ['heimdall', 'sindri', 'mimir']);
  assert.deepEqual(reports, ['Shutdown error: sindri would not close']);
  assert.equal(existsSync(accessFile), false);
  await close(); assert.equal(order.length, 3);
});

test('shutdown before services exist, without an access file, or with an unremovable one still closes what exists', async () => {
  let services = [undefined, undefined, undefined];
  await createShutdown({ accessFile: undefined, services: () => services })();
  await createShutdown({ accessFile: '/nonexistent/access.json', services: () => services })();
  const closed = [], reports = [];
  services = [undefined, { close: async () => closed.push('sindri') }, { close: async () => closed.push('mimir') }];
  const fs = { existsSync: () => true, unlinkSync: () => { throw Error('EPERM'); } };
  await createShutdown({ accessFile: 'access.json', services: () => services, report: m => reports.push(m), fs })();
  assert.deepEqual(closed, ['sindri', 'mimir']);
  assert.deepEqual(reports, ['Shutdown error: EPERM']);
});

test('the default reporter writes shutdown errors to stderr', async t => {
  const lines = []; t.mock.method(console, 'error', m => lines.push(m));
  await createShutdown({ services: () => [{ close: async () => { throw Error('stuck'); } }] })();
  assert.deepEqual(lines, ['Shutdown error: stuck']);
});

// build.sh runs against a copy of the repository layout with stand-in pnpm and npm, so nothing is installed or built.
function buildFixture(t, npmFails) {
  const root = temporary(t), bin = join(root, 'bin'), log = join(root, 'log.txt');
  for (const project of ['work/ecosystem/brokkr', 'work/ecosystem/mimir', 'work/ecosystem/sindri', 'outputs/heimdall', 'outputs/skidbladnir']) mkdirSync(join(root, project), { recursive: true });
  copyFileSync(join(repository, 'build.sh'), join(root, 'build.sh'));
  mkdirSync(bin);
  for (const tool of ['pnpm', 'npm']) { writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $* in \${PWD##*/}" >> "${log}"\n[ "${tool}" = npm ] && [ -n "$FAIL_NPM" ] && exit 1\nexit 0\n`); chmodSync(join(bin, tool), 0o755); }
  const result = spawnSync('/bin/sh', [join(root, 'build.sh')], { encoding: 'utf8', env: { PATH: bin + delimiter + dirname(process.execPath) + delimiter + '/usr/bin:/bin', ...(npmFails ? { FAIL_NPM: '1' } : {}) } });
  return { ...result, log: readFileSync(log, 'utf8').trim().split('\n') };
}

test('build.sh builds the factory projects, then Skidbladnir', t => {
  const { status, stdout, log } = buildFixture(t, false);
  assert.equal(status, 0);
  assert.match(stdout, /Build complete/);
  assert.deepEqual(log, ['brokkr', 'mimir', 'sindri', 'heimdall'].flatMap(p => [`pnpm install --frozen-lockfile in ${p}`, `pnpm build in ${p}`]).concat(['npm ci in skidbladnir', 'npm run build in skidbladnir']));
});

test('a Skidbladnir build failure says the factory is still usable and exits with a distinct status', t => {
  const { status, stdout, stderr, log } = buildFixture(t, true);
  assert.equal(status, 2);
  assert.doesNotMatch(stdout, /Build complete/);
  assert.match(stderr, /The factory is built; Start outputs\/local-factory\/Start Factory.command/);
  assert.match(stderr, /Skidbladnir \(optional, not used by the launcher\) failed to build/);
  assert.equal(log.at(-1), 'npm ci in skidbladnir');
});
