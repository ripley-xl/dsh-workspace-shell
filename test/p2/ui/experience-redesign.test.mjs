import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStatusClient, plain } from './helpers.mjs';

const status = await loadStatusClient();
const {
  normalizePluginPage, normalizePlugin, pluginInstallSpec, normalizePluginOutcome,
  createPluginApi, returnToLocal,
} = status.__test;

test('plugin page filters official packages only from local install candidates', () => {
  const page = normalizePluginPage({ ok: true,
    local: { schemaVersion: 1, bundles: [
      { name: '@deepseek-ai/dsh-official', official: false, version: '1.0.0' },
      { name: '@local/marked-official', official: true },
      { name: 'dsh-workspace-shell-status', official: false },
      { name: '@local/theme', spec: '@local/theme', version: '2.0.0', meta: { title: { en: 'Theme', zh: '主题' }, description: { en: 'Theme plugin' } }, pendingBuilds: ['theme-build'] },
    ] },
    remote: [
      { name: '@deepseek-ai/dsh-official', enabled: true, removable: false },
      { name: '@local/theme', version: '1.0.0', enabled: false, removable: true },
    ],
  });
  assert.deepEqual(plain(page.local.map((plugin) => plugin.name)), ['@local/theme']);
  assert.deepEqual(plain(page.remote.map((plugin) => plugin.name)), ['@deepseek-ai/dsh-official', '@local/theme']);
  assert.equal(page.local[0].title, 'Theme');
  assert.deepEqual(plain(page.local[0].pendingBuilds), ['theme-build']);
  assert.equal(page.remote[0].removable, false);
  assert.equal(page.remote[1].enabled, false);
});

test('plugin install spec uses the snapshot version without replacing an existing exact spec', () => {
  assert.equal(pluginInstallSpec({ name: '@local/theme', spec: '@local/theme', version: '2.0.0' }), '@local/theme@2.0.0');
  assert.equal(pluginInstallSpec({ name: '@local/theme', spec: '@local/theme@1.0.0', version: '2.0.0' }), '@local/theme@1.0.0');
  assert.equal(pluginInstallSpec({ name: 'plain-plugin', spec: '', version: '3.0.0' }), 'plain-plugin@3.0.0');
  assert.equal(normalizePlugin({ name: 'third-party', source: 'npm' }, 'local').official, false);
  assert.equal(normalizePlugin({ name: 'builtin-plugin', source: 'official' }, 'local').official, true);
});

test('plugin operation outcome exposes pending builds, partial item failures and restart state', () => {
  const pending = normalizePluginOutcome({ ok: true, result: { application: 'not-applied', pendingBuilds: ['build-script'] } });
  assert.equal(pending.partial, true);
  assert.deepEqual(plain(pending.pendingBuilds), ['build-script']);
  const restart = normalizePluginOutcome({ ok: true, result: { application: 'restart-required', pendingBuilds: [] } });
  assert.equal(restart.ok, true);
  assert.equal(restart.application, 'restart-required');
  const failed = normalizePluginOutcome({ ok: false, result: { application: 'failed', items: [
    { name: 'one', ok: true },
    { name: 'two', ok: false, error: { code: 'INSTALL_FAILED', message: 'failed safely' } },
  ] }, error: { code: 'PLUGIN_PARTIAL', message: 'partial' } });
  assert.equal(failed.partial, true);
  assert.equal(failed.items[1].code, 'INSTALL_FAILED');
  assert.equal(failed.error.code, 'PLUGIN_PARTIAL');
});

test('set-enabled and remove return partial failures for the UI instead of throwing HTTP 200 errors', async () => {
  const api = createPluginApi(async () => Response.json({
    ok: false, result: { application: 'failed', error: { diagnostic: 'safe operation failure' } },
  }));
  const plugin = { name: '@local/theme', spec: '@local/theme' };
  const disabled = await api.setEnabled(plugin, false);
  const disabledOutcome = normalizePluginOutcome(disabled);
  assert.equal(disabledOutcome.ok, false);
  assert.equal(disabledOutcome.error.message, 'safe operation failure');
  const removed = await api.remove(plugin);
  assert.equal(normalizePluginOutcome(removed).error.message, 'safe operation failure');
});

test('plugin API uses the agreed page install set-enabled and remove requests', async () => {
  const calls = [];
  const api = createPluginApi(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true, local: { bundles: [] }, remote: [], result: { application: 'applied' } });
  });
  const plugin = { name: '@local/theme', spec: '@local/theme', version: '2.0.0', registry: null };
  await api.page();
  await api.install(plugin, { requestId: 'req-1' });
  await api.install(plugin, { requestId: 'req-2', approvedBuilds: ['theme-build'] });
  await api.setEnabled(plugin, false);
  await api.remove(plugin);
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/ssh-remote/plugins/page', '/api/ssh-remote/plugins/install', '/api/ssh-remote/plugins/install',
    '/api/ssh-remote/plugins/set-enabled', '/api/ssh-remote/plugins/remove',
  ]);
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  assert.deepEqual(JSON.parse(calls[1].options.body), { spec: '@local/theme@2.0.0', requestId: 'req-1', registry: null });
  assert.deepEqual(JSON.parse(calls[2].options.body), { spec: '@local/theme@2.0.0', requestId: 'req-2', approvedBuilds: ['theme-build'], registry: null });
  assert.deepEqual(JSON.parse(calls[3].options.body), { name: '@local/theme', enabled: false });
  assert.deepEqual(JSON.parse(calls[4].options.body), { name: '@local/theme' });
});

test('remote status keeps return navigation and registers header sidebar and main Slots', () => {
  const assigned = [];
  assert.equal(returnToLocal({ localReturnUrl: 'http://127.0.0.1:54542/' }, (url) => assigned.push(url)), null);
  assert.deepEqual(assigned, ['http://127.0.0.1:54542/']);
  const slots = [];
  const ctx = {
    locale: { register() { return () => {}; }, bind() { return (key) => key; } },
    slots: { inject(_owner, callback) { callback(); }, register(options, component) { slots.push({ options, component }); return () => {}; } },
    effect(callback) { return callback(); },
  };
  status.apply(ctx, { hostAlias: 'linux', localReturnUrl: 'http://127.0.0.1:54542/' });
  assert.deepEqual(slots.map((entry) => entry.options.name), ['conversation.session.header.utilities', 'sidebar.panellist', 'main']);
  assert.equal(slots[1].options.id, 'ssh-remote-plugins');
  assert.equal(slots[2].options.key, 'ssh-remote-plugins');
});
