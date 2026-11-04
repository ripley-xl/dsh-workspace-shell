import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from '../../p1/service/helpers.mjs';

async function sharingFixture(t) {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  const bundles = [{ name: '@deepseek-ai/optional', official: true, optional: true, enabled: true, installed: false, availability: 'installation', version: '1.0.0' }];
  fixture.service.localBundles = async () => bundles;
  return { ...fixture, record, bundles };
}

test('explicit sync shares the real local plugin snapshot and official enabled state', async (t) => {
  const fixture = await sharingFixture(t);
  const calls = [];
  fixture.service.shareLocalPlugins = async (client, bundles) => {
    calls.push({ client, bundles });
    return { ok: true, snapshot: { schemaVersion: 1, bundles: [] }, official: { ok: true, restartRequired: false, items: [] } };
  };
  const report = await fixture.service.sync(fixture.record.id);
  assert.equal(report.ok, true);
  assert.equal(report.pluginSharing.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].client, fixture.service.runtime(fixture.record.id).host.client);
  assert.deepEqual(calls[0].bundles, fixture.bundles);
});

test('plugin sharing failure is reported as partial without disconnecting the host', async (t) => {
  const fixture = await sharingFixture(t);
  fixture.service.shareLocalPlugins = async () => { throw new Error('snapshot upload failed'); };
  const report = await fixture.service.sync(fixture.record.id);
  assert.equal(report.ok, false);
  assert.equal(report.pluginSharing.ok, false);
  assert.equal(report.pluginSharing.error.message, 'snapshot upload failed');
  assert.equal(fixture.service.publicConnection(fixture.record.id).phase, 'connected');
});

test('official restart restores only the snapshot on the replacement instance', async (t) => {
  const fixture = await sharingFixture(t);
  const oldInstanceId = fixture.service.runtime(fixture.record.id).host.instanceId;
  const shared = [];
  const uploaded = [];
  fixture.service.shareLocalPlugins = async () => {
    shared.push(oldInstanceId);
    return {
      ok: true,
      snapshot: { schemaVersion: 1, bundles: [{ name: '@deepseek-ai/optional', enabled: true }] },
      official: { ok: true, restartRequired: true, items: [] },
    };
  };
  fixture.service.uploadLocalPluginSnapshot = async (client, snapshot) => {
    uploaded.push({ instanceId: client.instanceId, snapshot });
    return { ok: true };
  };
  const report = await fixture.service.sync(fixture.record.id);
  const replacementId = fixture.service.runtime(fixture.record.id).host.instanceId;
  assert.notEqual(replacementId, oldInstanceId);
  assert.equal(shared.length, 1);
  assert.deepEqual(uploaded.map((item) => item.instanceId), [replacementId]);
  assert.equal(report.ok, true);
  assert.equal(report.pluginSharing.snapshotRestored, true);
  assert.equal(report.pluginSharing.restartRequired, false);
  assert.equal(report.instanceId, replacementId);
});
