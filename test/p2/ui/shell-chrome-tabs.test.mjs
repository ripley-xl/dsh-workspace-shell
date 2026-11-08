import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { React, act, mount } from './react-harness.mjs';
import * as chromeTabsModule from '../../../packages/shell/src/chrome-tabs.js';

const { createChromeTabs, css } = chromeTabsModule;
const TAB_WIDTH = 200;
const SOURCE = new URL('../../../packages/shell/src/chrome-tabs.js', import.meta.url);

// ---------------------------------------------------------------------------
// Fake DOM: rects, pointer capture, focus and a deterministic rAF queue. No
// browser layout, native window or SSH transport is emulated here.
// ---------------------------------------------------------------------------

function createEnvironment(options = {}) {
  const listeners = new Map();
  const frames = [];
  const cancelledFrames = [];
  const captureCalls = [];
  const releaseCalls = [];
  const focusCalls = [];
  const shells = new Map();
  const bodies = new Map();
  const ghosts = new Map();
  const animations = [];
  let frameId = 0;
  const mirror = { tabs: [] };

  const document = {
    activeElement: null,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };

  const window = {
    requestAnimationFrame(callback) {
      const id = ++frameId;
      frames.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      const index = frames.findIndex((frame) => frame.id === id);
      if (index >= 0) frames.splice(index, 1);
    },
  };
  if (options.reducedMotion) window.matchMedia = () => ({ matches: true });

  const scroller = {
    tagName: 'DIV',
    scrollLeft: 0,
    clientWidth: options.clientWidth ?? TAB_WIDTH * 2,
    scrollWidth: options.scrollWidth ?? TAB_WIDTH * 2,
    getBoundingClientRect() {
      const width = this.clientWidth;
      return { left: 0, right: width, top: 0, bottom: 48, width, height: 48 };
    },
  };

  const root = {
    tagName: 'DIV',
    getBoundingClientRect() {
      return { left: 0, right: scroller.clientWidth, top: 0, bottom: 48, width: scroller.clientWidth, height: 48 };
    },
  };

  function shellNode(id) {
    if (shells.has(id)) return shells.get(id);
    const node = {
      id,
      tagName: 'DIV',
      attributes: new Map(),
      captured: new Set(),
      style: {},
      ...(options.noAnimate ? {} : {
        animate(frames, animationOptions) {
          const animation = {
            id,
            frames,
            options: animationOptions,
            cancelled: false,
            cancel() { animation.cancelled = true; },
          };
          animations.push(animation);
          return animation;
        },
      }),
      setPointerCapture(pointerId) {
        captureCalls.push([id, pointerId]);
        node.captured.add(pointerId);
      },
      hasPointerCapture(pointerId) {
        return node.captured.has(pointerId);
      },
      releasePointerCapture(pointerId) {
        releaseCalls.push([id, pointerId]);
        node.captured.delete(pointerId);
      },
      getAttribute(name) {
        return node.attributes.get(name) ?? null;
      },
      hasAttribute(name) {
        return node.attributes.has(name);
      },
      getBoundingClientRect() {
        const index = mirror.tabs.findIndex((tab) => tab.id === id);
        if (index < 0) return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
        const left = index * TAB_WIDTH - scroller.scrollLeft;
        return { left, right: left + TAB_WIDTH, top: 0, bottom: 36, width: TAB_WIDTH, height: 36 };
      },
    };
    shells.set(id, node);
    return node;
  }

  function ghostNode(id) {
    if (ghosts.has(id)) return ghosts.get(id);
    const node = { id, tagName: 'DIV', style: {}, attributes: new Map() };
    ghosts.set(id, node);
    return node;
  }

  function bodyNode(id) {
    if (bodies.has(id)) return bodies.get(id);
    const node = {
      id,
      tagName: 'DIV',
      focus(options_) {
        focusCalls.push([id, options_]);
        document.activeElement = node;
      },
      getBoundingClientRect() {
        return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
      },
    };
    bodies.set(id, node);
    return node;
  }

  function createNodeMock(element) {
    const props = element?.props ?? {};
    if (props['data-chrome-tabs'] !== undefined) return root;
    if (props['data-chrome-tablist'] !== undefined) return scroller;
    const ghostId = props['data-chrome-tab-ghost'];
    if (ghostId !== undefined) return ghostNode(String(ghostId));
    const bodyId = props['data-chrome-tab-body'];
    if (bodyId !== undefined) return bodyNode(String(bodyId));
    const shellId = props['data-chrome-tab'];
    if (shellId !== undefined) return shellNode(String(shellId));
    return { tagName: 'DIV' };
  }

  function runFrames(count = 1) {
    for (let step = 0; step < count; step += 1) {
      const queued = frames.splice(0, frames.length);
      for (const frame of queued) frame.callback(16 * (step + 1));
    }
  }

  return {
    document, window, mirror, scroller, root, createNodeMock, captureCalls, releaseCalls, focusCalls,
    frames, cancelledFrames, animations, ghosts, runFrames, shellNode, ghostNode, bodyNode,
    pendingFrames: () => frames.length,
  };
}

function pointerEvent(options = {}) {
  let prevented = 0;
  let stopped = 0;
  const event = {
    button: options.button ?? 0,
    pointerId: options.pointerId ?? 1,
    isPrimary: options.isPrimary ?? true,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
    target: options.target ?? { tagName: 'DIV' },
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  };
  Object.defineProperties(event, {
    prevented: { get: () => prevented },
    stopped: { get: () => stopped },
  });
  return event;
}

function keyEvent(options = {}) {
  let prevented = 0;
  let stopped = 0;
  const event = {
    key: options.key,
    altKey: options.altKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false,
    defaultPrevented: false,
    target: options.target ?? { tagName: 'DIV' },
    nativeEvent: options.nativeEvent ?? {},
    preventDefault() { prevented += 1; event.defaultPrevented = true; },
    stopPropagation() { stopped += 1; },
  };
  Object.defineProperties(event, {
    prevented: { get: () => prevented },
    stopped: { get: () => stopped },
  });
  return event;
}

function reorder(tabs, id, index) {
  const from = tabs.findIndex((tab) => tab.id === id);
  assert.notEqual(from, -1, `Unknown tab ${id}`);
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  const target = Math.max(0, Math.min(index, next.length));
  next.splice(target, 0, moved);
  return next;
}

function createFixture(tabs, options = {}) {
  const env = createEnvironment(options);
  const { ChromeTabStrip } = createChromeTabs(React, { document: env.document, window: env.window });
  const log = { select: [], close: [], move: [], add: 0, status: [] };
  const statuses = options.statuses ?? {};
  const getStatus = options.noStatus ? undefined : (tab) => {
    log.status.push(tab.id);
    if (options.statusError) throw new Error('status failure');
    return statuses[tab.id];
  };
  const controls = { setTabs: null, setActive: null };
  const stripProps = options.stripProps ?? {};

  function Host() {
    const [list, setTabs] = React.useState(tabs);
    const [activeId, setActiveId] = React.useState(options.activeId ?? tabs[0]?.id);
    env.mirror.tabs = list;
    controls.setTabs = setTabs;
    controls.setActive = setActiveId;
    return React.createElement(ChromeTabStrip, {
      tabs: list,
      activeId,
      getStatus,
      onSelect(id) {
        log.select.push(id);
        setActiveId(id);
      },
      onClose(id) {
        log.close.push(id);
        setTabs((current) => current.filter((tab) => tab.id !== id));
      },
      onMove(id, index) {
        log.move.push([id, index]);
        setTabs((current) => reorder(current, id, index));
      },
      onAdd() {
        log.add += 1;
      },
      ...stripProps,
    });
  }

  return { env, log, stripProps, Host, controls, tabs };
}

