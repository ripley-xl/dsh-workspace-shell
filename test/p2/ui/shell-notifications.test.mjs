import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NOTIFICATION_EVENT,
  OPEN_SESSION_EVENT,
  NOTIFICATION_VERSION,
  validNotificationEvent,
  validOpenSessionRequest,
  createSessionNotificationMonitor,
  createGuestNotificationBridge,
  createNotificationCenter,
} from '../../../packages/shell/src/notifications.js';

const SESSION = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

function listStore(rows) {
  let value = rows;
  return {
    getSnapshot: () => ({ phase: 'ready', ids: Object.keys(value), byId: value, projectionsBySession: {} }),
    set(next) { value = next; },
  };
}

const statusOf = (overrides = {}) => ({ running: undefined, pendingInteraction: undefined, completionUnread: false, ...overrides });
const rowOf = (title, viewing = false) => ({ id: SESSION, displayTitle: title, running: false, blank: false, updatedAt: 0, retainedBy: { mainView: viewing ? 1 : 0 } });

function monitorHarness({ rows = { [SESSION]: rowOf('Release check') }, status = new Map() } = {}) {
  const statusStore = observable(status);
  const list = listStore(rows);
  const events = [];
  const monitor = createSessionNotificationMonitor({ status: statusStore, list, report: (payload) => events.push(payload) });
  return { statusStore, list, events, monitor };
}

test('the first status snapshot seeds the baseline and emits nothing', () => {
  const { events } = monitorHarness({ status: new Map([[SESSION, statusOf({ running: true })]]) });
  assert.deepEqual(events, []);
});

test('a Turn settling from running to idle emits one turn-end event with the list title', () => {
  const { statusStore, events } = monitorHarness({ status: new Map([[SESSION, statusOf({ running: true })]]) });
  statusStore.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { event: 'turn-end', kind: 'turn-end', sessionId: SESSION, title: 'Release check', detail: '', viewing: false });
  statusStore.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(events.length, 1, 'an unchanged idle state is not replayed');
});

test('a Turn starting does not notify, and a second settlement does', () => {
  const { statusStore, events } = monitorHarness();
  statusStore.set(new Map([[SESSION, statusOf({ running: true })]]));
  assert.equal(events.length, 0);
  statusStore.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(events.length, 1);
});

test('a pending approval emits once per request key and again for a replacement', () => {
  const { statusStore, events } = monitorHarness();
  const approval = { kind: 'approval', key: 'approval:1', sessionId: SESSION, toolName: 'bash', reason: 'Delete build output' };
  statusStore.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: approval })]]));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event: 'attention', kind: 'approval', sessionId: SESSION, title: 'Release check', detail: 'bash · Delete build output', viewing: false,
  });
  statusStore.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: approval })]]));
  assert.equal(events.length, 1, 'the same key never repeats');
  statusStore.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: { ...approval, key: 'approval:2', toolName: 'write' } })]]));
  assert.equal(events.length, 2);
  assert.equal(events[1].detail, 'write · Delete build output');
});

test('a pending question carries the first question text and viewing follows the main view', () => {
  const { statusStore, events } = monitorHarness({ rows: { [SESSION]: rowOf('Release check', true) } });
  statusStore.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: {
    kind: 'question', key: 'question:1', sessionId: SESSION, questions: [{ question: 'Which target should ship?' }],
  } })]]));
  assert.deepEqual(events[0], {
    event: 'attention', kind: 'question', sessionId: SESSION, title: 'Release check', detail: 'Which target should ship?', viewing: true,
  });
});

test('plan review and unknown interaction kinds stay distinguishable', () => {
  const { statusStore, events } = monitorHarness();
  statusStore.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: {
    kind: 'plan-review', key: 'question:2', sessionId: SESSION, questions: [{ header: 'Migration plan' }],
  } })]]));
  assert.equal(events[0].kind, 'plan-review');
  assert.equal(events[0].detail, 'Migration plan');
  statusStore.set(new Map([[SESSION, statusOf({ running: true, pendingInteraction: { kind: 'permission', key: 'permission:1', sessionId: SESSION } })]]));
  assert.equal(events[1].kind, 'attention');
  assert.equal(events[1].detail, 'permission');
});

test('a Turn settling while an interaction is pending reports the interaction only', () => {
  const { statusStore, events } = monitorHarness();
  statusStore.set(new Map([[SESSION, statusOf({ running: false, pendingInteraction: { kind: 'approval', key: 'approval:1', sessionId: SESSION, toolName: 'bash' } })]]));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'attention');
});

