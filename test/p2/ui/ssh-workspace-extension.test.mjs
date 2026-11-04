import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { React, mount, flushEffects, deferred, click } from './react-harness.mjs';
import { createSshLauncher } from '../../../packages/shell/ssh-remote/src/client/ssh-launcher.js';
import { createSshWorkspaceExtension, createSshRequest, createSshComponentPlugin } from '../../../packages/shell/ssh-remote/src/client/workspace-extension.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
test('the single package ships the SSH component as part of its own bundle', async () => {
  const read = (name) => readFile(new URL('../../../packages/' + name, import.meta.url), 'utf8');
  const shell = JSON.parse(await read('shell/package.json'));
  const patch = await read('shell/cordis.patch.yml');
  assert.deepEqual(shell.dependencies, { ssh2: '^1.17.0' }, 'the SSH transport is the only runtime dependency');
  assert.ok(shell.files.includes('ssh-remote/src/**/*.js'));
  assert.deepEqual([...patch.matchAll(/id: ([\w-]+)/g)].map((match) => match[1]), ['workspace-shell']);
  assert.doesNotMatch(patch, /group:|disabled:/);
  const client = await read('shell/client.js');
  assert.match(client, /get\('workspaceShell', false\)/u, 'the composed apply reads the service by value while its own fiber loads');
});

function fixture(t, handler = () => ({ ok: true, connections: [] })) {
  const calls = [], sources = [], inputs = [{ value: '' }];
  class EventSource {
    listeners = new Map();
    constructor() { sources.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
    close() { this.closed = true; }
  }
  const document = { documentElement: { lang: 'en' } };
  const window = { EventSource, location: { search: '' }, fetch: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url, options, body });
    const result = await handler(url.replace('/api/ssh-remote', ''), body, options);
    return Response.json(result);
  } };
  const deps = { window, document, createSshLauncher };
  const extension = createSshWorkspaceExtension(React, deps);
  t.after(() => extension.dispose());
  return { extension, deps, calls, sources, inputs, desktop: { createNodeMock: (node) => node.type === 'form' ? { querySelectorAll: () => inputs } : {} } };
}

