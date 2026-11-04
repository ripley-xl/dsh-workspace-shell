import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dshInstall = process.env.DSH_INSTALL_DIR;
if (dshInstall === undefined) throw new Error('Set DSH_INSTALL_DIR to the installed @deepseek-ai/dsh package directory');
const { boot, readProfilePatches } = await import(pathToFileURL(dshInstall + '/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js').href);

test('registration mounts through the real Cordis loader with the actual JSONL provider', async () => {
  const root = await mkdtemp('/tmp/wsh-boot-test-');
  let ctx;
  const routes = new Map();
  try {
    await mkdir(root + '/sessions');
    const config = [
      { id: 'sessions', name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: root + '/sessions', compression: 'none' } },
      { id: 'workspace-shell', name: fileURLToPath(new URL('../../packages/shell/index.js', import.meta.url)), config: {} },
    ];
    await writeFile(root + '/cordis.json', JSON.stringify(config));
    ctx = await boot('workspace-test', root + '/cordis.json', [], (context) => {
      context.provide('profileContext', { home: root, name: 'test', dir: root, cwd: root });
      context.provide('agents', { get: (id) => id === 'live' ? {} : null });
      context.provide('subprocess', {});
      context.provide('tools', { register: () => () => {} });
      context.provide('sessionQuery', { readSurface: () => { throw new Error('Not used'); } });
      context.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
    }, pathToFileURL(dshInstall + '/').href);
    const registry = ctx.get('workspaceSessionHosts');
    assert.ok(registry, 'the core registration must activate without a separate component');
    assert.equal((await registry.lookup(['live'])).sessions.live.state, 'local');
    assert.ok(routes.has('/api/workspace-session-hosts/status'));
    assert.ok(routes.has('/api/workspace-shell/catalog'));
    assert.equal([...ctx.loader.entries()].some((entry) => entry.options.id === 'workspace-session-host'), false);
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('real plugin inventory lists the single package and its bundle switch preserves services', async () => {
  const root = await mkdtemp('/tmp/wsh-component-test-');
  let ctx;
  const routes = new Map();
  try {
    await mkdir(root + '/sessions');
    await mkdir(root + '/node_modules', { recursive: true });
    await symlink(dshInstall + '/node_modules/@deepseek-ai', root + '/node_modules/@deepseek-ai');
    await symlink(fileURLToPath(new URL('../../packages/shell', import.meta.url)), root + '/node_modules/dsh-workspace-shell');
    await writeFile(root + '/package.json', JSON.stringify({ dsh: { profile: { bundles: ['dsh-workspace-shell'] } } }));
    await writeFile(root + '/cordis.json', '[]');
    const profile = { home: root, dir: root, name: 'test', cwd: root, patchPath: root + '/profile.patch.yml',
      installAnchor: dshInstall + '/package.json', startedBundles: [], overlays: [{ insert: [
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
      context.provide('storageDomain', { async open() { return { table: () => new Map(), close() {} }; } });
      context.provide('connection', { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } });
      context.provide('hmr', { runExclusive: (fn) => fn(), async reconcileProfile() {
        const entry = context.loader.resolve('include');
        await entry.update({ config: { ...entry.options.config, patches: readProfilePatches('dsh', profile) } });
        await context.loader.await();
        return { warnings: [], pending: [] };
      } });
    });
    const rows = await ctx.pluginManager.listPlugins();
    const plugin = rows.find((row) => row.moduleName === 'dsh-workspace-shell');
    assert.ok(plugin, JSON.stringify(rows.map((row) => row.moduleName)));
    assert.equal(plugin.patchId, 'workspace-shell');
    assert.equal(plugin.enabled, true);
    assert.equal(rows.some((row) => row.moduleName.includes('ssh-remote')), false, 'SSH is not a separate inventory row');
    assert.ok(routes.has('/api/ssh-remote/status'));
    assert.ok(routes.has('/api/workspace-shell/catalog'));
    assert.equal((await ctx.pluginManager.setBundleEnabled('dsh-workspace-shell', false)).application, 'applied');
    assert.equal(routes.size, 0, 'bundle deactivation removes every route');
    assert.equal(ctx.get('workspaceSessionHosts'), undefined);
    assert.equal((await ctx.pluginManager.setBundleEnabled('dsh-workspace-shell', true)).application, 'applied');
    assert.ok(ctx.get('workspaceSessionHosts'));
    assert.ok(routes.has('/api/ssh-remote/status'));
    const shellEntry = [...ctx.loader.entries()].find((entry) => entry.options.id === 'workspace-shell');
    await shellEntry.fiber.update({}, true);
    await ctx.loader.await();
    assert.ok(routes.has('/api/ssh-remote/status'), 'an empty config keeps the single package mounted');
    await ctx.fiber.dispose(); ctx = null;
    assert.equal(routes.size, 0, 'unloading the complete bundle releases its routes');
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
