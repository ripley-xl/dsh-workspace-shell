import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { createSessionHostClient } from '../../../packages/shell/session-host/controller.js';
import { observeSessionSubmissions, applyTransferredDraft } from '../../../packages/shell/session-host/submissions.js';
import { createSessionHostPlugin, sessionHostCss } from '../../../packages/shell/session-host/ui.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const a = 'a'.repeat(32), b = 'b'.repeat(32), v = 'c'.repeat(32), tab = 'd'.repeat(32);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, set(next) { value = next; for (const fn of listeners) fn(); } };
}
function fixture(t, overrides = {}, embedded = false) {
  const calls = [];
  const host = { instanceId: a, profile: 'desktop' }, owner = { instanceId: b, profile: 'web', canAttach: true };
  const panelInfo = observable({ activePanelId: null });
  const list = observable({ byId: { s: { id: 's', retainedBy: { mainView: 1 } } } });
  let nav = new AbortController();
  const identity = {};
  const shell = { getSnapshot: () => ({ activeId: 'local', tabs: [{ id: 'local' }, { id: 'target' }] }), sessionTabs: () => [{ id: 'target', token: tab, identity }],
    activate: async (id) => { calls.push(['activate', id]); return true; }, openSessionHost: async (input) => { calls.push(['open', input]); return 'target'; } };
  const ctx = { get: () => shell, sessions: { list }, layout: { panelInfo, beginNavigation() { nav.abort(); nav = new AbortController(); return nav.signal; } }, uiWorkspace: { openSession() { assert.fail('source must not select or resume'); } } };
  const window = { crypto: { randomUUID }, location: { search: embedded ? `?workspaceShellEmbedded=1&workspaceSessionWindow=${v}&workspaceSessionParent=${b}&workspaceSessionTab=${tab}` : '' }, document: { visibilityState: 'visible', hasFocus: () => true },
    async fetch(path, options) {
      const input = JSON.parse(options.body), route = path.replace('/api/workspace-session-hosts/', ''); calls.push([route, input]);
      if (options.signal?.aborted) throw new Error('aborted');
      let result;
      if (overrides[route]) result = await overrides[route](input, options);
      else if (route === 'view/update') result = { host, command: null };
      else if (route === 'status') result = { host, sessions: Object.fromEntries(input.sessionIds.map((id) => [id, { state: 'foreign', host: owner }])) };
      else if (route === 'views') result = [{ viewId: v, tabId: tab, sessionId: 's', used: 1 }];
      else if (route === 'command') result = { viewId: v, sessionId: input.command.sessionId, draftId: input.command.draft?.id };
      else result = {};
      return { ok: true, json: async () => ({ ok: true, result }) };
    } };
  const client = createSessionHostClient({ ctx, window, applyDraft: applyTransferredDraft });
  t.after(() => client.dispose());
  return { client, ctx, window, shell, calls, host, owner, async fail(text = 'failed text') { client.failed('s', { text }); await flush(); } };
}

