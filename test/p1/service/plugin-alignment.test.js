import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPluginAlignmentPlan, DESKTOP_ONLY_PLUGINS, planPluginSync,
} from '../../../packages/manager/src/host/plugin-alignment.js';
import { EXCLUDED_PACKAGES } from '../../../packages/shell/src/host/desktop-align.js';
import { serviceFixture } from './helpers.mjs';

const CODEX = '@deepseek-ai/dsh-subagent-codex';
const CLAUDE = '@deepseek-ai/dsh-subagent-claude-code';
const CODEX_SPEC = `${CODEX}@2.0.0`;
const CLAUDE_SPEC = `${CLAUDE}@2.0.0`;

const LOCAL_BUNDLES = [
  { name: CODEX, official: true, optional: false, enabled: true, version: '2.0.0', installTarget: { spec: CODEX_SPEC } },
  // `missing` only describes the local installation; the target spec is still usable.
  { name: CLAUDE, official: true, optional: false, availability: 'missing', version: '2.0.0', installTarget: { spec: CLAUDE_SPEC } },
];

const REMOTE_BUNDLES = [
  { name: CODEX, version: '1.0.0', installed: true, availability: 'profile', enabled: false, error: { code: 'incompatible-version' } },
  { name: CLAUDE, version: '1.0.0', installed: true, availability: 'profile', enabled: false, incompatible: ['dsh-version'] },
  { name: '@deepseek-ai/dsh-compatible', version: '1.0.0', installed: true, availability: 'profile', enabled: true },
];

function pluginPaths(fixture) {
  return fixture.state.calls
    .filter((call) => ['/api/ssh-remote/sync/backup', '/api/ssh-remote/plugins/remove', '/api/ssh-remote/plugins/install'].includes(call.path));
}

async function connectedFixture(t, options = {}) {
  const fixture = await serviceFixture(options);
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  return { ...fixture, record };
}

test('buildPluginAlignmentPlan upgrades only incompatible profile bundles with a safe local target', () => {
  const plan = buildPluginAlignmentPlan({ localBundles: LOCAL_BUNDLES, remoteBundles: REMOTE_BUNDLES });
  assert.deepEqual(plan.operations.map((operation) => operation.name), [CODEX, CLAUDE]);
  assert.deepEqual(plan.operations.map((operation) => operation.spec), [CODEX_SPEC, CLAUDE_SPEC]);
  assert.deepEqual(plan.operations.map((operation) => operation.remoteVersion), ['1.0.0', '1.0.0']);
  assert.deepEqual(plan.operations.map((operation) => operation.toVersion), ['2.0.0', '2.0.0']);
  assert.deepEqual(plan.skipped, []);

  // A missing local bundle is reported, not guessed.
  const missing = buildPluginAlignmentPlan({
    localBundles: LOCAL_BUNDLES.filter((bundle) => bundle.name !== CLAUDE),
    remoteBundles: REMOTE_BUNDLES,
  });
  assert.deepEqual(missing.operations.map((operation) => operation.name), [CODEX]);
  assert.deepEqual(missing.skipped, [{ name: CLAUDE, reason: 'missing-local-bundle' }]);

  // Not installed, not profile-scoped or not explicitly incompatible: untouched.
  const ignored = buildPluginAlignmentPlan({
    localBundles: LOCAL_BUNDLES,
    remoteBundles: [
      { ...REMOTE_BUNDLES[0], installed: false },
      { ...REMOTE_BUNDLES[0], availability: 'installation' },
      { ...REMOTE_BUNDLES[0], error: { code: 'other' } },
      { ...REMOTE_BUNDLES[0], incompatible: [] },
    ],
  });
  assert.deepEqual(ignored.operations, []);
});