async function setup(t, tabs, options = {}) {
  const fixture = createFixture(tabs, options);
  const app = await mount(t, fixture.Host, {}, { createNodeMock: fixture.env.createNodeMock });
  const root = app.root;
  const find = (predicate) => {
    const matches = root.findAll(predicate);
    assert.equal(matches.length, 1, 'Expected exactly one matching node');
    return matches[0];
  };
  const shell = (id) => find((node) => node.props['data-chrome-tab'] === id);
  const body = (id) => find((node) => node.props['data-chrome-tab-body'] === id);
  const list = () => find((node) => node.props['data-chrome-tablist'] !== undefined);
  const fire = async (handler, event) => {
    assert.equal(typeof handler, 'function');
    await act(async () => { handler(event); });
  };
  const click = async (node, options_ = {}) => {
    await fire(node.props.onClick, pointerEvent(options_));
  };
  const keydown = async (id, options_) => {
    await fire(shell(id).props.onKeyDown, keyEvent(options_));
  };
  const pointerDown = async (id, options_) => {
    await fire(shell(id).props.onPointerDown, pointerEvent(options_));
  };
  const pointerMove = async (event) => {
    await fire(list().props.onPointerMove, event);
  };
  const pointerUp = async (event) => {
    await fire(list().props.onPointerUp, event);
  };
  const pointerCancel = async (event) => {
    await fire(list().props.onPointerCancel, event);
  };
  const lostCapture = async (event) => {
    await fire(shell(event.shellId ?? 'a').props.onLostPointerCapture, event);
  };
  const removeTab = async (id) => {
    await act(async () => { fixture.controls.setTabs((current) => current.filter((tab) => tab.id !== id)); });
  };
  return {
    ...fixture, app, root, shell, body, list, fire, click, keydown,
    pointerDown, pointerMove, pointerUp, pointerCancel, lostCapture, removeTab,
  };
}

function contentNodes(node) {
  return (node?.props?.children ?? []).filter((child) => child != null);
}

function renderedText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join('');
  if (node.children) return node.children.map(renderedText).join('');
  if (node.props) return renderedText(node.props.children);
  return '';
}

function nodesOfType(json, type) {
  const found = [];
  const walk = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === type) found.push(node);
    (node.children ?? []).forEach(walk);
  };
  walk(json);
  return found;
}

const localTab = { id: 'local', identity: Object.freeze({}), kind: 'local', title: '本地', closable: false };
const sshTab = { id: 'ssh:1', identity: Object.freeze({}), kind: 'web', title: 'Web · app', closable: true };
const tuiTab = { id: 'tui:1', identity: Object.freeze({}), kind: 'tui', title: 'TUI', closable: true };

// ---------------------------------------------------------------------------
// Factory and stylesheet contract
// ---------------------------------------------------------------------------

