import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture, waitFor } from './helpers.mjs';

async function connectedFixture(t, options = {}) {
  const fixture = await serviceFixture({ version: '1.0.0', ...options });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  return { fixture, record };
}

async function waitForUpgradeEnd(fixture, hostId, timeoutMs = 3_000) {
  await waitFor(() => {
    const phase = fixture.service.runtime(hostId).upgrade?.phase;
    return phase === 'done' || phase === 'failed';
  }, timeoutMs);
  return fixture.service.runtime(hostId).upgrade;
}

test('status and the host list expose the current and newest runtime versions', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  fixture.setLatestRuntimeVersion('2.0.0');
  const status = await fixture.service.status();
  const connection = status.connections.find((item) => item.id === record.id);
  assert.equal(connection.remoteVersion, '1.0.0');
  assert.equal(connection.dshVersion, '1.0.0');
  assert.equal(connection.latestDshVersion, '2.0.0');
  assert.equal(connection.upgrade, null);
  const listed = await fixture.service.webList(record.id);
  const host = listed.hosts.find((item) => item.profileId === 'web');
  assert.equal(host.dshVersion, '1.0.0');
  assert.equal(host.latestDshVersion, '2.0.0');
  assert.equal(host.upgrade, null);
});

test('an upgrade installs the newest bundled runtime and immediately returns started', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  const previousInstanceId = fixture.service.profileRuntime(record.id, 'web').host.instanceId;
  fixture.setLatestRuntimeVersion('2.0.0');
  const started = await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  assert.equal(started.started, true);
  assert.equal(started.upgrade.phase, 'running');
  assert.equal(started.upgrade.step, 'runtime');
  await waitForUpgradeEnd(fixture, record.id);
  const upgrade = fixture.service.runtime(record.id).upgrade;
  assert.equal(upgrade.phase, 'done');
  assert.equal(upgrade.step, 'plugins');
  const host = fixture.service.profileRuntime(record.id, 'web').host;
  assert.notEqual(host.instanceId, previousInstanceId);
  assert.equal(host.version, '2.0.0');
  // The previous instance belongs to the old runtime and keeps running.
  const previous = fixture.state.instances.find((entry) => entry.instance.instanceId === previousInstanceId);
  assert.equal(previous.health.healthy, true);
  assert.deepEqual(fixture.state.stops, []);
  assert.equal(fixture.service.publicConnection(record.id).remoteVersion, '2.0.0');
  assert.equal(fixture.store.get(record.id).lastServerVersion, '2.0.0');
});

test('an up-to-date Host reports that no upgrade is needed and starts nothing', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  const before = fixture.service.profileRuntime(record.id, 'web').host.instanceId;
  const result = await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  assert.deepEqual(result, {
    started: false,
    reason: 'up-to-date',
    hostId: record.id,
    profileId: 'web',
    dshVersion: '1.0.0',
    latestDshVersion: '1.0.0',
  });
  assert.equal(fixture.service.profileRuntime(record.id, 'web').host.instanceId, before);
  assert.equal(fixture.service.runtime(record.id).upgrade, null);
});

test('a second upgrade while one is running returns UPGRADE_BUSY', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  fixture.setLatestRuntimeVersion('2.0.0');
  const open = fixture.service.openControllerSession;
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  fixture.service.openControllerSession = async (input) => {
    entered();
    await gate;
    return open(input);
  };
  const started = await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  assert.equal(started.started, true);
  await enteredPromise;
  const status = await fixture.service.status();
  assert.equal(status.connections[0].upgrade.phase, 'running');
  assert.equal(status.connections[0].upgrade.step, 'runtime');
  const listed = await fixture.service.webList(record.id);
  assert.equal(listed.hosts.find((item) => item.profileId === 'web').upgrade.phase, 'running');
  await assert.rejects(
    fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' }),
    (error) => error.code === 'UPGRADE_BUSY',
  );
  release();
  await waitForUpgradeEnd(fixture, record.id);
});