test('a subagent finishing does not report a Turn end', () => {
  const { statusStore, events } = monitorHarness({ rows: { [SESSION]: { ...rowOf('Child'), origin: 'subagent' } }, status: new Map([[SESSION, statusOf({ running: true })]]) });
  statusStore.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.deepEqual(events, []);
  statusStore.set(new Map([[SESSION, statusOf({ running: false, pendingInteraction: { kind: 'approval', key: 'approval:1', sessionId: SESSION, toolName: 'bash' } })]]));
  assert.equal(events.length, 1, 'a subagent approval still needs the user');
  assert.equal(events[0].kind, 'approval');
});

test('sessions that disappear from the snapshot are forgotten and never replayed', () => {
  const { statusStore, events } = monitorHarness({ status: new Map([[SESSION, statusOf({ running: true })]]) });
  statusStore.set(new Map());
  statusStore.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(events.length, 0);
});

test('a failing status source leaves the monitor silent and disposable', () => {
  const events = [];
  const monitor = createSessionNotificationMonitor({ status: { getSnapshot() { throw new Error('gone'); }, subscribe() { throw new Error('gone'); } }, list: listStore({}), report: (payload) => events.push(payload) });
  monitor.dispose();
  assert.deepEqual(events, []);
});

test('notification frames reject foreign types, versions, identifiers, kinds and oversized fields', () => {
  const base = { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, event: 'turn-end', kind: 'turn-end', sessionId: SESSION, title: 'Title', detail: '', viewing: false };
  assert.deepEqual(validNotificationEvent(base), { event: 'turn-end', kind: 'turn-end', sessionId: SESSION, title: 'Title', detail: '', viewing: false });
  for (const broken of [
    null,
    [],
    { ...base, type: 'workspace-shell-cwd-request' },
    { ...base, version: 2 },
    { ...base, event: 'started' },
    { ...base, kind: 'question' },
    { ...base, event: 'attention', kind: 'turn-end' },
    { ...base, kind: 'driver' },
    { ...base, sessionId: '../etc/passwd' },
    { ...base, title: 'x'.repeat(2000) },
    { ...base, detail: 'x'.repeat(2000) },
    { ...base, viewing: 'yes' },
  ]) assert.equal(validNotificationEvent(broken), null, JSON.stringify(broken));
  assert.equal(validNotificationEvent({ ...base, title: '  spaced\n\ntitle  ' }).title, 'spaced title');
});

test('open-Session frames require the request identity and a Session identifier', () => {
  const valid = { type: OPEN_SESSION_EVENT, version: NOTIFICATION_VERSION, requestId: 'r'.repeat(32), sessionId: SESSION };
  assert.deepEqual(validOpenSessionRequest(valid), { requestId: 'r'.repeat(32), sessionId: SESSION });
  for (const broken of [
    { ...valid, requestId: 'short' },
    { ...valid, sessionId: 'bad id' },
    { ...valid, version: 0 },
    { ...valid, type: 'workspace-shell-notification' },
  ]) assert.equal(validOpenSessionRequest(broken), null);
});

function bridgeHarness({ parentOrigin = 'http://127.0.0.1:64016', embedded = true, parentIsSelf = false, status = new Map(), location = null } = {}) {
  const sent = [];
  const logged = [];
  const listeners = new Set();
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const window = {
    parent,
    console: { log: (message) => logged.push(message) },
    location: location ?? { search: embedded ? '?workspaceShellEmbedded=1&workspaceShellParentOrigin=' + encodeURIComponent(parentOrigin) : '' },
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); },
    deliver(event) { for (const listener of [...listeners]) listener(event); },
    get listenerCount() { return listeners.size; },
  };
  if (!embedded || parentIsSelf) window.parent = window;
  const statusStore = observable(status);
  const opened = [];
  const ctx = {
    uiSession: { sessionStatus: statusStore },
    sessions: { list: listStore({ [SESSION]: rowOf('Remote check') }) },
    uiWorkspace: { openSession(sessionId) { opened.push(sessionId); } },
  };
  return { window, parent, parentOrigin, sent, logged, statusStore, opened, ctx, listeners };
}

test('an embedded page reports status transitions to its declared parent origin', () => {
  const harness = bridgeHarness({ status: new Map([[SESSION, statusOf({ running: true })]]) });
  const bridge = createGuestNotificationBridge({ window: harness.window, ctx: harness.ctx });
  harness.statusStore.set(new Map([[SESSION, statusOf({ running: false, pendingInteraction: { kind: 'approval', key: 'approval:1', sessionId: SESSION, toolName: 'bash' } })]]));
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].origin, harness.parentOrigin);
  assert.equal(harness.sent[0].message.type, NOTIFICATION_EVENT);
  assert.equal(harness.sent[0].message.sessionId, SESSION);
  bridge.dispose();
  assert.equal(harness.listeners.size, 0);
});