test('factory is import-free ESM and returns the component plus its stylesheet', async () => {
  assert.deepEqual(Object.keys(chromeTabsModule).sort(), ['createChromeTabs', 'css']);
  assert.equal(typeof createChromeTabs, 'function');
  assert.equal(typeof css, 'string');
  assert.throws(() => createChromeTabs(null), TypeError);
  const app = createChromeTabs(React, {});
  assert.deepEqual(Object.keys(app).sort(), ['ChromeTabStrip', 'css']);
  assert.equal(app.css, css);

  const source = await readFile(SOURCE, 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bgeneration\b/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(|console\./);
  const transformed = source.replace(/^export /gm, '');
  assert.doesNotMatch(transformed, /^\s*(import|export)\s/m);
  const env = createEnvironment();
  const context = vm.createContext({
    React, document: env.document, window: env.window,
    Set, Map, Number, Math, String, Object, Array, Boolean, Error, TypeError, Symbol, encodeURIComponent,
  });
  const factory = vm.runInContext(`${transformed}\ncreateChromeTabs`, context);
  const built = factory(React, { document: env.document, window: env.window });
  assert.equal(typeof built.ChromeTabStrip, 'function');
  assert.equal(built.css, css);
});

test('stylesheet uses only official tokens or its own variables, keeps 48px, theme and motion rules', () => {
  const declared = new Set([...css.matchAll(/(--ct-[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
  const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]));
  assert.ok(used.size > 0);
  for (const name of used) {
    assert.ok(name.startsWith('--dsw-') || name.startsWith('--ct-'), `Unexpected custom property ${name}`);
    if (name.startsWith('--ct-')) assert.ok(declared.has(name), `Missing definition for ${name}`);
  }
  assert.ok(declared.has('--ct-height'));
  assert.match(css, /--ct-height:48px/);
  assert.match(css, /\.ct-root\{[^}]*height:var\(--ct-height\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'No hard-coded hex colors');
  assert.doesNotMatch(css, /\b(?:rgba?|hsla?)\(/i, 'No hard-coded color functions');
  for (const match of css.matchAll(/color-mix\(([^)]*)\)/g)) {
    assert.match(match[1], /var\(--ct-|var\(--dsw-/, `color-mix must derive from a token: ${match[0]}`);
  }
  // Chrome shape: rounded top corners touching the content background.
  assert.match(css, /\.ct-tab\{[^}]*border-radius:var\(--ct-radius\) var\(--ct-radius\) 0 0/);
  assert.match(css, /\.ct-tab\[data-active=true\]\{background:var\(--ct-tab-active-bg\)/);
  assert.match(css, /\.ct-tab:not\(\[data-active=true\]\):hover[^{]*\{background:var\(--ct-hover-bg\)\}/);
  assert.match(css, /\.ct-title\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
  // Width shrinks before the title is truncated.
  assert.match(css, /\.ct-tab\{[^}]*flex:1 1 auto;min-width:var\(--ct-tab-min-width\);max-width:var\(--ct-tab-max-width\)/);
  // Tabs and the alias share stay wide enough for short SSH aliases such as "anydev".
  assert.match(css, /--ct-tab-min-width:88px;/);
  assert.match(css, /--ct-tab-max-width:360px;/);
  assert.match(css, /\.ct-alias\{[^}]*max-width:60%/);
  // Close button is hidden until hover, focus-within or the active tab.
  assert.match(css, /\.ct-close\{[^}]*opacity:0;pointer-events:none/);
  assert.match(css, /\.ct-tab:hover \.ct-close,\.ct-tab:focus-within \.ct-close,\.ct-tab\[data-active=true\] \.ct-close\{opacity:1;pointer-events:auto\}/);
  assert.match(css, /\.ct-close:active\{background:var\(--ct-press-bg\)\}/);
  assert.match(css, /\.ct-close:focus-visible\{[^}]*outline:var\(--ct-focus-width\) solid var\(--ct-focus-ring\)/);
  assert.match(css, /\.ct-marker\{[^}]*width:3px[^}]*height:14px[^}]*background:var\(--dsw-alias-state-idle-primary\)/);
  for (const [color, token] of [['blue', 'business'], ['green', 'success'], ['amber', 'warn'], ['red', 'error'], ['gray', 'idle']]) {
    assert.match(css, new RegExp(`\\.ct-marker\\[data-color=${color}\\]\\{background:var\\(--dsw-alias-state-${token}-primary\\)\\}`));
  }
  assert.match(css, /\.ct-edit\{[^}]*opacity:0;pointer-events:none/);
  assert.match(css, /\.ct-tab:hover \.ct-edit,\.ct-tab:focus-within \.ct-edit,\.ct-tab\[data-active=true\] \.ct-edit\{opacity:1;pointer-events:auto\}/);
  assert.match(css, /\.ct-edit:focus-visible\{[^}]*outline:var\(--ct-focus-width\) solid var\(--ct-focus-ring\)/);
  // Round plus button.
  assert.match(css, /\.ct-add\{[^}]*border-radius:50%/);
  // Window drag reuse: blank strip area drags, controls do not.
  assert.match(css, /\.ct-blank\{[^}]*flex:1 1 auto[^}]*-webkit-app-region:drag/);
  assert.match(css, /\.ct-tab\{[^}]*-webkit-app-region:no-drag/);
  assert.match(css, /\.ct-add\{[^}]*-webkit-app-region:no-drag/);
  // Keyboard focus, reduced motion, narrow screens.
  assert.match(css, /\.ct-tab-body:focus-visible\{outline:var\(--ct-focus-width\) solid var\(--ct-focus-ring\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^}]*transition:none!important/);
  assert.match(css, /@media\(prefers-reduced-motion:no-preference\)/);
  assert.match(css, /@media\(max-width:640px\)\{\.ct-root\{--ct-tab-min-width:72px;--ct-tab-max-width:240px/);
  // Narrow tabs also keep a readable alias share (50%).
  assert.match(css, /@media\(max-width:640px\)\{[^\n]*\.ct-alias\{max-width:50%\}\}/);
  assert.match(css, /--ct-dot-on:var\(--dsw-alias-state-success-primary/);
  assert.match(css, /--ct-dot-off:var\(--dsw-alias-state-idle-primary/);
  assert.match(css, /--ct-tab-active-bg:var\(--dsw-alias-bg-base\)/);
  // Drag feedback: a raised copy over a dimmed slot, both theme-derived.
  assert.match(css, /\.ct-root\{[^}]*position:relative/);
  assert.match(css, /--ct-ghost-bg:var\(--ct-tab-active-bg\)/);
  assert.match(css, /--ct-ghost-shadow:var\(--dsw-shadow-lv2/);
  assert.match(css, /\.ct-tab\[data-dragging=true\]\{[^}]*opacity:\.45[^}]*box-shadow:inset 0 0 0 1px/);
  assert.match(css, /\.ct-tab\[data-dragging=true\] \.ct-close\{opacity:0;pointer-events:none\}/);
  assert.match(css, /\.ct-ghost\{[^}]*position:absolute[^}]*box-shadow:var\(--ct-ghost-shadow\),0 0 0 1px var\(--ct-veil\)[^}]*pointer-events:none/);
  assert.match(css, /@keyframes ct-ghost-in\{from\{opacity:0\}to\{opacity:1\}\}/);
  assert.match(css, /\.ct-ghost\{animation:ct-ghost-in 90ms ease-out\}/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{[^}]*\.ct-ghost\{[^}]*animation:none!important/);
});

// ---------------------------------------------------------------------------
// Rendering contract
// ---------------------------------------------------------------------------

test('renders a Chrome tablist with roving focus, stable ids and no decorative icons', async (t) => {
  const fixture = await setup(t, [localTab, sshTab, tuiTab], { activeId: 'ssh:1' });
  const tablist = fixture.list();
  assert.equal(tablist.props.role, 'tablist');
  assert.equal(tablist.props['aria-orientation'], 'horizontal');
  assert.equal(tablist.props['aria-label'], '工作区页签');
  assert.equal(fixture.root.findAll((node) => node.props.role === 'tab').length, 3);

  const local = fixture.body('local');
  const ssh = fixture.body('ssh:1');
  assert.equal(local.props.id, 'chrome-tab-local');
  assert.equal(local.props['aria-controls'], 'chrome-tab-panel-local');
  assert.equal(local.props.tabIndex, -1);
  assert.equal(ssh.props.tabIndex, 0);
  assert.equal(ssh.props['aria-selected'], 'true');
  assert.equal(local.props['aria-selected'], 'false');
  assert.match(ssh.props['aria-keyshortcuts'], /Delete/);
  assert.match(ssh.props['aria-keyshortcuts'], /Alt\+ArrowLeft/);

  const closeButtons = fixture.root.findAll((node) => node.props['data-chrome-tab-close'] !== undefined);
  assert.deepEqual(closeButtons.map((node) => node.props['data-chrome-tab-close']), ['ssh:1', 'tui:1']);
  assert.equal(fixture.root.findAllByType('svg').length, 0);
  assert.equal(fixture.root.findAllByType('img').length, 0);
  const json = JSON.stringify(fixture.app.toJSON());
  assert.doesNotMatch(json, /wsh-mark|wsh-tab|generation/);

  const add = fixture.root.findAll((node) => node.props['data-chrome-tab-add'] !== undefined);
  assert.equal(add.length, 1);
  assert.equal(renderedText(add[0]), '+');
  assert.equal(add[0].props['aria-label'], '新建工作区');

  const blank = fixture.root.findAll((node) => node.props['data-window-drag'] !== undefined);
  assert.equal(blank.length, 1);
  assert.match(blank[0].props.className, /\bct-blank\b/);
  assert.equal(blank[0].props['aria-hidden'], 'true');
  assert.equal(fixture.root.findByProps({ 'data-chrome-tablist': '' }).props.style.WebkitAppRegion, 'drag');

  const live = fixture.root.findAll((node) => node.props['data-chrome-tab-status'] !== undefined);
  assert.equal(live.length, 1);
  assert.equal(live[0].props.role, 'status');
  assert.equal(live[0].props['aria-live'], 'polite');

  const plusClick = fixture.root.findAll((node) => node.props['data-chrome-tab-add'] !== undefined)[0];
  await fixture.click(plusClick);
  assert.equal(fixture.log.add, 1);
  assert.deepEqual(fixture.log.select, []);
});

test('a custom id prefix and ids resolver keep tab/panel relationships owned by the host', async (t) => {
  const fixture = await setup(t, [localTab], {
    stripProps: { idPrefix: 'shell', ids: (tab) => ({ tab: `t-${tab.id}`, panel: `p-${tab.id}` }) },
  });
  const body = fixture.body('local');
  assert.equal(body.props.id, 't-local');
  assert.equal(body.props['aria-controls'], 'p-local');
});

test('dragRegion=false removes the native window drag surface while keeping controls', async (t) => {
  const fixture = await setup(t, [localTab], { stripProps: { dragRegion: false } });
  assert.equal(fixture.root.findAll((node) => node.props['data-window-drag'] !== undefined).length, 0);
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tab-add'] !== undefined).length, 1);
  assert.equal(fixture.root.findByProps({ 'data-chrome-tablist': '' }).props.style.WebkitAppRegion, 'no-drag');
});

test('SSH tabs order green/grey dot, connection name and tab title without reading generation', async (t) => {
  const frozen = [localTab, Object.freeze({ ...sshTab, generation: 9 }), tuiTab];
  const fixture = await setup(t, frozen, {
    statuses: { 'ssh:1': { source: 'ssh', alias: 'dev-box', connected: true } },
  });
  const kids = contentNodes(fixture.body('ssh:1'));
  assert.deepEqual(kids.map((child) => child.props.className), ['ct-dot', 'ct-sr-only', 'ct-alias', 'ct-title']);
  assert.equal(kids[0].props['data-connected'], 'true');
  assert.equal(renderedText(kids[1]), '已连接');
  assert.equal(renderedText(kids[2]), 'dev-box');
  assert.equal(renderedText(kids[3]), 'Web · app');
  assert.equal(fixture.shell('ssh:1').props.title, 'dev-box · Web · app');
  assert.doesNotMatch(renderedText(fixture.body('ssh:1')), /9/);
  assert.equal(fixture.root.findAll((node) => node.props['data-connected'] === 'false').length, 0);

  // Local never receives the SSH dot and alias, even if a status provider mentions it.
  assert.deepEqual(contentNodes(fixture.body('local')).map((child) => child.props.className), ['ct-title']);

  await act(async () => {
    fixture.controls.setTabs((current) => current.map((tab) => tab.id === 'ssh:1'
      ? { ...tab, identity: Object.freeze({}) } : tab));
  });
});

test('a disconnected SSH tab shows a grey dot and an offline label', async (t) => {
  const fixture = await setup(t, [localTab, sshTab], {
    statuses: { 'ssh:1': { source: 'ssh', alias: 'dev-box', connected: false } },
  });
  const kids = contentNodes(fixture.body('ssh:1'));
  assert.equal(kids[0].props['data-connected'], 'false');
  assert.equal(renderedText(kids[1]), '未连接');
  assert.equal(renderedText(kids[2]), 'dev-box');
});

test('custom display names and color markers replace only the visible label', async (t) => {
  const edits = [];
  const fixture = await setup(t, [localTab, sshTab, tuiTab], {
    activeId: 'ssh:1',
    statuses: { 'ssh:1': { source: 'ssh', alias: 'dev-box', connected: true } },
    stripProps: {
      getAppearance: (tab) => tab.id === 'ssh:1' ? { name: '生产', color: 'red' } : null,
      canEdit: () => true,
      onEdit: (id) => edits.push(id),
    },
  });
  const kids = contentNodes(fixture.body('ssh:1'));
  assert.deepEqual(kids.map((child) => child.props.className), ['ct-marker', 'ct-dot', 'ct-sr-only', 'ct-alias', 'ct-title']);
  assert.equal(kids[0].props['data-color'], 'red');
  assert.equal(renderedText(kids[4]), '生产');
  assert.equal(fixture.shell('ssh:1').props.title, 'dev-box · 生产');
  assert.equal(fixture.shell('ssh:1').props['data-custom-title'], 'true');
  assert.equal(fixture.shell('ssh:1').props['data-appearance-color'], 'red');
  assert.match(fixture.body('ssh:1').props['aria-keyshortcuts'], /F2/);
  const close = fixture.root.findAll((node) => node.props['data-chrome-tab-close'] === 'ssh:1')[0];
  assert.equal(close.props['aria-label'], '关闭页签 生产');
  assert.equal(renderedText(fixture.body('tui:1')), 'TUI', 'tabs without appearance keep their original title');
  assert.deepEqual(contentNodes(fixture.body('tui:1')).map((child) => child.props.className), ['ct-title']);

  await fixture.fire(fixture.shell('ssh:1').props.onDoubleClick, pointerEvent({ target: { tagName: 'DIV' } }));
  await fixture.keydown('ssh:1', { key: 'F2' });
  assert.deepEqual(edits, ['ssh:1', 'ssh:1']);
  const edit = fixture.root.findAll((node) => node.props['data-chrome-tab-edit'] === 'ssh:1')[0];
  assert.equal(renderedText(edit), '✎');
  assert.equal(edit.props['aria-label'], '编辑页签名称与彩色标记 生产');
  await fixture.click(edit, { target: { tagName: 'BUTTON' } });
  assert.deepEqual(edits, ['ssh:1', 'ssh:1', 'ssh:1']);
  assert.deepEqual(fixture.log.select, [], 'the edit control never selects the tab');
  assert.deepEqual(fixture.log.close, []);
  assert.deepEqual(fixture.log.move, []);
});

test('an uneditable tab exposes no F2 or edit control and double-click is ignored', async (t) => {
  const edits = [];
  const fixture = await setup(t, [localTab, sshTab], {
    activeId: 'local',
    stripProps: {
      canEdit: (tab) => tab.id !== 'local',
      onEdit: (id) => edits.push(id),
    },
  });
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tab-edit'] === 'local').length, 0);
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tab-edit'] === 'ssh:1').length, 1);
  await fixture.fire(fixture.shell('local').props.onDoubleClick, pointerEvent({ target: { tagName: 'DIV' } }));
  await fixture.keydown('local', { key: 'F2' });
  assert.deepEqual(edits, []);
  await fixture.fire(fixture.shell('ssh:1').props.onDoubleClick, pointerEvent({ target: { tagName: 'BUTTON' } }));
  assert.deepEqual(edits, [], 'double-clicking a control does not start editing');
});

test('non-SSH, throwing and missing status providers render no connection chrome', async (t) => {
  for (const options of [
    { statuses: { 'ssh:1': { source: 'local', alias: 'nope', connected: true } } },
    { statusError: true },
    { noStatus: true },
    { statuses: { 'ssh:1': { source: 'ssh', connected: true } } },
    { statuses: { 'ssh:1': null } },
  ]) {
    const fixture = await setup(t, [localTab, sshTab], options);
    const kids = contentNodes(fixture.body('ssh:1'));
    assert.equal(kids.length, 1, JSON.stringify(options));
    assert.equal(kids[0].props.className, 'ct-title');
    assert.equal(renderedText(kids[0]), 'Web · app');
    await fixture.app.unmount();
  }
});

test('Local is never closable even when the record claims it is, and close only closes', async (t) => {
  const claimed = { id: 'local', identity: {}, kind: 'local', title: '本地', closable: true };
  const hardLocal = { id: 'local', kind: 'profile-ui', title: '本地', closable: false };
  const fixture = await setup(t, [claimed, sshTab], { activeId: 'local' });
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tab-close'] === 'local').length, 0);
  assert.equal(fixture.shell('local').props['data-closable'], undefined);
  assert.equal(fixture.shell('ssh:1').props['data-closable'], 'true');

  const closeButton = fixture.root.findAll((node) => node.props['data-chrome-tab-close'] === 'ssh:1')[0];
  assert.equal(closeButton.props['aria-label'], '关闭页签 Web · app');
  const down = pointerEvent({ target: { tagName: 'BUTTON' } });
  await fixture.fire(closeButton.props.onPointerDown, down);
  assert.equal(down.stopped, 1);
  await fixture.click(closeButton, { target: { tagName: 'BUTTON' } });
  assert.deepEqual(fixture.log.close, ['ssh:1']);
  assert.deepEqual(fixture.log.select, []);
  assert.deepEqual(fixture.log.move, []);
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tab'] === 'ssh:1').length, 0);

  const second = await setup(t, [hardLocal, sshTab]);
  assert.equal(second.root.findAll((node) => node.props['data-chrome-tab-close'] === 'local').length, 0);
});

test('clicking a tab selects and focuses it but ignores clicks on controls', async (t) => {
  const fixture = await setup(t, [localTab, sshTab], { activeId: 'local' });
  await fixture.click(fixture.shell('ssh:1'));
  assert.deepEqual(fixture.log.select, ['ssh:1']);
  assert.deepEqual(fixture.env.focusCalls.at(-1), ['ssh:1', { preventScroll: true }]);
  assert.equal(fixture.body('ssh:1').props['aria-selected'], 'true');
  assert.equal(fixture.body('ssh:1').props.tabIndex, 0);
  assert.equal(fixture.body('local').props.tabIndex, -1);

  const onButton = pointerEvent({ target: { tagName: 'BUTTON' } });
  await fixture.fire(fixture.shell('local').props.onClick, onButton);
  assert.deepEqual(fixture.log.select, ['ssh:1']);
});

// ---------------------------------------------------------------------------
// Keyboard and ARIA
// ---------------------------------------------------------------------------

test('keyboard navigation follows the tablist pattern and ignores modified keys and composition', async (t) => {
  const fixture = await setup(t, [localTab, sshTab, tuiTab], { activeId: 'local' });
  await fixture.keydown('local', { key: 'ArrowRight' });
  assert.deepEqual(fixture.log.select, ['ssh:1']);
  assert.equal(fixture.env.document.activeElement, fixture.env.bodyNode('ssh:1'));

  await fixture.keydown('ssh:1', { key: 'End' });
  assert.deepEqual(fixture.log.select, ['ssh:1', 'tui:1']);
  await fixture.keydown('tui:1', { key: 'ArrowRight' });
  assert.deepEqual(fixture.log.select, ['ssh:1', 'tui:1', 'local']);
  await fixture.keydown('local', { key: 'ArrowLeft' });
  assert.deepEqual(fixture.log.select.at(-1), 'tui:1');
  await fixture.keydown('tui:1', { key: 'Home' });
  assert.deepEqual(fixture.log.select.at(-1), 'local');

  const enter = keyEvent({ key: 'Enter' });
  await fixture.fire(fixture.shell('ssh:1').props.onKeyDown, enter);
  assert.equal(enter.prevented, 1);
  await fixture.keydown('local', { key: 'ArrowRight', ctrlKey: true });
  await fixture.keydown('local', { key: 'ArrowRight', nativeEvent: { isComposing: true } });
  await fixture.keydown('local', { key: 'a' });
  assert.deepEqual(fixture.log.select, ['ssh:1', 'tui:1', 'local', 'tui:1', 'local', 'ssh:1']);
  assert.deepEqual(fixture.log.close, []);
  assert.deepEqual(fixture.log.move, []);
});

test('Delete closes a closable tab, skips Local, and Alt+Arrow moves without selecting', async (t) => {
  const fixture = await setup(t, [localTab, sshTab], { activeId: 'local' });
  await fixture.keydown('local', { key: 'Delete' });
  assert.deepEqual(fixture.log.close, []);
  await fixture.keydown('ssh:1', { key: 'Delete' });
  assert.deepEqual(fixture.log.close, ['ssh:1']);
  assert.deepEqual(fixture.log.select, []);

  const second = await setup(t, [localTab, sshTab, tuiTab], { activeId: 'local' });
  const alt = keyEvent({ key: 'ArrowRight', altKey: true });
  await second.fire(second.shell('local').props.onKeyDown, alt);
  assert.equal(alt.prevented, 1);
  assert.deepEqual(second.log.move, [['local', 1]]);
  assert.deepEqual(second.log.select, []);
  assert.equal(renderedText(second.root.findAll((node) => node.props['data-chrome-tab-status'] !== undefined)[0]), '已移动：本地（2）');
  assert.equal(second.env.mirror.tabs[1].id, 'local');
});

// ---------------------------------------------------------------------------
// Pointer drag, auto-scroll and race handling
// ---------------------------------------------------------------------------

test('pointer motion below 4px neither captures nor reorders, and the release still selects', async (t) => {
  const fixture = await setup(t, [localTab, sshTab, tuiTab], { activeId: 'local' });
  await fixture.pointerDown('ssh:1', { clientX: 100, clientY: 10, pointerId: 1 });
  const move = pointerEvent({ clientX: 103, clientY: 12, pointerId: 1 });
  await fixture.pointerMove(move);
  assert.equal(move.prevented, 0);
  assert.deepEqual(fixture.env.captureCalls, []);
  assert.deepEqual(fixture.log.move, []);
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], undefined);

  const up = pointerEvent({ clientX: 103, clientY: 12, pointerId: 1 });
  await fixture.pointerUp(up);
  assert.deepEqual(fixture.env.releaseCalls, []);
  assert.deepEqual(fixture.env.document.listenerCount('keydown'), 0);
  await fixture.click(fixture.shell('ssh:1'));
  assert.deepEqual(fixture.log.select, ['ssh:1']);
});

test('crossing the threshold captures the pointer and reorders live at every midpoint', async (t) => {
  const a = { id: 'a', identity: Object.freeze({ key: 'a' }), kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: Object.freeze({ key: 'b' }), kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: Object.freeze({ key: 'c' }), kind: 'web', title: 'C', closable: true };
  const fixture = await setup(t, [a, b, c], { activeId: 'a' });
  await fixture.pointerDown('c', { clientX: 450, clientY: 10, pointerId: 7 });
  const cross = pointerEvent({ clientX: 430, clientY: 10, pointerId: 7 });
  await fixture.pointerMove(cross);
  assert.equal(cross.prevented, 1, 'Drag motion consumes the pointer move');
  assert.deepEqual(fixture.env.captureCalls, [['c', 7]]);
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], 'true');
  assert.equal(fixture.shell('c').props['data-dragging'], 'true');
  assert.deepEqual(fixture.log.move, []);
  assert.equal(fixture.env.document.listenerCount('keydown'), 1, 'Escape is armed for the gesture');
  assert.deepEqual(fixture.env.focusCalls, []);

  await fixture.pointerMove(pointerEvent({ clientX: 210, clientY: 10, pointerId: 7 }));
  assert.deepEqual(fixture.log.move, [['c', 1]]);
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['a', 'c', 'b']);
  assert.deepEqual(fixture.log.select, [], 'Reordering must not activate a tab');

  await fixture.pointerMove(pointerEvent({ clientX: 90, clientY: 10, pointerId: 7 }));
  assert.deepEqual(fixture.log.move, [['c', 1], ['c', 0]]);
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['c', 'a', 'b']);
  // Identity and IDs survive reordering; the same record objects remain.
  assert.equal(fixture.env.mirror.tabs[0], c);
  assert.equal(fixture.env.mirror.tabs[1], a);
  assert.equal(fixture.env.mirror.tabs[2], b);
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['c', 'a', 'b']);
});

test('pointer up commits the final midpoint position, releases capture and suppresses one click', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };
  const fixture = await setup(t, [a, b, c], { activeId: 'a' });
  await fixture.pointerDown('a', { clientX: 20, clientY: 10, pointerId: 2 });
  await fixture.pointerMove(pointerEvent({ clientX: 30, clientY: 10, pointerId: 2 }));
  const up = pointerEvent({ clientX: 590, clientY: 10, pointerId: 2 });
  await fixture.pointerUp(up);
  assert.equal(up.prevented, 1);
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['b', 'c', 'a']);
  assert.deepEqual(fixture.log.move, [['a', 2]]);
  assert.deepEqual(fixture.env.releaseCalls, [['a', 2]]);
  assert.equal(fixture.env.document.listenerCount('keydown'), 0);
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], undefined);
  assert.equal(fixture.shell('a').props['data-dragging'], undefined);

  await fixture.click(fixture.shell('b'));
  assert.deepEqual(fixture.log.select, [], 'The click emitted by the drag release is swallowed');
  await fixture.click(fixture.shell('b'));
  assert.deepEqual(fixture.log.select, ['b'], 'The next click behaves normally');
});

