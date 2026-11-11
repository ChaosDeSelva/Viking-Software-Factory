// factory.mjs end to end against stand-in Mimir and Sindri modules (FACTORY_ECOSYSTEM_ROOT) and
// stand-in agent CLIs. Heimdall is the real one, on a free port, pointed at closed loopback ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const factory = join(dirname(fileURLToPath(import.meta.url)), '..', 'factory.mjs');

const MIMIR = `import { appendFileSync } from 'node:fs';
const log = m => appendFileSync(process.env.FAKE_LOG, m + '\\n');
export async function startMimir(env) {
  log('mimir.start ' + JSON.stringify({ port: env.MIMIR_PORT, host: env.MIMIR_HOST, runtime: env.MIMIR_RUNTIME, fleet: env.MIMIR_FLEET_CONFIG, codex: env.MIMIR_CODEX_BIN, claude: env.MIMIR_CLAUDE_BIN, web: env.MIMIR_WEB_ROOT }));
  if (env.FAKE_FAIL === 'mimir') throw Error('Mimir could not open its database');
  return { auth: { token: 'mimir-token' }, close: async () => log('mimir.close') };
}`;
const SINDRI = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const log = m => appendFileSync(process.env.FAKE_LOG, m + '\\n');
export const secretStoreFor = () => ({ get: async name => 'operator:' + name });
export async function startServer(env, options) {
  log('sindri.start ' + JSON.stringify({ port: env.SINDRI_PORT, host: env.SINDRI_HOST, webDist: options.webDist.endsWith('sindri/apps/web/dist') }));
  if (env.FAKE_FAIL === 'sindri') throw Error('Sindri could not start');
  options.overrides.approval.onPairingCode('PAIR-1234');
  const secrets = options.overrides.secrets;
  log('sindri.secrets ' + JSON.stringify([await secrets.get('local.mimir.token'), await secrets.get('linear.apiKey')]));
  mkdirSync(env.SINDRI_DATA_DIR, { recursive: true });
  const tokenPath = join(env.SINDRI_DATA_DIR, 'token');
  writeFileSync(tokenPath, 'sindri-token\\n');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE server_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)');
  if (env.FAKE_SAVED) db.prepare("INSERT INTO server_settings VALUES (1, ?, 'then')").run(env.FAKE_SAVED);
  return { db, tokenPath, url: 'http://127.0.0.1:' + env.FAKE_SINDRI_PORT, close: async () => { log('sindri.close'); if (env.FAKE_FAIL === 'sindri-close') throw Error('Sindri would not close'); } };
}`;
const SETTINGS = `import { appendFileSync } from 'node:fs';
export class SettingsStore {
  constructor(db, now) { this.db = db; this.now = now; }
  get() { const row = this.db.prepare('SELECT settings_json FROM server_settings WHERE id = 1').get(); return row ? JSON.parse(row.settings_json) : { provider: 'null', model: 'default' }; }
  put(value) { appendFileSync(process.env.FAKE_LOG, 'settings.put ' + JSON.stringify({ ...value, clock: this.now() instanceof Date }) + '\\n'); }
}`;

/** A loopback port with nothing listening on it. */
async function closedPort() {
  const server = createServer();
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  await new Promise(ok => server.close(ok));
  return port;
}

async function fixture(t, { claude = '{"loggedIn":true}', env = {}, unset = [], before = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'local-factory-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eco = join(dir, 'ecosystem'), bin = join(dir, 'bin'), data = join(dir, 'data'), log = join(dir, 'log.txt');
  for (const [file, text] of [['mimir/apps/server/dist/start.js', MIMIR], ['sindri/apps/server/dist/boot.js', SINDRI], ['sindri/apps/server/dist/settings.js', SETTINGS]]) {
    mkdirSync(dirname(join(eco, file)), { recursive: true });
    writeFileSync(join(eco, file), text);
  }
  mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho '${claude}'\n`);
  writeFileSync(join(bin, 'open'), `#!/bin/sh\necho "open $*" >> "${log}"\n`);
  for (const tool of ['codex', 'claude', 'open']) chmodSync(join(bin, tool), 0o755);
  writeFileSync(log, '');
  before(dir);
  const [mimirPort, sindriPort] = [await closedPort(), await closedPort()];
  const childEnv = {
      PATH: bin + delimiter + process.env.PATH,
      FACTORY_ECOSYSTEM_ROOT: eco,
      FACTORY_DATA_DIR: data,
      FACTORY_ACCESS_FILE: join(dir, 'access.json'),
      FACTORY_NO_OPEN: '1',
      MIMIR_CODEX_BIN: join(bin, 'codex'),
      MIMIR_CLAUDE_BIN: join(bin, 'claude'),
      MIMIR_PORT: String(mimirPort),
      SINDRI_PORT: String(sindriPort),
      FAKE_SINDRI_PORT: String(sindriPort),
      HEIMDALL_PORT: '0',
      FAKE_LOG: log,
      ...env,
  };
  for (const name of unset) delete childEnv[name];
  const run = spawn(process.execPath, [factory], {
    cwd: dir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => run.kill('SIGKILL'));
  let stdout = '', stderr = '';
  run.stdout.on('data', d => { stdout += d; });
  run.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(ok => run.on('exit', (code, signal) => ok({ code, signal })));
  const ready = new Promise((ok, fail) => {
    run.stdout.on('data', () => { if (stdout.includes('Keep this terminal open')) ok(); });
    exited.then(() => fail(Error('factory exited before it was ready:\n' + stdout + stderr)));
  });
  ready.catch(() => {}); // a run that is meant to fail is awaited through `exited` instead

  return { dir, data, log: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), run, exited, ready, out: () => ({ stdout, stderr }), mimirPort, accessFile: join(dir, 'access.json') };
}