test('a finished upgrade is reported once and then cleared on the next poll', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  fixture.setLatestRuntimeVersion('2.0.0');
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  await waitForUpgradeEnd(fixture, record.id);
  const finished = await fixture.service.webList(record.id);
  assert.equal(finished.hosts.find((item) => item.profileId === 'web').upgrade.phase, 'done');
  const cleared = await fixture.service.webList(record.id);
  assert.equal(cleared.hosts.find((item) => item.profileId === 'web').upgrade, null);
  assert.equal(cleared.hosts.find((item) => item.profileId === 'web').dshVersion, '2.0.0');
});

test('plugin upgrades skip official and non-registry bundles and install registry latest', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0', '@acme/current': '3.0.0' },
    remotePlugins: [
      { name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false },
      { name: '@acme/current', version: '3.0.0', spec: '@acme/current@3.0.0', official: false },
      { name: '@deepseek-ai/dsh-web-app', version: '1.0.0', official: true },
      { name: 'git-plugin', version: '1.0.0', spec: 'github:acme/git-plugin', official: false },
      { name: 'file-plugin', version: '1.0.0', spec: 'file:/tmp/plugin.tgz', official: false },
    ],
  });
  fixture.setLatestRuntimeVersion('2.0.0');
  assert.equal((await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' })).started, true);
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.deepEqual(fixture.state.pluginInstalls.map((item) => item.spec), ['@acme/one@1.5.0']);
  assert.equal(fixture.state.pluginInstalls.some((item) => item.name === '@acme/current'), false);
  const installed = upgrade.items.find((item) => item.name === '@acme/one');
  assert.deepEqual(installed, {
    name: '@acme/one', fromVersion: '1.0.0', toVersion: '1.5.0', ok: true, application: 'applied',
  });
});

test('restart-required plugin results restart the upgraded Host exactly once', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0', '@acme/two': '2.0.0' },
    remotePlugins: [
      { name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false },
      { name: '@acme/two', version: '1.0.0', spec: '@acme/two@1.0.0', official: false },
    ],
  });
  fixture.state.pluginInstallResults = {
    '@acme/one': { application: 'restart-required', pendingBuilds: [] },
    '@acme/two': { application: 'restart-required', pendingBuilds: [] },
  };
  fixture.setLatestRuntimeVersion('2.0.0');
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.equal(upgrade.step, 'plugins');
  assert.equal(fixture.state.pluginInstalls.length, 2);
  assert.equal(fixture.state.stops.length, 1, 'the replacement Host is restarted only once');
  const restarted = fixture.service.profileRuntime(record.id, 'web').host;
  assert.equal(restarted.closed, false);
  assert.notEqual(restarted.instanceId, fixture.state.stops[0]);
});

test('one failing plugin is reported without rolling back the successful ones', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0', '@acme/two': '2.0.0' },
    remotePlugins: [
      { name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false },
      { name: '@acme/two', version: '1.0.0', spec: '@acme/two@1.0.0', official: false },
    ],
  });
  fixture.state.failPluginInstall = '@acme/one';
  fixture.setLatestRuntimeVersion('2.0.0');
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'failed');
  assert.equal(upgrade.step, 'plugins');
  assert.equal(upgrade.error.code, 'UPGRADE_PLUGIN_FAILED');
  const failed = upgrade.items.find((item) => item.name === '@acme/one');
  const succeeded = upgrade.items.find((item) => item.name === '@acme/two');
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.error, { code: 'UPGRADE_PLUGIN_FAILED' });
  assert.equal(succeeded.ok, true);
  assert.equal(fixture.state.pluginInstalls.some((item) => item.spec === '@acme/two@2.0.0'), true);
});

test('an upgrade pushes config only for the plugins it touched', async (t) => {
  const localBundles = [
    { name: 'dsh-meme', version: '0.1.80', source: 'dsh-meme@0.1.80', installed: true, official: false, availability: 'profile' },
  ];
  const configEditor = {
    configuration: () => [
      { entry: { options: { id: 'meme-settings', name: 'dsh-meme' } }, override: { theme: 'cat', apiKey: 'SECRET', path: '/Users/me/file' } },
      { entry: { options: { id: 'pet-settings', name: 'dsh-pet' } }, override: { theme: 'dog' } },
    ],
  };
  const { fixture, record } = await connectedFixture(t, { localBundles: async () => localBundles, configEditor });
  await fixture.service.webList(record.id);
  await waitFor(() => fixture.service.profileHosts(record.id).find((item) => item.profileId === 'web')?.pluginsUpgradable === true);
  fixture.state.calls.length = 0;
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  const call = fixture.state.calls.find((entry) => entry.path === '/api/ssh-remote/plugins/config');
  assert.ok(call, 'the touched plugin config is sent');
  assert.deepEqual(call.body.entries, [{
    id: 'meme-settings', name: 'dsh-meme', config: { theme: 'cat' },
  }], 'secrets and local paths stay home; unrelated plugins are not sent');
});