test('a drag onto the close button does not close the tab on release', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const fixture = await setup(t, [a, b], { activeId: 'a' });
  await fixture.pointerDown('a', { clientX: 20, pointerId: 3 });
  await fixture.pointerMove(pointerEvent({ clientX: 120, pointerId: 3 }));
  await fixture.pointerUp(pointerEvent({ clientX: 120, pointerId: 3 }));
  const closeButton = fixture.root.findAll((node) => node.props['data-chrome-tab-close'] === 'a')[0];
  await fixture.click(closeButton, { target: { tagName: 'BUTTON' } });
  assert.deepEqual(fixture.log.close, []);
  assert.deepEqual(fixture.log.select, []);
});

test('Escape restores the pre-drag order, cancels the commit and suppresses the release click', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };
  const d = { id: 'd', identity: {}, kind: 'web', title: 'D', closable: true };
  const fixture = await setup(t, [a, b, c, d], { activeId: 'a' });
  await fixture.pointerDown('b', { clientX: 250, pointerId: 4 });
  await fixture.pointerMove(pointerEvent({ clientX: 520, pointerId: 4 }));
  assert.deepEqual(fixture.log.move, [['b', 2]]);
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['a', 'c', 'b', 'd']);

  const escape = keyEvent({ key: 'Escape' });
  await act(async () => { fixture.env.document.emit('keydown', escape); });
  assert.equal(escape.prevented, 1);
  assert.equal(escape.stopped, 1);
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(fixture.log.move.at(-1), ['b', 1]);
  assert.deepEqual(fixture.env.releaseCalls, [['b', 4]]);
  assert.equal(fixture.env.document.listenerCount('keydown'), 0);
  assert.equal(renderedText(fixture.root.findAll((node) => node.props['data-chrome-tab-status'] !== undefined)[0]), '已恢复页签顺序');
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], undefined);

  // The pointer release after Escape must not move anything again or select.
  await fixture.pointerUp(pointerEvent({ clientX: 520, pointerId: 4 }));
  assert.equal(fixture.log.move.length, 2);
  await fixture.click(fixture.shell('b'));
  assert.deepEqual(fixture.log.select, []);
});

