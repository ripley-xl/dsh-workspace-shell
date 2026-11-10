import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../../../packages/status/src/host/index.js';
import { validateLocalPluginSnapshot } from '../../../packages/status/src/host/plugin-sharing.js';

function bundle(name, overrides = {}) {
  return {
    name,
    spec: `${name}@1.0.0`,
    version: '1.0.0',
    enabled: true,
    official: true,
    optional: true,
    installed: true,
    removable: true,
    availability: 'profile',
    ...overrides,
  };
}

function snapshot(bundles = [bundle('@official/example')]) {
  return { schemaVersion: 1, bundles };
}

function fixture(remote = [], { enableError = null, configEditor = null } = {}) {
  const routes = new Map();
  const calls = [];
  const state = { remote };
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } },
    pluginManager: {
      async listBundles() {
        calls.push({ method: 'listBundles' });
        return state.remote;
      },
      async installBundle(spec, options) {
        calls.push({ method: 'installBundle', spec, options });
        return { application: 'applied', pendingBuilds: [] };
      },
      async setBundleEnabled(name, enabled) {
        calls.push({ method: 'setBundleEnabled', name, enabled });
        if (enableError && name === enableError.name) throw enableError.error;
        const target = state.remote.find((item) => item.name === name);
        if (target) target.enabled = enabled;
        return { changed: true, application: 'applied', stage: 'enable', target: name, enabled };
      },
      async removeBundle(name) {
        calls.push({ method: 'removeBundle', name });
        return { changed: true, application: 'applied', stage: 'remove', target: name };
      },
      async setVersionExemption() { throw new Error('Version exemptions must not be granted.'); },
    },
    ...configEditor ? { configEditor } : {},
    settings: { describe: () => [], async update() {} },
    credentials: { async describe() { return { configured: false, writable: true }; }, async set() {} },
    effect(callback) { callback(); },
  };
  apply(ctx, { hostAlias: 'test', dshVersion: '1.0.0' });
  return { routes, calls, state };
}

async function post(routes, path, value, raw) {
  const response = await routes.get(path).fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    body: raw ?? JSON.stringify(value),
  }));
  return { response, value: await response.json() };
}

test('local inventory is stored and page reads the live remote list', async () => {
  const { routes, calls, state } = fixture([bundle('@official/remote', { enabled: false })]);
  const empty = await post(routes, '/api/ssh-remote/plugins/page', {});
  assert.equal(empty.value.ok, true);
  assert.equal(empty.value.local, null);
  assert.deepEqual(empty.value.remote, state.remote);

  const input = snapshot([bundle('@official/example', {
    source: 'npm',
    meta: { title: { en: 'Example', zh: '示例' }, description: 'Safe description', icon: './icon.svg' },
    pendingBuilds: ['example-build'],
  })]);
  const written = await post(routes, '/api/ssh-remote/plugins/local-inventory', { snapshot: input });
  assert.equal(written.response.status, 200);
  assert.deepEqual(written.value, { ok: true, snapshot: input });

  state.remote = [bundle('@official/changed', { availability: 'installation', installed: false })];
  const page = await post(routes, '/api/ssh-remote/plugins/page', {});
  assert.deepEqual(page.value.local, input);
  assert.deepEqual(page.value.remote, state.remote);
  assert.equal(calls.filter((call) => call.method === 'listBundles').length, 2);
});

test('snapshot validation rejects unknown fields, secrets, credentials and local paths', async (t) => {
  const cases = {
    'top-level secrets': { ...snapshot(), secrets: ['secret'] },
    'bundle browser URL': snapshot([bundle('@official/example', { browserUrl: 'http://localhost/?tkn=secret' })]),
    'bundle credentials': snapshot([bundle('@official/example', { credentials: { TOKEN: 'secret' } })]),
    'POSIX spec path': snapshot([bundle('@official/example', { spec: '/Users/alice/.dsh/example' })]),
    'absolute spec path': snapshot([bundle('@official/example', { spec: '/custom/example' })]),
    'Windows source path': snapshot([bundle('@official/example', { source: 'C:\\Users\\alice\\example' })]),
    'metadata local path': snapshot([bundle('@official/example', { meta: { description: 'Installed at /home/alice/.dsh/example' } })]),
    'nested credentials': snapshot([bundle('@official/example', { meta: { title: { credentials: 'secret' } } })]),
    'URL credentials': snapshot([bundle('@official/example', { source: 'https://token@example.com/registry' })]),
    'URL token query': snapshot([bundle('@official/example', { source: 'https://example.com/registry?token=secret' })]),
    'invalid boolean': snapshot([bundle('@official/example', { enabled: 'yes' })]),
    'duplicate bundle': snapshot([bundle('@official/example'), bundle('@official/example')]),
  };
  for (const [name, value] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { routes } = fixture();
      const result = await post(routes, '/api/ssh-remote/plugins/local-inventory', { snapshot: value });
      assert.equal(result.response.status, 400);
      assert.equal(result.value.ok, false);
      const page = await post(routes, '/api/ssh-remote/plugins/page', {});
      assert.equal(page.value.local, null);
    });
  }
});

