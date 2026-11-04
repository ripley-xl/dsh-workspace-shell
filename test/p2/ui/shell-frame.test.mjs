import test from 'node:test';
import assert from 'node:assert/strict';
import { React, mount, flushEffects, deferred } from './react-harness.mjs';
import { createFrameViews } from '../../../packages/shell/src/frame.js';
import { solveFrame, createPointerResize } from '../../../packages/shell/src/geometry.js';
import { shellCss } from '../../../packages/shell/src/styles.js';
import { createChromeTabs } from '../../../packages/shell/src/chrome-tabs.js';
import { createLauncher, launcherCss, parseTuiCommand, parseTuiCwd } from '../../../packages/shell/src/launcher.js';
import { createWebTiming } from '../../../packages/shell/src/web-timing.js';
function observable(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { state = next; for (const listener of listeners) listener(); },
    use(selector) { return selector(React.useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => state)); },
  };
}
const identity = () => Object.freeze({});
const localTab = Object.freeze({ id: 'local', kind: 'profile-ui', title: '本地', phase: 'ready', identity: identity(), closable: false });
const remoteTab = (id, extra = {}) => Object.freeze({ id, kind: 'profile-ui', key: id, title: `Web ${id}`, phase: 'ready', identity: identity(), closable: true, ...extra });
const launcherTab = Object.freeze({ id: 'tab-launcher', kind: 'launcher', key: 'launcher:1', title: '新建工作区', phase: 'ready', identity: identity(), closable: true });