test('pointer cancel, lost capture, wrong pointers and control presses never corrupt the gesture', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };

  // Right button and non-primary presses do not start a drag.
  const fixture = await setup(t, [a, b, c], { activeId: 'a' });
  await fixture.pointerDown('a', { clientX: 20, pointerId: 5, button: 2 });
  await fixture.pointerDown('a', { clientX: 20, pointerId: 5, isPrimary: false });
  await fixture.pointerMove(pointerEvent({ clientX: 200, pointerId: 5 }));
  assert.deepEqual(fixture.env.captureCalls, []);
  assert.deepEqual(fixture.log.move, []);

  // A second pointer cannot steal the active gesture.
  await fixture.pointerDown('a', { clientX: 20, pointerId: 1 });
  await fixture.pointerMove(pointerEvent({ clientX: 320, pointerId: 1 }));
  await fixture.pointerDown('b', { clientX: 350, pointerId: 2 });
  await fixture.pointerMove(pointerEvent({ clientX: 420, pointerId: 2 }));
  assert.deepEqual(fixture.env.captureCalls, [['a', 1]]);
  await fixture.pointerUp(pointerEvent({ clientX: 120, pointerId: 99 }));
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], 'true', 'Foreign pointer releases are ignored');
  await fixture.pointerMove(pointerEvent({ clientX: 520, pointerId: 1 }));
  await fixture.pointerUp(pointerEvent({ clientX: 520, pointerId: 1 }));
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['b', 'c', 'a']);

  // Pointer cancel discards the in-flight gesture and cleans up.
  const second = await setup(t, [a, b, c], { activeId: 'a' });
  await second.pointerDown('c', { clientX: 450, pointerId: 8 });
  await second.pointerMove(pointerEvent({ clientX: 250, pointerId: 8 }));
  assert.deepEqual(second.log.move, [['c', 1]]);
  const cancel = pointerEvent({ clientX: 250, pointerId: 8 });
  await second.pointerCancel(cancel);
  assert.equal(second.env.document.listenerCount('keydown'), 0);
  assert.deepEqual(second.env.releaseCalls, [['c', 8]]);
  assert.equal(second.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], undefined);
  assert.equal(second.env.mirror.tabs.length, 3);
  await second.pointerUp(pointerEvent({ clientX: 250, pointerId: 8 }));
  assert.equal(second.log.move.length, 1, 'Cancel must not commit on a later release');

  // A new gesture can start after cancellation.
  await second.pointerDown('a', { clientX: 20, pointerId: 9 });
  await second.pointerMove(pointerEvent({ clientX: 130, pointerId: 9 }));
  assert.deepEqual(second.env.captureCalls, [['c', 8], ['a', 9]]);
  await second.pointerUp(pointerEvent({ clientX: 130, pointerId: 9 }));

  // Lost pointer capture behaves like a cancel.
  const third = await setup(t, [a, b, c], { activeId: 'a' });
  await third.pointerDown('b', { clientX: 250, pointerId: 11 });
  await third.pointerMove(pointerEvent({ clientX: 260, pointerId: 11 }));
  const lost = pointerEvent({ clientX: 260, pointerId: 11 });
  await third.fire(third.shell('b').props.onLostPointerCapture, lost);
  assert.equal(third.env.document.listenerCount('keydown'), 0);
  assert.equal(third.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], undefined);

  // Control presses never start a drag even if propagation is not stopped.
  const fourth = await setup(t, [a, b], { activeId: 'a' });
  await fourth.pointerDown('a', { clientX: 20, pointerId: 12, target: { tagName: 'BUTTON' } });
  await fourth.pointerMove(pointerEvent({ clientX: 220, pointerId: 12 }));
  assert.deepEqual(fourth.env.captureCalls, []);
  assert.deepEqual(fourth.log.move, []);
  await fourth.pointerDown('a', { clientX: 20, pointerId: 13, target: { tagName: 'DIV', getAttribute: () => 'button' } });
  await fourth.pointerMove(pointerEvent({ clientX: 220, pointerId: 13 }));
  assert.deepEqual(fourth.env.captureCalls, []);
});

