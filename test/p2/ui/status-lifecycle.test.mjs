import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { React, mount, click, buttonByName, flushEffects, deferred } from './react-harness.mjs';

// Actual React reconciliation/effects. Browser focus, timers and HTTP are explicit
// controlled boundaries; these assertions do not establish native paint or layout.
const source = await readFile(new URL('../../../packages/status/client.js', import.meta.url), 'utf8');
const plugin = { name: '@local/theme', version: '2.0.0', title: 'Theme', enabled: true, installed: true };
const config = { hostAlias: 'isolated-test', dshVersion: '1.0.0' };
function childText(value) {
  if (Array.isArray(value)) return value.map(childText).join('');
  if (value == null || typeof value === 'boolean') return '';
  return typeof value === 'object' ? childText(value.props?.children) : String(value);
}
function fixture(fetchImpl) {
  let definition;
  const calls = [];
  const timers = new Map();
  const document = { hidden: false, activeElement: null };
  const focus = [];
  const trigger = { isConnected: true, focus() { document.activeElement = this; focus.push('trigger'); } };
  document.activeElement = trigger;
  const boundary = {
    document, focus, disabled: () => false,
    createNodeMock(node) {
      const name = node.type === 'button' ? childText(node.props.children) : node.type;
      return {
        isConnected: true, open: false, ownerDocument: document,
        showModal() { assert.equal(this.open, false); this.open = true; },
        close() { this.open = false; },
        focus() {
          if (node.type === 'button' && boundary.disabled(name)) return;
          document.activeElement = this; focus.push(name);
        },
      };
    },
  };
  const window = { location: { href: 'http://localhost/', assign() { throw new Error('Unexpected navigation'); } },
    __ModuleLoader__: { load(value) { definition = value; } } };
  const context = vm.createContext({
    window, document, URL, console,
    crypto: { randomUUID: () => 'test-request' },
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body });
      assert.equal(typeof fetchImpl, 'function', `Unexpected request: ${url}`);
      return fetchImpl(url, body);
    },
    setInterval(callback) { const id = Symbol('timer'); timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context, { filename: 'packages/status/client.js' });
  const client = definition.factory((id) => { assert.equal(id, 'react'); return React; });
  const helpers = client.__test;
  return { client, helpers, t: (key) => helpers.messages.en[key], boundary, calls, timers };
}

test('local-snapshot Enable targets the installed remote record without installing or disabling it', async (t) => {
  let enabled = false;
  const rt = fixture(async (url, body) => {
    if (url.endsWith('/plugins/page')) return Response.json({ ok: true, local: { bundles: [plugin] }, remote: [{ ...plugin, enabled }] });
    if (url.endsWith('/plugins/set-enabled')) enabled = body.enabled;
    return Response.json({ ok: true, result: { application: 'applied' } });
  });
  const view = await mount(t, rt.helpers.PluginManagerPage, { t: rt.t, config, embedded: true }, rt.boundary);
  await click(view.root.find((node) => node.type === 'button' && node.props.id === 'ssh-rs-tab-local'));
  await click(buttonByName(view.root, 'Enable: Theme'));
  assert.deepEqual(rt.calls.filter((call) => !call.url.endsWith('/plugins/page')), [
    { url: '/api/ssh-remote/plugins/set-enabled', body: { name: '@local/theme', enabled: true } },
  ]);
  assert.equal(enabled, true);
  await view.unmount();
  assert.equal(rt.timers.size, 0);
});

test('pending-build dialog focuses Cancel after its refresh makes the challenge actionable', async (t) => {
  let pages = 0;
  const refresh = deferred();
  const rt = fixture(async (url) => {
    if (url.endsWith('/plugins/page')) {
      pages += 1;
      if (pages > 1) return refresh.promise;
      return Response.json({ ok: true, local: { bundles: [plugin] }, remote: [] });
    }
    if (url.endsWith('/plugins/install')) return Response.json({ ok: true, result: { pendingBuilds: ['native-package'] } });
    throw new Error(`Unexpected request: ${url}`);
  });
  const view = await mount(t, rt.helpers.PluginManagerPage, { t: rt.t, config, embedded: true }, rt.boundary);
  rt.boundary.disabled = (name) => name === 'Cancel' && buttonByName(view.root, 'Cancel').props.disabled;
  await click(view.root.find((node) => node.type === 'button' && node.props.id === 'ssh-rs-tab-local'));
  await click(buttonByName(view.root, 'Install on remote: Theme'));
  assert.equal(view.root.findByType('dialog').props['aria-busy'], true);
  assert.equal(buttonByName(view.root, 'Cancel').props.disabled, true);
  assert.equal(rt.boundary.focus.includes('Cancel'), false);
  await flushEffects(() => refresh.resolve(Response.json({ ok: true, local: { bundles: [plugin] }, remote: [] })));
  assert.equal(buttonByName(view.root, 'Cancel').props.disabled, false);
  assert.equal(rt.boundary.focus.filter((name) => name === 'Cancel').length, 1);
  await click(buttonByName(view.root, 'Cancel'));
  assert.equal(view.root.findAllByType('dialog').length, 0);
  assert.equal(rt.calls.filter((call) => call.url.endsWith('/plugins/install')).length, 1, 'Cancelling never approves a build');
});

test('replacement build challenges focus Cancel once without reopening the native dialog', async (t) => {
  const rt = fixture();
  let busy = true;
  rt.boundary.disabled = () => busy;
  const dialog = { kind: 'builds', plugin, builds: ['first-package'] };
  const props = { t: rt.t, dialog, busy, onCancel() {}, onConfirm() {} };
  const view = await mount(t, rt.helpers.ConfirmationDialog, props, rt.boundary);
  busy = false;
  await view.update({ ...props, busy });
  assert.equal(rt.boundary.focus.filter((name) => name === 'Cancel').length, 1);
  await view.update({ ...props, busy, dialog: { ...dialog } });
  assert.equal(rt.boundary.focus.filter((name) => name === 'Cancel').length, 1);
  await view.update({ ...props, busy, dialog: { ...dialog, builds: ['second-package'] } });
  assert.equal(rt.boundary.focus.filter((name) => name === 'Cancel').length, 2);
  await view.unmount();
  assert.equal(rt.boundary.focus.at(-1), 'trigger');
});
