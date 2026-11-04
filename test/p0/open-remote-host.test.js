import assert from 'node:assert/strict';
import test from 'node:test';
import { statusPluginPatch } from '../../packages/manager/src/host/open-remote-host.js';

test('remote status patch carries no local access token', () => {
  const patch = statusPluginPatch({
    runtimeRoot: '/home/test/.dsh/ssh-remote/servers/runtime-1',
    hostAlias: 'p0-linux',
    localReturnUrl: 'http://127.0.0.1:54542/?tkn=local-secret',
    dshVersion: '0.2.1-rc.5',
  });
  assert.equal(patch.includes('local-secret'), false);
  assert.equal(patch.includes('/plugins/status'), true);
  assert.equal(patch.includes('/plugins/guest-cwd'), true);
  assert.equal(patch.includes('workspace-shell-guest-cwd'), true);
  assert.equal(patch.includes('p0-linux'), true);
});

test('remote status patch rejects a non-loopback return address', () => {
  assert.throws(() => statusPluginPatch({
    runtimeRoot: '/opt/dsh', hostAlias: 'p0-linux', localReturnUrl: 'https://example.com', dshVersion: '0.2.1-rc.5',
  }));
});
