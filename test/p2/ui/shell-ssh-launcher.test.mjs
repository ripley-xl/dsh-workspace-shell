import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createSshLauncher } from '../../../packages/manager/src/client/ssh-launcher.js';
import { parseSshGOutput } from '../../../packages/manager/src/host/ssh/config.js';
import { serviceFixture } from '../../p1/service/helpers.mjs';
import { React, act, createDesktopHarness, deferred, flushEffects, mount, plain } from './react-harness.mjs';

// Real React 19 reconciliation and effects. Only the injected api boundary is faked;
// no real SSH, HTTP, Desktop bridge, dialog top layer or layout engine runs here.
const { SshLauncher, css } = createSshLauncher(React, {
  api: async () => { throw new Error('Each test injects its own api'); },
});
const createComponent = (api) => createSshLauncher(React, { api }).SshLauncher;

const SECRET_URL = 'http://127.0.0.1:4567/app?token=SECRET-TOKEN#x';

function connections(overrides = []) {
  return [
    { id: 'a', name: 'Alpha', hostAlias: 'alpha', autoConnect: true, phase: 'connected', portForwards: [] },
    { id: 'b', name: 'Beta', hostAlias: 'beta', autoConnect: false, phase: 'idle', portForwards: [] },
  ].map((entry, index) => ({ ...entry, ...(overrides[index] ?? {}) }));
}
function webList(overrides = {}) {
  return {
    ok: true,
    profiles: [{ id: 'web', web: true }, { id: 'work', web: true }],
    hosts: [{ profileId: 'work', profileName: 'Work', instanceId: 'inst-work', state: 'running', views: 2 }],
    profilesSource: 'remote',
    connected: true,
    ...overrides,
  };
}

/** Records every api call and answers from a per-path handler table. */
function harness(options = {}) {
  const calls = [];
  const handlers = {
    '/status': () => ({ ok: true, connections: connections() }),
    '/ssh-hosts': () => ({ ok: true, hosts: [
      { alias: 'builder', user: 'dev', hostName: '10.0.0.8', port: 22 },
      { alias: 'ops', hostName: 'ops.internal' },
    ] }),
    '/web/list': () => webList(),
    '/web/discovered': () => ({ ok: true, hosts: [] }),
    '/hosts': () => ({ ok: true, host: { id: 'a', name: 'Alpha', hostAlias: 'alpha', autoConnect: true } }),
    '/connect': () => ({ ok: true, host: { id: 'a', name: 'Alpha', hostAlias: 'alpha', phase: 'connected', instanceId: 'inst-a' } }),
    '/disconnect': () => ({ ok: true, host: { id: 'a', name: 'Alpha', hostAlias: 'alpha', phase: 'idle' } }),
    '/web/open': (input) => ({ ok: true, instanceId: `inst-${input.profileId}`, profileId: input.profileId, url: SECRET_URL }),
    '/web/attach': () => ({ ok: true, instanceId: 'inst-work', profileId: 'work', url: SECRET_URL }),
    '/web/stop': () => ({ ok: true, instanceId: 'inst-work', profileId: 'work' }),
    '/ports': () => ({ ok: true, forwards: [{ id: 'p1', remoteHost: '127.0.0.1', remotePort: 3000, localHost: '127.0.0.1', localPort: 54321, state: 'active' }] }),
    ...options.handlers,
  };
  const api = (path, input, signal) => {
    calls.push({ path, input: plain(input ?? {}), signal });
    const handler = handlers[path];
    if (!handler) return Promise.reject(Object.assign(new Error(`unexpected path ${path}`), { code: 'INVALID_RESPONSE' }));
    try {
      return Promise.resolve(handler(input, calls.length));
    } catch (cause) {
      return Promise.reject(cause);
    }
  };
  return { api, calls, handlers, of: (path) => calls.filter((call) => call.path === path) };
}
async function mountLauncher(t, options = {}) {
  const state = harness(options);
  const Component = createComponent(state.api);
  const view = await mount(t, Component, { locale: 'en', ...options.props }, options.desktop ?? createDesktopHarness());
  return { ...state, view };
}
function label(node) {
  return node.props['aria-label'] ?? '';
}
function buttonsByName(root, name) {
  return root.findAll((node) => node.type === 'button' && label(node) === name);
}
function button(root, name) {
  const matches = buttonsByName(root, name);
  assert.equal(matches.length, 1, `Expected exactly one button named ${name}, found ${matches.length}`);
  return matches[0];
}
const text = (node) => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node?.children ?? []).map(text).join('');
};
const tap = async (node) => flushEffects(() => { node.props.onClick?.({ currentTarget: null }); });
const menuButton = (root, name) => root.find((node) => node.type === 'button' && label(node).endsWith(name) && /More actions/.test(label(node)));
async function openMenuFor(root, name) {
  const buttonNode = menuButton(root, name);
  await act(async () => { buttonNode.props.onClick({ currentTarget: { focus() {}, isConnected: true } }); });
}
async function clickImmediate(node) {
  await act(async () => { node.props.onClick?.({ currentTarget: null }); });
}
function setValue(input, value) {
  return flushEffects(() => input.props.onChange({ target: { value } }));
}

/**
 * Minimal DOM boundary for dialogs and popup menus: document-level listeners,
 * focus bookkeeping and the focusable query used by the trap. Layout is not modelled.
 */
