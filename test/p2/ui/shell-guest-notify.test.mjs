import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const packageRoot = new URL('../../../packages/shell/guest-notify/', import.meta.url);
const clientSource = await readFile(new URL('client.js', packageRoot), 'utf8');
const SESSION = 'a'.repeat(32);
const MARKER = '__workspace-shell-notification__';

function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { value = next; for (const listener of [...listeners]) listener(); },
  };
}

const statusOf = (overrides = {}) => ({ running: undefined, pendingInteraction: undefined, completionUnread: false, ...overrides });

function loadBridge() {
  let registration;
  const logged = [];
  const opened = [];
  const effects = [];
  const window = {
    location: { search: '?workspaceShellEmbedded=1', hash: '' },
    console: { log: (message) => logged.push(message) },
    addEventListener() {},
    removeEventListener() {},
  };
  window.parent = window;
  window.__ModuleLoader__ = { load(value) { assert.equal(registration, undefined); registration = value; } };
  vm.runInNewContext(clientSource, { window, URL, URLSearchParams }, { filename: 'guest-notify-client.js' });
  assert.equal(registration.id, 'dsh-workspace-shell-guest-notify');
  const plugin = registration.factory();
  assert.deepEqual([...plugin.inject].sort(), ['sessions', 'uiSession', 'uiWorkspace']);
  assert.deepEqual(Object.keys(plugin).sort(), ['apply', 'inject']);
  const status = observable(new Map());
  const ctx = {
    uiSession: { sessionStatus: status },
    sessions: { list: { getSnapshot: () => ({ byId: { [SESSION]: { displayTitle: 'Remote check', retainedBy: { mainView: 0 } } } }) } },
    uiWorkspace: { openSession: (sessionId) => opened.push(sessionId) },
    effect(setup) { const dispose = setup(); effects.push(dispose); return dispose; },
  };
  plugin.apply(ctx);
  return { window, logged, opened, effects, status, ctx };
}

test('the companion seeds the baseline and reports one Turn end through the console channel', () => {
  const { logged, status } = loadBridge();
  assert.equal(logged.length, 0, 'the first snapshot only seeds');
  status.set(new Map([[SESSION, statusOf({ running: true })]]));
  status.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(logged.length, 1);
  assert.ok(logged[0].startsWith(MARKER));
  const message = JSON.parse(logged[0].slice(MARKER.length));
  assert.equal(message.type, 'workspace-shell-notification');
  assert.equal(message.event, 'turn-end');
  assert.equal(message.sessionId, SESSION);
  assert.equal(message.title, 'Remote check');
});

test('the companion exposes one validated open entry point and removes it on dispose', () => {
  const { window, opened, effects } = loadBridge();
  assert.equal(typeof window.__workspaceShellOpenSession, 'function');
  assert.equal(window.__workspaceShellOpenSession(SESSION), true);
  assert.deepEqual(opened, [SESSION]);
  assert.equal(window.__workspaceShellOpenSession('../etc/passwd'), false);
  effects[0]();
  assert.equal('__workspaceShellOpenSession' in window, false);
  assert.equal('__workspaceShellNotificationBridge' in window, false);
});

test('only the first bridge installs in one page', () => {
  const { window, ctx, effects } = loadBridge();
  // A second plugin instance in the same page finds the marker and stays inert.
  let second;
  window.__ModuleLoader__ = { load(value) { second = value; } };
  vm.runInNewContext(clientSource, { window, URL, URLSearchParams }, { filename: 'guest-notify-client-2.js' });
  const before = window.__workspaceShellOpenSession;
  second.factory().apply(ctx);
  assert.equal(window.__workspaceShellOpenSession, before);
  effects[0]();
  assert.equal('__workspaceShellOpenSession' in window, false);
});
