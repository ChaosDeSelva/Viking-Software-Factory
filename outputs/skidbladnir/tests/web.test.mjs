import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { themeScript } from '@factory/ui';
import { appHref, href, parseRoute } from '../apps/web/src/routes.js';
import { SINDRI_OVERVIEW, switcherApps } from '../apps/web/src/apps.js';

test('dashboard hash routes parse, ignore non-route hashes and round-trip', () => {
  assert.deepEqual(parseRoute(''), { page: 'fleet', workerId: null });
  assert.deepEqual(parseRoute('#/fleet'), { page: 'fleet', workerId: null });
  assert.deepEqual(parseRoute(href.fleet('sim-1')), { page: 'fleet', workerId: 'sim-1' });
  assert.deepEqual(parseRoute(href.launch()), { page: 'launch' });
  assert.deepEqual(parseRoute(href.history('sim-1')), { page: 'history', workerId: 'sim-1' });
  assert.deepEqual(parseRoute(href.history()), { page: 'history', workerId: null });
  assert.deepEqual(parseRoute(href.docs('statuses', 'failed-worker-status')), {
    page: 'docs',
    slug: 'statuses',
    anchor: 'failed-worker-status',
  });
  assert.deepEqual(parseRoute('#/docs'), { page: 'docs', slug: null, anchor: null });
  assert.deepEqual(parseRoute('#/nowhere'), { page: 'not-found' });
  // The skip link's #main must not navigate away.
  assert.equal(parseRoute('#main'), null);
  assert.equal(appHref('/docs/statuses#failed-worker-status'), '#/docs/statuses#failed-worker-status');
  assert.equal(appHref('/site/guide.html'), '/site/guide.html');
});

test('the pre-paint theme file matches @factory/ui themeScript (the CSP forbids inline scripts)', () => {
  const file = readFileSync(new URL('../apps/web/public/theme.js', import.meta.url), 'utf8');
  assert.ok(file.includes(themeScript));
  assert.match(
    readFileSync(new URL('../apps/web/index.html', import.meta.url), 'utf8'),
    /<script src="\/theme.js"><\/script>/,
  );
});

test('links to other apps carry no project ID (IDs are per app); Sindri opens on its Overview', () => {
  const links = Object.fromEntries(switcherApps('http://127.0.0.1:4330/', 'demo-app').map((a) => [a.id, a.href]));
  assert.deepEqual(links, {
    sindri: 'http://127.0.0.1:4310/#/overview',
    mimir: 'http://127.0.0.1:7700/',
    heimdall: 'http://127.0.0.1:4320/',
    skidbladnir: 'http://127.0.0.1:4330/?project=demo-app',
  });
  assert.equal(SINDRI_OVERVIEW, links.sindri);
});