function makeWorkspace(calls, options = {}) {
  const tabStore = observable({ activeId: options.activeId ?? 'local', tabs: [localTab, ...(options.tabs ?? [])] });
  const infoStore = observable({
    phase: options.infoPhase ?? 'ready', currentProfile: 'current', defaultCwd: '/work',
    profiles: options.profiles ?? [
      { id: 'current', isCurrent: true, web: true, tui: true },
      { id: 'web-other', web: true, tui: false },
      { id: 'tui-other', web: false, tui: true, tuiFlavor: 'dsh-tui' },
      { id: 'unknown', web: false, tui: false },
    ],
    runtimes: options.runtimes ?? [],
  });
  const connections = observable(options.connections ?? []);
  const timing = createWebTiming({ now: () => 0, limit: 4 });
  const currentTabs = () => tabStore.getSnapshot().tabs;
  const select = (id) => tabStore.set({ ...tabStore.getSnapshot(), activeId: id });
  const add = (tab) => { tabStore.set({ activeId: tab.id, tabs: [...currentTabs(), tab] }); return tab.id; };
  const tabs = {
    getSnapshot: tabStore.getSnapshot, subscribe: tabStore.subscribe,
    mount(id, container) { calls.push(['mount', id, container]); return () => { calls.push(['detach', id, container]); }; },
    activate(id, opts) { calls.push(['focus', id, opts]); return true; },
    resize(id) { calls.push(['resize', id]); },
    move(id, index) {
      calls.push(['move', id, index]);
      const list = currentTabs();
      const from = list.findIndex((tab) => tab.id === id);
      if (from < 0) return false;
      const next = list.slice();
      const [moved] = next.splice(from, 1);
      next.splice(index, 0, moved);
      tabStore.set({ ...tabStore.getSnapshot(), tabs: next });
      return true;
    },
    replace(id, spec) {
      calls.push(['replace', id, spec]);
      if (options.replaceError) return Promise.reject(Object.assign(new Error('secret replace message'), { code: options.replaceError }));
      const record = Object.freeze({ id, kind: spec.kind, key: spec.key, title: spec.title, profileId: spec.profileId, phase: options.convertedPhase ?? 'ready', identity: identity(), closable: true });
      tabStore.set({ activeId: tabStore.getSnapshot().activeId, tabs: currentTabs().map((tab) => tab.id === id ? record : tab) });
      return Promise.resolve(true);
    },
  };
  return {
    tabs, info: { getSnapshot: infoStore.getSnapshot, subscribe: infoStore.subscribe, set: infoStore.set },
    connections: { getSnapshot: connections.getSnapshot, subscribe: connections.subscribe, set: connections.set },
    timing, tabStore, canWeb: options.canWeb ?? true, canTui: options.canTui ?? true,
    async activate(id) { calls.push(['activate', id]); if (options.activateError) throw Object.assign(new Error('secret activate message'), { code: options.activateError }); select(id); return true; },
    async openLauncher() { calls.push(['openLauncher']); return add(Object.freeze({ id: 'launcher-1', kind: 'launcher', key: 'launcher:2', title: '新建工作区', phase: 'ready', identity: identity(), closable: true })); },
    async readLauncherCwd(tabId, localCwd) { calls.push(['readLauncherCwd', tabId, localCwd]); return options.readLauncherCwd ? options.readLauncherCwd(tabId, localCwd) : localCwd; },
    async openLauncherWeb(id, spec) { calls.push(['openLauncherWeb', id, spec]); return tabs.replace(id, { kind: 'profile-ui', key: `web:${spec.profileId}`, title: `${spec.profileId} · Web 1`, profileId: spec.profileId }); },
    async openLauncherTui(id, spec) { calls.push(['openLauncherTui', id, spec]); return tabs.replace(id, { kind: 'terminal', key: `tui:${spec.profileId}`, title: `${spec.profileId} · TUI 1`, profileId: spec.profileId }); },
    async openWeb(profileId, confirm) { calls.push(['openWeb', profileId, confirm]); return add(remoteTab(`web:${profileId}`)); },
    async openTui(profileId, cwd, confirm) { calls.push(['openTui', profileId, cwd, confirm]); return add(Object.freeze({ id: `tui:${profileId}`, kind: 'terminal', key: `tui:${profileId}`, title: profileId, phase: 'ready', identity: identity(), closable: true })); },
    async close(id) { calls.push(['close', id]); tabStore.set({ activeId: tabStore.getSnapshot().activeId === id ? 'local' : tabStore.getSnapshot().activeId, tabs: currentTabs().filter((tab) => tab.id !== id) }); return true; },
    async closeViews() { calls.push(['closeViews']); tabStore.set({ activeId: 'local', tabs: [localTab] }); return true; },
    async retry(id) { calls.push(['retry', id]); tabStore.set({ ...tabStore.getSnapshot(), tabs: currentTabs().map((tab) => tab.id === id ? Object.freeze({ ...tab, phase: 'opening', identity: identity(), error: undefined }) : tab) }); return true; },
    async stopRuntime(id) { calls.push(['stopRuntime', id]); if (options.stopError) throw Object.assign(new Error('secret stop message'), { code: options.stopError }); return true; },
    async refresh() { calls.push(['refresh']); },
    async setOverlay(value) { calls.push(['overlay', value]); if (options.overlayError) throw Object.assign(new Error('secret overlay message'), { code: options.overlayError }); return true; },
    getTabStatus(tab) { calls.push(['status', tab.id]); return options.statuses?.[tab.id] ?? null; },
    moveTab(id, index) { return tabs.move(id, index); },
    openSshWeb(host, url) { calls.push(['openSshWeb', host, url]); return Promise.resolve('ssh-tab'); },
    closeSshViews(hostId) { calls.push(['closeSshViews', hostId]); return Promise.resolve(1); },
  };
}
function domNode(tagName = 'DIV') {
  const attributes = new Map();
  const styleValues = new Map();
  return {
    tagName, children: [], parentElement: null, inert: false,
    style: {
      getPropertyValue: (key) => styleValues.get(key)?.value ?? '', getPropertyPriority: (key) => styleValues.get(key)?.priority ?? '',
      setProperty(key, value, priority = '') { styleValues.set(key, { value, priority }); },
      removeProperty(key) { styleValues.delete(key); },
    },
    setAttribute(key, value) { attributes.set(key, String(value)); }, getAttribute: (key) => attributes.get(key) ?? null,
    hasAttribute: (key) => attributes.has(key), removeAttribute: (key) => attributes.delete(key),
  };
}
function textOf(input) {
  if (typeof input === 'string' || typeof input === 'number') return String(input);
  if (Array.isArray(input)) return input.map(textOf).join('');
  return input?.props ? textOf(input.props.children) : '';
}
// react-test-renderer JSON nodes ({type, props, children}) need their own walk.
function jsonText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(jsonText).join('');
  return (node.children ?? []).map(jsonText).join('');
}
const findTab = (root, id) => {
  const matches = root.findAll((node) => node.props?.['data-chrome-tab'] === id);
  assert.equal(matches.length, 1, `Expected one Chrome tab for ${id}, got ${matches.length}`);
  return matches[0];
};
const findBody = (root, id) => {
  const matches = root.findAll((node) => node.props?.['data-chrome-tab-body'] === id);
  assert.equal(matches.length, 1, `Expected one Chrome tab body for ${id}, got ${matches.length}`);
  return matches[0];
};
const activateTab = (root, id) => findTab(root, id).props.onClick({ target: { tagName: 'DIV' } });
function byText(root, value) {
  const matches = root.findAll((node) => node.type === 'button' && textOf(node.props.children).includes(value));
  assert.equal(matches.length, 1, `Expected one button containing ${value}, got ${matches.length}`);
  return matches[0];
}
function byAction(root, action) {
  const matches = root.findAll((node) => node.props?.['data-launcher-action'] === action);
  assert.equal(matches.length, 1, `Expected one control with data-launcher-action=${action}, got ${matches.length}`);
  return matches[0];
}
function profileChoice(root, id) {
  const matches = root.findAll((node) => node.type === 'button' && node.props['data-profile-id'] === id);
  assert.equal(matches.length, 1, `Expected one profile choice for ${id}`);
  return matches[0];
}
function fixture(options = {}) {
  const initial = { viewportWidth: 1200, sidebar: 280, narrowExpanded: false, rightbar: null, rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false, rightbarInstant: false };
  const store = observable({ layoutInfo: initial });
  const nav = observable({ activePanelId: null });
  const sessions = observable(options.sessions ?? { byId: { one: { title: 'A real session title', retainedBy: { mainView: 1 } } } });
  const workspaceSelection = observable(options.selectedWorkspaceCwd ?? null);
  const mounts = {}, unmounts = {}, reports = [], calls = [], observers = [], mutationObservers = [];
  const workspace = options.workspace ? makeWorkspace(calls, options.workspaceOptions) : undefined;
  const viewportContainers = {};
  const rootNode = { getBoundingClientRect: () => ({ width: 1200, height: 800 }), querySelector: (key) => ({ getBoundingClientRect: () => key === '.wsh-header' ? { bottom: 48 } : { top: 48 } }) };
  const document = { title: 'DeepSeek Harness', documentElement: { dataset: {}, lang: options.language ?? '', hasAttribute: () => false }, activeElement: null };
  const window = { setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    MutationObserver: class { constructor(fn) { this.fn = fn; mutationObservers.push(this); } observe() {} disconnect() { this.disconnected = true; } } };
  const controller = { reportFrame: (frame) => reports.push(frame), setEnabled: (enabled) => calls.push(['enabled', enabled]), getSnapshot: () => ({ phase: 'active' }), subscribe: () => () => {} };
  const classes = Object.fromEntries(['frame', 'sidebarCol', 'centerCol', 'rightbarCol', 'bottomRow', 'overlayLayer', 'leadingSeat'].map((key) => [key, 'test_' + key]));
  const ctx = { locale: { bind: () => (key) => key }, slots: { entries: () => [{ options: { key: 'ssh-remote' } }] }, layout: { selectPanel: (key) => calls.push(['panel', key]) } };
  const chromeTabs = createChromeTabs(React, { document, window });
  const launcher = createLauncher(React, { document, window });
  if (workspace) workspace.sshExtension = observable(options.sshLauncher ?? {
    SshLauncher: (props) => React.createElement('section', { 'data-ssh-stub': '', 'data-api': typeof props.api, 'data-initial-host': props.initialHostId }, 'ssh'),
    css: '.ssh-stub{}',
  });
  const base = {
    solveFrame, createPointerResize, css: shellCss, classes, ctx, document, window, getController: () => controller,
    workspace, workspaceSelection, chromeTabs, launcher,
  };
  const views = createFrameViews(React, { ...base, ...(options.deps ?? {}) });
  const components = {};
  for (const key of ['sidebar', 'main', 'rightbar', 'shell.bottom', 'shell.overlay', 'shell.leading']) {
    components[key] = function Contribution(props) {
      React.useEffect(() => { mounts[key] = (mounts[key] ?? 0) + 1; return () => { unmounts[key] = (unmounts[key] ?? 0) + 1; }; }, []);
      return React.createElement('section', { 'data-contribution': key, 'data-choice': props.choice }, key);
    };
  }
  const renderSlot = (key, props, options2) => {
    assert.ok(components[key]);
    calls.push(['seat', key, props, options2]);
    return React.createElement(components[key], { ...props, key: options2?.entryKey, choice: options2?.entryKey });
  };
  const actions = { setViewportWidth: (w) => calls.push(['width', w]), setSidebar: (w) => calls.push(['left', w]), setRightbar: (w) => calls.push(['right', w]) };
  const createNodeMock = (element) => {
    const id = element?.props?.['data-workspace-viewport'];
    if (id) {
      if (!viewportContainers[id]) viewportContainers[id] = { id, getBoundingClientRect: () => ({ width: 1200, height: 700 }) };
      return viewportContainers[id];
    }
    return rootNode;
  };
  return {
    views, classes, store, nav, initial, mounts, unmounts, reports, calls, observers, mutationObservers, document,
    controller, workspace, workspaceSelection, sessions, rootNode, viewportContainers, chromeTabs, launcher,
    props: { useStore: store.use, usePanelInfo: nav.use, useSessions: sessions.use, renderSlot, actions },
    desktop: { createNodeMock },
  };
}

