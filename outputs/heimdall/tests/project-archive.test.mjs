import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePreferences } from '../apps/server/preferences.mjs';
import { Store } from '../apps/server/storage.mjs';
test('archived projects persist and restore without losing other preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-archive-'));
  let store = new Store(dir);
  try {
    store.savePreferences({ theme: 'dark', ...validatePreferences({ archivedProjects: ['prj_one', 'prj_one'] }) });
    store.close(); store = new Store(dir);
    assert.deepEqual(store.preferences().archivedProjects, ['prj_one']);
    store.savePreferences({ ...store.preferences(), ...validatePreferences({ archivedProjects: [] }) });
    assert.deepEqual(store.preferences(), { theme: 'dark', archivedProjects: [] });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('archive identifiers reject malformed or oversized payloads', () => {
  for (const value of [null, {}, ['../path'], [null], Array(1001).fill('a')])
    assert.throws(() => validatePreferences({ archivedProjects: value }));
});