test('normal activation never opens history, blocks sending, or looks up every sidebar row', async (t) => {
  const f = fixture(t); await flush();
  assert.deepEqual(f.client.getSnapshot().failures, {});
  assert.equal(f.calls.some(([kind]) => ['history', 'status', 'command', 'open'].includes(kind)), false);
});
test('failed send locates ownership without navigation; click transfers exact text and validates receipt', async (t) => {
  const f = fixture(t); await f.fail('exact failed text');
  assert.equal(f.calls.some(([kind]) => ['open', 'activate', 'command'].includes(kind)), false);
  await f.client.navigate('s');
  const command = f.calls.find(([kind]) => kind === 'command')[1];
  assert.equal(command.instanceId, b); assert.equal(command.viewId, v);
  assert.equal(command.command.draft.text, 'exact failed text');
  assert.equal(command.command.sessionId, 's');
  assert.ok(f.calls.some(([kind]) => kind === 'activate'));
  assert.equal(f.client.getSnapshot().failures.s.text, 'exact failed text');
});
test('opening an absent tab attaches only the exact existing Host after clicking', async (t) => {
  let created = false;
  const f = fixture(t, { views: () => created ? [{ viewId: v, tabId: tab }] : [] });
  f.shell.openSessionHost = async (input) => { f.calls.push(['open', input]); created = true; return 'target'; };
  await f.fail(); assert.equal(f.client.getSnapshot().failures.s.action, 'open');
  await f.client.navigate('s');
  assert.deepEqual(f.calls.find(([kind]) => kind === 'open')[1], { instanceId: b, sessionId: 's', profile: 'web' });
});
test('missing draft receipt never reports success or activates the target', async (t) => {
  const f = fixture(t, { command: () => ({ viewId: v, sessionId: 's' }) }); await f.fail(); await f.client.navigate('s');
  assert.equal(f.calls.some(([kind]) => kind === 'activate'), false);
  assert.equal(f.client.getSnapshot().failures.s.error, 'SESSION_HOST_CHANGED');
});
test('unknown owner, navigation away, dismissal and oversized text never dispatch a transfer', async (t) => {
  const f = fixture(t); await f.fail('x'.repeat(65000)); await f.client.navigate('s');
  assert.equal(f.client.getSnapshot().failures.s.error, 'SESSION_DRAFT_TOO_LARGE');
  await f.fail(); f.ctx.sessions.list.set({ byId: {} }); await f.client.navigate('s');
  f.client.dismiss('s'); await f.client.navigate('s');
  assert.equal(f.calls.some(([kind]) => kind === 'command'), false);
  const unknown = fixture(t, { status: () => ({ host: f.host, sessions: { s: { state: 'unknown' } } }) });
  await unknown.fail(); await unknown.client.navigate('s');
  assert.equal(unknown.calls.some(([kind]) => kind === 'command'), false);
});
test('embedded navigation relays text to the parent with exact Host and session identities', async (t) => {
  const f = fixture(t, {}, true); await f.fail(); await f.client.navigate('s');
  const request = f.calls.find(([kind]) => kind === 'command')[1];
  assert.equal(request.command.kind, 'goto'); assert.equal(request.command.draft.text, 'failed text');
  assert.equal(request.viewId, v); assert.equal(request.instanceId, b);
});
test('a cancelled parent receipt cannot be mistaken for successful draft transfer', async (t) => {
  const f = fixture(t, { command: ({ command }) => ({ sessionId: command.sessionId, draftId: command.draft.id, cancelled: true }) }, true);
  await f.fail(); await f.client.navigate('s');
  assert.equal(f.client.getSnapshot().failures.s.transferred, false);
  assert.equal(f.client.getSnapshot().failures.s.error, 'SESSION_NAVIGATION_CANCELLED');
});
test('a new send failure replaces the earlier incoming-draft notice', async (t) => {
  const host = { instanceId: a, profile: 'desktop' };
  const command = { kind: 'select', requestId: b, sessionId: 's', draft: { id: tab, text: 'incoming' } };
  const f = fixture(t, {
    'view/update': () => ({ host, command }),
    status: () => ({ host, sessions: { s: { state: 'local', host } } }),
  });
  f.ctx.uiWorkspace.openSession = () => {};
  f.ctx.sessions.retain = () => ({ ready: Promise.resolve(), release() {} });
  f.ctx.sessions.binding = () => ({});
  f.ctx.conversation = { input: { requestDraftInitialization: () => 'applied' } };
  for (let attempt = 0; attempt < 50 && !f.client.getSnapshot().incoming.s; attempt++) await flush();
  assert.equal(f.client.getSnapshot().incoming.s, true);
  await f.fail('new rejected text');
  assert.equal(f.client.getSnapshot().incoming.s, undefined);
  assert.equal(f.client.getSnapshot().failures.s.text, 'new rejected text');
});
test('submission observer captures the rejected payload, not later edits, and preserves results', async () => {
  let finish; const calls = [];
  const result = { ok: false, error: { code: 'session/writer-held' } };
  const session = { prompt: () => new Promise((resolve) => { finish = resolve; }) };
  const original = session.prompt;
  const list = observable({ byId: { s: {} } });
  const off = observeSessionSubmissions({ list, binding: () => ({ session }) }, { failed: (...args) => calls.push(args), succeeded: () => calls.push('success') });
  const pending = session.prompt([{ type: 'text', text: 'original failed text' }, { type: 'image' }]);
  finish(result); assert.equal(await pending, result);
  assert.deepEqual(calls, [['s', { text: 'original failed text', attachments: true }]]);
  off(); assert.equal(session.prompt, original);
});
test('network and model errors are untouched; observer disposal ignores late results and later wrappers', async () => {
  let result = { ok: false, error: { code: 'gateway/internal' } }, resolve;
  const session = { prompt: async () => result };
  const off = observeSessionSubmissions({ list: observable({ byId: { s: {} } }), binding: () => ({ session }) }, { failed() { assert.fail(); }, succeeded() { throw new Error('observer failed'); } });
  assert.equal(await session.prompt([]), result);
  result = { ok: true }; assert.equal(await session.prompt([]), result);
  const captured = session.prompt;
  const later = (...args) => captured(...args); session.prompt = later; off(); assert.equal(session.prompt, later);
  const other = { prompt: () => new Promise((r) => { resolve = r; }) };
  const stop = observeSessionSubmissions({ list: observable({ byId: { s: {} } }), binding: () => ({ session: other }) }, { failed() { assert.fail(); } });
  const pending = other.prompt([]); stop(); resolve({ ok: false, error: { code: 'session/writer-held' } }); await pending;
});
test('draft transfer appends through the public API, preserves existing contents and deduplicates retries', () => {
  const binding = {}, calls = [], received = new Map();
  const ctx = { sessions: { binding: () => binding }, conversation: { input: { requestDraftInitialization: (...args) => { calls.push(args); return 'applied'; } } } };
  const draft = { id: a, text: 'failed text' };
  applyTransferredDraft(ctx, 's', draft, received); applyTransferredDraft(ctx, 's', draft, received);
  assert.deepEqual(calls, [[binding, { prompt: 'failed text', whenDraftExists: 'append' }]]);
  assert.throws(() => applyTransferredDraft(ctx, 'other', draft, received), /CHANGED/);
  ctx.conversation.input.requestDraftInitialization = () => 'blocked';
  assert.throws(() => applyTransferredDraft(ctx, 's', { id: b, text: 'next' }, received), /BLOCKED/);
  assert.equal(received.has(b), false);
});
test('a late older submission cannot replace the newest result; renewed bindings are observed', async () => {
  const pending = [], calls = [];
  const makeSession = () => ({ prompt: () => new Promise((resolve) => pending.push(resolve)) });
  let session = makeSession();
  const old = session, original = session.prompt;
  const list = observable({ byId: { s: {} } });
  const off = observeSessionSubmissions({ list, binding: () => ({ session }) }, { failed: (_id, value) => calls.push(value.text), succeeded: () => calls.push('success') });
  const first = session.prompt([{ type: 'text', text: 'older' }]);
  const second = session.prompt([{ type: 'text', text: 'newer' }]);
  pending[1]({ ok: true }); await second;
  pending[0]({ ok: false, error: { code: 'session/writer-held' } }); await first;
  assert.deepEqual(calls, ['success']);
  session = makeSession(); list.set({ byId: { s: {} } });
  assert.equal(old.prompt, original);
  const renewed = session.prompt([{ type: 'text', text: 'renewed' }]);
  pending[2]({ ok: false, error: { code: 'session/writer-held' } }); await renewed;
  assert.deepEqual(calls, ['success', 'renewed']); off();
});
test('cancellation after a draft receipt never reports successful navigation', async (t) => {
  let receipt;
  const f = fixture(t, { command: (input) => new Promise((resolve) => { receipt = () => resolve({ viewId: v, sessionId: 's', draftId: input.command.draft.id }); }) });
  await f.fail(); const pending = f.client.navigate('s');
  while (!receipt) await flush();
  f.ctx.layout.panelInfo.set({ activePanelId: 'settings' }); receipt(); await pending;
  assert.equal(f.calls.some(([kind]) => kind === 'activate'), false);
  assert.equal(f.client.getSnapshot().failures.s.transferred, false);
  assert.equal(f.client.getSnapshot().failures.s.text, 'failed text');
});
test('UI adds only the input notice, no preview, sidebar adapter, modal or shortcut interception', async () => {
  assert.match(sessionHostCss, /var\(--dsh-composer-card-max-width,/);
  assert.match(sessionHostCss, /var\(--dsh-composer-side-clearance,/);
  const store = observable({ failures: {}, incoming: {} });
  let Notice; const slots = [], effects = [];
  const client = { ...store, dispose() {}, context() {}, failed() {}, dismiss() {} };
  const locale = observable({ active: 'en' });
  const ctx = { locale, sessions: {}, provide() {}, inject() {}, effect(fn) { effects.push(fn()); }, slots: { inject(_name, fn) { fn(); }, register(def, component) { slots.push(def.name); Notice = component; } } };
  const Icon = () => null;
  createSessionHostPlugin(React, { IconCloseOutlineRegular: Icon, IconRefreshOutlineRegular: Icon, IconRightUpOutlineRegular: Icon }, {
    createSessionHostClient: () => client, observeSessionSubmissions: () => () => {}, document: { createElement: () => ({ remove() {} }), head: { append() {} } },
  }).apply(ctx);
  assert.deepEqual(slots, ['conversation.input.dock']);
  const props = { sessionId: 's', useSession: (fn) => fn({ promptError: { error: { code: 'session/writer-held' } } }) };
  let renderer; await act(async () => { renderer = create(React.createElement(Notice, props)); }); assert.equal(renderer.toJSON(), null);
  await act(async () => store.set({ failures: { s: { owner: { state: 'foreign', host: { profile: 'web' } } } }, incoming: {} }));
  assert.equal(renderer.root.findAllByType('button').length, 2);
  await act(async () => store.set({ failures: {}, incoming: { s: true } }));
  assert.match(JSON.stringify(renderer.toJSON()), /Review it before sending/);
  await act(async () => renderer.unmount()); for (const off of effects.reverse()) off?.();
});