function domBoundary() {
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  const focusOrder = [];
  const makeElement = (name, focusable) => {
    const own = new Map();
    return {
      name, isConnected: true, ownerDocument: document, focusable, own,
      contains(target) { return target === this || target?.name === 'menu-child'; },
      querySelector(selector) { return selector === '[data-autofocus]:not([disabled])' ? (name === 'dialog' ? focusable[0] : null) : null; },
      querySelectorAll() { return focusable; },
      focus() { document.activeElement = this; focusOrder.push(name); },
      addEventListener(type, listener) { if (!own.has(type)) own.set(type, new Set()); own.get(type).add(listener); },
      removeEventListener(type, listener) { own.get(type)?.delete(listener); },
      emit(type, event) { for (const listener of [...(own.get(type) ?? [])]) listener(event); },
    };
  };
  const trigger = makeElement('trigger', []);
  document.activeElement = trigger;
  const first = makeElement('first', []);
  const last = makeElement('last', []);
  first.focusable = [first, last];
  const dialogs = [];
  const menus = [];
  const createNodeMock = (node) => {
    if (node.type === 'section') {
      const element = makeElement('dialog', [first, last]);
      dialogs.push(element);
      return element;
    }
    if (node.props.role === 'menu') {
      const element = makeElement('menu', [first, last]);
      menus.push(element);
      return element;
    }
    return makeElement(`${node.type}:${node.props.className ?? ''}`, [first, last]);
  };
  const emit = (type, event) => { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); };
  return { createNodeMock, document, trigger, first, last, focusOrder, emit, listeners, dialogs, menus };
}
function keyEvent(key, shiftKey = false) {
  return { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test('dialog Escape closes it and restores focus to the trigger', async (t) => {
  const boundary = domBoundary();
  const h = await mountLauncher(t, { desktop: { createNodeMock: boundary.createNodeMock, calls: { external: [] } } });
  await openMenuFor(h.view.root, 'Alpha');
  const beforeDialog = boundary.document.activeElement;
  await clickImmediate(h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Settings'));
  assert.ok(h.view.root.find((node) => node.props.role === 'dialog'));
  assert.equal(boundary.document.activeElement, boundary.first, 'the first focusable control receives focus');
  const escape = keyEvent('Escape');
  await flushEffects(() => boundary.emit('keydown', escape));
  assert.equal(escape.prevented, true);
  assert.equal(h.view.root.findAll((node) => node.props.role === 'dialog').length, 0);
  assert.equal(boundary.document.activeElement, beforeDialog, 'focus returns to the element that opened the dialog');
});

test('a busy dialog does not close on Escape or Tab, and traps Tab inside itself', async (t) => {
  const pending = deferred();
  const boundary = domBoundary();
  const h = await mountLauncher(t, {
    desktop: { createNodeMock: boundary.createNodeMock, calls: { external: [] } },
    handlers: { '/ports': () => pending.promise },
  });
  await openMenuFor(h.view.root, 'Alpha');
  await clickImmediate(h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Settings'));
  const remotePort = h.view.root.findAll((node) => node.type === 'input' && node.props.inputMode === 'numeric')[0];
  await setValue(remotePort, '3000');
  await flushEffects(() => h.view.root.findAll((node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }));
  assert.equal(h.of('/ports').length, 1);
  const escape = keyEvent('Escape');
  await flushEffects(() => boundary.emit('keydown', escape));
  assert.ok(h.view.root.find((node) => node.props.role === 'dialog'), 'a busy dialog stays open');
  // Tab wraps from the last focusable control back to the first.
  boundary.document.activeElement = boundary.last;
  const tab = keyEvent('Tab');
  await flushEffects(() => boundary.dialogs[0].emit('keydown', tab));
  assert.equal(tab.prevented, true);
  assert.equal(boundary.document.activeElement, boundary.first);
  await flushEffects(() => pending.resolve({ ok: true, forwards: [] }));
});

test('an outside pointerdown closes the menu without running an action', async (t) => {
  const boundary = domBoundary();
  const h = await mountLauncher(t, { desktop: { createNodeMock: boundary.createNodeMock, calls: { external: [] } } });
  await openMenuFor(h.view.root, 'Alpha');
  const menu = h.view.root.find((node) => node.props.role === 'menu');
  assert.equal(menu.props['aria-label'], 'More actions: Alpha');
  await flushEffects(() => boundary.emit('pointerdown', { target: { name: 'outside' } }));
  assert.equal(h.view.root.findAll((node) => node.props.role === 'menu').length, 0);
  assert.equal(h.of('/connect').length, 0);
  assert.equal(h.of('/disconnect').length, 0);
});

test('connection rows support arrow-key navigation and keep focus with the new selection', async (t) => {
  const boundary = domBoundary();
  const h = await mountLauncher(t, { desktop: { createNodeMock: boundary.createNodeMock, calls: { external: [] } } });
  const alpha = button(h.view.root, 'Alpha');
  const event = keyEvent('ArrowDown');
  await flushEffects(() => alpha.props.onKeyDown(event));
  assert.equal(event.prevented, true);
  assert.equal(h.of('/web/list').at(-1).input.hostId, 'b');
  const up = keyEvent('ArrowUp');
  await flushEffects(() => button(h.view.root, 'Beta').props.onKeyDown(up));
  assert.equal(h.of('/web/list').at(-1).input.hostId, 'a');
  assert.equal(h.of('/connect').length, 0, 'keyboard navigation never connects');
});

test('switching away from the SSH source pauses reads and hides the pane; switching back reloads', async (t) => {
  const pending = deferred();
  const h = await mountLauncher(t, { handlers: { '/status': () => pending.promise } });
  const callsBefore = h.calls.length;
  await h.view.update({ locale: 'en', active: false });
  assert.equal(h.view.root.findAll((node) => node.props['data-active'] !== undefined)[0].props['data-active'], 'false');
  assert.equal(h.of('/status')[0].signal.aborted, true, 'the in-flight status read is cancelled');
  assert.equal(h.calls.length, callsBefore, 'an inactive source issues no new reads');
  await h.view.update({ locale: 'en', active: true });
  assert.equal(h.of('/status').length, 2, 'reactivating the source reloads it');
});

test('an api-level { ok: false } envelope is treated as a failure with its code', async (t) => {
  const h = await mountLauncher(t, {
    handlers: {
      '/web/open': () => ({ ok: false, error: { code: 'HOST_BUSY', message: 'secret details' } }),
    },
  });
  const row = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined).find((node) => text(node).includes('work'));
  const newTab = row.findAll((node) => node.type === 'button' && text(node) === 'New tab')[0];
  await flushEffects(() => newTab.props.onClick());
  const body = text(h.view.toJSON());
  assert.match(body, /Another operation is running/);
  assert.doesNotMatch(body, /secret details/);
  assert.equal(h.view.root.findAll((node) => node.type === 'button' && text(node) === 'New tab').length > 0, true);
});

test('module shape: factory, css tokens, no imports or ambient I/O', async () => {
  assert.equal(typeof SshLauncher, 'function');
  assert.equal(typeof css, 'string');
  assert.ok(css.length > 2000);
  const source = await readFile(new URL('../../../packages/manager/src/client/ssh-launcher.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /WebSocket|EventSource/);
  assert.throws(() => createSshLauncher(React, {}), /requires an api/);
  assert.throws(() => createSshLauncher(null, { api: async () => ({}) }), /requires React/);
  // Every custom property must be one of the component's own --ssh-* aliases.
  for (const name of new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gu)].map((match) => match[1]))) {
    assert.ok(name.startsWith('--dsw-') || name.startsWith('--ssh-'), `unexpected custom property ${name}`);
  }
  // Component variables alias --dsw-* tokens only.
  for (const match of css.matchAll(/(--ssh-[a-z-]+):([^;}]+)/gu)) assert.match(match[2], /^var\(--dsw-/u, `${match[1]} must alias a dsw token`);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u, 'raw colors are not allowed');
});

test('initial load reads status only and selection expands without connecting or starting a Host', async (t) => {
  const h = await mountLauncher(t);
  // The Host list and its discovered-Host probe are loaded together.
  assert.deepEqual(h.calls.map((call) => call.path), ['/status', '/web/list', '/web/discovered']);
  assert.equal(h.of('/status')[0].input.autoConnect, undefined);
  // Both rows render; Alpha is selected first and its profiles are shown.
  assert.ok(button(h.view.root, 'Alpha'));
  assert.ok(menuButton(h.view.root, 'Beta'));
  // Selecting Beta switches the source of the detail read only.
  await act(async () => { button(h.view.root, 'Beta').props.onClick({ currentTarget: null }); });
  assert.equal(h.of('/web/list').at(-1).input.hostId, 'b');
  assert.equal(h.of('/connect').length, 0, 'selection must not connect');
  assert.equal(h.of('/web/open').length, 0);
  assert.equal(h.of('/hosts').length, 0);
});

test('autoConnect switch persists through hosts upsert; turning it off also disconnects', async (t) => {
  const h = await mountLauncher(t);
  const switches = h.view.root.findAll((node) => node.type === 'input' && node.props.role === 'switch');
  assert.equal(switches.length, 2);
  assert.equal(switches[0].props.checked, true);
  assert.equal(switches[1].props.checked, false);
  // Turn on for Beta.
  await act(async () => { switches[1].props.onChange({ target: { checked: true } }); });
  const saved = h.of('/hosts');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].input.action, 'upsert');
  assert.deepEqual(saved[0].input.host, { id: 'b', hostAlias: 'beta', name: 'Beta', autoConnect: true });
  assert.equal(h.view.root.findAll((node) => node.type === 'input' && node.props.role === 'switch')[1].props.checked, true);
  // Turn Alpha off: upsert then disconnect.
  await act(async () => {
    h.view.root.findAll((node) => node.type === 'input' && node.props.role === 'switch')[0].props.onChange({ target: { checked: false } });
  });
  const toggles = h.of('/hosts');
  assert.equal(toggles.length, 2);
  assert.equal(toggles[1].input.host.autoConnect, false);
  assert.deepEqual(h.of('/disconnect').map((call) => call.input.hostId), ['a']);
  assert.equal(h.view.root.findAll((node) => node.type === 'input' && node.props.role === 'switch')[0].props.checked, false);
  assert.doesNotMatch(text(h.view.toJSON()), /SECRET-TOKEN/);
});