test('a failed config sync is reported without losing the installed plugin', async (t) => {
  const localBundles = [
    { name: 'dsh-meme', version: '0.1.80', source: 'dsh-meme@0.1.80', installed: true, official: false, availability: 'profile' },
  ];
  const configEditor = { configuration: () => [{ entry: { options: { id: 'meme-settings', name: 'dsh-meme' } }, override: { theme: 'cat' } }] };
  const { fixture, record } = await connectedFixture(t, { localBundles: async () => localBundles, configEditor });
  fixture.state.failPluginConfig = true;
  await fixture.service.webList(record.id);
  await waitFor(() => fixture.service.profileHosts(record.id).find((item) => item.profileId === 'web')?.pluginsUpgradable === true);
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'failed');
  assert.equal(upgrade.error.code, 'UPGRADE_CONFIG_FAILED');
  assert.equal(upgrade.items.find((item) => item.name === 'dsh-meme').ok, true, 'the plugin install itself is kept');
});

test('a changed git spec reinstalls the remote plugin even at the same version', async (t) => {
  const localBundles = [{
    name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#newsha', installed: true, official: false, availability: 'profile',
  }];
  const { fixture, record } = await connectedFixture(t, {
    localBundles: async () => localBundles,
    remotePlugins: [{
      name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#oldsha', installed: true, official: false, availability: 'profile',
    }],
  });
  await fixture.service.webList(record.id);
  await waitFor(() => fixture.service.profileHosts(record.id).find((item) => item.profileId === 'web')?.pluginsUpgradable === true);
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.deepEqual(fixture.state.pluginRemovals, ['dsh-codex-cua']);
  assert.deepEqual(fixture.state.pluginInstalls.map((item) => item.spec), ['github:owner/cua#newsha']);
});

test('a failed git reinstall puts the previous pinned spec back', async (t) => {
  const localBundles = [{
    name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#newsha', installed: true, official: false, availability: 'profile',
  }];
  const { fixture, record } = await connectedFixture(t, {
    localBundles: async () => localBundles,
    remotePlugins: [{
      name: 'dsh-codex-cua', version: '0.1.0', source: 'github:owner/cua#oldsha', installed: true, official: false, availability: 'profile',
    }],
  });
  fixture.state.failPluginInstallSpecs = ['github:owner/cua#newsha'];
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'failed');
  assert.deepEqual(fixture.state.pluginInstalls.map((item) => item.spec),
    ['github:owner/cua#newsha', 'github:owner/cua#oldsha'], 'the old pin is reinstalled after the failure');
});

test('a bundle with no npm dist-tag is left alone instead of failing the upgrade', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [
      { name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false },
      // A github: install has no spec in the remote inventory and no npm dist-tag.
      { name: 'dsh-codex-cua', version: '0.1.0', spec: null, official: false },
    ],
  });
  fixture.setLatestRuntimeVersion('2.0.0');
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.equal(upgrade.items.some((item) => item.name === 'dsh-codex-cua'), false, 'not an npm package, no verdict');
  assert.equal(upgrade.items.find((item) => item.name === '@acme/one').ok, true);
  assert.equal(fixture.state.pluginInstalls.some((item) => item.name === 'dsh-codex-cua'), false);
});

test('an unresolved registry version is reported as UPGRADE_REGISTRY_UNAVAILABLE', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    remotePlugins: [{ name: '@acme/unknown', version: '1.0.0', spec: '@acme/unknown@1.0.0', official: false }],
  });
  fixture.setLatestRuntimeVersion('2.0.0');
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'failed');
  assert.deepEqual(upgrade.items[0].error, { code: 'UPGRADE_REGISTRY_UNAVAILABLE' });
  assert.equal(fixture.state.pluginInstalls.length, 0);
});