test('buildPluginAlignmentPlan prefers installTarget, then version, then source', () => {
  const remote = [REMOTE_BUNDLES[0]];
  const withTarget = buildPluginAlignmentPlan({
    localBundles: [{ name: CODEX, version: '9.0.0', source: 'github:owner/repo', installTarget: { spec: CODEX_SPEC } }],
    remoteBundles: remote,
  });
  assert.equal(withTarget.operations[0].spec, CODEX_SPEC);
  assert.equal(withTarget.operations[0].toVersion, '2.0.0');

  const versioned = buildPluginAlignmentPlan({
    localBundles: [{ name: CODEX, version: '2.0.0', source: 'github:owner/repo' }],
    remoteBundles: remote,
  });
  assert.equal(versioned.operations[0].spec, `${CODEX}@2.0.0`);

  const sourced = buildPluginAlignmentPlan({
    localBundles: [{ name: CODEX, source: 'github:owner/repo#v2' }],
    remoteBundles: remote,
  });
  assert.equal(sourced.operations[0].spec, 'github:owner/repo#v2');
  assert.equal(sourced.operations[0].toVersion, null);

  // An install target for another package is ignored in favour of the name@version form.
  const mismatched = buildPluginAlignmentPlan({
    localBundles: [{ name: CODEX, version: '2.0.0', installTarget: { spec: '@other/pkg@2.0.0' } }],
    remoteBundles: remote,
  });
  assert.equal(mismatched.operations[0].spec, `${CODEX}@2.0.0`);
});

test('buildPluginAlignmentPlan refuses local paths, tarballs, file: specs and credentials', () => {
  const unsafe = [
    { name: CODEX, installTarget: { spec: '/Users/me/pkg' } },
    { name: CODEX, installTarget: { spec: './pkg' } },
    { name: CODEX, installTarget: { spec: 'file:/tmp/pkg.tgz' } },
    { name: CODEX, installTarget: { spec: `${CODEX}.tgz` } },
    { name: CODEX, installTarget: { spec: 'https://user:pass@example.com/pkg.tgz' } },
    { name: CODEX, installTarget: { spec: 'https://example.com/pkg?token=secret' } },
    { name: CODEX, source: 'C:\\tmp\\pkg' },
  ];
  for (const local of unsafe) {
    const plan = buildPluginAlignmentPlan({ localBundles: [local], remoteBundles: [REMOTE_BUNDLES[0]] });
    assert.deepEqual(plan.operations, [], JSON.stringify(local));
    assert.deepEqual(plan.skipped, [{ name: CODEX, reason: 'no-safe-install-spec' }]);
  }
});

test('incompatible remote plugins are backed up, removed and reinstalled from local specs', async (t) => {
  const fixture = await connectedFixture(t, { localBundles: async () => LOCAL_BUNDLES, remotePlugins: REMOTE_BUNDLES });
  const connected = await fixture.service.connect(fixture.record.id);
  assert.equal(fixture.state.backupCalls, 1);
  assert.deepEqual(fixture.state.pluginRemovals, [CODEX, CLAUDE]);
  assert.deepEqual(fixture.state.pluginInstalls.map((install) => install.spec), [CODEX_SPEC, CLAUDE_SPEC]);
  assert.equal(fixture.state.pluginInstalls.every((install) => typeof install.requestId === 'string' && install.requestId.length > 0), true);
  const paths = pluginPaths(fixture).map((call) => call.path);
  assert.deepEqual(paths, [
    '/api/ssh-remote/sync/backup',
    '/api/ssh-remote/plugins/remove',
    '/api/ssh-remote/plugins/install',
    '/api/ssh-remote/plugins/remove',
    '/api/ssh-remote/plugins/install',
  ]);
  assert.equal(connected.host.phase, 'connected');
  assert.equal(connected.pluginAlignment.ok, true);
  assert.equal(connected.pluginAlignment.restarted, false);
  assert.deepEqual(connected.pluginAlignment.items.map((item) => [item.name, item.fromVersion, item.toVersion, item.application]), [
    [CODEX, '1.0.0', '2.0.0', 'applied'],
    [CLAUDE, '1.0.0', '2.0.0', 'applied'],
  ]);
  assert.equal(JSON.stringify(connected.pluginAlignment).includes('1.0.0-controller'), false);
  assert.equal(fixture.service.runtime(fixture.record.id).pluginAlignment.items.length, 2);
});