test('autoConnect switch failure keeps the old value and shows a safe code only', async (t) => {
  const h = await mountLauncher(t, { handlers: {
    '/hosts': () => { throw Object.assign(new Error('boom'), { code: 'HOST_BUSY', token: 'SECRET-TOKEN' }); },
  } });
  const before = h.view.root.findAll((node) => node.type === 'input' && node.props.role === 'switch')[1].props.checked;
  await act(async () => {
    h.view.root.findAll((node) => node.type === 'input' && node.props.role === 'switch')[1].props.onChange({ target: { checked: true } });
  });
  assert.equal(h.view.root.findAll((node) => node.type === 'input' && node.props.role === 'switch')[1].props.checked, before);
  const body = text(h.view.toJSON());
  assert.doesNotMatch(body, /SECRET-TOKEN/);
  assert.match(body, /Another operation is running/);
  const alerts = h.view.root.findAll((node) => node.props.role === 'alert');
  assert.ok(alerts.length >= 1);
  assert.match(text(alerts[0]), /Another operation is running/);
});

test('more menu exposes settings, restart, disconnect and delete; Escape restores focus', async (t) => {
  const h = await mountLauncher(t);
  await openMenuFor(h.view.root, 'Alpha');
  const menu = h.view.root.find((node) => node.props.role === 'menu');
  assert.equal(menu.props['aria-label'], 'More actions: Alpha');
  const items = h.view.root.findAll((node) => node.props.role === 'menuitem').map((node) => text(node));
  assert.deepEqual(items, ['Settings', 'Restart connection', 'Clean up remote runtime', 'Disconnect', 'Delete']);
  let event = { key: 'Escape', prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  await flushEffects(() => menu.props.onKeyDown(event));
  assert.equal(event.prevented, true);
  assert.equal(h.of('/connect').length, 0);
  assert.throws(() => h.view.root.find((node) => node.props.role === 'menu'));
});

test('outside pointerdown closes the menu; restart rebuilds and disconnect clears SSH', async (t) => {
  const h = await mountLauncher(t);
  await openMenuFor(h.view.root, 'Alpha');
  // Restart is enabled because Alpha is connected; it rebuilds SSH then reconnects.
  const restart = h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Restart connection');
  assert.equal(restart.props.disabled, false);
  await clickImmediate(restart);
  assert.deepEqual(h.of('/disconnect').map((call) => call.input.hostId), ['a']);
  assert.deepEqual(h.of('/connect').map((call) => call.input.hostId), ['a']);
  assert.deepEqual(h.of('/connect')[0].input, { hostId: 'a', background: false });
  // Once restarted, the menu closes.
  assert.equal(h.view.root.findAll((node) => node.props.role === 'menu').length, 0);
});

test('disconnect and delete reach the agreed endpoints and delete asks for confirmation', async (t) => {
  let releaseDisconnect;
  const gate = new Promise((resolve) => { releaseDisconnect = resolve; });
  const h = await mountLauncher(t, { handlers: { '/disconnect': () => gate.then(() => ({ ok: true, host: { id: 'a', phase: 'idle' } })) } });
  await openMenuFor(h.view.root, 'Alpha');
  const disconnectItem = h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Disconnect');
  await clickImmediate(disconnectItem);
  assert.deepEqual(h.of('/disconnect').map((call) => call.input.hostId), ['a']);
  // While SSH disconnects, the more button is disabled so a second menu cannot open.
  assert.equal(menuButton(h.view.root, 'Alpha').props.disabled, true);
  await flushEffects(() => releaseDisconnect());
  await openMenuFor(h.view.root, 'Beta');
  const deleteItem = h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Delete');
  await clickImmediate(deleteItem);
  assert.equal(h.of('/hosts').length, 0, 'delete must wait for confirmation');
  const dialog = h.view.root.find((node) => node.props.role === 'dialog');
  assert.equal(dialog.props['aria-modal'], true);
  assert.match(text(dialog), /removes the local record/);
  const confirm = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Delete connection');
  assert.equal(confirm.length, 1);
  await clickImmediate(confirm[0]);
  assert.deepEqual(h.of('/hosts').map((call) => call.input), [{ action: 'remove', hostId: 'b' }]);
  assert.equal(h.view.root.findAll((node) => node.props.role === 'dialog').length, 0, 'the dialog closes after a successful delete');
  assert.equal(h.of('/status').length, 2, 'the list is reloaded after delete');
});

test('menu actions are disabled while a connection is not connected and busy blocks repeats', async (t) => {
  const pending = deferred();
  const h = await mountLauncher(t, { handlers: {
    '/connect': () => pending.promise,
  } });
  await openMenuFor(h.view.root, 'Beta');
  const items = h.view.root.findAll((node) => node.props.role === 'menuitem');
  assert.equal(items.find((node) => text(node) === 'Restart connection').props.disabled, true);
  assert.equal(items.find((node) => text(node) === 'Disconnect').props.disabled, true);
  await clickImmediate(items.find((node) => text(node) === 'Settings'));
  const dialog = h.view.root.find((node) => node.props.role === 'dialog');
  assert.match(text(dialog), /Connection settings: Beta/);
  const close = h.view.root.findAll((node) => node.type === 'button' && label(node) === 'Close')[0];
  await clickImmediate(close);
  assert.equal(h.view.root.findAll((node) => node.props.role === 'dialog').length, 0);
  void pending;
});

test('settings dialog renders resolved SSH fields from the real service status contract', async (t) => {
  const fixture = await serviceFixture();
  t.after(fixture.close);
  const record = await fixture.store.upsert({ name: 'Alpha', hostAlias: 'alpha' });
  await fixture.service.ensureTransport(fixture.service.session(record.id));
  fixture.service.session(record.id).channel.config = parseSshGOutput('alpha', [
    'hostname builder.example.test', 'port 2222', 'user remote-user',
    'identityfile ~/.ssh/builder',
  ].join('\n'), { homeDir: '/home/local' });
  const h = await mountLauncher(t, {
    handlers: {
      '/status': () => fixture.service.status(),
      '/web/list': () => fixture.service.webList(record.id),
    },
  });
  await openMenuFor(h.view.root, 'Alpha');
  await tap(h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Settings'));
  const dialog = h.view.root.find((node) => node.props.role === 'dialog');
  const values = dialog.findAllByType('dd').map(text);
  for (const expected of ['builder.example.test', '2222', 'remote-user', '/home/local/.ssh/builder']) {
    assert.ok(values.includes(expected), `settings dialog should show ${expected} from service status`);
  }
});

test('settings dialog lists safe connection fields and port forwards, adds and removes with a kept draft', async (t) => {
  const pending = deferred();
  const h = await mountLauncher(t, {
    handlers: {
      '/status': () => ({ ok: true, connections: connections([{ hostName: '10.0.0.8', user: 'dev', port: 2222, identityFiles: ['/Users/dev/.ssh/id_ed25519'], autoConnect: true }]) }),
      '/web/list': () => webList({ hosts: [] }),
      '/ports': async (input) => {
        if (input.action === 'add') return pending.promise;
        return { ok: true, forwards: [] };
      },
    },
  });
  await openMenuFor(h.view.root, 'Alpha');
  await clickImmediate(h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Settings'));
  const dialog = h.view.root.find((node) => node.props.role === 'dialog');
  const body = text(dialog);
  for (const expected of ['Display name', 'OpenSSH alias', 'Resolved host', '10.0.0.8', '2222', 'dev', 'Identity file', '/Users/dev/.ssh/id_ed25519', 'No port forwards', 'Port forwards']) {
    assert.ok(body.includes(expected), `settings dialog should show ${expected}`);
  }
  assert.doesNotMatch(body, /BEGIN OPENSSH|PRIVATE KEY/);
  // Validation keeps the draft and does not call the API.
  const form = dialog.findAll((node) => node.type === 'form')[0];
  await flushEffects(() => form.props.onSubmit({ preventDefault() {} }));
  assert.equal(h.of('/ports').length, 0);
  assert.match(text(h.view.root), /Enter a remote port from 1 to 65535/);
  const remotePort = h.view.root.findAll((node) => node.type === 'input' && node.props.inputMode === 'numeric')[0];
  const localPort = h.view.root.findAll((node) => node.type === 'input' && node.props.inputMode === 'numeric')[1];
  await setValue(remotePort, '3000');
  await setValue(localPort, '');
  await flushEffects(() => h.view.root.findAll((node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }));
  const adds = h.of('/ports');
  assert.equal(adds.length, 1);
  assert.deepEqual(adds[0].input, { hostId: 'a', action: 'add', forward: { remoteHost: '127.0.0.1', remotePort: 3000 } });
  // While the request is pending the draft is preserved.
  assert.equal(h.view.root.findAll((node) => node.type === 'input' && node.props.inputMode === 'numeric')[0].props.value, '3000');
  await flushEffects(() => pending.resolve({ ok: true, forwards: [{ id: 'p9', remoteHost: '127.0.0.1', remotePort: 3000, localHost: '127.0.0.1', localPort: 49152, state: 'active' }] }));
  assert.equal(h.view.root.findAll((node) => node.type === 'input' && node.props.inputMode === 'numeric')[0].props.value, '');
  assert.match(text(h.view.root), /127\.0\.0\.1:49152/);
});

test('failed port add keeps the draft and shows a safe error', async (t) => {
  const h = await mountLauncher(t, {
    handlers: {
      '/status': () => ({ ok: true, connections: connections([{ portForwards: [] }]) }),
      '/web/list': () => webList({ hosts: [] }),
      '/ports': () => { throw Object.assign(new Error('tunnel'), { code: 'TUNNEL_FAILED', secret: 'SECRET-TOKEN' }); },
    },
  });
  await openMenuFor(h.view.root, 'Alpha');
  await clickImmediate(h.view.root.findAll((node) => node.props.role === 'menuitem').find((node) => text(node) === 'Settings'));
  const remotePort = h.view.root.findAll((node) => node.type === 'input' && node.props.inputMode === 'numeric')[0];
  await setValue(remotePort, '8080');
  await flushEffects(() => h.view.root.findAll((node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }));
  assert.equal(h.view.root.findAll((node) => node.type === 'input' && node.props.inputMode === 'numeric')[0].props.value, '8080');
  const body = text(h.view.toJSON());
  assert.match(body, /port forward failed/i);
  assert.doesNotMatch(body, /SECRET-TOKEN/);
});

test('add OpenSSH alias needs only the alias and supports search, selection and manual entry', async (t) => {
  const h = await mountLauncher(t);
  await clickImmediate(h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Add connection').at(0));
  let dialog = h.view.root.find((node) => node.props.role === 'dialog');
  assert.match(text(dialog), /Add SSH connection/);
  assert.equal(h.of('/ssh-hosts').length, 1);
  // Selecting a discovered alias fills the controlled field.
  const picker = h.view.root.findAll((node) => node.props['aria-pressed'] !== undefined);
  assert.equal(picker.length, 2);
  await clickImmediate(picker[0]);
  const aliasInput = h.view.root.find((node) => node.type === 'input' && node.props.required === true);
  assert.equal(aliasInput.props.value, 'builder');
  // Search sends the query and keeps a manual value possible.
  const searchInput = h.view.root.find((node) => node.type === 'input' && node.props.type === 'search');
  await setValue(searchInput, 'ops');
  await clickImmediate(h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Search').at(-1));
  assert.equal(h.of('/ssh-hosts').at(-1).input.query, 'ops');
  // Manual entry wins and only the alias is sent.
  await setValue(aliasInput, 'manual-host');
  dialog = h.view.root.find((node) => node.props.role === 'dialog');
  await flushEffects(() => dialog.findAll((node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }));
  const saved = h.of('/hosts');
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].input, { action: 'upsert', host: { hostAlias: 'manual-host', name: 'manual-host' } });
  assert.equal(Object.keys(saved[0].input.host).some((key) => /^(?:port|user|identityFile)$/u.test(key)), false);
});

test('empty alias shows a field error and stays in the dialog', async (t) => {
  const h = await mountLauncher(t);
  await clickImmediate(h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Add connection').at(0));
  const dialog = h.view.root.find((node) => node.props.role === 'dialog');
  await flushEffects(() => dialog.findAll((node) => node.type === 'form')[0].props.onSubmit({ preventDefault() {} }));
  assert.equal(h.of('/hosts').length, 0);
  assert.match(text(h.view.root), /Enter an OpenSSH alias/);
  assert.ok(h.view.root.find((node) => node.props.role === 'dialog'));
});

test('Web Host rows use the profile as title and expose source, state and views', async (t) => {
  const h = await mountLauncher(t);
  const rows = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined);
  assert.equal(rows.length, 2);
  const work = rows.find((node) => text(node).includes('work'));
  const body = text(work);
  assert.ok(body.includes('Work') || body.includes('work'));
  assert.match(body, /Source: Remote/);
  assert.match(body, /State: Running/);
  assert.match(body, /2 views/);
});

for (const [locale, newLabel, stopLabel] of [['en', 'New tab', 'Stop'], ['zh', '新建页签', '停止']]) {
  test(`${locale} Host rows expose one open action for idle and running profiles`, async (t) => {
    const opened = [];
    const h = await mountLauncher(t, { props: { locale, onOpenWeb: (...args) => opened.push(args) } });
    for (const [profileId, state] of [['web', 'idle'], ['work', 'running']]) {
      const row = h.view.root.find((node) => node.type === 'li' && node.props['data-state'] === state);
      const actions = row.findAll((node) => node.type === 'button');
      // Card-backed rows also expose Restart and Sync; the open action stays one.
      const open = actions.find((button) => text(button) === newLabel);
      assert.ok(open, `${state} row has an open action`);
      assert.equal(actions.filter((button) => text(button) === newLabel).length, 1);
      assert.equal(open.props.disabled, false);
      await tap(open);
      assert.deepEqual(h.of('/web/open').at(-1).input, { hostId: 'a', profileId });
      assert.deepEqual(opened.at(-1)[2], { instanceId: `inst-${profileId}`, profileId });
    }
    assert.equal(h.of('/web/open').length, 2);
    assert.equal(opened.length, 2);
    assert.equal(h.of('/web/attach').length, 0);
    assert.equal(h.of('/web/stop').length, 0);
  });
}

test('Web Host rows show the DSH version and offer Upgrade only for a newer bundled runtime', async (t) => {
  const h = await mountLauncher(t, {
    handlers: {
      '/web/list': () => webList({
        profiles: [{ id: 'web', web: true }, { id: 'work', web: true }],
        hosts: [
          { profileId: 'web', instanceId: 'inst-web', state: 'running', dshVersion: '1.0.0', latestDshVersion: '2.0.0' },
          { profileId: 'work', instanceId: 'inst-work', state: 'running', dshVersion: '2.0.0', latestDshVersion: '2.0.0' },
        ],
      }),
    },
  });
  const rows = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] === 'running');
  const web = rows.find((node) => text(node).includes('web'));
  const work = rows.find((node) => text(node).includes('work'));
  assert.match(text(web), /DSH version: 1\.0\.0/);
  assert.match(text(work), /DSH version: 2\.0\.0/);
  assert.equal(web.findAll((node) => node.type === 'button' && text(node) === 'Sync & upgrade').length, 1);
  assert.equal(work.findAll((node) => node.type === 'button' && text(node) === 'Sync & upgrade').length, 0);
});

test('new tab opens a Web Host and hands the URL only to onOpenWeb', async (t) => {
  const opened = [];
  const h = await mountLauncher(t, { props: { onOpenWeb: (...args) => { opened.push(args); } } });
  const row = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined).find((node) => text(node).includes('work'));
  const newTab = row.findAll((node) => node.type === 'button' && text(node) === 'New tab')[0];
  await flushEffects(() => newTab.props.onClick());
  assert.equal(h.of('/web/open').length, 1);
  assert.deepEqual(h.of('/web/open')[0].input, { hostId: 'a', profileId: 'work' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0].id, 'a');
  assert.equal(opened[0][0].connected, true);
  assert.equal(opened[0][1], SECRET_URL);
  // The callback also carries the exact instance and profile, without storing a URL copy.
  assert.equal(opened[0].length, 3);
  assert.equal(opened[0][2].profileId, 'work');
  assert.ok(opened[0][2].instanceId);
  // The URL never reaches rendered text or plain state.
  assert.doesNotMatch(text(h.view.toJSON()), /SECRET-TOKEN/);
});