test('snapshot validation enforces count and serialized byte limits', async () => {
  const { routes } = fixture();
  const tooMany = snapshot(Array.from({ length: 257 }, (_, index) => bundle(`@official/example-${index}`)));
  const countResult = await post(routes, '/api/ssh-remote/plugins/local-inventory', { snapshot: tooMany });
  assert.equal(countResult.response.status, 400);
  assert.match(countResult.value.error, /at most 256/u);

  const tooLarge = snapshot([bundle('@official/example', { meta: { description: 'x'.repeat(49 * 1024) } })]);
  const sizeResult = await post(routes, '/api/ssh-remote/plugins/local-inventory', { snapshot: tooLarge });
  assert.equal(sizeResult.response.status, 400);
  assert.match(sizeResult.value.error, /at most 49152 bytes/u);
});

test('a rejected inventory does not replace the last valid snapshot', async () => {
  const { routes } = fixture();
  const valid = snapshot();
  await post(routes, '/api/ssh-remote/plugins/local-inventory', { snapshot: valid });
  await post(routes, '/api/ssh-remote/plugins/local-inventory', { snapshot: { ...snapshot(), credentials: ['secret'] } });
  const page = await post(routes, '/api/ssh-remote/plugins/page', {});
  assert.deepEqual(page.value.local, valid);
});

test('official sync requires an uploaded snapshot', async () => {
  const { routes, calls } = fixture();
  const result = await post(routes, '/api/ssh-remote/plugins/official', {});
  assert.equal(result.response.status, 400);
  assert.equal(result.value.ok, false);
  assert.equal(calls.length, 0);
});

test('official sync changes only official optional bundles and skips unchanged state', async () => {
  const { routes, calls } = fixture([
    bundle('@official/enable', { enabled: false }),
    bundle('@official/disable', { enabled: true }),
    bundle('@official/same', { enabled: true }),
    bundle('@official/required', { enabled: false, optional: false }),
    bundle('@third-party/example', { enabled: false, official: false }),
  ]);
  await post(routes, '/api/ssh-remote/plugins/local-inventory', {
    snapshot: snapshot([
      bundle('@official/enable', { enabled: true }),
      bundle('@official/disable', { enabled: false }),
      bundle('@official/same', { enabled: true }),
      bundle('@official/required', { enabled: true, optional: false }),
      bundle('@third-party/example', { enabled: true, official: false }),
    ]),
  });
  const result = await post(routes, '/api/ssh-remote/plugins/official', {});
  assert.equal(result.value.ok, true);
  assert.equal(result.value.restartRequired, false);
  assert.deepEqual(calls.filter((call) => call.method === 'setBundleEnabled'), [
    { method: 'setBundleEnabled', name: '@official/enable', enabled: true },
    { method: 'setBundleEnabled', name: '@official/disable', enabled: false },
  ]);
  assert.equal(result.value.items.find((item) => item.name === '@official/same').changed, false);
  assert.equal(calls.some((call) => call.method === 'setVersionExemption'), false);
});

test('official sync reports target mismatches and per-bundle failures without version exemptions', async () => {
  const { routes, calls } = fixture([
    bundle('@official/failure', { enabled: false }),
    bundle('@third-party/not-official', { enabled: false, official: false }),
    bundle('@official/after-failure', { enabled: false }),
  ], { enableError: { name: '@official/failure', error: new Error('remote write failed') } });
  await post(routes, '/api/ssh-remote/plugins/local-inventory', {
    snapshot: snapshot([
      bundle('@official/failure'),
      bundle('@third-party/not-official'),
      bundle('@official/after-failure'),
    ]),
  });
  const result = await post(routes, '/api/ssh-remote/plugins/official', {});
  assert.equal(result.value.ok, false);
  assert.equal(result.value.items.find((item) => item.name === '@official/failure').error, 'remote write failed');
  assert.match(result.value.items.find((item) => item.name === '@third-party/not-official').error, /not an official optional bundle/u);
  assert.equal(result.value.items.find((item) => item.name === '@official/after-failure').ok, true);
  assert.deepEqual(calls.filter((call) => call.method === 'setBundleEnabled').map((call) => call.name), [
    '@official/failure', '@official/after-failure',
  ]);
  assert.equal(calls.some((call) => call.method === 'setVersionExemption'), false);
});

