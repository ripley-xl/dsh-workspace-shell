import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const connectionUrl = new URL('../../../packages/shell/ssh-remote/src/host/ssh/connection.js', import.meta.url).href;
const helpersUrl = new URL('./helpers.mjs', import.meta.url).href;

for (const mode of ['fresh', 'stale-esm', 'stale-barrel']) {
  test(`default ssh2 client constructs with ${mode} exports`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const require = createRequire(${JSON.stringify(connectionUrl)});
      const ssh2 = require('ssh2');
      const Client = ssh2.Client;
      const filename = require.resolve('ssh2');
      if (${JSON.stringify(mode)} === 'stale-esm') {
        // A hot reload can replace CJS exports without replacing an existing ESM namespace.
        ssh2.Client = () => {};
        const stale = await import(pathToFileURL(filename).href);
        assert.equal(stale.Client, ssh2.Client);
        require.cache[filename].exports = { ...ssh2, Client };
        assert.notEqual(stale.Client, require('ssh2').Client);
      }
      if (${JSON.stringify(mode)} === 'stale-barrel') {
        require.cache[filename].exports = { ...ssh2, Client: {} };
        assert.equal(typeof require('ssh2').Client, 'object');
        assert.equal(typeof require('ssh2/lib/client.js'), 'function');
      }
      let constructed = false;
      Client.prototype.connect = function () {
        constructed = true;
        queueMicrotask(() => this.emit('error', Object.assign(new Error('test transport closed'), { code: 'ECONNRESET' })));
        return this;
      };
      const { connectResolvedSsh } = await import(${JSON.stringify(connectionUrl)});
      const { baseConfig } = await import(${JSON.stringify(helpersUrl)});
      await assert.rejects(connectResolvedSsh(baseConfig()), { code: 'SSH_CONNECTION_FAILED' });
      assert.equal(constructed, true);
    `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