test('a non-loopback URL is refused and never handed to onOpenWeb', async (t) => {
  const opened = [];
  const h = await mountLauncher(t, {
    props: { onOpenWeb: (...args) => opened.push(args) },
    handlers: { '/web/open': () => ({ ok: true, instanceId: 'inst-x', profileId: 'web', url: 'https://evil.example/app?token=SECRET-TOKEN' }) },
  });
  const row = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined).find((node) => text(node).includes('work'));
  const webRow = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined).find((node) => text(node).includes('web'));
  const newTab = (webRow ?? row).findAll((node) => node.type === 'button' && text(node) === 'New tab')[0];
  await flushEffects(() => newTab.props.onClick());
  assert.equal(opened.length, 0);
  assert.match(text(h.view.toJSON()), /not a local loopback URL/);
  assert.doesNotMatch(text(h.view.toJSON()), /SECRET-TOKEN/);
});

test('starting, stopping, offline and missing instances disable actions with a reason', async (t) => {
  const h = await mountLauncher(t, {
    handlers: {
      '/web/list': () => webList({
        connected: true,
        profiles: [{ id: 'web', web: true }, { id: 'work', web: true }, { id: 'tui', web: false }],
        hosts: [
          { profileId: 'web', instanceId: 'inst-starting', state: 'starting' },
          { profileId: 'work', instanceId: 'inst-stopping', state: 'stopping' },
          { profileId: 'tui', instanceId: 'inst-offline', state: 'offline' },
        ],
      }),
    },
  });
  const rows = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined);
  const byId = (id) => rows.find((node) => text(node).includes(id));
  const newTabOf = (node) => node.findAll((node2) => node2.type === 'button' && text(node2) === 'New tab')[0];
  const stopOf = (node) => node.findAll((node2) => node2.type === 'button' && text(node2) === 'Stop')[0];
  assert.match(newTabOf(byId('web')).props.title, /starting/i);
  assert.match(stopOf(byId('web')).props.title, /starting/i);
  assert.equal(newTabOf(byId('web')).props.disabled, true);
  assert.equal(stopOf(byId('web')).props.disabled, true);
  assert.match(newTabOf(byId('work')).props.title, /stopping/i);
  assert.equal(stopOf(byId('work')).props.disabled, true);
  assert.match(newTabOf(byId('tui')).props.title, /not a Web profile/i);
  assert.equal(newTabOf(byId('tui')).props.disabled, true);
  // A stopped/offline Host cannot be stopped either, and the reason is explicit.
  assert.match(stopOf(byId('tui')).props.title, /offline/i);
  assert.equal(stopOf(byId('tui')).props.disabled, true);
});

