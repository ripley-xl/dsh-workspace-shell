import assert from 'node:assert/strict';
import test from 'node:test';

import { RemoteControllerClient } from '../../../packages/shell/ssh-remote/src/host/remote-controller.js';
import {
  defaultProfiles,
  instanceProfileId,
  normalizeProfileId,
  normalizeProfiles,
  publicProfileInstance,
} from '../../../packages/shell/ssh-remote/src/host/profiles.js';

function controllerRecording() {
  const requests = [];
  const channel = {
    async execJson(value) {
      requests.push(value);
      return { protocolVersion: value.protocolVersion, requestId: value.requestId, ok: true, result: { instances: [] } };
    },
  };
  return {
    requests,
    client: new RemoteControllerClient({
      channel,
      executable: '/opt/dsh/bin/dsh-ssh-remote-controller',
      root: '/home/test/.dsh/ssh-remote',
    }),
  };
}

test('controller client sends --profile for list, start and attach', async () => {
  const { client, requests } = controllerRecording();
  await client.list({ version: '1.0.0', buildId: 'build-1', profileId: 'work' });
  assert.deepEqual(requests[1].args.slice(0, 7), [
    'list', '--expected-version', '1.0.0', '--expected-build-id', 'build-1', '--profile', 'work',
  ]);
  await client.start({ version: '1.0.0', buildId: 'build-1', workspace: '/home/test', profileId: 'work' });
  const start = requests[2].args;
  assert.equal(start[0], 'start');
  assert.equal(start.includes('--profile'), true);
  assert.equal(start[start.indexOf('--profile') + 1], 'work');
  await client.attach({ instanceId: 'instance-1', version: '1.0.0', buildId: 'build-1', profileId: 'work' });
  const attach = requests[3].args;
  assert.equal(attach[attach.indexOf('--profile') + 1], 'work');
  assert.equal(attach[attach.indexOf('--instance-id') + 1], 'instance-1');
});

test('controller client defaults the started profile to web and rejects unsafe ids', async () => {
  const { client, requests } = controllerRecording();
  await client.start({ version: '1.0.0', buildId: 'build-1', workspace: '/home/test' });
  const args = requests[1].args;
  assert.equal(args[args.indexOf('--profile') + 1], 'web');
  await client.list();
  assert.equal(requests[2].args.includes('--profile'), false);
  await assert.rejects(client.attach({ instanceId: 'i', version: '1.0.0', profileId: '../escape' }), (error) => error.code === 'INVALID_PROFILE_ID');
  assert.equal(requests.length, 3);
});

test('legacy controllers keep the original default-web arguments and reject other profiles', async () => {
  const requests = [];
  const client = new RemoteControllerClient({
    channel: {
      async execJson(value) {
        requests.push(value);
        const base = { protocolVersion: value.protocolVersion, requestId: value.requestId };
        if (value.args[0] === 'profiles') return { ...base, ok: false, error: { code: 'REMOTE_OPERATION_FAILED', message: 'unknown command' } };
        return { ...base, ok: true, result: { instances: [] } };
      },
    },
    executable: '/opt/dsh/bin/dsh-ssh-remote-controller',
    root: '/home/test/.dsh/ssh-remote',
  });
  await client.list({ profileId: 'web' });
  await client.attach({ instanceId: 'i1', profileId: 'web' });
  await client.start({ version: '1.0.0', buildId: 'build-1', workspace: '/home/test', profileId: 'web' });
  assert.equal(requests.filter((request) => request.args.includes('--profile')).length, 0);
  await assert.rejects(client.list({ profileId: 'work' }), (error) => error.code === 'REMOTE_PROFILE_UNSUPPORTED');
});

test('controller client exposes profiles() through the controller command', async () => {
  const requests = [];
  const client = new RemoteControllerClient({
    channel: {
      async execJson(value) {
        requests.push(value);
        return { protocolVersion: 1, requestId: value.requestId, ok: true, result: { profiles: ['web', 'work'] } };
      },
    },
    executable: '/opt/dsh/bin/dsh-ssh-remote-controller',
    root: '/home/test/.dsh/ssh-remote',
  });
  const result = await client.profiles({ dshHome: '/home/test' });
  assert.deepEqual(result, { profiles: ['web', 'work'] });
  assert.equal(requests[0].args[0], 'profiles');
  assert.deepEqual(requests[0].args.slice(1, 3), ['--dsh-home', '/home/test']);
  await client.profiles();
  assert.equal(requests[1].args.includes('--dsh-home'), false);
});

test('profile helpers normalize identifiers, lists and instance projection', () => {
  assert.equal(normalizeProfileId(undefined), 'web');
  assert.equal(normalizeProfileId('work-2'), 'work-2');
  assert.throws(() => normalizeProfileId(''), (error) => error.code === 'INVALID_PROFILE_ID');
  assert.throws(() => normalizeProfileId('a/b'), (error) => error.code === 'INVALID_PROFILE_ID');
  assert.throws(() => normalizeProfileId('..'), (error) => error.code === 'INVALID_PROFILE_ID');
  assert.deepEqual(defaultProfiles(), [{ id: 'web', web: true }]);

  assert.deepEqual(normalizeProfiles(null), defaultProfiles());
  assert.deepEqual(normalizeProfiles({ profiles: [] }), []);
  assert.deepEqual(normalizeProfiles({ profiles: [{ id: 'b' }, { id: 'a', web: true }, { id: 'a' }, { id: 'bad/id' }, null] }), [
    { id: 'a', web: true },
    { id: 'b', web: true },
  ]);
  assert.deepEqual(normalizeProfiles([{ id: 'tui', web: false }]), [{ id: 'tui', web: false }]);
  // The controller's current wire shape is a plain id list.
  assert.deepEqual(normalizeProfiles({ profiles: ['work', 'web'] }), [
    { id: 'web', web: true },
    { id: 'work', web: true },
  ]);

  assert.equal(instanceProfileId({}), 'web');
  assert.equal(instanceProfileId({ profileId: 'work' }), 'work');
  const projected = publicProfileInstance({
    instance: {
      instanceId: 'instance-1',
      profileId: 'work',
      state: 'running',
      dshVersion: '1.0.0',
      buildId: 'build-1',
      endpoint: { host: '127.0.0.1', port: 41000 },
      workspace: '/home/test',
      authenticatedUrl: 'http://127.0.0.1:41000/?tkn=secret',
    },
    health: { healthy: true, hostAlive: true, supervisorAlive: true, reachable: true },
  });
  assert.deepEqual(projected, {
    profileId: 'work',
    instanceId: 'instance-1',
    state: 'running',
    health: { known: true, healthy: true, hostAlive: true, supervisorAlive: true, reachable: true },
    dshVersion: '1.0.0',
    buildId: 'build-1',
    startedAt: null,
    lastAttachAt: null,
  });
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(JSON.stringify(projected).includes('41000'), false);
});
