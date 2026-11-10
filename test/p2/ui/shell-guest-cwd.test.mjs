import assert from 'node:assert/strict';
import test from 'node:test';

import { installGuestCwd } from '../../../packages/guest/src/cwd.js';

const SESSION = 'a'.repeat(32);
const PARENT_ORIGIN = 'http://127.0.0.1:64016';
const GLOBAL = '__workspaceShellGuestCwd';
const REQUEST = 'workspace-shell-cwd-request';

function harness({ cwd = '/work/space', embedded = true, origin = null } = {}) {
  const delivered = [];
  const listeners = new Set();
  const parent = { postMessage: (message, target) => delivered.push({ message, target }) };
  const window = {
    parent,
    location: { search: '?workspaceShellParentOrigin=' + encodeURIComponent(origin ?? PARENT_ORIGIN) },
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); },
    deliver(event) { for (const listener of [...listeners]) listener(event); },
    get listenerCount() { return listeners.size; },
  };
  if (!embedded) window.parent = window;
  const effects = [];
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: { [SESSION]: { retainedBy: { mainView: 1 }, projectionValues: { workingDirectory: cwd } } } }) } },
    effect(setup) { const dispose = setup(); effects.push(dispose); return dispose; },
  };
  return { window, ctx, delivered, effects };
}

test('the scalar global answers the single main-view Session working directory', () => {
  const h = harness();
  installGuestCwd(h.ctx, h.window);
  assert.equal(h.window[GLOBAL](), '/work/space');
  h.effects[0]();
  assert.equal(GLOBAL in h.window, false);
});

test('an embedded Guest answers only a parent frame request on its declared origin', () => {
  const h = harness();
  installGuestCwd(h.ctx, h.window);
  const request = { type: REQUEST, version: 1, requestId: 'r'.repeat(32) };
  h.window.deliver({ data: request, origin: 'https://evil.example', source: h.window.parent });
  h.window.deliver({ data: request, origin: PARENT_ORIGIN, source: {} });
  h.window.deliver({ data: { ...request, version: 2 }, origin: PARENT_ORIGIN, source: h.window.parent });
  assert.deepEqual(h.delivered, []);
  h.window.deliver({ data: request, origin: PARENT_ORIGIN, source: h.window.parent });
  assert.deepEqual(h.delivered, [{ message: { type: 'workspace-shell-cwd-response', version: 1, requestId: request.requestId, cwd: '/work/space' }, target: PARENT_ORIGIN }]);
  h.effects[0]();
  assert.equal(h.window.listenerCount, 0);
});

test('a top-level page keeps the scalar but installs no message listener', () => {
  const h = harness({ embedded: false });
  installGuestCwd(h.ctx, h.window);
  assert.equal(typeof h.window[GLOBAL], 'function');
  assert.equal(h.window.listenerCount, 0);
});
