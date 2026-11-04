import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture, waitForPhase } from './helpers.mjs';

test('connect returns a browser URL once and keeps it out of status and storage', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({
    name: 'Test', hostAlias: 'p0-test', defaultWorkspace: '/home/test/work',
    pluginTemplate: [{ spec: '@local/example@1.0.0' }],
    syncPolicy: { appearance: true, modelNamespaces: ['model'], credentialRefs: ['TEST_KEY'] },
  });
  const connected = await fixture.service.connect(record.id);
  assert.equal(connected.ok, true);
  assert.equal(connected.host.phase, 'connected');
  assert.match(connected.browserUrl, /\?tkn=secret-instance-1$/u);
  assert.equal(connected.sync.ok, true);
  assert.deepEqual(fixture.credentialCalls, ['TEST_KEY']);
  const status = await fixture.service.status();
  assert.equal(status.dshVersion, '1.0.0');
  assert.equal(status.localReturnUrl.includes('local-secret'), false);
  assert.equal(JSON.stringify(status).includes(connected.browserUrl), false);
  assert.equal(JSON.stringify(status).includes('secret-value-TEST_KEY'), false);
  assert.equal(JSON.stringify(fixture.store.get(record.id)).includes('secret-instance-1'), false);
  assert.equal(fixture.state.calls.some((call) => call.path === '/api/ssh-remote/credentials/set' && call.body.value === 'secret-value-TEST_KEY'), true);
  assert.equal(fixture.state.calls.some((call) => call.path === '/api/ssh-remote/settings/update' && call.body.patch.apiKey !== undefined), false);

  const again = await fixture.service.connect(record.id);
  assert.equal(again.browserUrl, connected.browserUrl);
  assert.deepEqual(fixture.credentialCalls, ['TEST_KEY']);

  await fixture.service.disconnect(record.id);
  assert.equal(fixture.state.stops.length, 0);
  assert.equal(fixture.service.publicConnection(record.id).phase, 'idle');
  const stopped = await fixture.service.stop(record.id, { instanceId: 'instance-1' });
  assert.equal(stopped.stoppedInstanceId, 'instance-1');
  assert.equal(fixture.store.get(record.id).lastInstanceId, null);
});

test('an active old instance requires explicit upgrade confirmation', async (t) => {
  const fixture = await serviceFixture({ version: '2.0.0' });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  fixture.state.instances.push({
    instance: { instanceId: 'old-instance', dshVersion: '1.0.0', buildId: 'build-1', endpoint: { host: '127.0.0.1', port: 41000 } },
    health: { healthy: true }, active: true,
  });
  await fixture.store.markConnected(record.id, { instanceId: 'old-instance', version: '1.0.0', buildId: 'build-1' });
  await assert.rejects(fixture.service.connect(record.id), (error) => {
    assert.equal(error.code, 'UPGRADE_CONFIRMATION_REQUIRED');
    assert.equal(error.details.instanceId, 'old-instance');
    return true;
  });
  assert.deepEqual(fixture.state.stops, []);
  const upgraded = await fixture.service.connect(record.id, { allowUpgrade: true });
  assert.deepEqual(fixture.state.stops, ['old-instance']);
  assert.equal(upgraded.host.lastServerVersion, '2.0.0');
  assert.notEqual(upgraded.host.lastInstanceId, 'old-instance');
});

test('transport recovery attaches to the original instance without replaying sync', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: true } });
  const connected = await fixture.service.connect(record.id);
  const originalId = connected.host.instanceId;
  const originalChannel = fixture.service.runtime(record.id).channel;
  const syncCalls = fixture.state.calls.length;
  const reconnecting = waitForPhase(fixture.service, record.id, 'reconnecting');
  await originalChannel.close();
  await reconnecting;
  await waitForPhase(fixture.service, record.id, 'connected');
  assert.equal(fixture.service.publicConnection(record.id).instanceId, originalId);
  assert.equal(fixture.state.calls.length, syncCalls);
  assert.equal(fixture.service.publicConnection(record.id).reconnectAttempts, 0);
});

test('official plugin enablement restart stops the old instance and restores the snapshot', async (t) => {
  let restartOfficial = false;
  const fixture = await serviceFixture({
    localBundles: async () => [{ name: '@deepseek-ai/example-official', official: true, optional: true }],
    shareLocalPlugins: async () => ({
      ok: true,
      restartRequired: restartOfficial,
      snapshot: { schemaVersion: 1, bundles: [] },
    }),
  });
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const oldInstanceId = fixture.service.runtime(record.id).host.instanceId;
  restartOfficial = true;
  const report = await fixture.service.sync(record.id);
  const replacementId = fixture.service.runtime(record.id).host.instanceId;
  assert.equal(report.restartRequired, false);
  assert.equal(report.restarted, true);
  assert.equal(report.ok, true);
  assert.equal(report.pluginSharing.snapshotRestored, true);
  assert.notEqual(replacementId, oldInstanceId);
  assert.equal(fixture.state.stops.includes(oldInstanceId), true);
  assert.equal(fixture.store.get(record.id).lastInstanceId, replacementId);
});

test('sync requires a connected instance and stop rejects an ambiguous target', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await assert.rejects(fixture.service.sync(record.id), (error) => error.code === 'HOST_NOT_CONNECTED');
  await fixture.service.connect(record.id);
  await assert.rejects(fixture.service.stop(record.id, { instanceId: 'some-other-instance' }), (error) => error.code === 'REMOTE_INSTANCE_UNAVAILABLE');
});