test('the factory starts Mimir, Sindri and Heimdall, writes the access file, and stops all three on a signal', async t => {
  const f = await fixture(t);
  await f.ready;
  const { stdout } = f.out();
  assert.match(stdout, /Runtime: fleet/);
  assert.match(stdout, /Access token \(paste into the browser\): sindri-token/);
  assert.match(stdout, /Approval pairing code \(for approving your plans\): PAIR-1234/);
  const heimdallUrl = /Heimdall command center: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)[1];
  const access = JSON.parse(readFileSync(f.accessFile, 'utf8'));
  assert.equal(statSync(f.accessFile).mode & 0o777, 0o600);
  assert.equal(access.sindriPairingCode, 'PAIR-1234');
  assert.match(stdout, new RegExp('Heimdall access token: ' + access.heimdallToken + '\nHeimdall operator code: ' + access.operatorCode));
  // Heimdall answers with the token the access file carries.
  const login = await fetch(heimdallUrl + '/api/login', { method: 'POST', headers: { 'x-heimdall-request': '1', 'content-type': 'application/json' }, body: JSON.stringify({ token: access.heimdallToken }) });
  assert.equal(login.status, 200);
  const [mimirStart, sindriStart, secrets, put] = f.log();
  const mimir = JSON.parse(mimirStart.slice('mimir.start '.length));
  assert.deepEqual({ ...mimir, fleet: undefined }, { port: String(f.mimirPort), host: '127.0.0.1', runtime: 'fleet', fleet: undefined, codex: join(f.dir, 'bin/codex'), claude: join(f.dir, 'bin/claude') });
  assert.equal(mimir.fleet, join(f.data, 'fleet.json'));
  assert.ok(existsSync(mimir.fleet), 'the fleet runtime gets its fleet file');
  assert.match(sindriStart, /"host":"127\.0\.0\.1".*"webDist":true/);
  // Sindri reads Mimir's token from the launcher and every other secret from the operator's store.
  assert.equal(secrets, 'sindri.secrets ["mimir-token","operator:linear.apiKey"]');
  const settings = JSON.parse(put.slice('settings.put '.length));
  assert.equal(settings.provider, 'claude-cli', 'first-run agent defaults');
  assert.equal(settings.mimirUrl, `http://127.0.0.1:${f.mimirPort}`);
  assert.equal(settings.clock, true, 'the settings store is given a clock');
  assert.ok(existsSync(join(f.data, 'sindri/.launcher-defaults-applied')));
  f.run.kill('SIGTERM');
  assert.deepEqual(await f.exited, { code: 0, signal: null });
  assert.deepEqual(f.log().slice(4), ['sindri.close', 'mimir.close']);
  assert.equal(existsSync(f.accessFile), false, 'the access file is removed on shutdown');
});

test('a built Mimir web app is served from Mimir and its address printed', async t => {
  const f = await fixture(t, { before: dir => { const web = join(dir, 'ecosystem/mimir/apps/web/dist'); mkdirSync(web, { recursive: true }); writeFileSync(join(web, 'index.html'), '<!doctype html>'); } });
  await f.ready;
  const mimir = JSON.parse(f.log()[0].slice('mimir.start '.length));
  assert.equal(mimir.web, join(f.dir, 'ecosystem/mimir/apps/web/dist'));
  const { stdout } = f.out();
  assert.match(stdout, new RegExp(`Mimir executor: http://127\\.0\\.0\\.1:${f.mimirPort}`));
  assert.match(stdout, /Mimir access token: mimir-token/);
});