test('an upgrade without a matching bundled runtime fails with a safe code', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  fixture.service.catalog.newest = async () => null;
  await assert.rejects(
    fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' }),
    (error) => error.code === 'UPGRADE_RUNTIME_UNAVAILABLE',
  );
  assert.equal(fixture.service.runtime(record.id).upgrade, null);
  assert.equal(fixture.service.profileRuntime(record.id, 'web').host.version, '1.0.0');
});

test('a failed runtime install keeps the previous Host connected', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  const previous = fixture.service.profileRuntime(record.id, 'web').host;
  fixture.setLatestRuntimeVersion('2.0.0');
  const open = fixture.service.openControllerSession;
  fixture.service.openControllerSession = async (input) => {
    if (input.version === '2.0.0') throw Object.assign(new Error('install failed'), { code: 'REMOTE_INSTALL_FAILED' });
    return open(input);
  };
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'failed');
  assert.equal(upgrade.step, 'runtime');
  assert.deepEqual(upgrade.error, { code: 'REMOTE_INSTALL_FAILED' });
  assert.equal(fixture.service.profileRuntime(record.id, 'web').host, previous);
  assert.equal(previous.closed, false);
  assert.equal(fixture.service.publicConnection(record.id).phase, 'connected');
  assert.deepEqual(fixture.state.stops, []);
});

test('an upgrade of a non-Web profile is refused', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  fixture.service.sessions.get(record.id).profiles = [{ id: 'web', web: true }, { id: 'tui', web: false }];
  await assert.rejects(
    fixture.service.upgradeHost({ hostId: record.id, profileId: 'tui' }),
    (error) => error.code === 'UPGRADE_UNSUPPORTED_PROFILE',
  );
});

test('an upgrade of an unknown host reports HOST_NOT_FOUND', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  await assert.rejects(
    fixture.service.upgradeHost({ hostId: 'missing' }),
    (error) => error.code === 'HOST_NOT_FOUND',
  );
});

test('an up-to-date runtime still upgrades plugins that are behind npm latest', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  const before = fixture.service.profileRuntime(record.id, 'web').host.instanceId;
  const started = await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  assert.equal(started.started, true, 'a plugin-only upgrade is allowed when the runtime is current');
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.equal(fixture.service.profileRuntime(record.id, 'web').host.instanceId, before, 'the runtime instance is kept');
  assert.deepEqual(fixture.state.pluginInstalls.map((item) => item.spec), ['@acme/one@1.5.0']);
});

test('an up-to-date runtime with current plugins still reports up-to-date', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.0.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  const result = await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  assert.equal(result.started, false);
  assert.equal(result.reason, 'up-to-date');
  assert.equal(fixture.state.pluginInstalls.length, 0);
});

test('the host list marks a Host whose plugins are behind latest', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  await fixture.service.webList(record.id);
  let host = null;
  await waitFor(() => {
    host = fixture.service.profileHosts(record.id).find((item) => item.profileId === 'web');
    return host?.pluginsUpgradable === true;
  });
  assert.equal(host.pluginsUpgradable, true);
  assert.equal(host.latestDshVersion, '1.0.0');
});

test('an installed plugin behind latest is removed then reinstalled at latest', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.deepEqual(fixture.state.pluginRemovals, ['@acme/one'], 'an existing version must be removed first');
  assert.deepEqual(fixture.state.pluginInstalls.map((item) => item.spec), ['@acme/one@1.5.0']);
  assert.equal(upgrade.items.find((item) => item.name === '@acme/one').ok, true);
});