test('compatible remote plugins are left untouched and need no backup', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => LOCAL_BUNDLES,
    remotePlugins: [{ name: '@deepseek-ai/dsh-compatible', version: '2.0.0', installed: true, availability: 'profile', enabled: true }],
  });
  const connected = await fixture.service.connect(fixture.record.id);
  assert.equal(fixture.state.backupCalls, 0);
  assert.deepEqual(fixture.state.pluginRemovals, []);
  assert.deepEqual(fixture.state.pluginInstalls, []);
  assert.equal(connected.host.pluginAlignment, null);
  assert.equal(fixture.service.runtime(fixture.record.id).pluginAlignment, null);
});

test('an incompatible plugin without a safe local spec is skipped without remote writes', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => [{ name: CODEX, installTarget: { spec: 'file:/Users/me/codex.tgz' } }],
    remotePlugins: [REMOTE_BUNDLES[0]],
  });
  const connected = await fixture.service.connect(fixture.record.id);
  assert.equal(connected.host.phase, 'connected');
  assert.equal(fixture.state.backupCalls, 0);
  assert.deepEqual(fixture.state.pluginRemovals, []);
  assert.deepEqual(fixture.state.pluginInstalls, []);
  assert.equal(fixture.service.runtime(fixture.record.id).pluginAlignment, null);
});

test('restart-required installs restart the Host once after every plugin is installed', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => LOCAL_BUNDLES,
    remotePlugins: REMOTE_BUNDLES,
  });
  const firstConnect = await fixture.service.connect(fixture.record.id);
  const oldInstanceId = firstConnect.host.instanceId;
  assert.equal(fixture.state.backupCalls, 1);
  // A real reconnect re-attaches the saved instance and aligns again; the
  // custom result makes the first plugin ask for a Host restart.
  await fixture.service.disconnect(fixture.record.id);
  fixture.state.pluginInstallResults = { [CODEX]: { application: 'restart-required', pendingBuilds: [] } };
  const reconnected = await fixture.service.connect(fixture.record.id);
  assert.equal(fixture.state.backupCalls, 2);
  assert.deepEqual(fixture.state.pluginRemovals, [CODEX, CLAUDE, CODEX, CLAUDE]);
  assert.equal(reconnected.pluginAlignment.ok, true);
  assert.equal(reconnected.pluginAlignment.restarted, true);
  assert.notEqual(reconnected.host.instanceId, oldInstanceId);
  assert.deepEqual(fixture.state.stops, [oldInstanceId]);
  assert.equal(fixture.state.pluginInstalls.length, 4);
  assert.equal(reconnected.pluginAlignment.items.every((item) => item.ok), true);
});

test('an HMR application does not restart the Host', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => LOCAL_BUNDLES,
    remotePlugins: REMOTE_BUNDLES,
  });
  const connected = await fixture.service.connect(fixture.record.id);
  assert.equal(connected.pluginAlignment.restarted, false);
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(fixture.service.runtime(fixture.record.id).host.instanceId, connected.host.instanceId);
});

test('pending build scripts mark the item as needing approval and do not restart', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => LOCAL_BUNDLES,
    remotePlugins: REMOTE_BUNDLES,
  });
  fixture.state.pluginInstallResults = { [CODEX]: { application: 'applied', pendingBuilds: ['esbuild'] } };
  const connected = await fixture.service.connect(fixture.record.id);
  const [codex, claude] = fixture.service.runtime(fixture.record.id).pluginAlignment.items;
  assert.equal(codex.ok, false);
  assert.equal(codex.error.code, 'PLUGIN_BUILD_APPROVAL_REQUIRED');
  assert.deepEqual(codex.pendingBuilds, ['esbuild']);
  assert.equal(claude.ok, true);
  assert.equal(connected.pluginAlignment.ok, false);
  assert.equal(connected.pluginAlignment.restarted, false);
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(connected.host.phase, 'connected');
});

