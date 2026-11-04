import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteClient, rewriteAuthenticatedUrl } from '../../packages/shell/ssh-remote/src/host/remote-client.js';

test('authenticated URL rewrite preserves path and token on a loopback gateway', () => {
  const value = rewriteAuthenticatedUrl(
    'http://127.0.0.1:41000/workspace?tkn=secret-value#fragment',
    'http://localhost:52000',
  );
  assert.equal(value, 'http://localhost:52000/workspace?tkn=secret-value#fragment');
});

test('authenticated URL rewrite rejects non-loopback endpoints', () => {
  assert.throws(() => rewriteAuthenticatedUrl('https://example.com/?tkn=secret', 'http://localhost:52000'));
  assert.throws(() => rewriteAuthenticatedUrl('http://127.0.0.1:41000/?tkn=secret', 'http://0.0.0.0:52000'));
});

test('remote client authenticates once and sends API requests without the token in the URL', async () => {
  const calls = [];
  const client = new RemoteClient({
    authenticatedUrl: 'http://127.0.0.1:41000/?tkn=secret-value',
    gatewayOrigin: 'http://localhost:52000',
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return Response.json({}, {
          status: 302,
          headers: { 'set-cookie': 'browser-credential=secret-cookie; Path=/; HttpOnly; SameSite=Strict' },
        });
      }
      assert.equal(options.headers.cookie, 'browser-credential=secret-cookie');
      return Response.json({ ok: true, credential: { configured: true } });
    },
  });

  const result = await client.post('/api/ssh-remote/credentials/set', { ref: 'TEST_KEY', value: 'secret-api-key' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://localhost:52000/?tkn=secret-value');
  assert.equal(calls[1].url, 'http://localhost:52000/api/ssh-remote/credentials/set');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ref: 'TEST_KEY', value: 'secret-api-key' });
  client.close();
  assert.equal(client.browserUrl, null);
});

test('remote client stops reading an oversized JSON response', async () => {
  const client = new RemoteClient({
    authenticatedUrl: 'http://127.0.0.1:41000/?tkn=secret-value',
    gatewayOrigin: 'http://localhost:52000',
    async fetchImpl(_url, options) {
      if (options.method === undefined) {
        return new Response(null, { status: 302, headers: { 'set-cookie': 'browser-credential=secret-cookie; Path=/' } });
      }
      return Response.json({ value: 'x'.repeat(1024) });
    },
  });
  await assert.rejects(client.request('/api/ssh-remote/status', { method: 'POST', body: {}, maxBytes: 32 }), /too large/);
  client.close();
});