test('component only registers with the workspace shell and has no old navigation slots', async (t) => {
  const f = fixture(t);
  let extension, cleanup, removed = 0;
  const plugin = createSshComponentPlugin(React, f.deps);
  assert.deepEqual(plugin.inject, ['workspaceShell']);
  plugin.apply({ workspaceShell: { registerSshExtension(value) { extension = value; return () => { removed++; }; } }, effect(fn) { cleanup = fn(); } });
  await flush();
  assert.equal(typeof extension.SshLauncher, 'function');
  assert.equal(f.sources.length, 1);
  await cleanup();
  assert.equal(removed, 1);
  assert.equal(f.sources[0].closed, true);
});
for (const location of [{ search: '?workspaceShellEmbedded=1' }, { search: '', hash: '#workspaceShellEmbedded=1' }]) {
  test('embedded Guests activate without waiting for a missing shell: ' + JSON.stringify(location), async (t) => {
    const f = fixture(t); f.deps.window.location = location;
    const plugin = createSshComponentPlugin(React, f.deps);
    assert.deepEqual(plugin.inject, []);
    plugin.apply({ effect() { assert.fail('must not mount'); } });
  });
}
test('component status events update sanitized snapshots and dispose drops late responses', async (t) => {
  let connected = true;
  const f = fixture(t, () => ({ ok: true, connections: [{ id: 'c1', name: 'host', connected, token: 'SECRET', url: 'SECRET' }] }));
  f.extension.start(); await flush();
  assert.deepEqual(f.extension.getSnapshot().connections, [{ id: 'c1', name: 'host', connected: true }]);
  connected = false;
  f.sources[0].emit('connection', {}); await flush();
  assert.equal(f.extension.getSnapshot().connections[0].connected, false);
  f.extension.dispose();
  assert.equal(f.sources[0].closed, true);
  assert.deepEqual(f.extension.getSnapshot().connections, []);
  await assert.rejects(f.extension.request('/status'), { code: 'OPERATION_CANCELLED' });
});
test('newer foreground status wins over an older background read', async (t) => {
  const pending = deferred(); let count = 0;
  const f = fixture(t, () => ++count === 1 ? pending.promise : { connections: [{ id: 'new', name: 'New' }] });
  f.extension.start();
  await f.extension.request('/status');
  pending.resolve({ connections: [{ id: 'old', name: 'Old' }] }); await flush();
  assert.equal(f.extension.getSnapshot().connections[0].id, 'new');
});
test('request surface rejects arbitrary paths, sanitizes errors and propagates cancellation', async () => {
  const lifetime = new AbortController(); let calls = 0;
  const request = createSshRequest(async () => { calls++; return Response.json({ ok: false, error: { code: 'BAD', message: 'SECRET' } }); }, lifetime.signal);
  await assert.rejects(request('https://example.com'), { code: 'WORKSPACE_INVALID_REQUEST' });
  assert.equal(calls, 0);
  await assert.rejects(request('/status'), (cause) => cause.code === 'BAD' && !cause.message.includes('SECRET'));
  lifetime.abort();
  await assert.rejects(request('/status'), { code: 'OPERATION_CANCELLED' });
  assert.equal(calls, 1);
});
test('upgrade requires explicit confirmation before retrying with allowUpgrade', async (t) => {
  const f = fixture(t, (path, body) => path === '/connect' && !body.allowUpgrade
    ? { ok: false, error: { code: 'UPGRADE_CONFIRMATION_REQUIRED', details: { remoteVersion: '1', localVersion: '2' } } }
    : { ok: true, connections: [] });
  const modal = [];
  const view = await mount(t, f.extension.Overlay, { onModalChange: (value) => modal.push(value) }, f.desktop);
  let task;
  await flushEffects(() => { task = f.extension.request('/connect', { body: { hostId: 'c1' } }); });
  assert.equal(f.calls.filter((call) => call.url.endsWith('/connect')).length, 1);
  assert.equal(f.extension.getSnapshot().prompts[0].kind, 'upgrade');
  await flushEffects(() => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await task;
  assert.equal(f.calls.filter((call) => call.url.endsWith('/connect'))[1].body.allowUpgrade, true);
  await view.unmount(); assert.equal(modal.at(-1), false);
});
test('cancelling or unloading an upgrade never grants upgrade permission', async (t) => {
  const f = fixture(t, () => ({ ok: false, error: { code: 'UPGRADE_CONFIRMATION_REQUIRED' } }));
  const task = f.extension.request('/connect', { body: { hostId: 'c1' } });
  const result = assert.rejects(task, { code: 'OPERATION_CANCELLED' });
  await flush(); f.extension.dispose(); await result;
  assert.equal(f.calls.length, 1);
});
test('partial synchronization and backup review remain available until dismissed', async (t) => {
  const f = fixture(t, () => ({ ok: true, sync: { ok: false, requiresMerge: true, backup: { path: '/remote/backup' } } }));
  const view = await mount(t, f.extension.Overlay, {}, f.desktop);
  let task;
  await flushEffects(() => { task = f.extension.request('/connect', { body: { hostId: 'c1' } }); });
  const prompt = f.extension.getSnapshot().prompts[0];
  assert.equal(prompt.kind, 'review'); assert.equal(prompt.partial, true); assert.equal(prompt.path, '/remote/backup');
  await click(view.root.findAll((node) => node.type === 'button' && node.props.children === 'Close')[0]);
  await task;
  assert.equal(f.extension.getSnapshot().prompts.length, 0);
});
for (const kind of ['password', 'passphrase', 'keyboardInteractive', 'host-key']) {
  test(`${kind} prompt sends the Host contract and clears transient secrets`, async (t) => {
    const f = fixture(t);
    f.extension.start(); await flush();
    const view = await mount(t, f.extension.Overlay, {}, f.desktop);
    await flushEffects(() => f.sources[0].emit('interaction', { requestId: 'r1', hostId: 'c1', kind, fingerprint: 'SHA256:test', prompts: [{ prompt: 'Secret', echo: false }], value: 'NEVER_KEEP' }));
    f.inputs[0].value = 'PASSWORD';
    assert.doesNotMatch(JSON.stringify(f.extension.getSnapshot()), /PASSWORD|NEVER_KEEP/);
    await flushEffects(() => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    const call = f.calls.find((item) => item.url.endsWith('/interaction'));
    assert.deepEqual(call.body, { requestId: 'r1', ...(kind === 'host-key' ? { trusted: true } : kind === 'keyboardInteractive' ? { responses: ['PASSWORD'] } : { value: 'PASSWORD' }) });
    assert.equal(f.inputs[0].value, '');
    assert.equal(f.extension.getSnapshot().prompts.length, 0);
  });
}
test('interaction-ended only removes the matching prompt and unmount clears input', async (t) => {
  const f = fixture(t); f.extension.start(); await flush();
  const view = await mount(t, f.extension.Overlay, {}, f.desktop);
  await flushEffects(() => f.sources[0].emit('interaction', { requestId: 'r1', kind: 'password' }));
  await flushEffects(() => f.sources[0].emit('interaction-ended', { requestId: 'other' }));
  assert.equal(f.extension.getSnapshot().prompts.length, 1);
  f.inputs[0].value = 'SECRET';
  await view.unmount(); assert.equal(f.inputs[0].value, '');
  f.sources[0].emit('interaction-ended', { requestId: 'r1' });
  assert.equal(f.extension.getSnapshot().prompts.length, 0);
});
