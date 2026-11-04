import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticationCallbacks, InteractionBroker, interactiveHostKeyVerifier } from '../../../packages/shell/ssh-remote/src/host/interactions.js';

test('interaction broker exposes only public prompts and returns secrets to the waiting callback', async () => {
  const broker = new InteractionBroker();
  const events = [];
  broker.on('interaction', (event) => events.push(event));
  const callbacks = authenticationCallbacks(broker, 'host-1');
  const pending = callbacks.password({ alias: 'test', prompts: [], signal: undefined });
  const request = events[0];
  assert.equal(request.hostId, 'host-1');
  assert.equal(request.kind, 'password');
  assert.equal(broker.answer(request.requestId, { value: 'secret-password' }), true);
  assert.equal(await pending, 'secret-password');
  assert.equal(JSON.stringify(events).includes('secret-password'), false);
  assert.equal(broker.pending.size, 0);
});

test('keyboard interaction preserves prompt echo flags without storing answers', async () => {
  const broker = new InteractionBroker();
  const callbacks = authenticationCallbacks(broker, 'host-1');
  let publicRequest;
  broker.on('interaction', (event) => { publicRequest = event; });
  const pending = callbacks.keyboardInteractive({ prompts: [{ prompt: 'OTP', echo: false }] });
  assert.equal(publicRequest.prompts[0].echo, false);
  broker.answer(publicRequest.requestId, { responses: ['123456'] });
  assert.deepEqual(await pending, ['123456']);
  assert.equal(broker.pending.size, 0);
});

test('host cancellation rejects pending interaction without retaining the answer', async () => {
  const broker = new InteractionBroker();
  const pending = broker.request('host-1', 'passphrase', { identityFile: '/private/key' });
  const publicRequest = broker.pending.values().next().value.public;
  assert.equal(JSON.stringify(publicRequest).includes('/private/key'), false);
  broker.cancelHost('host-1');
  await assert.rejects(pending, (error) => error.code === 'OPERATION_CANCELLED');
  assert.equal(broker.pending.size, 0);
});

test('unknown host key is appended only after explicit user trust', async () => {
  const broker = new InteractionBroker();
  const appends = [];
  const verifier = interactiveHostKeyVerifier(broker, 'host-1', {
    verify: async () => { throw Object.assign(new Error('unknown'), { code: 'SSH_HOST_KEY_UNKNOWN', details: { fingerprint: 'SHA256:test', host: '127.0.0.1' } }); },
    append: async (file, input) => { appends.push({ file, input }); },
  });
  const interaction = new Promise((resolve) => broker.once('interaction', resolve));
  const pending = verifier(Buffer.from('host-key'), {
    interactive: true, hostname: '127.0.0.1', port: 22, keyType: 'ssh-ed25519', userKnownHostsFiles: ['/tmp/known_hosts'],
  });
  const request = await interaction;
  broker.answer(request.requestId, { trusted: true });
  assert.equal((await pending).status, 'accepted-new');
  assert.equal(appends.length, 1);
});

test('changed host key never enters the trust interaction', async () => {
  const broker = new InteractionBroker();
  const verifier = interactiveHostKeyVerifier(broker, 'host-1', {
    verify: async () => { throw Object.assign(new Error('changed'), { code: 'SSH_HOST_KEY_CHANGED' }); },
  });
  await assert.rejects(verifier(Buffer.from('host-key'), { interactive: true }), /changed/);
  assert.equal(broker.pending.size, 0);
});
