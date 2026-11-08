import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { boot, readProfilePatches } from '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';

test('registration mounts through the real Cordis loader with the actual JSONL provider', async () => {
  const root = await mkdtemp('/tmp/wsh-boot-test-');
  let ctx;
  const routes = new Map();
  try {
    await mkdir(root + '/sessions');
    const config = [
      { id: 'sessions', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: root + '/sessions', compression: 'none' } },
      { id: 'workspace-shell', name: fileURLToPath(new URL('../../packages/shell/index.js', import.meta.url)), group: true, config: [] },
    ];
    await writeFile(root + '/cordis.json', JSON.stringify(config));
    ctx = await boot('workspace-test', root + '/cordis.json', [], (context) => {
      context.provide('profileContext', { home: root, name: 'test', dir: root, cwd: root });
      context.provide('agents', { get: (id) => id === 'live' ? {} : null });
      context.provide('subprocess', {});
      context.provide('tools', { register: () => () => {} });
      context.provide('sessionQuery', { readSurface: () => { throw new Error('Not used'); } });
      context.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
    }, 'file:///opt/homebrew/lib/node_modules/@deepseek-ai/dsh/');
    const registry = ctx.get('workspaceSessionHosts');
    assert.ok(registry, 'the core registration must activate without a separate component');
    assert.equal((await registry.lookup(['live'])).sessions.live.state, 'local');
    assert.ok(routes.has('/api/workspace-session-hosts/status'));
    assert.ok(routes.has('/api/workspace-shell/catalog'));
    assert.ok(routes.has('/api/workspace-shell/tab-order/get'), 'the remembered tab order has a Host route');
    assert.ok(routes.has('/api/workspace-shell/tab-order/set'));
    assert.equal([...ctx.loader.entries()].some((entry) => entry.options.id === 'workspace-session-host'), false);
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('real plugin inventory exposes only nested SSH; its persisted switch preserves core services', async () => {
  const root = await mkdtemp('/tmp/wsh-component-test-');
  let ctx;
  const routes = new Map();
  let opens = 0, closes = 0;
  try {
    await mkdir(root + '/sessions');
    await mkdir(root + '/node_modules/@local', { recursive: true });
    await symlink('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai', root + '/node_modules/@deepseek-ai');
    await symlink(fileURLToPath(new URL('../../packages/shell', import.meta.url)), root + '/node_modules/dsh-workspace-shell');
    await symlink(fileURLToPath(new URL('../../packages/manager', import.meta.url)), root + '/node_modules/@local/dsh-ssh-remote');
    await writeFile(root + '/package.json', JSON.stringify({ dsh: { profile: { bundles: ['dsh-workspace-shell'] } } }));
    await writeFile(root + '/cordis.json', '[]');
    const profile = { home: root, dir: root, name: 'test', cwd: root, patchPath: root + '/profile.patch.yml',
      installAnchor: '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json', startedBundles: [], overlays: [{ insert: [
        { id: 'sessions', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: root + '/sessions', compression: 'none' } },
        { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager', config: {} },
      ] }] };
    ctx = await boot('workspace-test', root + '/cordis.json', readProfilePatches('dsh', profile), (context) => {
      context.provide('profileContext', profile);
      context.provide('agents', { get: () => null });
      context.provide('subprocess', {});
      context.provide('tools', { register: () => () => {} });
      context.provide('settings', {});
      context.provide('credentials', {});
      context.provide('storageDomain', { async open() { opens++; return { table: () => new Map(), close() { closes++; } }; } });
      context.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
      context.provide('hmr', { runExclusive: (fn) => fn(), async reconcileProfile() {
        const entry = context.loader.resolve('include');
        await entry.update({ config: { ...entry.options.config, patches: readProfilePatches('dsh', profile) } });
        await context.loader.await();
        return { warnings: [], pending: [] };
      } });
    });
    const registry = ctx.workspaceSessionHosts, runtimes = ctx.workspaceLocalRuntimes;
    const coreRoute = routes.get('/api/workspace-shell/catalog');
    const rows = await ctx.pluginManager.listPlugins();
    assert.equal(rows.some((row) => row.moduleName === 'dsh-workspace-shell'), false);
    assert.equal(rows.some((row) => row.moduleName.includes('session-host')), false);
    const ssh = rows.find((row) => row.moduleName === '@local/dsh-ssh-remote');
    assert.equal(ssh.readOnlyReason, undefined);
    assert.equal(ssh.patchId, 'ssh-remote');
    assert.equal(ssh.enabled, true);
    assert.ok(routes.has('/api/ssh-remote/status'));
    for (const enabled of [false, true, false]) {
      const result = await ctx.pluginManager.setPluginEnabled(ssh.entryId, enabled);
      assert.equal(result.application, 'applied', JSON.stringify(result));
      assert.equal(routes.has('/api/ssh-remote/status'), enabled);
      assert.equal(ctx.workspaceSessionHosts, registry);
      assert.equal(ctx.workspaceLocalRuntimes, runtimes);
      assert.equal(routes.get('/api/workspace-shell/catalog'), coreRoute);
      assert.equal((await ctx.pluginManager.listPlugins()).find((row) => row.entryId === ssh.entryId).enabled, enabled);
    }
    assert.equal(opens, 2); assert.equal(closes, 2);
    assert.equal((await ctx.pluginManager.setBundleEnabled('dsh-workspace-shell', false)).application, 'applied');
    assert.equal(routes.size, 0, 'bundle deactivation removes core routes too');
    assert.equal(ctx.get('workspaceSessionHosts'), undefined);
    assert.equal((await ctx.pluginManager.setBundleEnabled('dsh-workspace-shell', true)).application, 'applied');
    assert.ok(ctx.get('workspaceSessionHosts'));
    assert.notEqual(ctx.workspaceSessionHosts, registry);
    assert.equal(routes.has('/api/ssh-remote/status'), false, 'persisted SSH disable survives a fresh bundle activation');
    assert.equal(opens, 2);
    assert.equal((await ctx.pluginManager.setPluginEnabled(ssh.entryId, true)).application, 'applied');
    assert.ok(routes.has('/api/ssh-remote/status'));
    const renewedRegistry = ctx.workspaceSessionHosts;
    const shellEntry = [...ctx.loader.entries()].find((entry) => entry.options.id === 'workspace-shell');
    await shellEntry.fiber.update({}, true);
    await ctx.loader.await();
    assert.ok(routes.has('/api/ssh-remote/status'), 'legacy empty core config defaults to the SSH child');
    assert.equal(ctx.workspaceSessionHosts, renewedRegistry);
    await ctx.fiber.dispose(); ctx = null;
    assert.equal(routes.size, 0, 'unloading the complete bundle releases its routes');
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('the remembered tab order round-trips through the real Host route and storage domain', async () => {
  const root = await mkdtemp('/tmp/wsh-order-boot-');
  let ctx;
  const routes = new Map();
  const records = new Map();
  try {
    await mkdir(root + '/sessions');
    const config = [
      { id: 'sessions', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: root + '/sessions', compression: 'none' } },
      { id: 'workspace-shell', name: fileURLToPath(new URL('../../packages/shell/index.js', import.meta.url)), config: [] },
    ];
    await writeFile(root + '/cordis.json', JSON.stringify(config));
    ctx = await boot('workspace-test', root + '/cordis.json', [], (context) => {
      context.provide('profileContext', { home: root, name: 'test', dir: root, cwd: root });
      context.provide('agents', { get: () => null });
      context.provide('subprocess', {});
      context.provide('tools', { register: () => () => {} });
      context.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
      context.provide('storageDomain', {
        async open(spec) {
          assert.equal(spec.name, 'workspace_shell');
          assert.equal(spec.version, 1);
          return {
            table(name) {
              assert.equal(name, 'tab_order');
              return {
                get(key) { return records.get(key); },
                async put(key, value) { records.set(key, value); },
              };
            },
          };
        },
      });
    }, 'file:///opt/homebrew/lib/node_modules/@deepseek-ai/dsh/');
    const post = (path, input) => routes.get('/api/workspace-shell' + path).fetch(new Request('http://localhost/api/workspace-shell' + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }));
    const read = await post('/tab-order/get', {});
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).result, { order: [] });
    const write = await post('/tab-order/set', { order: ['local', 'web:alpha'] });
    assert.equal(write.status, 200);
    assert.deepEqual((await write.json()).result, { saved: true });
    assert.deepEqual(records.get('default'), { version: 1, order: ['local', 'web:alpha'] });
    assert.deepEqual((await (await post('/tab-order/get', {})).json()).result, { order: ['local', 'web:alpha'] });
    const invalid = await post('/tab-order/set', { order: ['bad token'] });
    assert.equal(invalid.status, 400);
  } finally {
    await ctx?.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
