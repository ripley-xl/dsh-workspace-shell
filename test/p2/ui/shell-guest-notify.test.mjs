import assert from 'node:assert/strict';
import test from 'node:test';

import { createGuestNotificationBridge } from '../../../packages/guest/src/notification.js';

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

function harness({ parentIsSelf = true, running = true } = {}) {
  const logged = [];
  const opened = [];
  const listeners = new Set();
  const window = {
    parent: parentIsSelf ? null : { postMessage() {} },
    location: { search: '?workspaceShellEmbedded=1', hash: '' },
    console: { log: (message) => logged.push(message) },
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); },
  };
  if (parentIsSelf) window.parent = window;
  const status = observable(new Map());
  const ctx = {
    uiSession: { sessionStatus: status },
    sessions: { list: { getSnapshot: () => ({ byId: { [SESSION]: { displayTitle: 'Remote check', retainedBy: { mainView: 0 } } } }) } },
    uiWorkspace: { openSession: (sessionId) => opened.push(sessionId) },
    effect(setup) { return setup(); },
  };
  const bridge = createGuestNotificationBridge({ window, ctx });
  return { window, status, opened, logged, bridge, ctx, running };
}

test('a webview Guest seeds the baseline and reports one Turn end through its console', () => {
  const h = harness();
  h.status.set(new Map([[SESSION, statusOf({ running: true })]]));
  h.status.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(h.logged.length, 1);
  const message = JSON.parse(h.logged[0].slice(MARKER.length));
  assert.equal(message.type, 'workspace-shell-notification');
  assert.equal(message.event, 'turn-end');
  assert.equal(message.sessionId, SESSION);
  assert.equal(typeof h.window.__workspaceShellOpenSession, 'function');
  assert.equal(h.window.__workspaceShellOpenSession(SESSION), true);
  assert.deepEqual(h.opened, [SESSION]);
  h.bridge.dispose();
  assert.equal('__workspaceShellOpenSession' in h.window, false);
});

test('a pending interaction is reported once and only one bridge installs per page', () => {
  const h = harness();
  const pending = { kind: 'approval', key: 'approval:1', sessionId: SESSION, toolName: 'bash' };
  h.status.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: pending })]]));
  h.status.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: pending })]]));
  assert.equal(h.logged.length, 1);
  const message = JSON.parse(h.logged[0].slice(MARKER.length));
  assert.equal(message.kind, 'approval');
  assert.equal(message.detail, 'bash');
  const second = createGuestNotificationBridge({ window: h.window, ctx: h.ctx });
  second.dispose();
  assert.equal(typeof h.window.__workspaceShellOpenSession, 'function');
  h.bridge.dispose();
});
