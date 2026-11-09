import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from './helpers.mjs';

test('concurrent connects merge into one installation and instance', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const phases = [];
  fixture.service.on('connection', (connection) => phases.push(connection.phase));
  const [first, second] = await Promise.all([fixture.service.connect(record.id), fixture.service.connect(record.id)]);
  assert.equal(first.browserUrl, second.browserUrl);
  assert.equal(fixture.state.instances.length, 1);
  for (const phase of ['installing', 'syncing', 'ready', 'switching', 'connected']) assert.ok(phases.includes(phase), phase);
});

test('optional first-connection sync failure returns a partial report with a usable host', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  fixture.state.failSettingsUpdate = true;
  const record = await fixture.store.upsert({ hostAlias: 'p0-test' });
  const connected = await fixture.service.connect(record.id);
  assert.equal(connected.host.phase, 'connected');
  assert.equal(connected.sync.ok, false);
  assert.equal(connected.sync.settings.ok, false);
  assert.equal(connected.sync.settings.items.some((item) => item.ok === false), true);
  assert.ok(connected.browserUrl);
});

test('closing the local manager keeps the remote host alive for a later attach', async () => {
  const fixture = await serviceFixture();
  const record = await fixture.store.upsert({ hostAlias: 'p0-test' });
  const connected = await fixture.service.connect(record.id);
  await fixture.service.close();
  assert.equal(fixture.state.stops.length, 0);
  const instance = fixture.state.instances.find((entry) => entry.instance.instanceId === connected.host.instanceId);
  assert.equal(instance.health.healthy, true);
  await fixture.store.close();
});

test('an active connection cannot be retargeted to another SSH alias', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await fixture.service.connect(record.id);
  await assert.rejects(fixture.service.upsert({ id: record.id, hostAlias: 'other-host' }), (error) => error.code === 'HOST_BUSY');
  assert.equal(fixture.store.get(record.id).hostAlias, 'p0-test');
});

test('a bounded connect timeout transitions to failed', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  fixture.service.connectTimeoutMs = 5;
  fixture.service.openControllerSession = () => new Promise(() => {});
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  await assert.rejects(fixture.service.connect(record.id), (error) => error.code === 'OPERATION_TIMEOUT');
  assert.equal(fixture.service.publicConnection(record.id).phase, 'failed');
});