test('a failed plugin installation is recorded and does not fail the connection', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => LOCAL_BUNDLES,
    remotePlugins: REMOTE_BUNDLES,
  });
  fixture.state.failPluginInstall = CODEX;
  const connected = await fixture.service.connect(fixture.record.id);
  assert.equal(connected.host.phase, 'connected');
  assert.equal(connected.pluginAlignment.ok, false);
  const [codex, claude] = fixture.service.runtime(fixture.record.id).pluginAlignment.items;
  assert.equal(codex.ok, false);
  assert.equal(codex.error.code, 'REMOTE_OPERATION_FAILED');
  assert.equal(claude.ok, true);
  assert.equal(connected.pluginAlignment.items.length, 2);
});

test('a failed backup is recorded and does not fail the connection', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => LOCAL_BUNDLES,
    remotePlugins: REMOTE_BUNDLES,
  });
  fixture.service.createRemoteBackup = async () => { throw new Error('backup unavailable'); };
  const connected = await fixture.service.connect(fixture.record.id);
  assert.equal(connected.host.phase, 'connected');
  assert.equal(connected.pluginAlignment.ok, false);
  assert.equal(connected.pluginAlignment.error.code, 'REMOTE_OPERATION_FAILED');
  assert.deepEqual(fixture.state.pluginRemovals, []);
  assert.equal(fixture.service.runtime(fixture.record.id).phase, 'connected');
});

test('a profile Host aligns its own plugins and restarts only when required', async (t) => {
  const fixture = await connectedFixture(t, {
    localBundles: async () => LOCAL_BUNDLES,
    remotePlugins: REMOTE_BUNDLES,
  });
  fixture.state.pluginInstallResults = { [CODEX]: { application: 'restart-required', pendingBuilds: [] } };
  const opened = await fixture.service.webOpen(fixture.record.id, { profileId: 'work' });
  assert.equal(opened.profileId, 'work');
  assert.equal(fixture.state.backupCalls, 1);
  assert.deepEqual(fixture.state.pluginRemovals, [CODEX, CLAUDE]);
  assert.equal(opened.pluginAlignment.ok, true);
  assert.equal(opened.pluginAlignment.restarted, true);
  const profileRuntime = fixture.service.profileRuntime(fixture.record.id, 'work');
  assert.equal(profileRuntime.host.closed, false);
  assert.equal(profileRuntime.host.profileId, 'work');
  assert.equal(profileRuntime.host.instanceId, opened.instanceId);
  // The profile restart must not touch the stored default connection instance.
  assert.equal(fixture.store.get(fixture.record.id).lastInstanceId, null);
  const stoppedProfileInstances = fixture.state.instances
    .filter((entry) => entry.instance.profileId === 'work' && entry.health.healthy === false);
  assert.equal(stoppedProfileInstances.length, 1);
});

test('planPluginSync installs local registry plugins the remote profile lacks', () => {
  const plan = planPluginSync({
    localBundles: [
      { name: 'dsh-meme', version: '0.1.80', source: 'dsh-meme@0.1.80', installed: true, official: false, availability: 'profile' },
      { name: 'dsh-carbon', version: '1.0.0', installTarget: { spec: 'dsh-carbon@1.0.0' }, installed: true, official: false, availability: 'profile' },
      { name: '@acme/code', version: '2.0.0', source: 'github:acme/code#abc', installed: true, official: false, availability: 'profile' },
    ],
    remoteBundles: [{ name: 'dsh-context', version: '0.83.1', installed: true, official: false, availability: 'profile' }],
  });
  assert.deepEqual(plan.operations.map((item) => [item.name, item.action, item.spec]), [
    ['dsh-meme', 'install', 'dsh-meme@0.1.80'],
    ['dsh-carbon', 'install', 'dsh-carbon@1.0.0'],
    ['@acme/code', 'install', 'github:acme/code#abc'],
  ]);
  assert.deepEqual(plan.skipped, []);
});