test('a missing local plugin that needs a build approval is recorded and retried after approval', async (t) => {
  const localBundles = [
    { name: 'dsh-meme', version: '0.1.80', source: 'dsh-meme@0.1.80', installed: true, official: false, availability: 'profile' },
  ];
  const { fixture, record } = await connectedFixture(t, { localBundles: async () => localBundles });
  fixture.state.pluginBuildBlockedSpecs = ['dsh-meme@0.1.80'];
  await fixture.service.webList(record.id);
  await waitFor(() => fixture.service.profileHosts(record.id).find((item) => item.profileId === 'web')?.pluginsUpgradable === true);
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const failed = await waitForUpgradeEnd(fixture, record.id);
  const item = failed.items.find((entry) => entry.name === 'dsh-meme');
  assert.equal(item.error.code, 'PLUGIN_BUILD_APPROVAL_REQUIRED');
  const host = fixture.service.profileHosts(record.id).find((entry) => entry.profileId === 'web');
  assert.deepEqual(host.buildApprovals, [{ name: 'dsh-meme', builds: ['bun@1.4.4'] }]);

  fixture.state.pluginBuildBlockedSpecs = [];
  fixture.state.calls.length = 0;
  await fixture.service.approveUpgrades({ hostId: record.id, profileId: 'web' });
  const retried = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(retried.phase, 'done');
  const install = fixture.state.calls.find((call) => call.path === '/api/ssh-remote/plugins/install');
  assert.deepEqual(install.body.approvedBuilds, ['bun@1.4.4'], 'the approval travels with the synced plugin');
});

test('a local plugin missing on the remote marks the Host upgradable and is installed', async (t) => {
  const localBundles = [
    { name: 'dsh-meme', version: '0.1.80', source: 'dsh-meme@0.1.80', installed: true, official: false, availability: 'profile' },
    { name: 'dsh-subagent-model', version: '0.1.1', source: 'link:/Users/me/plugins/model', installed: true, official: false, availability: 'profile' },
  ];
  const { fixture, record } = await connectedFixture(t, { localBundles: async () => localBundles });
  await fixture.service.webList(record.id);
  let host = null;
  await waitFor(() => {
    host = fixture.service.profileHosts(record.id).find((item) => item.profileId === 'web');
    return host?.pluginsUpgradable === true;
  });
  assert.equal(host.pluginsUpgradable, true, 'a missing local plugin is a difference worth a sync');
  const started = await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  assert.equal(started.started, true);
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.deepEqual(fixture.state.pluginInstalls.map((item) => item.spec), ['dsh-meme@0.1.80']);
  assert.equal(upgrade.items.some((item) => item.name === 'dsh-meme' && item.ok === true), true);
  assert.equal(fixture.state.pluginInstalls.some((item) => item.name === 'dsh-subagent-model'), false,
    'a link: install never travels to the remote');
});

test('a Host restarted by an upgrade gets the local plugin snapshot again', async (t) => {
  const localBundles = [{ name: 'dsh-meme', version: '0.1.80', official: false, availability: 'profile' }];
  const { fixture, record } = await connectedFixture(t, {
    localBundles: async () => localBundles,
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  fixture.state.pluginInstallResults = { '@acme/one': { application: 'restart-required', pendingBuilds: [] } };
  fixture.state.calls.length = 0;
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.equal(fixture.state.stops.length, 1, 'the plugin restart replaced the Host');
  const uploads = fixture.state.calls.filter((call) => call.path === '/api/ssh-remote/plugins/local-inventory');
  assert.equal(uploads.length, 1, 'the replacement Host receives the snapshot before it is used');
  assert.deepEqual(uploads[0].body.snapshot.bundles.map((bundle) => bundle.name), ['dsh-meme']);
});

test('an enable failure right after removal is retried instead of failing the upgrade', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  fixture.state.pluginInstallResults = {
    '@acme/one': [
      { ok: false, stage: 'enable', application: 'failed', changed: true, error: { code: 'operation-error', diagnostic: 'failed to import' } },
      { stage: 'install', application: 'applied', changed: false },
    ],
  };
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.equal(upgrade.items.find((entry) => entry.name === '@acme/one').ok, true);
  assert.deepEqual(fixture.state.pluginInstalls.map((entry) => entry.spec), ['@acme/one@1.5.0', '@acme/one@1.5.0']);
  assert.deepEqual(fixture.state.pluginRemovals, ['@acme/one'], 'the plugin is removed only once');
});

test('a persistent enable failure still rolls back to the previous version', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  const failure = { ok: false, stage: 'enable', application: 'failed', changed: true, error: { code: 'operation-error', diagnostic: 'failed to import' } };
  fixture.state.pluginInstallResults = { '@acme/one': [{ ...failure }, { ...failure }] };
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'failed');
  assert.deepEqual(fixture.state.pluginInstalls.map((entry) => entry.spec),
    ['@acme/one@1.5.0', '@acme/one@1.5.0', '@acme/one@1.0.0']);
  assert.equal(upgrade.items.find((entry) => entry.name === '@acme/one').ok, false);
});

