import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { React, mount, flushEffects, deferred, click } from './react-harness.mjs';
import { createSshLauncher } from '../../../packages/manager/src/client/ssh-launcher.js';
import { createSshWorkspaceExtension, createSshRequest, createSshComponentPlugin } from '../../../packages/manager/src/client/workspace-extension.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
test('workspace bundle includes SSH by default and SSH is not a separate bundle', async () => {
  const read = (name) => readFile(new URL('../../../packages/' + name, import.meta.url), 'utf8');
  const shell = JSON.parse(await read('shell/package.json'));
  const manager = JSON.parse(await read('manager/package.json'));
  const patch = await read('shell/cordis.patch.yml');
  assert.ok(shell.dependencies['@local/dsh-ssh-remote']);
  assert.deepEqual([...patch.matchAll(/id: ([\w-]+)/g)].map((match) => match[1]), ['workspace-shell', 'ssh-remote']);
  assert.match(patch, /group:\s*true/);
  assert.doesNotMatch(patch, /disabled:\s*true/);
  assert.equal(manager.dsh.bundle, undefined);
  assert.deepEqual(manager.dsh.client.inject, ['dsh-workspace-shell']);
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
  const source = await readFile(new URL('../../../packages/manager/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sidebar\.panellist|sidebar\.footer|ManagerPage|EnvironmentView|selectPanel/);
  let definition;
  vm.runInNewContext(source, { URLSearchParams, window: { __ModuleLoader__: { load(value) { definition = value; } } }, document: {} });
  assert.deepEqual(Array.from(definition.factory(() => React).inject), ['workspaceShell']);
});
for (const location of [{ search: '?workspaceShellEmbedded=1' }, { search: '', hash: '#workspaceShellEmbedded=1' }]) {
  test('embedded Guests activate without waiting for a missing shell: ' + JSON.stringify(location), async (t) => {
    const f = fixture(t); f.deps.window.location = location;
    const plugin = createSshComponentPlugin(React, f.deps);
    assert.deepEqual(plugin.inject, []);
    plugin.apply({ effect() { assert.fail('must not mount'); } });
    const source = await readFile(new URL('../../../packages/manager/client.js', import.meta.url), 'utf8');
    let definition;
    vm.runInNewContext(source, { URLSearchParams, window: { location, __ModuleLoader__: { load(value) { definition = value; } } }, document: {} });
    const built = definition.factory(() => React);
    assert.deepEqual(Array.from(built.inject), []);
    built.apply({ effect() { assert.fail('must not mount'); } });
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
test('a remote Host upgrade connects without an upgrade prompt', async (t) => {
  const f = fixture(t, () => ({ ok: true, connections: [] }));
  const modal = [];
  const view = await mount(t, f.extension.Overlay, { onModalChange: (value) => modal.push(value) }, f.desktop);
  const result = await f.extension.request('/connect', { body: { hostId: 'c1' } });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.filter((call) => call.url.endsWith('/connect')).map((call) => call.body), [{ hostId: 'c1' }]);
  assert.equal(f.extension.getSnapshot().prompts.length, 0);
  await view.unmount(); assert.equal(modal.at(-1), false);
});
test('a runtime mismatch is reported without a confirmation prompt', async (t) => {
  const f = fixture(t, () => ({
    ok: false,
    error: { code: 'REMOTE_VERSION_MISMATCH', details: { localVersion: '2.0.0' } },
  }));
  const view = await mount(t, f.extension.Overlay, {}, f.desktop);
  await assert.rejects(f.extension.request('/connect', { body: { hostId: 'c1' } }), (cause) => {
    assert.equal(cause.code, 'REMOTE_VERSION_MISMATCH');
    assert.equal(cause.message.includes('SECRET'), false);
    return true;
  });
  assert.equal(f.calls.filter((call) => call.url.endsWith('/connect')).length, 1);
  assert.equal(f.extension.getSnapshot().prompts.length, 0);
  await view.unmount();
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