test('unmount and mid-gesture removal finish the drag without leaking listeners or frames', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };

  const first = await setup(t, [a, b], { activeId: 'a', scrollWidth: 800 });
  await first.pointerDown('a', { clientX: 20, pointerId: 1 });
  await first.pointerMove(pointerEvent({ clientX: 25, pointerId: 1 }));
  assert.equal(first.env.pendingFrames(), 0);
  await first.pointerMove(pointerEvent({ clientX: 395, pointerId: 1 }));
  assert.equal(first.env.pendingFrames(), 1);
  await first.app.unmount();
  assert.equal(first.env.document.listenerCount('keydown'), 0);
  assert.equal(first.env.pendingFrames(), 0);
  assert.equal(first.env.cancelledFrames.length, 1);
  assert.deepEqual(first.env.releaseCalls, [['a', 1]]);
  assert.deepEqual(first.log.move, [['a', 1]]);

  // Removing the dragged record while the pointer is down cancels the gesture.
  const second = await setup(t, [a, b], { activeId: 'a' });
  await second.pointerDown('a', { clientX: 20, pointerId: 2 });
  // Dropping past b's midpoint moves a to the end of the two-tab strip.
  await second.pointerMove(pointerEvent({ clientX: 320, pointerId: 2 }));
  assert.deepEqual(second.log.move, [['a', 1]]);
  await second.removeTab('a');
  assert.equal(second.env.document.listenerCount('keydown'), 0);
  assert.equal(second.root.findAll((node) => node.props['data-chrome-tabs'] !== undefined)[0].props['data-dragging'], undefined);
  await second.pointerUp(pointerEvent({ clientX: 250, pointerId: 2 }));
  assert.equal(second.log.move.length, 1);
  assert.deepEqual(second.env.mirror.tabs.map((tab) => tab.id), ['b']);
});