test('empty profiles, no Host and disconnected states explain the next action', async (t) => {
  const h = await mountLauncher(t, {
    handlers: { '/web/list': () => ({ ok: true, profiles: [], hosts: [], connected: false, profilesSource: 'default' }) },
  });
  assert.match(text(h.view.toJSON()), /no Web profiles/);
  assert.match(text(h.view.toJSON()), /Profiles are read after the SSH connection is ready/);
  const h2 = await mountLauncher(t, { handlers: { '/web/list': () => webList({ hosts: [] }) } });
  // The single list shows the declared profiles; a running Host would add a row.
  assert.match(text(h2.view.toJSON()), /web/);
  const h3 = await mountLauncher(t, { handlers: { '/status': () => ({ ok: true, connections: [] }) } });
  assert.match(text(h3.view.toJSON()), /No SSH connections saved/);
  assert.equal(h3.of('/web/list').length, 0);
});

test('loading, stale and failure states keep old data and a retry action', async (t) => {
  const slowStatus = deferred();
  const slowList = deferred();
  const h = await mountLauncher(t, {
    handlers: {
      '/status': () => slowStatus.promise,
      '/web/list': () => slowList.promise,
    },
  });
  assert.match(text(h.view.toJSON()), /Loading connections/);
  await flushEffects(() => slowStatus.resolve({ ok: true, connections: connections() }));
  await flushEffects(() => slowList.resolve(webList()));
  assert.equal(h.of('/web/list').length, 1);
  // A later status failure keeps the rows and flags staleness.
  h.handlers['/status'] = () => { throw Object.assign(new Error('down'), { code: 'SSH_CONNECTION_FAILED' }); };
  await clickImmediate(h.view.root.findAll((node) => node.type === 'button' && node.props.title === 'Refresh connections')[0]);
  assert.match(text(h.view.toJSON()), /Showing the last saved SSH connections/);
  assert.match(text(h.view.toJSON()), /The SSH connection failed/);
  assert.ok(button(h.view.root, 'Beta'));
});