test('invalid open-Session frames are dropped and a valid one opens the Session once', () => {
  const harness = bridgeHarness();
  const bridge = createGuestNotificationBridge({ window: harness.window, ctx: harness.ctx });
  const frame = (extra = {}) => ({
    source: harness.parent,
    origin: harness.parentOrigin,
    data: { type: OPEN_SESSION_EVENT, version: NOTIFICATION_VERSION, requestId: 'r'.repeat(32), sessionId: SESSION },
    ...extra,
  });
  harness.window.deliver(frame({ source: {} }));
  harness.window.deliver(frame({ origin: 'https://evil.example' }));
  harness.window.deliver(frame({ data: { ...frame().data, version: 2 } }));
  harness.window.deliver(frame({ data: { ...frame().data, sessionId: '../etc/passwd' } }));
  assert.deepEqual(harness.opened, []);
  harness.window.deliver(frame());
  harness.window.deliver(frame());
  assert.deepEqual(harness.opened, [SESSION]);
  bridge.dispose();
});

test('a webview Guest reports through console output and exposes one open entry point', () => {
  const harness = bridgeHarness({ parentIsSelf: true, status: new Map([[SESSION, statusOf({ running: true })]]) });
  const bridge = createGuestNotificationBridge({ window: harness.window, ctx: harness.ctx });
  const open = harness.window.__workspaceShellOpenSession;
  assert.equal(typeof open, 'function');
  harness.statusStore.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(harness.sent.length, 0, 'a webview has no parent to post to');
  assert.equal(harness.logged.length, 1);
  assert.ok(harness.logged[0].startsWith('__workspace-shell-notification__'));
  const message = JSON.parse(harness.logged[0].slice('__workspace-shell-notification__'.length));
  assert.equal(message.type, NOTIFICATION_EVENT);
  assert.equal(message.sessionId, SESSION);
  assert.equal(message.event, 'turn-end');
  assert.equal(open(SESSION), true);
  assert.deepEqual(harness.opened, [SESSION]);
  assert.equal(open('../etc/passwd'), false);
  assert.equal(open(''), false);
  bridge.dispose();
  assert.equal('__workspaceShellOpenSession' in harness.window, false);
  assert.deepEqual(harness.opened, [SESSION]);
});

test('a login redirect that drops the query still reports through the fragment origin', () => {
  const harness = bridgeHarness({ location: { search: '?thread=1', hash: '#thread=1&workspaceShellParentOrigin=' + encodeURIComponent('dsh-app://app') } });
  const bridge = createGuestNotificationBridge({ window: harness.window, ctx: harness.ctx });
  harness.statusStore.set(new Map([[SESSION, statusOf({ running: true })]]));
  harness.statusStore.set(new Map([[SESSION, statusOf({ running: false })]]));
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].origin, 'dsh-app://app');
  bridge.dispose();
});

test('a page without the parent-origin parameter installs nothing', () => {
  const harness = bridgeHarness({ embedded: false });
  const bridge = createGuestNotificationBridge({ window: harness.window, ctx: harness.ctx });
  assert.equal(harness.listeners.size, 0);
  bridge.dispose();
});

class FakeNotification {
  static permission = 'granted';
  static shown = [];
  constructor(title, options) {
    this.title = title;
    this.options = options;
    this.closed = 0;
    this.onclick = null;
    FakeNotification.shown.push(this);
  }
  close() { this.closed += 1; }
}

function centerHarness({ tabs, activeId, focused = false, permission = 'granted', locale = 'zh', rows } = {}) {
  FakeNotification.shown = [];
  FakeNotification.permission = permission;
  const listeners = new Map();
  const window = {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    emit(name) { for (const listener of [...(listeners.get(name) ?? [])]) listener(); },
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
  };
  const document = { hasFocus: () => focused, visibilityState: 'visible' };
  const activated = [];
  const opened = [];
  const workspace = {
    tabs: { getSnapshot: () => ({ tabs, activeId }) },
    activate: async (id) => { activated.push(id); return true; },
    openSessionInTab: (key, sessionId) => { opened.push({ key, sessionId }); return true; },
    getTabAppearance: (tab) => tab.appearance ?? null,
  };
  const center = createNotificationCenter({
    window, document, workspace,
    localeOf: () => ({ active: locale }),
    openLocalSession: (sessionId) => opened.push({ key: 'local', sessionId }),
    NotificationCtor: FakeNotification,
    log: () => {},
  });
  return { center, window, document, workspace, activated, opened, tabs, rows };
}

