import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSshGOutput } from '../../../packages/manager/src/host/ssh/config.js';
import { serviceFixture } from '../../p1/service/helpers.mjs';

const expected = {
  hostName: 'builder.example.test',
  port: 2222,
  user: 'remote-user',
  identityFiles: ['/home/local/.ssh/builder', '/home/local/.ssh/backup'],
};
const fields = (connection) => Object.fromEntries(Object.keys(expected).map((key) => [key, connection[key]]));

async function fixture(t) {
  const result = await serviceFixture();
  t.after(result.close);
  const record = await result.store.upsert({ hostAlias: 'p0-test', syncPolicy: { appearance: false } });
  const open = result.service.openControllerSession;
  result.service.openControllerSession = async (input) => {
    const session = await open(input);
    session.channel.config = {
      ...parseSshGOutput(input.alias, [
        'hostname builder.example.test', 'port 2222', 'user remote-user',
        'identityfile ~/.ssh/builder', 'identityfile ~/.ssh/backup',
        'proxycommand /usr/bin/proxy --token PRIVATE-PROXY-TOKEN %h %p',
        'identityagent /private/agent.sock',
      ].join('\n'), { homeDir: '/home/local', proxySupport: true }),
      privateKey: 'PRIVATE-KEY-CONTENT',
      password: 'PRIVATE-PASSWORD',
    };
    return session;
  };
  return { ...result, record };
}

for (const mode of ['connect', 'webOpen', 'transport']) {
  test(`${mode} publishes resolved SSH settings without transport secrets`, async (t) => {
    const { service, record, store } = await fixture(t);
    if (mode === 'connect') await service.connect(record.id);
    else if (mode === 'webOpen') await service.webOpen(record.id, { profileId: 'work' });
    else await service.ensureTransport(service.session(record.id));

    const status = await service.status();
    assert.deepEqual(fields(status.connections[0]), expected);
    let event;
    service.once('connection', (connection) => { event = connection; });
    service.publish(record.id);
    assert.deepEqual(fields(event), expected);
    assert.doesNotMatch(JSON.stringify({ status, event }), /PRIVATE-|proxyCommand|identityAgent|privateKey|password|agent\.sock/);
    for (const key of Object.keys(expected)) assert.equal(Object.hasOwn(store.get(record.id), key), false);

    status.connections[0].identityFiles.push('/unexpected');
    assert.deepEqual(service.session(record.id).channel.config.identityFiles, expected.identityFiles);
  });
}

test('settings never reuse a closed channel or another SSH alias', async (t) => {
  const { service, record } = await fixture(t);
  await service.ensureTransport(service.session(record.id));
  const channel = service.session(record.id).channel;
  channel.closed = true;
  assert.deepEqual(fields(service.publicConnection(record.id)), { hostName: null, port: null, user: null, identityFiles: [] });
  channel.closed = false;
  channel.config.alias = 'different-host';
  assert.deepEqual(fields(service.publicConnection(record.id)), { hostName: null, port: null, user: null, identityFiles: [] });
  channel.config.alias = record.hostAlias;
  assert.deepEqual(fields(service.publicConnection(record.id)), expected);
  await service.disconnect(record.id);
  assert.deepEqual(fields(service.publicConnection(record.id)), { hostName: null, port: null, user: null, identityFiles: [] });
});
