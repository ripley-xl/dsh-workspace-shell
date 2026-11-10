import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forwardedUrl, parseHostCards, publicHost, readHostCard, readRemoteHostCards,
} from '../../../packages/manager/src/host/remote-hosts.js';

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function card(overrides = {}) {
  const now = new Date().toISOString();
  return {
    version: 1,
    instanceId: ID,
    hostKey: 'profile:web',
    profile: 'web',
    pid: 1234,
    port: 3080,
    url: 'http://127.0.0.1:3080/?token=secret',
    startedAt: now,
    heartbeatAt: now,
    supervised: false,
    cwd: '/home/user',
    argv: ['node', 'dsh'],
    guestVersion: '0.6.1',
    ...overrides,
  };
}

test('a valid card is accepted without exposing anything extra', () => {
  const result = readHostCard(JSON.stringify(card()), ID);
  assert.equal(result.code, undefined);
  assert.equal(result.card.instanceId, ID);
  assert.equal(result.card.profileId, 'web');
  assert.equal(result.card.port, 3080);
  assert.equal(result.card.url, 'http://127.0.0.1:3080/?token=secret');
  const visible = publicHost(result.card);
  assert.equal('url' in visible, false, 'the authenticated URL is not part of the listing');
  assert.equal(JSON.stringify(visible).includes('secret'), false);
});

test('cards that could not describe a reachable Host are refused', () => {
  assert.equal(readHostCard('{bad json', ID).code, 'HOST_CARD_INVALID');
  assert.equal(readHostCard(JSON.stringify(card({ version: 2 })), ID).code, 'HOST_CARD_INVALID');
  assert.equal(readHostCard(JSON.stringify(card({ instanceId: 'f'.repeat(32) })), ID).code, 'HOST_CARD_INVALID');
  assert.equal(readHostCard(JSON.stringify(card({ pid: 0 })), ID).code, 'HOST_CARD_INVALID');
  assert.equal(readHostCard(JSON.stringify(card({ port: 70_000 })), ID).code, 'HOST_CARD_INVALID');
  assert.equal(readHostCard(JSON.stringify(card({ supervised: 'yes' })), ID).code, 'HOST_CARD_INVALID');
  assert.equal(readHostCard(JSON.stringify(card({ startedAt: 'not a date' })), ID).code, 'HOST_CARD_INVALID');
  assert.equal(readHostCard(JSON.stringify(card({ url: 'http://example.com:3080/' })), ID).code, 'HOST_CARD_URL_REJECTED');
  assert.equal(readHostCard(JSON.stringify(card({ url: 'http://user:pw@127.0.0.1:3080/' })), ID).code, 'HOST_CARD_URL_REJECTED');
  assert.equal(readHostCard(JSON.stringify(card({ url: 'https://127.0.0.1:3080/' })), ID).code, 'HOST_CARD_URL_REJECTED');
});

test('the concatenated card stream keeps valid hosts, newest first', () => {
  const older = card({ instanceId: 'b'.repeat(32), startedAt: '2026-11-10T00:00:00.000Z' });
  const newer = card({ instanceId: 'c'.repeat(32), startedAt: '2026-11-10T01:00:00.000Z' });
  const output = [JSON.stringify(older), JSON.stringify(newer), JSON.stringify(card({ instanceId: 'c'.repeat(32) })), '', 'not json', JSON.stringify(card({ instanceId: 'd'.repeat(32), url: 'http://example.com/' }))].join('\n');
  const parsed = parseHostCards(output);
  assert.deepEqual(parsed.hosts.map((host) => host.instanceId), ['c'.repeat(32), 'b'.repeat(32)]);
  assert.equal(parsed.skipped.length, 2, 'garbage and a rejected URL are reported, a duplicate is not');
});

test('a missing card directory reads as an empty list', async () => {
  const channel = {
    async exec(request) {
      assert.equal(request.command, 'sh');
      assert.equal(request.args[0], '-c');
      return { code: 0, stdout: '' };
    },
  };
  assert.deepEqual(await readRemoteHostCards(channel), { hosts: [], skipped: [] });
});

test('a failed remote read becomes a typed error', async () => {
  const channel = { async exec() { return { code: 127, stdout: '', stderr: 'sh: not found' }; } };
  await assert.rejects(readRemoteHostCards(channel), (error) => error.code === 'REMOTE_HOST_DISCOVERY_FAILED');
});

test('the forwarded URL keeps the token and only moves host and port', () => {
  assert.equal(forwardedUrl('http://127.0.0.1:3080/?token=abc', 40_001), 'http://127.0.0.1:40001/?token=abc');
  assert.equal(forwardedUrl('http://127.0.0.1:3080/app/?token=abc', 40_001), 'http://127.0.0.1:40001/app/?token=abc');
  assert.throws(() => forwardedUrl('http://127.0.0.1:3080/', 0), (error) => error.code === 'TUNNEL_FAILED');
});

test('sync plans missing plugins and upgrades, never downgrades or pushes local paths', async () => {
  const { planDiscoveredSync } = await import('../../../packages/manager/src/host/remote-hosts.js');
  const plan = planDiscoveredSync({
    localBundles: [
      { name: 'dsh-missing', version: '1.0.0' },
      { name: 'dsh-older', version: '2.0.0' },
      { name: 'dsh-newer', version: '1.0.0' },
      { name: 'dsh-same', version: '3.0.0' },
      { name: 'dsh-linked', version: '1.0.0' },
      { name: 'dsh-workspace-shell', version: '0.5.44' },
      { name: '@local/thing', version: '1.0.0' },
      { name: 'dsh-disabled', version: '1.0.0', enabled: false },
    ],
    remoteDependencies: {
      'dsh-older': '1.0.0',
      'dsh-newer': '9.0.0',
      'dsh-same': '3.0.0',
      'dsh-linked': 'link:/Users/me/plugin',
      'dsh-disabled': '0.1.0',
    },
  });
  assert.deepEqual(plan.install.map((item) => [item.name, item.reason]), [
    ['dsh-missing', 'missing'],
    ['dsh-older', 'upgrade'],
  ]);
  assert.deepEqual(plan.skipped.map((item) => [item.name, item.reason]), [
    ['dsh-newer', 'remote-newer'],
    ['dsh-linked', 'local-spec'],
  ]);
});
