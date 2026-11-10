import assert from 'node:assert/strict';
import test from 'node:test';

import { serviceFixture } from './helpers.mjs';

const INSTANCE = 'c'.repeat(32);
const CARD = {
  version: 1,
  instanceId: INSTANCE,
  hostKey: 'profile:web',
  profile: 'web',
  pid: 7777,
  port: 3095,
  url: 'http://127.0.0.1:3095/?token=guest-token',
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  supervised: false,
  cwd: '/home/user',
  argv: ['/opt/node', '/opt/dsh'],
};

function fakeGuestChannel() {
  const handlers = new Map();
  const channel = {
    closed: false,
    async exec(request) {
      const script = String(request.args?.[1] ?? '');
      if (script.includes('ls -1')) return { code: 0, stdout: 'web\n', stderr: '' };
      if (script.includes('cat "$HOME/.dsh/profiles/web/package.json"')) {
        return { code: 0, stdout: JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }), stderr: '' };
      }
      if (script.includes('workspace-hosts')) return { code: 0, stdout: `${JSON.stringify(CARD)}\n`, stderr: '' };
      if (script.includes('kill -0')) return { code: 0, stdout: `${CARD.pid}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async upload() {},
    on() {},
    off() {},
    once(event, listener) { handlers.set(event, listener); },
    emit() {},
    async close() { channel.closed = true; },
  };
  return channel;
}

async function guestFixture(t) {
  const fixture = await serviceFixture({ transport: 'guest', openGuestChannel: async () => {
    const channel = globalThis.__guestChannel;
    return { channel, controller: null, installed: null, artifact: null, target: null, transportMode: 'guest' };
  } });
  t.after(fixture.close);
  globalThis.__guestChannel = fakeGuestChannel();
  const record = await fixture.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  return { fixture, record };
}

test('guest transport connects with the SSH channel alone', async (t) => {
  const { fixture, record } = await guestFixture(t);
  const connected = await fixture.service.connect(record.id);
  assert.equal(connected.ok, true);
  assert.equal(connected.browserUrl, null);
  assert.equal(fixture.state.instances.length, 0, 'no controller instance is created');
  assert.equal(fixture.service.session(record.id).connected, true);
});

test('guest transport lists profiles and running Hosts from the remote machine', async (t) => {
  const { fixture, record } = await guestFixture(t);
  await fixture.service.connect(record.id);
  const listed = await fixture.service.webList(record.id);
  assert.equal(listed.connected, true);
  assert.deepEqual(listed.profiles, [{ id: 'web', name: 'web', web: true }]);
  assert.equal(listed.hosts.length, 1);
  assert.equal(listed.hosts[0].instanceId, INSTANCE);
  assert.equal(listed.hosts[0].state, 'running');
});

test('guest transport opens the reported Host instead of starting a controller one', async (t) => {
  const { fixture, record } = await guestFixture(t);
  await fixture.service.connect(record.id);
  const runtime = fixture.service.runtime(record.id);
  const forward = { id: 'guest-forward', state: 'active', localHost: '127.0.0.1', localPort: 40_020, remoteHost: '127.0.0.1', remotePort: 3095 };
  runtime.portManager = { closed: false, list: () => [forward], add: async () => forward, on() {}, off() {} };
  const opened = await fixture.service.webOpen(record.id, { profileId: 'web' });
  assert.equal(opened.guest, true);
  assert.equal(opened.url, 'http://127.0.0.1:40020/?token=guest-token');
  assert.equal(fixture.state.instances.length, 0);
});

test('guest transport refuses upgrade with a clear reason', async (t) => {
  const { fixture, record } = await guestFixture(t);
  await fixture.service.connect(record.id);
  await assert.rejects(
    fixture.service.upgradeHost({ hostId: record.id, profileId: 'web' }),
    (error) => error.code === 'UPGRADE_RUNTIME_UNAVAILABLE',
  );
});