test('without a built Mimir web app Mimir stays API-only and no Mimir address is printed', async t => {
  const f = await fixture(t);
  await f.ready;
  assert.equal(JSON.parse(f.log()[0].slice('mimir.start '.length)).web, undefined);
  assert.doesNotMatch(f.out().stdout, /Mimir executor|Mimir access token/);
});

test('a quiet start prints no secrets, keeps an operator\'s saved settings and opens Heimdall', async t => {
  // No agent paths given: Claude Code comes from PATH; Codex is not checked for the ssh runtime.
  const f = await fixture(t, { env: { FACTORY_QUIET_AUTH: '1', MIMIR_RUNTIME: 'ssh', FAKE_SAVED: JSON.stringify({ provider: 'null', model: 'm' }) }, unset: ['FACTORY_NO_OPEN', 'MIMIR_CODEX_BIN', 'MIMIR_CLAUDE_BIN'] });
  await f.ready;
  const { stdout } = f.out();
  const access = JSON.parse(readFileSync(f.accessFile, 'utf8'));
  for (const secret of ['sindri-token', 'PAIR-1234', access.heimdallToken, access.operatorCode]) assert.equal(stdout.includes(secret), false, secret);
  assert.match(stdout, /Runtime: ssh/);
  const put = JSON.parse(f.log().find(l => l.startsWith('settings.put ')).slice('settings.put '.length));
  assert.equal(put.provider, 'null', 'a saved null provider is the operator\'s choice');
  assert.equal(existsSync(join(f.data, 'fleet.json')), false, 'only the fleet runtime needs a fleet file');
  assert.equal(JSON.parse(f.log()[0].slice('mimir.start '.length)).claude, 'claude');
  const heimdallUrl = /Heimdall command center: (\S+)/.exec(stdout)[1];
  // The browser opener runs detached from the start; wait for it rather than for a fixed time.
  while (!f.log().includes('open ' + heimdallUrl)) await new Promise(ok => setTimeout(ok, 50));
  f.run.kill('SIGHUP');
  assert.equal((await f.exited).code, 0);
});

test('a signed-out Claude Code stops the start before any service runs', async t => {
  const f = await fixture(t, { claude: '{"loggedIn":false}' });
  assert.deepEqual(await f.exited, { code: 1, signal: null });
  assert.match(f.out().stderr, /Claude Code is unavailable or signed out/);
  assert.deepEqual(f.log(), []);
  assert.equal(existsSync(f.accessFile), false);
});

test('a service that fails to start ends the run with its message after closing what had started', async t => {
  const mimirFails = await fixture(t, { env: { FAKE_FAIL: 'mimir' } });
  assert.equal((await mimirFails.exited).code, 1);
  assert.match(mimirFails.out().stderr, /Mimir could not open its database/);
  assert.equal(mimirFails.log().length, 1);

  const sindriFails = await fixture(t, { env: { FAKE_FAIL: 'sindri' } });
  assert.equal((await sindriFails.exited).code, 1);
  assert.match(sindriFails.out().stderr, /Sindri could not start/);
  assert.deepEqual(sindriFails.log().map(l => l.split(' ')[0]), ['mimir.start', 'sindri.start', 'mimir.close']);
});

test('a service that fails to close is reported and the rest still close', async t => {
  const f = await fixture(t, { env: { FAKE_FAIL: 'sindri-close' } });
  await f.ready;
  f.run.kill('SIGINT');
  assert.equal((await f.exited).code, 0);
  assert.match(f.out().stderr, /Shutdown error: Sindri would not close/);
  assert.deepEqual(f.log().slice(-2), ['sindri.close', 'mimir.close']);
});

test('an access file left readable by others is replaced by a private one', async t => {
  const f = await fixture(t, { before: dir => { writeFileSync(join(dir, 'access.json'), '{}', { mode: 0o644 }); chmodSync(join(dir, 'access.json'), 0o644); } });
  await f.ready;
  assert.equal(statSync(f.accessFile).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(f.accessFile, 'utf8')).heimdallToken);
  f.run.kill('SIGTERM');
  assert.equal((await f.exited).code, 0);
});
