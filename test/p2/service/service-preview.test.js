import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from '../../p1/service/helpers.mjs';

async function connectedFixture(t) {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  await fixture.store.upsert({
    id: record.id,
    pluginTemplate: [],
    syncPolicy: { appearance: true, modelNamespaces: [], credentialRefs: ['TEST_KEY'] },
  });
  fixture.service.credentials.describe = async () => ({ configured: true, writable: true });
  const model = fixture.descriptors.find((descriptor) => descriptor.ns === 'model');
  model.schema = { properties: { apiKeyEnv: { default: 'TEST_KEY', 'x-cordis': { role: 'credential-ref' } } } };
  model.value.apiKeyEnv = 'TEST_KEY';
  return { ...fixture, record, host: fixture.service.runtime(record.id).host, initialCredentialCalls: fixture.credentialCalls.length };
}

test('reviewed conflicts block writes until allowConflicts is explicit', async (t) => {
  const fixture = await connectedFixture(t);
  const calls = [];
  fixture.host.client.post = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/ssh-remote/settings/describe') {
      return { ok: true, descriptors: [{ ns: 'ui-theme', revision: 7, value: { preference: 'light', fontSize: 14, remoteOnly: 'keep' }, user: { preference: 'light', remoteOnly: 'keep' } }] };
    }
    if (path === '/api/ssh-remote/plugins/list') return { ok: true, bundles: [] };
    if (path === '/api/ssh-remote/credentials/describe') return { ok: true, credentials: { TEST_KEY: { configured: true, writable: true } } };
    return { ok: true };
  };
  const preview = await fixture.service.previewSync(fixture.record.id);
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(fixture.credentialCalls.length, fixture.initialCredentialCalls);
  assert.equal(calls.some((call) => call.path === '/api/ssh-remote/settings/update'), false);
  await assert.rejects(fixture.service.sync(fixture.record.id), (error) => {
    assert.equal(error.code, 'SYNC_CONFIRMATION_REQUIRED');
    assert.equal(error.details.preview.requiresConfirmation, true);
    assert.equal(JSON.stringify(error.details).includes('secret-value-TEST_KEY'), false);
    return true;
  });
  assert.equal(calls.some((call) => call.path === '/api/ssh-remote/settings/update'), false);
  const report = await fixture.service.sync(fixture.record.id, { allowConflicts: true });
  assert.equal(report.ok, true);
  const update = calls.find((call) => call.path === '/api/ssh-remote/settings/update');
  assert.deepEqual(update.body.patch, { preference: 'dark', fontSize: 14 });
  assert.equal(update.body.expectedRevision, 7);
  assert.equal(Object.hasOwn(update.body.patch, 'remoteOnly'), false);
  assert.equal(fixture.credentialCalls.length, fixture.initialCredentialCalls + 1);
  assert.equal(fixture.service.publicConnection(fixture.record.id).phase, 'connected');
});

test('a reviewed plan without conflicts keeps the existing sync call compatible', async (t) => {
  const fixture = await connectedFixture(t);
  const calls = [];
  fixture.host.client.post = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/ssh-remote/settings/describe') {
      return { ok: true, descriptors: [{ ns: 'ui-theme', value: { preference: 'light', fontSize: 14 }, user: {} }] };
    }
    if (path === '/api/ssh-remote/plugins/list') return { ok: true, bundles: [] };
    if (path === '/api/ssh-remote/credentials/describe') return { ok: true, credentials: { TEST_KEY: { configured: false, writable: true } } };
    return { ok: true };
  };
  const preview = await fixture.service.previewSync(fixture.record.id);
  assert.equal(preview.requiresConfirmation, false);
  const report = await fixture.service.sync(fixture.record.id);
  assert.equal(report.ok, true);
  assert.equal(calls.filter((call) => call.path === '/api/ssh-remote/settings/update').length, 2);
});

test('preview is bounded and requires a connected remote instance', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await assert.rejects(fixture.service.previewSync(record.id), (error) => error.code === 'HOST_NOT_CONNECTED');
  await fixture.service.connect(record.id);
  fixture.service.runtime(record.id).host.client.post = () => new Promise(() => {});
  fixture.service.syncTimeoutMs = 5;
  await assert.rejects(fixture.service.previewSync(record.id), (error) => error.code === 'OPERATION_TIMEOUT');
  assert.equal(fixture.service.publicConnection(record.id).phase, 'connected');
});