test('dragging near a strip edge auto-scrolls on animation frames and stops on pointer up', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };
  const d = { id: 'd', identity: {}, kind: 'web', title: 'D', closable: true };
  const fixture = await setup(t, [a, b, c, d], { activeId: 'a', clientWidth: 400, scrollWidth: 800 });
  await fixture.pointerDown('a', { clientX: 20, pointerId: 1 });
  await fixture.pointerMove(pointerEvent({ clientX: 60, pointerId: 1 }));
  assert.equal(fixture.env.pendingFrames(), 0, 'A centered pointer never auto-scrolls');
  await fixture.pointerMove(pointerEvent({ clientX: 395, pointerId: 1 }));
  assert.equal(fixture.env.pendingFrames(), 1);
  assert.deepEqual(fixture.log.move, [['a', 1]]);

  fixture.env.runFrames(1);
  assert.equal(fixture.env.scroller.scrollLeft, 14);
  fixture.env.runFrames(1);
  assert.equal(fixture.env.scroller.scrollLeft, 28);
  assert.equal(fixture.env.cancelledFrames.length, 0);

  await fixture.pointerUp(pointerEvent({ clientX: 395, pointerId: 1 }));
  assert.equal(fixture.env.pendingFrames(), 0);
  fixture.env.runFrames(1);
  assert.equal(fixture.env.scroller.scrollLeft, 28);
  assert.equal(fixture.log.move.at(-1)[0], 'a');
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['b', 'a', 'c', 'd']);

  // Leaving the edge zone stops the loop before the release.
  const second = await setup(t, [a, b, c, d], { activeId: 'a', clientWidth: 400, scrollWidth: 800 });
  await second.pointerDown('a', { clientX: 20, pointerId: 2 });
  await second.pointerMove(pointerEvent({ clientX: 395, pointerId: 2 }));
  assert.equal(second.env.pendingFrames(), 1);
  await second.pointerMove(pointerEvent({ clientX: 200, pointerId: 2 }));
  assert.equal(second.env.pendingFrames(), 0);
  assert.ok(second.env.cancelledFrames.length >= 1);

  // An unscrollable strip never requests frames.
  const third = await setup(t, [a, b], { activeId: 'a', clientWidth: 400, scrollWidth: 400 });
  await third.pointerDown('a', { clientX: 20, pointerId: 3 });
  await third.pointerMove(pointerEvent({ clientX: 399, pointerId: 3 }));
  assert.equal(third.env.pendingFrames(), 0);
  await third.pointerUp(pointerEvent({ clientX: 399, pointerId: 3 }));
});

test('the whole gesture runs against frozen records without mutating the host tabs', async (t) => {
  const records = [
    Object.freeze({ id: 'local', identity: Object.freeze({}), kind: 'local', title: '本地', closable: false }),
    Object.freeze({ id: 'ssh:1', identity: Object.freeze({ workspace: '/w' }), kind: 'web', title: 'Web · app', closable: true }),
    Object.freeze({ id: 'ssh:2', identity: Object.freeze({ workspace: '/x' }), kind: 'web', title: 'Web · api', closable: true }),
  ];
  const fixture = await setup(t, records, { activeId: 'local' });
  await fixture.pointerDown('local', { clientX: 20, pointerId: 1 });
  await fixture.pointerMove(pointerEvent({ clientX: 520, pointerId: 1 }));
  await fixture.pointerUp(pointerEvent({ clientX: 520, pointerId: 1 }));
  assert.deepEqual(fixture.log.move, [['local', 2]]);
  assert.equal(fixture.env.mirror.tabs[2], records[0]);
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['ssh:1', 'ssh:2', 'local']);
  assert.deepEqual(fixture.log.select, []);
  assert.deepEqual(records.map((tab) => tab.id), ['local', 'ssh:1', 'ssh:2']);
});

// ---------------------------------------------------------------------------
// Drag feedback: floating copy and reorder transition
// ---------------------------------------------------------------------------