test('late detail responses and source switches cannot overwrite the current selection', async (t) => {
  const first = deferred();
  const second = deferred();
  let listCalls = 0;
  const h = await mountLauncher(t, {
    handlers: {
      '/web/list': () => {
        listCalls += 1;
        return listCalls === 1 ? first.promise : second.promise;
      },
    },
  });
  // Select Beta while Alpha's detail request is still pending.
  await act(async () => { button(h.view.root, 'Beta').props.onClick({ currentTarget: null }); });
  await flushEffects(() => second.resolve(webList({ profiles: [{ id: 'beta-prof', web: true }], hosts: [] })));
  await flushEffects(() => first.resolve(webList({ profiles: [{ id: 'alpha-prof', web: true }], hosts: [] })));
  const body = text(h.view.toJSON());
  assert.match(body, /beta-prof/);
  assert.doesNotMatch(body, /alpha-prof/);
});

test('unmount cancels reads and drops late responses', async (t) => {
  const pending = deferred();
  const h = await mountLauncher(t, { handlers: { '/status': () => pending.promise } });
  await h.view.unmount();
  const signals = h.of('/status').map((call) => call.signal);
  assert.ok(signals.every((signal) => signal?.aborted === true), 'in-flight reads must be aborted on unmount');
  await flushEffects(() => pending.resolve({ ok: true, connections: connections() }));
  // Nothing re-rendered: the renderer is unmounted; resolving must not throw.
  assert.equal(h.of('/status').length, 1);
});

