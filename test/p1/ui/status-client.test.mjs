import assert from 'node:assert/strict';
import test from 'node:test';
import { loadClient, plain, registrationContext } from './helpers.mjs';

const client = await loadClient('../../../packages/status/client.js');
const { normalizeRemoteStatus, returnToLocal, fetchRemoteStatus, isLoopbackUrl, statusError } = client.__test;

test('remote status adapter shows host and version without retaining the local return URL', () => {
  const status = normalizeRemoteStatus({ ok: true, role: 'remote', hostAlias: 'linux-dev', dshVersion: '1.2.3', localReturnUrl: 'http://localhost/?tkn=secret' });
  assert.deepEqual(plain(status), { ok: true, role: 'remote', hostAlias: 'linux-dev', dshVersion: '1.2.3' });
  assert.equal(JSON.stringify(status).includes('localReturnUrl'), false);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  const fallback = normalizeRemoteStatus(null, { hostAlias: 'fallback', dshVersion: '1.0.0' });
  assert.equal(fallback.hostAlias, 'fallback');
  assert.equal(fallback.dshVersion, '1.0.0');
});

test('return to local performs a full-page assignment only to a loopback HTTP(S) address', () => {
  const config = { localReturnUrl: 'http://127.0.0.1:54542/' };
  const assigned = [];
  assert.equal(returnToLocal(config, (url) => assigned.push(url)), null);
  assert.deepEqual(assigned, [config.localReturnUrl]);
  assert.throws(() => returnToLocal({ localReturnUrl: 'https://example.com/?secret=1' }, () => {}), (error) => {
    assert.equal(error.code, 'INVALID_RETURN_URL');
    assert.equal(error.message.includes('example.com'), false);
    return true;
  });
  assert.throws(() => returnToLocal(config, () => { throw new Error('failed with secret URL'); }), (error) => {
    assert.equal(error.code, 'NAVIGATION_FAILED');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(isLoopbackUrl(config.localReturnUrl), true);
  assert.equal(isLoopbackUrl('https://localhost:54542/'), true);
  assert.equal(isLoopbackUrl('http://localhost.evil.test/'), false);
});

test('remote status request handles success and structured failures', async () => {
  let request;
  const value = await fetchRemoteStatus(async (url, options) => {
    request = { url, options };
    return Response.json({ ok: true, role: 'remote', hostAlias: 'linux', dshVersion: '1.0.0' });
  });
  assert.equal(request.url, '/api/ssh-remote/status');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(value.hostAlias, 'linux');
  await assert.rejects(fetchRemoteStatus(async () => Response.json({
    ok: false, error: { code: 'REMOTE_INSTANCE_UNAVAILABLE', message: 'instance unavailable', phase: 'attaching' },
  }, { status: 503 })), (error) => {
    assert.equal(error.code, 'REMOTE_INSTANCE_UNAVAILABLE');
    assert.equal(error.phase, 'attaching');
    assert.equal(error.message, 'instance unavailable');
    return true;
  });
  await assert.rejects(fetchRemoteStatus(async () => new Response('not json', { status: 200 })), (error) => error.code === 'INVALID_RESPONSE');
});

test('status error adapter keeps only safe structured fields', () => {
  const error = statusError({ error: { code: 'TUNNEL_FAILED', message: 'gateway unavailable', stage: 'forwarding', browserUrl: 'http://localhost/?tkn=secret' } });
  assert.equal(error.code, 'TUNNEL_FAILED');
  assert.equal(error.phase, 'forwarding');
  assert.equal(JSON.stringify(error).includes('browserUrl'), false);
});

test('remote status Client keeps its locale namespace and registers status plus plugin pages', () => {
  const { ctx, locales, slots } = registrationContext();
  client.apply(ctx, { hostAlias: 'linux', dshVersion: '1.0.0', localReturnUrl: 'http://localhost:54542/' });
  assert.deepEqual(locales.map((entry) => [entry[0], entry[1]]), [['ssh-remote-status', 'en'], ['ssh-remote-status', 'zh']]);
  assert.deepEqual(slots.map((entry) => entry.options.name), ['conversation.session.header.utilities', 'sidebar.panellist', 'main']);
  assert.equal(slots[0].options.id, 'ssh-remote-status');
  assert.equal(slots[1].options.id, 'ssh-remote-plugins');
  assert.equal(slots[2].options.key, 'ssh-remote-plugins');
});