test('a failed plugin upgrade restores the previous version instead of dropping it', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  fixture.state.failPluginInstallSpecs = ['@acme/one@1.5.0'];
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.deepEqual(fixture.state.pluginRemovals, ['@acme/one']);
  assert.deepEqual(fixture.state.pluginInstalls.map((item) => item.spec), ['@acme/one@1.5.0', '@acme/one@1.0.0'],
    'the previous version is reinstalled after the failure');
  assert.equal(upgrade.items.find((item) => item.name === '@acme/one').ok, false);
});

test('a build-blocked upgrade records the pending packages and offers the approval', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  fixture.state.pluginBuildBlockedSpecs = ['@acme/one@1.5.0'];
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  const item = upgrade.items.find((entry) => entry.name === '@acme/one');
  assert.equal(item.ok, false);
  assert.equal(item.error.code, 'PLUGIN_BUILD_APPROVAL_REQUIRED');
  assert.deepEqual(item.pendingBuilds, ['bun@1.4.4']);
  assert.deepEqual(fixture.state.pluginInstalls.map((entry) => entry.spec), ['@acme/one@1.5.0', '@acme/one@1.0.0']);
  const host = fixture.service.profileHosts(record.id).find((entry) => entry.profileId === 'web');
  assert.deepEqual(host.buildApprovals, [{ name: '@acme/one', builds: ['bun@1.4.4'] }]);
  const snapshot = fixture.service.upgradeSnapshot(fixture.service.runtime(record.id), 'web');
  const snapItem = snapshot.items.find((entry) => entry.name === '@acme/one');
  assert.deepEqual(snapItem.pendingBuilds, ['bun@1.4.4']);
});

test('approving the recorded builds retries the upgrade with per-plugin approvals', async (t) => {
  const { fixture, record } = await connectedFixture(t, {
    pluginLatest: { '@acme/one': '1.5.0' },
    remotePlugins: [{ name: '@acme/one', version: '1.0.0', spec: '@acme/one@1.0.0', official: false }],
  });
  fixture.state.pluginBuildBlockedSpecs = ['@acme/one@1.5.0'];
  await fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' });
  await waitForUpgradeEnd(fixture, record.id);
  fixture.service.upgradeSnapshot(fixture.service.runtime(record.id), 'web');

  fixture.state.pluginBuildBlockedSpecs = [];
  const approved = await fixture.service.approveUpgrades({ hostId: record.id, profileId: 'web' });
  assert.deepEqual(approved, {
    ...approved,
    started: true,
    approved: 1,
    hostId: record.id,
    profileId: 'web',
  });
  const upgrade = await waitForUpgradeEnd(fixture, record.id);
  assert.equal(upgrade.phase, 'done');
  assert.equal(upgrade.items.find((entry) => entry.name === '@acme/one').ok, true);
  const installs = fixture.state.calls.filter((call) => call.path === '/api/ssh-remote/plugins/install' && call.body?.approvedBuilds);
  assert.deepEqual(installs.map((call) => [call.body.spec, call.body.approvedBuilds]), [['@acme/one@1.5.0', ['bun@1.4.4']]]);
  const host = fixture.service.profileHosts(record.id).find((entry) => entry.profileId === 'web');
  assert.deepEqual(host.buildApprovals, [], 'the approval list clears after the successful retry');
});

test('approving without a recorded pending build reports a safe code', async (t) => {
  const { fixture, record } = await connectedFixture(t);
  await assert.rejects(fixture.service.approveUpgrades({ hostId: record.id, profileId: 'web' }), (error) => error.code === 'UPGRADE_APPROVAL_UNAVAILABLE');
});