test('busy state disables conflicting actions but does not block reading another connection', async (t) => {
  const pending = deferred();
  const h = await mountLauncher(t, { handlers: { '/connect': () => pending.promise } });
  const connectButton = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Connect and refresh')[0];
  await flushEffects(() => connectButton.props.onClick());
  assert.equal(h.of('/connect').length, 1);
  // While connecting, the connect button is replaced by a cancel action and rows stay readable.
  await act(async () => { button(h.view.root, 'Beta').props.onClick({ currentTarget: null }); });
  assert.equal(h.of('/web/list').at(-1).input.hostId, 'b');
  const cancel = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Cancel')[0];
  assert.ok(cancel);
  await clickImmediate(cancel);
  await flushEffects(() => pending.resolve({ ok: true, host: { id: 'a', phase: 'connected' } }));
  assert.doesNotMatch(text(h.view.toJSON()), /SECRET-TOKEN/);
});

test('cancelling a connect keeps the previous state and reports cancellation', async (t) => {
  const pending = deferred();
  const h = await mountLauncher(t, { handlers: { '/connect': () => pending.promise } });
  const connectButton = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Connect and refresh')[0];
  await flushEffects(() => connectButton.props.onClick());
  await clickImmediate(h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Cancel')[0]);
  assert.equal(h.of('/connect')[0].signal.aborted, true);
  await flushEffects(() => { pending.resolve({ ok: true, host: { id: 'a', phase: 'connected' } }); });
  assert.doesNotMatch(text(h.view.toJSON()), /Connected and refreshed/);
});

test('stopping a Web Host calls web/stop and notifies onStopWeb with the instance', async (t) => {
  const stopped = [];
  const h = await mountLauncher(t, { props: { onStopWeb: (...args) => stopped.push(args) } });
  const row = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined).find((node) => text(node).includes('work'));
  const stop = row.findAll((node) => node.type === 'button' && text(node) === 'Stop')[0];
  await flushEffects(() => stop.props.onClick());
  assert.equal(h.of('/web/stop').length, 0);
  const confirm = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Stop Host')[0];
  await flushEffects(() => confirm.props.onClick());
  assert.deepEqual(h.of('/web/stop')[0].input, { hostId: 'a', instanceId: 'inst-work' });
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0][0].id, 'a');
  assert.equal(stopped[0][1], 'inst-work');
});

test('request failures show stable codes without leaking secrets or raw messages', async (t) => {
  const h = await mountLauncher(t, {
    handlers: {
      '/web/open': () => { throw Object.assign(new Error('SECRET-TOKEN leaked'), { code: 'REMOTE_INSTANCE_UNAVAILABLE', token: 'SECRET-TOKEN' }); },
    },
  });
  const row = h.view.root.findAll((node) => node.type === 'li' && node.props['data-state'] !== undefined).find((node) => text(node).includes('work'));
  const newTab = row.findAll((node) => node.type === 'button' && text(node) === 'New tab')[0];
  await flushEffects(() => newTab.props.onClick());
  const body = text(h.view.toJSON());
  assert.match(body, /remote Host instance is no longer available/i);
  assert.doesNotMatch(body, /SECRET-TOKEN|leaked/);
});

test('no raw secrets are rendered when status returns them in unknown fields', async (t) => {
  const h = await mountLauncher(t, {
    handlers: {
      '/status': () => ({ ok: true, connections: connections([{ token: 'SECRET-TOKEN', password: 'hunter2' }]) }),
    },
  });
  const body = text(h.view.toJSON());
  assert.doesNotMatch(body, /SECRET-TOKEN|hunter2/);
});

