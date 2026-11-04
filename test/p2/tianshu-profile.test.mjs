import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../../packages/tianshu-profile/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
test('Tianshu profile bundle is configuration-only and version gated', () => {
  assert.equal(manifest.engines.dsh, '0.2.1-rc.5');
  assert.equal(manifest.peerDependencies['@huiliyi37/dsh-tianshu-tui'], '1.0.0-rc.4');
  assert.equal(manifest.dsh.runtime, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
});
test('preferences and input history derive from the selected profile', () => {
  const expressions = [...patch.matchAll(/!!js "([^"]+)"/g)].map(m => new Function('ctx', 'return (' + m[1] + ')'));
  assert.equal(expressions.length, 2);
  for (const cwd of ['/tmp/profiles/alpha', '/tmp/profiles/beta with spaces']) {
    assert.deepEqual(expressions.map(fn => fn({profileContext:{cwd}})), [cwd + '/tianshu-prefs.json', cwd + '/tianshu-input-history.json']);
  }
  assert.ok(patch.includes("inject: ['profileContext']"));
  assert.match(patch, /autoRestartOnUpdate: false/);
  assert.doesNotMatch(patch, /process.env|HOME|credentials/);
});
test('bundle includes readable display metadata and an original SVG icon', async () => {
  for (const locale of ['en', 'zh']) {
    const data = JSON.parse(await readFile(new URL('locale/' + locale + '.json', root), 'utf8'));
    assert.ok(data.meta.title && data.meta.description);
  }
  assert.equal(manifest.exports['./icon'], './icon.svg');
  const icon = await readFile(new URL('icon.svg', root), 'utf8');
  assert.match(icon, /^<svg /);
  assert.ok(Buffer.byteLength(icon) < 262144);
});