test('crossing the threshold mounts one pointer-following copy of the tab', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };
  const fixture = await setup(t, [a, b, c], { activeId: 'a' });
  const ghosts = () => fixture.root.findAll((node) => node.props['data-chrome-tab-ghost'] !== undefined);
  assert.equal(ghosts().length, 0);

  await fixture.pointerDown('c', { clientX: 450, clientY: 10, pointerId: 1 });
  await fixture.pointerMove(pointerEvent({ clientX: 430, clientY: 10, pointerId: 1 }));
  assert.equal(ghosts().length, 1);
  const ghost = ghosts()[0];
  assert.equal(ghost.props['data-chrome-tab-ghost'], 'c');
  assert.equal(ghost.props['aria-hidden'], 'true');
  assert.equal(ghost.props.role, undefined);
  assert.equal(ghost.props['data-chrome-tab'], undefined);
  assert.equal(ghost.props.style.width, '200px');
  assert.equal(ghost.props.style.height, '36px');
  assert.match(ghost.props.style.transform, /^translate3d\(380px, 0px, 0\) rotate\(-0\.33/);
  assert.equal(renderedText(ghost), 'C');
  assert.match(fixture.env.ghostNode('c').style.transform, /^translate3d\(380px, 0px, 0\) rotate\(-0\.33/);

  await fixture.pointerMove(pointerEvent({ clientX: 420, clientY: 20, pointerId: 1 }));
  assert.match(fixture.env.ghostNode('c').style.transform, /^translate3d\(370px, 10px, 0\) rotate\(-0\.5deg\)$/);

  await fixture.pointerUp(pointerEvent({ clientX: 420, clientY: 20, pointerId: 1 }));
  assert.equal(ghosts().length, 0);
});

test('drag and keyboard reorders animate moved tabs, reduced motion skips the animation', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };
  const fixture = await setup(t, [a, b, c], { activeId: 'a' });
  await fixture.pointerDown('c', { clientX: 450, pointerId: 2 });
  await fixture.pointerMove(pointerEvent({ clientX: 430, pointerId: 2 }));
  assert.equal(fixture.env.animations.length, 0, 'Starting a drag alone must not animate');
  await fixture.pointerMove(pointerEvent({ clientX: 210, pointerId: 2 }));
  assert.equal(fixture.env.animations.length, 2);
  const dragged = new Map(fixture.env.animations.map((animation) => [animation.id, animation]));
  assert.deepEqual(dragged.get('c').frames, [
    { transform: 'translate(200px, 0px)' },
    { transform: 'translate(0px, 0px)' },
  ]);
  assert.deepEqual(dragged.get('b').frames, [
    { transform: 'translate(-200px, 0px)' },
    { transform: 'translate(0px, 0px)' },
  ]);
  assert.equal(dragged.get('c').options.duration, 140);
  assert.equal(dragged.get('c').options.easing, 'cubic-bezier(.2,0,0,1)');
  await fixture.pointerUp(pointerEvent({ clientX: 210, pointerId: 2 }));

  const keyboard = await setup(t, [a, b, c], { activeId: 'a' });
  await keyboard.fire(keyboard.shell('a').props.onKeyDown, keyEvent({ key: 'ArrowRight', altKey: true }));
  assert.deepEqual(keyboard.log.move, [['a', 1]]);
  assert.equal(keyboard.env.animations.length, 2);
  const moved = new Map(keyboard.env.animations.map((animation) => [animation.id, animation]));
  assert.deepEqual(moved.get('a').frames[0], { transform: 'translate(-200px, 0px)' });
  assert.deepEqual(moved.get('b').frames[0], { transform: 'translate(200px, 0px)' });

  const reduced = await setup(t, [a, b, c], { activeId: 'a', reducedMotion: true });
  await reduced.pointerDown('c', { clientX: 450, pointerId: 3 });
  await reduced.pointerMove(pointerEvent({ clientX: 430, pointerId: 3 }));
  assert.match(reduced.env.ghostNode('c').style.transform, /rotate\(0deg\)$/);
  await reduced.pointerMove(pointerEvent({ clientX: 210, pointerId: 3 }));
  assert.deepEqual(reduced.env.mirror.tabs.map((tab) => tab.id), ['a', 'c', 'b']);
  assert.equal(reduced.env.animations.length, 0);
});

test('escape, cancel, removal and unmount release the copy and its animations', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };
  const ghosts = (fixture) => fixture.root.findAll((node) => node.props['data-chrome-tab-ghost'] !== undefined);

  const escaped = await setup(t, [a, b, c], { activeId: 'a' });
  await escaped.pointerDown('c', { clientX: 450, pointerId: 4 });
  await escaped.pointerMove(pointerEvent({ clientX: 430, pointerId: 4 }));
  await escaped.pointerMove(pointerEvent({ clientX: 210, pointerId: 4 }));
  assert.equal(ghosts(escaped).length, 1);
  assert.ok(escaped.env.animations.length > 0);
  const escape = keyEvent({ key: 'Escape' });
  await act(async () => { escaped.env.document.emit('keydown', escape); });
  assert.equal(ghosts(escaped).length, 0);
  assert.deepEqual(escaped.env.mirror.tabs.map((tab) => tab.id), ['a', 'b', 'c']);
  await escaped.app.unmount();
  assert.ok(escaped.env.animations.every((animation) => animation.cancelled));

  const cancelled = await setup(t, [a, b, c], { activeId: 'a' });
  await cancelled.pointerDown('c', { clientX: 450, pointerId: 5 });
  await cancelled.pointerMove(pointerEvent({ clientX: 430, pointerId: 5 }));
  await cancelled.pointerMove(pointerEvent({ clientX: 210, pointerId: 5 }));
  assert.equal(ghosts(cancelled).length, 1);
  await cancelled.pointerCancel(pointerEvent({ clientX: 210, pointerId: 5 }));
  assert.equal(ghosts(cancelled).length, 0);
  assert.equal(cancelled.env.document.listenerCount('keydown'), 0);
  assert.deepEqual(cancelled.env.mirror.tabs.map((tab) => tab.id), ['a', 'c', 'b']);
  await cancelled.app.unmount();
  assert.ok(cancelled.env.animations.every((animation) => animation.cancelled));

  const removed = await setup(t, [a, b, c], { activeId: 'a' });
  await removed.pointerDown('c', { clientX: 450, pointerId: 6 });
  await removed.pointerMove(pointerEvent({ clientX: 430, pointerId: 6 }));
  await removed.pointerMove(pointerEvent({ clientX: 210, pointerId: 6 }));
  assert.equal(ghosts(removed).length, 1);
  await removed.removeTab('c');
  assert.equal(ghosts(removed).length, 0);
  assert.equal(removed.env.document.listenerCount('keydown'), 0);
});

test('a renderer without Element.animate still mounts the copy and reorders', async (t) => {
  const a = { id: 'a', identity: {}, kind: 'web', title: 'A', closable: true };
  const b = { id: 'b', identity: {}, kind: 'web', title: 'B', closable: true };
  const c = { id: 'c', identity: {}, kind: 'web', title: 'C', closable: true };
  const fixture = await setup(t, [a, b, c], { activeId: 'a', noAnimate: true });
  await fixture.pointerDown('c', { clientX: 450, pointerId: 7 });
  await fixture.pointerMove(pointerEvent({ clientX: 430, pointerId: 7 }));
  assert.equal(fixture.root.findAll((node) => node.props['data-chrome-tab-ghost'] !== undefined).length, 1);
  await fixture.pointerMove(pointerEvent({ clientX: 210, pointerId: 7 }));
  assert.deepEqual(fixture.env.mirror.tabs.map((tab) => tab.id), ['a', 'c', 'b']);
  assert.equal(fixture.env.animations.length, 0);
  await fixture.pointerUp(pointerEvent({ clientX: 210, pointerId: 7 }));
});