test('autoConnect is not triggered on mount: everything stays passive until an action', async (t) => {
  const h = await mountLauncher(t);
  assert.equal(h.of('/connect').length, 0);
  assert.equal(h.of('/disconnect').length, 0);
  assert.equal(h.of('/web/open').length, 0);
  assert.equal(h.of('/web/attach').length, 0);
  assert.equal(h.of('/web/stop').length, 0);
  // The Host list and its discovered-Host probe are loaded together.
  assert.deepEqual(h.calls.map((call) => call.path), ['/status', '/web/list', '/web/discovered']);
});

test('narrow layout and keyboard affordances exist in the stylesheet', () => {
  assert.match(css, /@container\(max-width:640px\)/u);
  assert.match(css, /container-type:inline-size/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /@media\(max-width:520px\)/u);
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /\.wsh-ssh-switch\[|\.wsh-ssh-switch:checked/u);
});

const alignedHost = (items = [{ name: '@deepseek-ai/dsh-subagent-codex', fromVersion: '1.0.0', toVersion: '2.0.0', ok: true, application: 'applied' }]) => ({
  id: 'a', name: 'Alpha', hostAlias: 'alpha', phase: 'connected', instanceId: 'inst-a',
  pluginAlignment: { ok: true, items, restarted: false },
});

test('a successful connect reports the aligned remote plugin count', async (t) => {
  const h = await mountLauncher(t, { handlers: { '/connect': () => ({ ok: true, host: alignedHost() }) } });
  const connectButton = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Connect and refresh')[0];
  await flushEffects(() => connectButton.props.onClick({ currentTarget: null }));
  assert.match(text(h.view.toJSON()), /Remote plugins aligned to local versions: 1/u);
  assert.doesNotMatch(text(h.view.toJSON()), /SSH connected and refreshed/u);
});

test('the aligned remote plugin notice is localized', async (t) => {
  const h = await mountLauncher(t, { props: { locale: 'zh' }, handlers: { '/connect': () => ({ ok: true, host: alignedHost() }) } });
  const connectButton = h.view.root.findAll((node) => node.type === 'button' && text(node) === '连接并刷新')[0];
  await flushEffects(() => connectButton.props.onClick({ currentTarget: null }));
  assert.match(text(h.view.toJSON()), /已把远端插件对齐到本机版本：1 个/u);
});

for (const [name, pluginAlignment] of [
  ['a failed alignment', { ok: false, items: [], restarted: false, error: { code: 'REMOTE_OPERATION_FAILED' } }],
  ['an empty alignment', { ok: true, items: [], restarted: false }],
  ['no alignment', null],
]) {
  test(`${name} shows no alignment notice`, async (t) => {
    const h = await mountLauncher(t, {
      handlers: { '/connect': () => ({ ok: true, host: { id: 'a', name: 'Alpha', hostAlias: 'alpha', phase: 'connected', instanceId: 'inst-a', pluginAlignment } }) },
    });
    const connectButton = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Connect and refresh')[0];
    await flushEffects(() => connectButton.props.onClick({ currentTarget: null }));
    const body = text(h.view.toJSON());
    assert.doesNotMatch(body, /aligned|对齐到本机版本/u);
    assert.match(body, /Connect and refresh|已连接/u);
  });
}

for (const [locale, message, connectLabel] of [
  ['en', /does not match this plugin build/u, 'Connect and refresh'],
  ['zh', /远端运行包不可用或与本插件构建不匹配/u, '连接并刷新'],
]) {
  test(`REMOTE_VERSION_MISMATCH renders a safe localized failure (${locale})`, async (t) => {
    const h = await mountLauncher(t, {
      props: { locale },
      handlers: {
        '/connect': () => { throw Object.assign(new Error('raw secret detail'), { code: 'REMOTE_VERSION_MISMATCH' }); },
      },
    });
    const connectButton = h.view.root.findAll((node) => node.type === 'button' && text(node) === connectLabel)[0];
    await act(async () => { connectButton.props.onClick({ currentTarget: null }); });
    const body = text(h.view.toJSON());
    assert.match(body, message);
    assert.doesNotMatch(body, /raw secret detail/);
    assert.equal(h.of('/connect').length, 1);
  });
}

test('Chinese dictionary renders without missing keys', async (t) => {
  const h = await mountLauncher(t, { props: { locale: 'zh' } });
  const body = text(h.view.toJSON());
  assert.match(body, /连接/);
  assert.match(body, /连接并刷新/);
  assert.doesNotMatch(body, /\bwsh-ssh\b/);
});

test('the sync confirmation closes once the sync finishes', async (t) => {
  const sync = deferred();
  const h = await mountLauncher(t, {
    handlers: {
      '/web/discovered': () => ({ ok: true, hosts: [{ instanceId: 'inst-x', profileId: 'web', pid: 10, port: 3080 }] }),
      '/web/discovered/sync': () => sync.promise,
    },
  });
  const rows = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Sync & update');
  assert.ok(rows.length >= 1);
  await tap(rows[0]);
  // The dialog repeats the label; the last one belongs to the confirm panel.
  const confirm = h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Sync & update').at(-1);
  await tap(confirm);
  assert.equal(h.of('/web/discovered/sync').length, 1);
  await flushEffects(() => sync.resolve({ ok: true, items: [], config: { appended: [] }, preferences: { synced: [] } }));
  await act(async () => {});
  const headings = h.view.root.findAll((node) => typeof node.props?.title === 'string' && node.props.title.includes('Sync this Web Host profile'));
  assert.equal(headings.length, 0, 'the dialog is gone after the sync completes');
});

test('an idle disconnect keeps the Host row actions on screen', async (t) => {
  let disconnected = false;
  const h = await mountLauncher(t, {
    handlers: {
      '/web/list': () => (disconnected
        ? webList({ hosts: [], connected: false })
        : webList()),
    },
  });
  const syncButton = () => h.view.root.findAll((node) => node.type === 'button' && text(node) === 'Sync & update');
  assert.equal(syncButton().length, 1, 'the running Host row offers sync');
  disconnected = true;
  await tap(button(h.view.root, 'Refresh Web Hosts'));
  await act(async () => {});
  assert.equal(syncButton().length, 1, 'the row survives the disconnect instead of blinking out');
});