const TAB = { id: 'tab-1', key: 'local-web:alpha:1', title: 'alpha · Web 1', kind: 'profile-ui' };
const LOCAL = { id: 'local', key: 'local', title: '本地', kind: 'profile-ui' };
const payload = (overrides = {}) => ({ event: 'attention', kind: 'approval', sessionId: SESSION, title: 'Release check', detail: 'bash', viewing: false, ...overrides });

test('a guest report shows one notification with the scenario, detail and tab label', () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: 'local' });
  harness.center.reportGuest(TAB.key, {
    type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload(),
  });
  assert.equal(FakeNotification.shown.length, 1);
  const shown = FakeNotification.shown[0];
  assert.equal(shown.title, 'Release check');
  assert.equal(shown.options.body, '等待你确认：bash · alpha · Web 1');
  assert.equal(shown.options.tag, 'workspace-shell:' + SESSION);
});

test('the same Session replaces its notification instead of stacking', () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: 'local' });
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ detail: 'bash' }) });
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ kind: 'question', detail: 'Which target?' }) });
  assert.equal(FakeNotification.shown.length, 2);
  assert.equal(FakeNotification.shown[0].closed, 1);
  assert.equal(FakeNotification.shown[1].options.body, '等待你回答：Which target? · alpha · Web 1');
});

test('no notification while the window is focused on the active tab showing that Session', () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: TAB.id, focused: true });
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ viewing: true }) });
  assert.equal(FakeNotification.shown.length, 0);
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ viewing: false }) });
  assert.equal(FakeNotification.shown.length, 1, 'a background Session in the active tab still notifies');
});

test('a blurred window notifies even for the Session on screen', () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: TAB.id, focused: true });
  harness.window.emit('blur');
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ viewing: true }) });
  assert.equal(FakeNotification.shown.length, 1);
});

test('the Local host reports with the Local tab label, activates Local, then opens its Session', async () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: TAB.id });
  harness.center.reportHost(payload({ event: 'turn-end', kind: 'turn-end', detail: '' }));
  assert.equal(FakeNotification.shown.length, 1);
  assert.equal(FakeNotification.shown[0].options.body, '回合结束 · 本地');
  FakeNotification.shown[0].onclick();
  assert.equal(harness.window.focusCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.activated, ['local'], 'the Local tab comes forward before the Session opens');
  assert.deepEqual(harness.opened, [{ key: 'local', sessionId: SESSION }]);
});

test('clicking a guest notification activates its tab and asks that guest to open the Session', async () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: 'local' });
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ event: 'turn-end', kind: 'turn-end', detail: '' }) });
  FakeNotification.shown[0].onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.activated, [TAB.id]);
  assert.deepEqual(harness.opened, [{ key: TAB.key, sessionId: SESSION }]);
});

test('reports for a closed tab and denied permission are dropped without throwing', () => {
  const closed = centerHarness({ tabs: [LOCAL], activeId: 'local' });
  closed.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload() });
  assert.equal(FakeNotification.shown.length, 0);
  const denied = centerHarness({ tabs: [LOCAL, TAB], activeId: 'local', permission: 'denied' });
  denied.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload() });
  assert.equal(FakeNotification.shown.length, 0);
  assert.equal(closed.center.reportHost({}), undefined);
});

test('the English copy keeps the scenario, separator and tab label', () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: 'local', locale: 'en-US' });
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ kind: 'plan-review', detail: '' }) });
  assert.equal(FakeNotification.shown[0].options.body, 'Plan awaiting approval · alpha · Web 1');
});

test('the custom tab name replaces the original title in the body', () => {
  const named = { ...TAB, appearance: { name: '发布检查' } };
  const harness = centerHarness({ tabs: [LOCAL, named], activeId: 'local' });
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ event: 'turn-end', kind: 'turn-end', detail: '' }) });
  assert.equal(FakeNotification.shown[0].options.body, '回合结束 · 发布检查');
});

test('an empty title falls back to the localized Session label', () => {
  const harness = centerHarness({ tabs: [LOCAL, TAB], activeId: 'local' });
  harness.center.reportGuest(TAB.key, { type: NOTIFICATION_EVENT, version: NOTIFICATION_VERSION, ...payload({ event: 'turn-end', kind: 'turn-end', title: '', detail: '' }) });
  assert.equal(FakeNotification.shown[0].title, '会话');
});