test('the manager desktop-only list stays identical to the shell alignment exclusions', () => {
  assert.deepEqual([...DESKTOP_ONLY_PLUGINS].sort(), [...EXCLUDED_PACKAGES].sort(),
    'a plugin excluded from the local web profile must not reach a remote web profile either');
});

test('planPluginSync skips every desktop-only plugin even when it has a registry spec', () => {
  const plan = planPluginSync({
    localBundles: DESKTOP_ONLY_PLUGINS.map((name, index) => ({
      name, version: '1.0.0', source: `${name}@1.0.0`, installed: true, official: false, availability: 'profile',
    })),
    remoteBundles: [],
  });
  assert.deepEqual(plan.operations, []);
});

test('planPluginSync ignores local-only installs, official bundles and matching versions', () => {
  const plan = planPluginSync({
    localBundles: [
      { name: 'dsh-subagent-model', version: '0.1.1', source: 'link:/Users/me/plugins/model', installed: true, official: false, availability: 'profile' },
      { name: 'local-shell', version: '0.5.31', source: 'file:/Users/me/shell.tgz', installed: true, official: false, availability: 'profile' },
      { name: 'local-tar', version: '1.0.0', installTarget: { spec: 'file:../local-tar-1.0.0.tgz' }, installed: true, official: false, availability: 'profile' },
      { name: '@deepseek-ai/dsh-web-app', version: '0.2.2-rc.1', installed: true, official: true, availability: 'profile' },
      { name: 'dsh-context', version: '0.83.1', source: 'dsh-context@0.83.1', installed: true, official: false, availability: 'profile' },
      { name: '@local/dsh-ssh-remote', version: '0.3.14', source: 'file:../manager.tgz', installed: true, official: false, availability: 'profile' },
    ],
    remoteBundles: [{ name: 'dsh-context', version: '0.83.1', installed: true, official: false, availability: 'profile' }],
  });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.skipped.map((item) => item.name).sort(), ['dsh-subagent-model', 'local-shell', 'local-tar'].sort());
});

test('planPluginSync upgrades a remote plugin that is older than the local one', () => {
  const plan = planPluginSync({
    localBundles: [{ name: 'dsh-context', version: '0.83.1', source: 'dsh-context@0.83.1', installed: true, official: false, availability: 'profile' }],
    remoteBundles: [{ name: 'dsh-context', version: '0.83.0', installed: true, official: false, availability: 'profile' }],
  });
  assert.deepEqual(plan.operations, [{
    name: 'dsh-context', action: 'upgrade', spec: 'dsh-context@0.83.1', fromVersion: '0.83.0', toVersion: '0.83.1',
  }]);
});

test('planPluginSync reinstalls a git install whose spec changed even at the same version', () => {
  const plan = planPluginSync({
    localBundles: [{
      name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#newsha', installed: true, official: false, availability: 'profile',
    }],
    remoteBundles: [{
      name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#oldsha', installed: true, official: false, availability: 'profile',
    }],
  });
  assert.deepEqual(plan.operations, [{
    name: 'dsh-codex-cua', action: 'upgrade', spec: 'github:owner/cua#newsha',
    fromVersion: '0.1.0', toVersion: '0.1.0', fromSpec: 'github:owner/cua#oldsha',
  }]);
});

test('planPluginSync leaves a git install alone when the spec is unchanged', () => {
  const plan = planPluginSync({
    localBundles: [{
      name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#same', installed: true, official: false, availability: 'profile',
    }],
    remoteBundles: [{
      name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#same', installed: true, official: false, availability: 'profile',
    }],
  });
  assert.deepEqual(plan.operations, []);
});

test('planPluginSync keeps a remote plugin that is newer than the local copy', () => {
  const plan = planPluginSync({
    localBundles: [{ name: 'dsh-context', version: '0.83.0', source: 'dsh-context@0.83.0', installed: true, official: false, availability: 'profile' }],
    remoteBundles: [{ name: 'dsh-context', version: '0.83.1', installed: true, official: false, availability: 'profile' }],
  });
  assert.deepEqual(plan.operations, []);
});