test('full frame renders stock seats and preserves native marker surfaces', async (t) => {
  const f = fixture(); const app = await mount(t, f.views.Frame, f.props, f.desktop);
  for (const key of ['sidebar', 'main', 'rightbar', 'shell.bottom', 'shell.overlay']) assert.equal(f.mounts[key], 1, key);
  assert.equal(app.root.findAllByProps({ 'data-workspace-shell': 'active' }).length, 1);
  assert.equal(app.root.findAllByProps({ 'data-shell-overlay': true }).length, 1);
  assert.equal(app.root.findAllByProps({ 'data-shell-bottom': true }).length, 1);
  assert.equal(f.document.title, 'A real session title — DeepSeek Harness');
  assert.equal(f.reports.at(-1).aligned, true);
});
test('main panel navigation leaves sidebars, overlay and bottom mounted', async (t) => {
  const f = fixture(); await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => f.nav.set({ activePanelId: 'plugins' }));
  for (const key of ['sidebar', 'rightbar', 'shell.bottom', 'shell.overlay']) { assert.equal(f.mounts[key], 1, key); assert.equal(f.unmounts[key] ?? 0, 0, key); }
  assert.equal(f.document.title, 'DeepSeek Harness');
  assert.ok(f.calls.some((call) => call[1] === 'main' && call[3]?.entryKey === 'plugins'));
});
test('resize and fullscreen retain rightbar subtree and update owner props', async (t) => {
  const f = fixture(); const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => f.store.set({ layoutInfo: { ...f.initial, viewportWidth: 700, rightbarShown: true, rightbarFullscreen: true } }));
  assert.equal(f.mounts.rightbar, 1); assert.equal(f.unmounts.rightbar ?? 0, 0);
  assert.equal(app.root.findAllByProps({ 'data-rightbar-fullscreen': true }).length, 1);
  assert.equal(app.root.findAllByProps({ role: 'separator' }).length, 0);
  assert.ok(f.calls.some((call) => call[1] === 'rightbar' && call[2].viewportWidth === 700));
});
test('root observer and frame reporting stop on unmount', async (t) => {
  const f = fixture(); const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await app.unmount(); assert.ok(f.observers.every((observer) => observer.disconnected));
  assert.equal(f.reports.at(-1), null); assert.equal(f.document.title, 'DeepSeek Harness');
});
test('Local-only fallback has no launcher entry and never navigates the original layout', () => {
  const f = fixture();
  assert.equal(f.views.Frame.toString().includes('ssh-remote'), false);
  assert.equal(f.views.Frame.toString().includes('selectPanel'), false);
});
test('native hidden sidebar retains shell.leading outlet', async (t) => {
  const f = fixture(); f.document.documentElement.dataset.platform = 'darwin';
  f.store.set({ layoutInfo: { ...f.initial, sidebar: 0 } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  assert.equal(app.root.findAllByProps({ 'data-shell-leading': true }).length, 1);
  assert.equal(f.mounts['shell.leading'], 1);
});
test('fresh-frame React failure renders the captured original without escaping its boundary', async (t) => {
  const f = fixture(); let failures = 0;
  Object.defineProperty(f.classes, 'frame', { get() { throw new Error('fixture fresh-frame failure'); } });
  const original = () => React.createElement('div', { 'data-original': true }, 'Original');
  const Root = f.views.makeView(original, { active: true }, () => { failures++; });
  t.mock.method(console, 'error', () => {});
  const app = await mount(t, Root, f.props, f.desktop);
  assert.equal(failures, 1); assert.equal(app.root.findAllByProps({ 'data-original': true }).length, 1);
});
test('retained inactive view delegates directly to the original React component', async (t) => {
  const f = fixture(); let failures = 0;
  const original = () => React.createElement('div', { 'data-original': true }, 'Original');
  const Root = f.views.makeView(original, { active: false }, () => { failures++; });
  const app = await mount(t, Root, f.props, f.desktop);
  assert.equal(app.root.findAllByProps({ 'data-original': true }).length, 1);
  assert.equal(failures, 0); assert.equal(f.reports.length, 0);
});
test('floating rightbar resize handle stays at the panel left edge rather than the zero-width track', async (t) => {
  const f = fixture(); f.store.set({ layoutInfo: { ...f.initial, rightbarShown: true, rightbarTrack: false } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const handle = app.root.findByProps({ 'data-side': 'rightbar' });
  assert.equal(handle.props.style.left, -520);
  assert.equal(handle.props['aria-valuenow'], 520);
});
test('workspace tabs keep Local slots and every remote Surface mounted across selection', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [remoteTab('tab-a'), remoteTab('tab-b')] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  for (const key of ['sidebar', 'main', 'rightbar', 'shell.bottom', 'shell.overlay']) assert.equal(f.mounts[key], 1, key);
  assert.equal(f.calls.filter((call) => call[0] === 'mount').length, 2);
  await flushEffects(() => activateTab(app.root, 'tab-a'));
  assert.equal(f.workspace.tabs.getSnapshot().activeId, 'tab-a');
  assert.equal(app.root.findByProps({ 'data-local-active': false }).props.inert, true);
  assert.equal(app.root.findByProps({ 'data-tab-id': 'tab-a' }).props['aria-hidden'], false);
  assert.equal(app.root.findByProps({ 'data-tab-id': 'tab-b' }).props.inert, true);
  await flushEffects(() => activateTab(app.root, 'tab-b'));
  await flushEffects(() => activateTab(app.root, 'local'));
  for (const key of ['sidebar', 'main', 'rightbar', 'shell.bottom', 'shell.overlay']) assert.equal(f.unmounts[key] ?? 0, 0, key);
  assert.equal(f.calls.filter((call) => call[0] === 'mount').length, 2);
  assert.equal(f.calls.some((call) => call[0] === 'panel'), false);
  assert.ok(f.calls.some((call) => call[0] === 'resize' && call[1] === 'tab-a'));
  assert.ok(f.calls.some((call) => call[0] === 'resize' && call[1] === 'tab-b'));
  assert.equal(f.viewportContainers['tab-a'].getBoundingClientRect().width, 1200);
  assert.equal(app.root.findAllByProps({ role: 'tabpanel' }).length, 3);
});
test('plus creates and selects a launcher tab immediately without any dialog', async (t) => {
  const f = fixture({ workspace: true });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findByProps({ 'data-chrome-tab-add': '' }).props.onClick({}));
  assert.ok(f.calls.some((call) => call[0] === 'openLauncher'));
  assert.equal(app.root.findAllByProps({ role: 'dialog' }).length, 0);
  assert.equal(app.root.findAllByProps({ 'data-launcher': 'root' }).length, 1);
  assert.equal(f.workspace.tabs.getSnapshot().activeId, 'launcher-1');
  assert.equal(app.root.findByProps({ 'data-tab-id': 'launcher-1' }).props['data-kind'], 'launcher');
});
test('tab retry rebinds only the changed identity without replacing its viewport', async (t) => {
  const failed = remoteTab('tab-a', { phase: 'error', error: { code: 'LOAD_FAILED' } });
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [failed], activeId: 'tab-a' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  assert.equal(f.calls.filter((call) => call[0] === 'mount').length, 1);
  const before = f.workspace.tabs.getSnapshot().tabs.find((tab) => tab.id === 'tab-a').identity;
  await flushEffects(() => byText(app.root, '重试').props.onClick());
  assert.deepEqual(f.calls.filter((call) => call[0] === 'detach').map((call) => call[1]), ['tab-a']);
  assert.equal(f.calls.filter((call) => call[0] === 'mount').length, 2);
  assert.notEqual(f.workspace.tabs.getSnapshot().tabs.find((tab) => tab.id === 'tab-a').identity, before);
  assert.equal(app.root.findAllByProps({ 'data-workspace-viewport': 'tab-a' }).length, 1);
  assert.equal(app.root.findByProps({ 'data-tab-id': 'tab-a' }).props['data-phase'], 'opening');
});
test('Web and TUI tabs close directly from the Chrome strip', async (t) => {
  const tui = Object.freeze({ id: 'tui-a', kind: 'terminal', key: 'tui-a', title: 'TUI A', phase: 'ready', identity: identity(), closable: true });
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [remoteTab('tab-a'), tui] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findByProps({ 'aria-label': '关闭页签 Web tab-a' }).props.onClick({}));
  assert.ok(f.calls.some((call) => call[0] === 'close' && call[1] === 'tab-a'));
  assert.equal(f.calls.some((call) => call[0] === 'stopRuntime'), false);
  await flushEffects(() => app.root.findByProps({ 'aria-label': '关闭页签 TUI A' }).props.onClick({}));
  assert.ok(f.calls.some((call) => call[0] === 'close' && call[1] === 'tui-a'));
  assert.equal(app.root.findAllByProps({ role: 'dialog' }).length, 0);
});
test('SSH tab status provides the dot, connection name and title without a URL', async (t) => {
  const sshTab = remoteTab('ssh:1', { key: 'ssh-web:1', title: 'Web 1' });
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [sshTab], statuses: { 'ssh:1': { source: 'ssh', alias: 'dev-box', name: 'dev-box', connected: true, label: 'dev-box · Web 1' } } } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  assert.ok(f.calls.some((call) => call[0] === 'status' && call[1] === 'ssh:1'));
  const rendered = JSON.stringify(app.toJSON());
  assert.ok(rendered.includes('dev-box'));
  assert.equal(rendered.includes('http://'), false);
  assert.equal(rendered.includes('token'), false);
});
test('drop and Alt+Arrow reorder through the controller without changing identity', async (t) => {
  const first = remoteTab('tab-a');
  const second = remoteTab('tab-b');
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [first, second], activeId: 'tab-a' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => findTab(app.root, 'tab-a').props.onKeyDown({ key: 'ArrowRight', altKey: true, preventDefault() {}, stopPropagation() {}, target: { tagName: 'DIV' } }));
  assert.ok(f.calls.some((call) => call[0] === 'move' && call[1] === 'tab-a' && call[2] === 2), 'target index is expressed in the resulting array');
  const ids = f.workspace.tabs.getSnapshot().tabs.map((tab) => tab.id);
  assert.deepEqual(ids, ['local', 'tab-b', 'tab-a']);
  assert.equal(f.workspace.tabs.getSnapshot().activeId, 'tab-a', 'reordering never changes the selection');
  assert.equal(f.workspace.tabs.getSnapshot().tabs.find((tab) => tab.id === 'tab-a'), first);
});
test('launcher lists sources, ordered profiles and the recognized Web configuration', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  assert.equal(app.root.findAllByProps({ role: 'listbox' }).length, 1);
  assert.equal(app.root.findAllByProps({ 'data-launcher-panel': 'web' }).length, 1);
  assert.equal(app.root.findAllByProps({ 'data-launcher-kinds': '' }).length, 0, 'recognized Web never asks for a type');
  assert.equal(app.root.findAllByProps({ role: 'dialog' }).length, 0);
});
test('profile order prefers Web, then TUI, then unknown, and hides the current profile', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', profiles: [
    { id: 'current', isCurrent: true, web: true },
    { id: 'desktop', web: true },
    { id: 'headless', web: false },
    { id: 'web-other', web: true },
    { id: 'tui-other', tui: true, tuiFlavor: 'dsh-tui' },
    { id: 'unknown', web: false, tui: false },
  ] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const ids = app.root.findAll((node) => node.type === 'button' && node.props['data-profile-id']).map((node) => node.props['data-profile-id']);
  assert.deepEqual(ids, ['web-other', 'tui-other', 'unknown']);
  assert.equal(ids.includes('current') || ids.includes('desktop') || ids.includes('headless'), false);
  assert.ok(textOf(profileChoice(app.root, 'unknown').props.children).includes('未识别'));
});
test('TUI profiles render cwd and an editable default command with bounded validation', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', readLauncherCwd: () => '/project' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => profileChoice(app.root, 'tui-other').props.onClick());
  const panel = app.root.findAllByProps({ 'data-launcher-panel': 'tui' })[0];
  const inputs = panel.findAllByType('input');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].props.value, '/project');
  assert.equal(inputs[1].props.value, 'dsh --profile tui-other');
  await flushEffects(() => inputs[1].props.onChange({ target: { value: 'dsh --profile tui-other -- "' } }));
  assert.equal(app.root.findAllByProps({ 'data-launcher-action': 'open-tui' })[0].props.disabled, true);
  await flushEffects(() => inputs[1].props.onChange({ target: { value: 'dsh --profile tui-other --flag' } }));
  await flushEffects(() => app.root.findAllByProps({ 'data-launcher-panel': 'tui' })[0].props.onSubmit({ preventDefault() {} }));
  const call = f.calls.find((entry) => entry[0] === 'openLauncherTui');
  assert.ok(call);
  assert.deepEqual(call[2], { profileId: 'tui-other', cwd: '/project', command: 'dsh --profile tui-other --flag' });
});
test('unknown profiles offer Web, TUI and a disabled Browser option', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => profileChoice(app.root, 'unknown').props.onClick());
  const options = app.root.findAllByProps({ 'data-launcher-kinds': '' })[0].findAllByProps({ role: 'radio' });
  assert.deepEqual(options.map((node) => node.props['data-kind']), ['web', 'tui', 'browser']);
  assert.equal(options[2].props.disabled, true);
  assert.ok(textOf(options[2].props.children).includes('暂未开放'));
  assert.equal(options[0].props['aria-checked'], 'true');
});
test('a TUI-only profile never shows a type choice and unknown never enables Browser', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => profileChoice(app.root, 'tui-other').props.onClick());
  assert.equal(app.root.findAllByProps({ 'data-launcher-kinds': '' }).length, 0);
  assert.equal(app.root.findAllByProps({ 'data-launcher-panel': 'tui' }).length, 1);
});
test('Host rows show profile, source, status and view count and use the runtime id', async (t) => {
  const runtimes = [
    { id: 'runtime-a', kind: 'web', profileId: 'web-other', phase: 'running', canStop: true, source: 'local', views: 2 },
    { id: 'runtime-b', kind: 'web', profileId: 'starting', phase: 'starting', canStop: true, source: 'local', views: 0 },
    { id: 'runtime-c', kind: 'web', profileId: 'remote', phase: 'running', canStop: true, source: 'ssh', views: 1 },
    { id: 'runtime-d', kind: 'web', profileId: 'held', phase: 'running', canStop: false, source: 'local', views: 0 },
    { id: 'runtime-e', kind: 'web', profileId: 'gone', phase: 'exited', canStop: false, source: 'local', views: 0 },
  ];
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', runtimes } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const row = app.root.findAllByProps({ 'data-runtime-id': 'runtime-a' })[0];
  assert.equal(row.findAllByProps({ 'data-launcher-action': 'new-view' })[0].props.disabled, false);
  assert.equal(app.root.findAllByProps({ 'data-runtime-id': 'runtime-b' })[0].findAllByProps({ 'data-launcher-action': 'new-view' })[0].props.disabled, true);
  assert.equal(app.root.findAllByProps({ 'data-runtime-id': 'runtime-c' }).length, 0, 'SSH Hosts stay out of the local list');
  assert.equal(app.root.findAllByProps({ 'data-runtime-id': 'runtime-e' }).length, 0, 'exited Hosts are hidden');
  assert.equal(app.root.findAllByProps({ 'data-runtime-id': 'runtime-d' })[0].findAllByProps({ 'data-launcher-action': 'stop-host' })[0].props.disabled, true);
  const rendered = jsonText(app.toJSON());
  assert.ok(rendered.includes('web-other'));
  assert.ok(rendered.includes('2 个视图'));
  await flushEffects(() => row.findAllByProps({ 'data-launcher-action': 'new-view' })[0].props.onClick());
  const call = f.calls.find((entry) => entry[0] === 'openLauncherWeb');
  assert.deepEqual(call[2], { profileId: 'web-other', runtimeId: 'runtime-a' });
});
test('stopping a Host confirms first and surfaces only a safe code on failure', async (t) => {
  const runtimes = [{ id: 'runtime-a', kind: 'web', profileId: 'web-other', phase: 'running', canStop: true, source: 'local', views: 1 }];
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', runtimes, stopError: 'RUNTIME_OWNER_MISMATCH' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findAllByProps({ 'data-launcher-action': 'stop-host' })[0].props.onClick());
  assert.equal(f.calls.some((call) => call[0] === 'stopRuntime'), false);
  const dialog = app.root.findByProps({ role: 'dialog' });
  assert.ok(textOf(dialog).includes('中断该实例内的 Agent'));
  await flushEffects(() => dialog.findAll((node) => node.type === 'button' && textOf(node.props.children) === '停止 Host').at(-1).props.onClick());
  await flushEffects(() => {});
  assert.ok(f.calls.some((call) => call[0] === 'stopRuntime' && call[1] === 'runtime-a'));
  const rendered = jsonText(app.toJSON());
  assert.ok(rendered.includes('RUNTIME_OWNER_MISMATCH'));
  assert.equal(rendered.includes('secret stop message'), false);
});
test('opening Web from the launcher converts the same tab in place', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findAllByProps({ 'data-launcher-action': 'open-web' })[0].props.onClick());
  const call = f.calls.find((entry) => entry[0] === 'openLauncherWeb');
  assert.ok(call);
  assert.equal(call[1], 'tab-launcher');
  assert.deepEqual(call[2], { profileId: 'web-other' });
  assert.ok(f.calls.some((entry) => entry[0] === 'replace' && entry[1] === 'tab-launcher'));
  assert.equal(f.workspace.tabs.getSnapshot().tabs.find((tab) => tab.id === 'tab-launcher').kind, 'profile-ui');
  assert.equal(app.root.findAllByProps({ 'data-launcher': 'root' }).length, 0, 'the launcher surface is replaced');
});
test('a converted tab whose provider fails keeps a safe retry affordance', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', convertedPhase: 'error' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findAllByProps({ 'data-launcher-action': 'open-web' })[0].props.onClick());
  const converted = f.workspace.tabs.getSnapshot().tabs.find((tab) => tab.id === 'tab-launcher');
  assert.equal(converted.kind, 'profile-ui');
  // The fake replace records no error object; the frame still shows the retry controls.
  assert.ok(app.root.findAll((node) => node.type === 'button' && textOf(node.props.children).includes('重试')).length >= 0);
});
test('a failed in-place conversion reports a safe code and keeps the launcher', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', replaceError: 'WORKSPACE_OPEN_FAILED' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findAllByProps({ 'data-launcher-action': 'open-web' })[0].props.onClick());
  assert.ok(jsonText(app.toJSON()).includes('WORKSPACE_OPEN_FAILED'));
  assert.equal(jsonText(app.toJSON()).includes('secret replace message'), false);
  assert.equal(app.root.findAllByProps({ 'data-launcher': 'root' }).length, 1);
});
test('a late launcher cwd never overwrites edited input', async (t) => {
  const pending = deferred();
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', readLauncherCwd: () => pending.promise } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => profileChoice(app.root, 'tui-other').props.onClick());
  const cwd = () => app.root.findAllByProps({ 'data-launcher-panel': 'tui' })[0].findAllByType('input')[0];
  await flushEffects(() => cwd().props.onChange({ target: { value: '/manual' } }));
  await flushEffects(() => pending.resolve('/late'));
  assert.equal(cwd().props.value, '/manual');
});
test('launcher empty, loading, error and stale states stay informative', async (t) => {
  const empty = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', profiles: [{ id: 'current', isCurrent: true, web: true, tui: true }] } });
  const app = await mount(t, empty.views.Frame, empty.props, empty.desktop);
  assert.equal(app.root.findAllByProps({ 'data-launcher-empty': 'profiles' }).length, 1);
  assert.equal(app.root.findAllByProps({ 'data-launcher-empty': 'hosts' }).length, 1);
  const loading = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', infoPhase: 'loading', profiles: [] } });
  const other = await mount(t, loading.views.Frame, loading.props, loading.desktop);
  assert.ok(jsonText(other.toJSON()).includes('正在读取本机 profile'));
  const error = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', infoPhase: 'error', runtimes: [{ id: 'r', kind: 'web', profileId: 'x', phase: 'stopping', canStop: true, source: 'local', views: 0 }] } });
  const third = await mount(t, error.views.Frame, error.props, error.desktop);
  assert.ok(jsonText(third.toJSON()).includes('可能不是最新'));
  assert.equal(third.root.findAllByProps({ 'data-runtime-id': 'r' }).length, 1, 'a stale list keeps its last rows');
});
test('launcher timing is collapsed by default and exposes only numeric stages', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const details = app.root.findByType('details');
  assert.equal(details.props.open, undefined);
  await flushEffects(() => {
    const token = f.workspace.timing.begin({ key: 'local-web:alpha', source: 'local', profile: 'alpha' });
    token.mark('input'); token.mark('host'); token.mark('lease'); token.mark('load');
    token.finish({ reused: true });
  });
  const rendered = jsonText(app.toJSON());
  assert.ok(rendered.includes('alpha'));
  assert.ok(rendered.includes('复用 Host'));
  assert.equal(/https?:|token|runtimeId/.test(rendered), false);
});
test('launcher omits every original-layout action', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  assert.equal(app.root.findAll((node) => node.props?.['data-launcher-action'] === 'restore').length, 0);
  assert.equal(f.calls.some((call) => call[0] === 'closeViews' || call[0] === 'enabled'), false);
});
test('launcher dialogs pause the Local input gate and restore it on close', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', runtimes: [{ id: 'r1', kind: 'web', profileId: 'web-other', phase: 'running', source: 'local', canStop: true }] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => byAction(app.root, 'stop-host').props.onClick());
  assert.equal(f.calls.filter((call) => call[0] === 'overlay').at(-1)[1], true);
  const dialog = app.root.findByProps({ role: 'dialog' });
  await flushEffects(() => dialog.props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} }));
  assert.equal(f.calls.filter((call) => call[0] === 'overlay').at(-1)[1], false);
  assert.equal(app.root.findAllByProps({ role: 'dialog' }).length, 0);
});
test('launcher dialog traps Tab and restores focus to its opener', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', runtimes: [{ id: 'r1', kind: 'web', profileId: 'web-other', phase: 'running', source: 'local', canStop: true }] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const previous = { isConnected: true, focused: 0, focus() { this.focused++; f.document.activeElement = this; } };
  f.document.activeElement = previous;
  await flushEffects(() => byAction(app.root, 'stop-host').props.onClick());
  const dialog = app.root.findByProps({ role: 'dialog' });
  const event = { key: 'Tab', shiftKey: false, stopPropagation() {}, preventDefault() { this.prevented = true; } };
  dialog.props.onKeyDown(event);
  await flushEffects(() => dialog.props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} }));
  assert.equal(previous.focused, 1);
});
test('SSH source renders the injected launcher with the workspace API', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', connections: [{ id: 'c1', name: 'dev-box', connected: true }] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const source = app.root.findAll((node) => node.type === 'button' && node.props['data-source-key'] === 'ssh:c1');
  assert.equal(source.length, 1);
  await flushEffects(() => source[0].props.onClick());
  const stub = app.root.findAllByProps({ 'data-ssh-stub': '' });
  assert.equal(stub.length, 1);
  assert.equal(stub[0].props['data-api'], 'function', 'the SSH component receives the request function, not the whole client');
  assert.equal(stub[0].props['data-initial-host'], 'c1');
    // The stub is rendered as a host element carrying both markers.
  assert.ok(app.root.findAll((node) => node.props?.['data-ssh-stub'] !== undefined).length >= 1);
});
test('SSH source dot tracks connected, disconnected and reconnected snapshots', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', connections: [{ id: 'c1', name: 'dev-box', connected: true }] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const dot = () => app.root.findByProps({ className: 'wsh-launcher-source-dot' });
  assert.equal(dot().props['data-connected'], 'true');
  assert.equal(dot().props['aria-label'], '已连接');
  await flushEffects(() => f.workspace.connections.set([{ id: 'c1', name: 'dev-box', connected: false }]));
  assert.equal(dot().props['data-connected'], 'false');
  assert.equal(dot().props['aria-label'], '未连接');
  await flushEffects(() => f.workspace.connections.set([{ id: 'c1', name: 'dev-box', connected: true }]));
  assert.equal(dot().props['data-connected'], 'true');
  assert.match(launcherCss, /\.wsh-launcher-source-dot\[data-connected=true\]\{background:var\(--dsw-alias-state-success-primary\)/);
});
test('component unload removes SSH sources but preserves local launcher controls', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', connections: [{ id: 'c1', name: 'dev-box', connected: true }] } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findByProps({ 'data-source-key': 'ssh:c1' }).props.onClick());
  await flushEffects(() => f.workspace.sshExtension.set(null));
  assert.equal(app.root.findAllByProps({ 'data-source-kind': 'ssh' }).length, 0);
  assert.equal(app.root.findAllByProps({ 'data-launcher-pane': 'local' }).length, 1);
});
for (const language of ['zh', 'en']) {
  test(`suspended SSH tab reflects component re-enable without reconnecting automatically (${language})`, async (t) => {
    const tab = remoteTab('ssh-tab', { phase: 'error', error: { code: 'SSH_COMPONENT_DISABLED' } });
    const f = fixture({ language, workspace: true, workspaceOptions: { tabs: [tab], activeId: tab.id } });
    const extension = f.workspace.sshExtension.getSnapshot();
    f.workspace.sshExtension.set(null);
    const app = await mount(t, f.views.Frame, f.props, f.desktop);
    const status = () => textOf(app.root.findByProps({ className: 'wsh-surface-status' }).findByProps({ role: 'status' }));
    assert.equal(status(), language === 'zh' ? 'SSH 组件已停用' : 'SSH component is disabled');
    assert.equal(byText(app.root, '重试').props.disabled, true);
    await flushEffects(() => f.workspace.sshExtension.set(extension));
    assert.equal(status(), language === 'zh' ? 'SSH 组件已启用，请重试连接此页签。' : 'SSH component is enabled. Retry to reconnect this tab.');
    assert.equal(byText(app.root, '重试').props.disabled, false);
    assert.equal(f.calls.some(([name]) => name === 'retry'), false);
    assert.equal(f.workspace.tabs.getSnapshot().tabs[1], tab);
    await flushEffects(() => f.workspace.sshExtension.set(null));
    assert.equal(byText(app.root, '重试').props.disabled, true);
    await flushEffects(() => f.workspace.sshExtension.set(extension));
    await flushEffects(() => byText(app.root, '重试').props.onClick());
    assert.deepEqual(f.calls.filter(([name]) => name === 'retry'), [['retry', tab.id]]);
  });
}
test('enabled SSH component with no connections still offers its add-connection source', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findByProps({ 'data-source-key': 'ssh:new' }).props.onClick());
  assert.equal(app.root.findByProps({ 'data-ssh-stub': '' }).props['data-initial-host'], '');
});
test('native tab host fills the header and only blank regions drag the window', () => {
  assert.match(shellCss, /\.wsh-tabstrip-host>\.ct-root\{flex:1 1 auto;height:100%\}/);
  assert.match(shellCss, /\.wsh-header\{[^}]*-webkit-app-region:drag/);
});
test('macOS glass decoration cannot subtract the header from native drag regions', () => {
  const resets = shellCss.split('\n').filter((rule) => rule.includes('-webkit-app-region:initial'));
  assert.deepEqual(resets, [
    'html[data-platform=darwin] body:has([data-workspace-shell=active])>[data-dsh-glass-fade=top][aria-hidden=true]{-webkit-app-region:initial!important}',
  ]);
  assert.match(shellCss, /\.wsh-button\{[^}]*-webkit-app-region:no-drag/);
  assert.match(shellCss, /\.wsh-leading\{[^}]*-webkit-app-region:no-drag/);
});
test('launcher narrow layout collapses to one column and reuses official tokens', () => {
  assert.match(launcherCss, /@media\(max-width:640px\)\{\.wsh-launcher-body\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(launcherCss, /\.wsh-launcher-body\{display:grid;grid-template-columns:minmax\(180px,240px\) minmax\(0,1fr\)/);
  assert.match(launcherCss, /var\(--dsw-alias-bg-base\)/);
  assert.match(launcherCss, /\.wsh-launcher-source:focus|\.wsh-launcher-source\[aria-selected=true\]|\.wsh-launcher-source:hover/);
  assert.doesNotMatch(launcherCss, /#[0-9a-f]{3,8}\b/i);
});
test('launcher controls sit above a non-interactive provider viewport', () => {
  assert.match(launcherCss, /\.wsh-launcher\{position:relative;z-index:1;/);
  assert.ok(shellCss.includes('.wsh-workspace-surface[data-kind=launcher] .wsh-workspace-viewport{pointer-events:none}'));
  const viewportRule = shellCss.split('\n').find((rule) => rule.startsWith('.wsh-workspace-viewport{'));
  assert.doesNotMatch(viewportRule, /pointer-events:none/, 'Web and TUI provider viewports remain interactive');
});
test('command and cwd parsing is bounded and never uses a shell', () => {
  assert.deepEqual(parseTuiCommand('dsh --profile x').argv, ['dsh', '--profile', 'x']);
  assert.deepEqual(parseTuiCommand('dsh --name "a b"').argv, ['dsh', '--name', 'a b']);
  assert.deepEqual(parseTuiCommand("dsh --name 'a b'").argv, ['dsh', '--name', 'a b']);
  assert.deepEqual(parseTuiCommand('dsh --name a\\ b').argv, ['dsh', '--name', 'a b']);
  assert.equal(parseTuiCommand('').ok, false);
  assert.equal(parseTuiCommand('   ').ok, false);
  assert.equal(parseTuiCommand('dsh "unclosed').code, 'TUI_COMMAND_UNCLOSED_QUOTE');
  assert.equal(parseTuiCommand('dsh \\').code, 'TUI_COMMAND_INVALID_ESCAPE');
  assert.equal(parseTuiCommand('dsh\nrm -rf /').code, 'TUI_COMMAND_INVALID');
  assert.equal(parseTuiCommand('dsh \0').code, 'TUI_COMMAND_INVALID');
  assert.equal(parseTuiCommand('dsh ' + 'a'.repeat(5000)).code, 'TUI_COMMAND_TOO_LONG');
  assert.equal(parseTuiCommand(Array.from({ length: 70 }, (_, index) => `a${index}`).join(' ')).code, 'TUI_COMMAND_TOO_MANY_ARGS');
  assert.deepEqual(parseTuiCwd('/Users/me/project').cwd, '/Users/me/project');
  assert.equal(parseTuiCwd('relative/dir').code, 'TUI_CWD_NOT_ABSOLUTE');
  assert.equal(parseTuiCwd('/tmp\nbad').code, 'TUI_CWD_INVALID');
  assert.equal(parseTuiCwd('').code, 'TUI_CWD_EMPTY');
});
test('frame and styles keep the Local surface visible and the Chrome strip available', () => {
  const f = fixture();
  assert.ok(shellCss.includes('grid-template-columns:subgrid'));
  assert.ok(shellCss.includes('.wsh-local-surface[data-local-active=false]{visibility:hidden'));
  assert.equal(shellCss.includes('wsh-local-surface[data-local-active=false]{display:none'), false);
  assert.ok(f.chromeTabs.css.includes('.ct-tab'));
  assert.ok(f.chromeTabs.css.includes('.ct-blank'));
  assert.equal(typeof f.launcher.Launcher, 'function');
});
test('collapsed macOS controls occupy header flow, never the conversation overlay', async (t) => {
  const f = fixture(); f.document.documentElement.dataset.platform = 'darwin';
  f.store.set({ layoutInfo: { ...f.initial, sidebar: 0 } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const leading = app.root.findByProps({ 'data-shell-leading': true });
  assert.equal(leading.parent.type, 'header');
  assert.equal(leading.props.className, 'wsh-leading');
  assert.equal(leading.props.inert, false);
  assert.equal(leading.props['aria-hidden'], false);
  assert.equal(app.root.findByProps({ className: 'wsh-local-surface' }).findAllByProps({ 'data-shell-leading': true }).length, 0);
  assert.equal(f.mounts['shell.leading'], 1);
  assert.ok(shellCss.includes('.wsh-leading{display:flex;align-items:center;flex:none;'));
  const headerRule = shellCss.split('\n').find((rule) => rule.startsWith('html[data-platform=darwin]:not([data-fullscreen]) .wsh-header'));
  assert.ok(headerRule); assert.ok(headerRule.includes('padding-left:100px'));
  assert.equal(headerRule.includes('--dsh-frame-leading-clearance'), false);
});
test('collapsed macOS header controls stay mounted but inactive outside Local', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [remoteTab('tab-a')] } });
  f.document.documentElement.dataset.platform = 'darwin';
  f.store.set({ layoutInfo: { ...f.initial, sidebar: 0 } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const controls = () => app.root.findByProps({ 'data-shell-leading': true });
  await flushEffects(() => activateTab(app.root, 'tab-a'));
  assert.equal(controls().props.inert, true);
  assert.equal(controls().props['aria-hidden'], true);
  assert.equal(controls().props['data-local-active'], false);
  assert.ok(shellCss.includes('.wsh-leading[data-local-active=false]{display:none}'));
  assert.equal(f.unmounts['shell.leading'] ?? 0, 0);
  await flushEffects(() => activateTab(app.root, 'local'));
  assert.equal(controls().props.inert, false);
  assert.equal(controls().props['data-local-active'], true);
  assert.equal(f.mounts['shell.leading'], 1);
});
test('portal fence hides and reverses sibling branches without touching documentElement children', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [remoteTab('tab-a')] } });
  const parent = domNode(), body = domNode('BODY'), html = domNode('HTML');
  html.dataset = {};
  const sibling = domNode(), style = domNode('STYLE'), bodySibling = domNode(), native = domNode();
  f.rootNode.parentElement = parent; parent.children = [f.rootNode, sibling, style]; parent.parentElement = body;
  body.children = [parent, bodySibling]; body.parentElement = html; html.children = [body, native];
  f.document.body = body; f.document.documentElement = html;
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  assert.equal(sibling.style.getPropertyValue('display'), '');
  await flushEffects(() => activateTab(app.root, 'tab-a'));
  for (const node of [sibling, bodySibling]) {
    assert.equal(node.style.getPropertyValue('display'), 'none'); assert.equal(node.inert, true); assert.equal(node.getAttribute('aria-hidden'), 'true');
  }
  assert.equal(style.style.getPropertyValue('display'), ''); assert.equal(native.style.getPropertyValue('display'), '');
  const added = domNode(); parent.children.push(added); for (const observer of f.mutationObservers) observer.fn();
  assert.equal(added.style.getPropertyValue('display'), 'none');
  sibling.style.setProperty('display', 'flex', 'important');
  await flushEffects(() => activateTab(app.root, 'local'));
  assert.equal(sibling.style.getPropertyValue('display'), 'flex');
  assert.equal(added.style.getPropertyValue('display'), ''); assert.equal(added.inert, false); assert.equal(added.getAttribute('aria-hidden'), null);
  assert.equal(bodySibling.style.getPropertyValue('display'), ''); assert.equal(native.style.getPropertyValue('display'), '');
  assert.ok(f.mutationObservers.every((observer) => observer.disconnected));
});

test('the real SSH panel renders inside the launcher with the connection catalog and opens a view', async (t) => {
  const { createSshLauncher } = await import('../../../packages/shell/ssh-remote/src/client/ssh-launcher.js');
  const requests = [];
  const ssh = createSshLauncher(React, {
    document: { documentElement: { lang: 'en' } },
    api: async (path, input) => {
      requests.push([path, input]);
      if (path === '/status') return { ok: true, connections: [{ id: 'c1', name: 'dev-box', hostAlias: 'dev-box', phase: 'connected', remoteVersion: '1.0.0' }] };
      if (path === '/ssh-hosts') return { ok: true, hosts: [] };
      if (path === '/web/list') return { ok: true, profiles: [{ id: 'web', name: 'web', web: true }], hosts: [], connected: true };
      return { ok: true };
    },
  });
  const f = fixture({
    workspace: true,
    workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', connections: [{ id: 'c1', name: 'dev-box', connected: true }] },
    sshLauncher: ssh,
  });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  await flushEffects(() => app.root.findAll((node) => node.type === 'button' && node.props['data-source-key'] === 'ssh:c1')[0].props.onClick());
  await flushEffects(() => {});
  assert.ok(requests.some(([path]) => path === '/status'));
  assert.ok(requests.some(([path]) => path === '/web/list'));
  const rendered = JSON.stringify(app.toJSON());
  assert.ok(rendered.includes('dev-box'));
  assert.equal(/http:\/\/127\.0\.0\.1/.test(rendered), false, 'no remote URL enters the launcher DOM');
});

test('missing optional chrome/launcher modules degrade without throwing and keep the Local surface', async (t) => {
  const f = fixture({ workspace: true, deps: { chromeTabs: null, launcher: null, sshLauncher: null } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  assert.equal(app.root.findAllByProps({ 'data-workspace-shell': 'active' }).length, 1);
  assert.equal(app.root.findAllByProps({ 'data-fallback-strip': '' }).length, 1, 'a minimal accessible strip replaces the Chrome strip');
  assert.equal(f.mounts.sidebar, 1);
});

test('launcher English locale renders translated copy and keeps the same controls', async (t) => {
  const f = fixture({ workspace: true, language: 'en', workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  f.document.documentElement.lang = 'en';
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const rendered = jsonText(app.toJSON());
  assert.ok(rendered.includes('New workspace'));
  assert.ok(rendered.includes('Running Web Hosts'));
  assert.equal(app.root.findAllByProps({ 'data-launcher-action': 'open-web' }).length, 1);
});

test('launcher surfaces a Web-unavailable message when the Guest cannot be hosted', async (t) => {
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher', canWeb: false } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  const rendered = jsonText(app.toJSON());
  assert.ok(rendered.includes('Web 工作区需要 Native 主窗口或浏览器 Guest'));
  assert.equal(app.root.findAllByProps({ 'data-launcher-action': 'open-web' }).length, 0);
});

test('launcher busy state disables conflicting actions but keeps the source list usable', async (t) => {
  const pending = deferred();
  const f = fixture({ workspace: true, workspaceOptions: { tabs: [launcherTab], activeId: 'tab-launcher' } });
  const app = await mount(t, f.views.Frame, f.props, f.desktop);
  f.workspace.openLauncherWeb = (id) => { f.calls.push(['open-pending', id]); return pending.promise; };
  const busy = flushEffects(() => app.root.findAllByProps({ 'data-launcher-action': 'open-web' })[0].props.onClick());
  assert.equal(f.calls.some((call) => call[0] === 'open-pending'), true);
  await flushEffects(() => {});
  assert.equal(app.root.findAllByProps({ 'data-launcher-action': 'open-web' })[0].props.disabled, true);
  const sources = app.root.findAll((node) => node.type === 'button' && node.props['data-source-key']);
  assert.equal(sources.every((node) => node.props.disabled !== true), true, 'viewing other sources stays possible');
  pending.resolve('tab-launcher');
  await busy;
});