test('set-enabled and remove call pluginManager and preserve operation results', async () => {
  const { routes, calls } = fixture();
  const enabled = await post(routes, '/api/ssh-remote/plugins/set-enabled', { name: '@official/example', enabled: false });
  assert.equal(enabled.value.ok, true);
  assert.equal(enabled.value.result.enabled, false);
  const removed = await post(routes, '/api/ssh-remote/plugins/remove', { name: '@official/example' });
  assert.equal(removed.value.ok, true);
  assert.equal(removed.value.result.stage, 'remove');
  assert.deepEqual(calls.filter((call) => call.method !== 'listBundles'), [
    { method: 'setBundleEnabled', name: '@official/example', enabled: false },
    { method: 'removeBundle', name: '@official/example' },
  ]);
  const invalid = await post(routes, '/api/ssh-remote/plugins/set-enabled', { name: '@official/example', enabled: 'yes' });
  assert.equal(invalid.response.status, 400);
});

test('validateLocalPluginSnapshot returns a canonical white-listed clone', () => {
  const input = snapshot([bundle('@official/example', { pendingBuilds: ['one', 'two'] })]);
  const validated = validateLocalPluginSnapshot(input);
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.notEqual(validated.bundles[0], input.bundles[0]);
});

test('plugin config sync edits only the entries it was given and drops secrets', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-plugin-config-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  const edits = [];
  const configEditor = {
    documentPath: join(profileDir, 'cordis.patch.yml'),
    configuration: () => [],
    prepareDocument: async () => ({ profileDir }),
    entries: () => [
      { options: { id: 'meme-settings', name: 'dsh-meme' } },
      { options: { id: 'other-settings', name: 'dsh-other' } },
    ],
    async edit(entry, change) {
      edits.push({ id: entry.options.id, value: change({}, {}) });
    },
  };
  const { routes } = fixture([], { configEditor });
  const result = await post(routes, '/api/ssh-remote/plugins/config', {
    entries: [{ id: 'meme-settings', name: 'dsh-meme', config: { theme: 'cat', apiKey: 'SECRET', path: '/Users/me/file' } }],
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.ok, true);
  assert.deepEqual(result.value.items, [{ id: 'meme-settings', name: 'dsh-meme', ok: true }]);
  assert.deepEqual(edits, [{ id: 'meme-settings', value: { theme: 'cat' } }], 'secrets and local paths never reach the entry');
  assert.ok(result.value.backup?.path?.startsWith(profileDir), 'the profile is backed up before the edit');

  const missing = await post(routes, '/api/ssh-remote/plugins/config', {
    entries: [{ id: 'gone', name: 'dsh-gone', config: { theme: 'cat' } }],
  });
  assert.equal(missing.value.ok, false);
  assert.deepEqual(missing.value.items, [{ id: 'gone', name: 'dsh-gone', ok: false, error: 'entry-missing' }]);
  assert.equal(edits.length, 1, 'a missing entry edits nothing');

  const invalid = await post(routes, '/api/ssh-remote/plugins/config', { entries: [] });
  assert.equal(invalid.response.status, 400);
});

test('a config entry the remote lacks is created once the plugin is installed', async (t) => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-plugin-config-create-'));
  t.after(() => rm(profileDir, { recursive: true, force: true }));
  await writeFile(join(profileDir, 'cordis.patch.yml'), '# patch\n- id: ui-theme\n  name: "@deepseek-ai/dsh-client-ui-theme"\n');
  const configEditor = {
    documentPath: join(profileDir, 'cordis.patch.yml'),
    configuration: () => [],
    prepareDocument: async () => ({ profileDir }),
    entries: () => [],
    async edit() { throw new Error('nothing to edit'); },
  };
  const { routes } = fixture([bundle('dsh-meme', { official: false, optional: false })], { configEditor });
  const created = await post(routes, '/api/ssh-remote/plugins/config', {
    entries: [{ id: 'meme-settings', name: 'dsh-meme', config: { theme: 'cat' } }],
  });
  assert.equal(created.response.status, 200);
  assert.deepEqual(created.value.items, [{ id: 'meme-settings', name: 'dsh-meme', ok: true, created: true }]);
  assert.equal(created.value.restartRequired, true, 'a new entry only applies after a reload');
  const patch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- id: meme-settings\n {2}name: "dsh-meme"\n {2}config: \{"theme":"cat"\}\n/u);

  const unknown = await post(routes, '/api/ssh-remote/plugins/config', {
    entries: [{ id: 'gone-settings', name: 'dsh-absent', config: { theme: 'cat' } }],
  });
  assert.deepEqual(unknown.value.items, [{ id: 'gone-settings', name: 'dsh-absent', ok: false, error: 'entry-missing' }]);
  assert.equal(unknown.value.restartRequired, false);
  assert.equal((await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')).includes('gone-settings'), false);
});
