import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../../packages/shell/ssh-remote/plugins/status/client.js', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

// This runner exercises React component state and effect ownership without a DOM or network.
// Native dialog layout, browser focus trapping and paint still require browser verification.
function runtime({ href = 'http://localhost:5000/', storage = new Map(), fetchImpl = async () => Response.json({ ok: true }) } = {}) {
  let active;
  let definition;
  let nextId = 0;
  const timers = new Map();
  const assigned = [];
  const writes = [];
  const document = { hidden: false };
  const window = {
    location: { href, assign: (value) => assigned.push(value) },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { writes.push([key, value]); storage.set(key, value); } },
    __ModuleLoader__: { load(value) { definition = value; } },
  };
  const same = (left, right) => left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const owner = active;
      const index = owner.cursor++;
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [owner.hooks[index], (next) => { owner.hooks[index] = typeof next === 'function' ? next(owner.hooks[index]) : next; owner.updates += 1; }];
    },
    useRef(initial) {
      const index = active.cursor++;
      return active.hooks[index] ??= { current: initial };
    },
    useCallback(callback, deps) {
      const index = active.cursor++;
      if (!same(active.hooks[index]?.deps, deps)) active.hooks[index] = { callback, deps };
      return active.hooks[index].callback;
    },
    useEffect(callback, deps) {
      const owner = active;
      const index = owner.cursor++;
      if (!same(owner.hooks[index]?.deps, deps)) {
        const previous = owner.hooks[index];
        owner.hooks[index] = { deps, cleanup: previous?.cleanup };
        owner.effects.push(() => { previous?.cleanup?.(); owner.hooks[index].cleanup = callback(); });
      }
    },
  };
  const context = vm.createContext({ window, document, URL, fetch: fetchImpl, console,
    crypto: { randomUUID: () => `request-${++nextId}` },
    setInterval(callback) { const id = ++nextId; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  const client = definition.factory((id) => {
    assert.equal(id, 'react', 'no private DSH Client imports');
    return react;
  });
  function mount(component, props = {}) {
    const runner = {
      hooks: [], effects: [], cursor: 0, updates: 0, tree: null,
      render(next = props) {
        props = next; this.cursor = 0; active = this;
        try { this.tree = component(props); } finally { active = null; }
        return this.tree;
      },
      commit() { const pending = this.effects.splice(0); pending.forEach((effect) => effect()); },
      unmount() { this.hooks.forEach((hook) => hook?.cleanup?.()); },
      async settle() { await flush(); this.render(); this.commit(); await flush(); return this.render(); },
    };
    runner.render();
    return runner;
  }
  return { client, mount, window, document, timers, assigned, writes, storage };
}

function all(tree, predicate) {
  const result = [];
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (predicate(node)) result.push(node);
    visit(node.props?.children);
  }
  visit(tree);
  return result;
}
const ofType = (tree, type) => all(tree, (node) => node.type === type);
const named = (tree, name) => all(tree, (node) => node.type?.name === name);
const role = (tree, value) => all(tree, (node) => node.props?.role === value);
const content = (tree) => {
  if (Array.isArray(tree)) return tree.map(content).join(' ');
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return content(tree.props?.children);
};
const plugin = (overrides = {}) => ({ name: '@local/theme', spec: '@local/theme', version: '2.0.0', title: 'Theme', description: 'Quiet colors', ...overrides });
const page = (overrides = {}) => ({ ok: true, local: { bundles: [plugin()] }, remote: [plugin({ enabled: true })], ...overrides });
const config = { hostAlias: 'linux-dev', dshVersion: '1.2.3', localReturnUrl: 'http://127.0.0.1:57097/?tkn=return-secret' };
function mountPage(rt) {
  const { PluginManagerPage, messages } = rt.client.__test;
  return rt.mount(PluginManagerPage, { t: (key) => messages.en[key], config, embedded: false });
}
function slotsFor(rt) {
  const slots = [];
  const locales = [];
  const ctx = {
    locale: { register(...args) { locales.push(args); return () => {}; }, bind() { return (key) => rt.client.__test.messages.en[key]; } },
    slots: { inject(_name, callback) { callback(); }, register(options, component) { slots.push({ options, component }); return () => {}; } },
    effect(callback) { return callback(); },
  };
  rt.client.apply(ctx, config);
  return { slots, locales };
}

test('embedded detection persists only one Guest session bit and survives navigation or module reload', () => {
  const storage = new Map();
  const rt = runtime({ href: 'http://127.0.0.1:5000/?tkn=auth-secret&sshRemoteEmbedded=1', storage });
  assert.equal(rt.client.__test.detectEmbedded(rt.window), true);
  assert.deepEqual(rt.writes, [['ssh-remote:embedded', '1']]);
  rt.window.location.href = 'http://127.0.0.1:5000/session/abc';
  assert.equal(rt.client.__test.detectEmbedded(rt.window), true);
  const reloaded = runtime({ storage });
  assert.equal(reloaded.client.__test.detectEmbedded(reloaded.window), true);
  assert.equal(JSON.stringify([...storage]).includes('secret'), false);
  assert.equal(runtime().client.__test.detectEmbedded(runtime().window), false);
  for (const value of ['0', 'true', '01']) {
    const ordinary = runtime({ href: `http://localhost/?sshRemoteEmbedded=${value}` });
    assert.equal(ordinary.client.__test.detectEmbedded(ordinary.window), false);
    assert.equal(ordinary.writes.length, 0);
  }
});

test('embedded URL remains authoritative when session storage is denied', () => {
  const rt = runtime({ href: 'http://localhost/?sshRemoteEmbedded=1&tkn=secret' });
  Object.defineProperty(rt.window, 'sessionStorage', { get() { throw new Error('denied'); } });
  assert.equal(rt.client.__test.detectEmbedded(rt.window), true);
  rt.window.location.href = 'http://localhost/';
  assert.equal(rt.client.__test.detectEmbedded(rt.window), false);
  assert.equal(rt.client.__test.detectEmbedded({}), false);
});

test('both existing slots hide all ReturnLocal controls in embedded mode; ordinary browser return still assigns once', () => {
  for (const embedded of [true, false]) {
    const rt = runtime({ href: `http://localhost/${embedded ? '?sshRemoteEmbedded=1' : ''}` });
    const { slots, locales } = slotsFor(rt);
    assert.deepEqual(slots.map((entry) => entry.options.name), ['conversation.session.header.utilities', 'sidebar.panellist', 'main']);
    assert.deepEqual(locales.map((entry) => entry.slice(0, 2)), [['ssh-remote-status', 'en'], ['ssh-remote-status', 'zh']]);
    const header = rt.mount(slots[0].component);
    const returnNode = named(header.tree, 'ReturnLocal')[0];
    assert.equal(returnNode.props.embedded, embedded);
    const rendered = rt.client.__test.ReturnLocal(returnNode.props);
    if (embedded) assert.equal(rendered, null);
    else {
      assert.equal(rendered.props.disabled, false);
      rendered.props.onClick();
      assert.deepEqual(rt.assigned, [config.localReturnUrl]);
    }
    const panel = slots[2].component();
    assert.equal(panel.props.embedded, embedded);
    const pageRunner = rt.mount(panel.type, panel.props);
    const pageReturn = named(pageRunner.tree, 'ReturnLocal')[0];
    assert.equal(rt.client.__test.ReturnLocal(pageReturn.props) === null, embedded);
    assert.equal(JSON.stringify(rt.writes).includes('return-secret'), false);
    const errors = [];
    const invalid = rt.client.__test.ReturnLocal({ embedded: false, config: { localReturnUrl: 'https://example.com/' }, t: (key) => key, onError: (error) => errors.push(error) });
    assert.equal(invalid.props.disabled, true);
    invalid.props.onClick();
    assert.equal(errors[0].code, 'INVALID_RETURN_URL');
  }
});

test('search matches all terms across title, package, description and version without changing normalized inputs', () => {
  const { filterPlugins, normalizePlugin } = runtime().client.__test;
  const list = [normalizePlugin(plugin(), 'local'), normalizePlugin(plugin({ name: '@local/notes', title: '笔记', description: 'Markdown' }), 'local')];
  const before = plain(list);
  assert.deepEqual(plain(filterPlugins(list, ' THEME quiet 2.0 ').map((item) => item.name)), ['@local/theme']);
  assert.deepEqual(plain(filterPlugins(list, '笔记 mark').map((item) => item.name)), ['@local/notes']);
  assert.equal(filterPlugins(list, 'missing').length, 0);
  assert.deepEqual(plain(list), before);
});

test('snapshot install state distinguishes unavailable, existing, disabled and version-conflicting remote plugins', () => {
  const { localInstallState, normalizePlugin } = runtime().client.__test;
  const local = normalizePlugin(plugin(), 'local');
  assert.equal(localInstallState(local, []), 'available');
  assert.equal(localInstallState(local, [normalizePlugin(plugin(), 'remote')]), 'installed');
  assert.equal(localInstallState(local, [normalizePlugin(plugin({ enabled: false }), 'remote')]), 'enable');
  assert.equal(localInstallState(local, [normalizePlugin(plugin({ version: '1.0.0' }), 'remote')]), 'versionConflict');
  assert.equal(localInstallState(local, [normalizePlugin(plugin({ installed: false }), 'remote')]), 'available');
  assert.equal(localInstallState({ ...local, availability: 'missing' }, []), 'missing');
});

test('page loads into installed tab, searches compact rows and switches tabs by keyboard', async () => {
  const calls = [];
  const gate = deferred();
  const rt = runtime({ fetchImpl: async (url) => { calls.push(url); return gate.promise; } });
  const runner = mountPage(rt);
  assert.equal(named(runner.tree, 'EmptyState')[0].props.loading, true);
  assert.equal(named(runner.tree, 'PluginRow').length, 0);
  assert.deepEqual(role(runner.tree, 'tab').map((node) => node.props['aria-selected']), [true, false]);
  runner.commit();
  gate.resolve(Response.json(page({ remote: [plugin(), plugin({ name: 'not-installed', installed: false })] })));
  await runner.settle();
  assert.equal(named(runner.tree, 'PluginRow').length, 1);
  assert.equal(named(runner.tree, 'PluginRow')[0].props.plugin.origin, 'remote');
  const focused = [];
  role(runner.tree, 'tab')[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, currentTarget: { parentElement: { querySelector: (selector) => ({ focus: () => focused.push(selector) }) } } });
  runner.render();
  assert.deepEqual(focused, ['#ssh-rs-tab-local']);
  assert.deepEqual(role(runner.tree, 'tab').map((node) => node.props.tabIndex), [-1, 0]);
  assert.equal(role(runner.tree, 'tabpanel').find((node) => !node.props.hidden).props['aria-labelledby'], 'ssh-rs-tab-local');
  for (const tab of role(runner.tree, 'tab')) assert.ok(all(runner.tree, (node) => node.props.id === tab.props['aria-controls']).length);
  const input = ofType(runner.tree, 'input')[0];
  assert.ok(ofType(runner.tree, 'label').some((node) => node.props.htmlFor === input.props.id));
  assert.equal(named(runner.tree, 'PluginRow')[0].props.plugin.origin, 'local');
  assert.match(content(runner.tree), /snapshot shared/);
  ofType(runner.tree, 'input')[0].props.onChange({ target: { value: 'unmatched' } });
  runner.render();
  assert.equal(named(runner.tree, 'EmptyState')[0].props.title, 'No matching plugins');
  assert.equal(named(runner.tree, 'PluginRow').length, 0);
  assert.deepEqual(calls, ['/api/ssh-remote/plugins/page'], 'search and tab switches never mutate or refetch');
  runner.unmount();
  assert.equal(rt.timers.size, 0);
});

test('initial failure, empty remote, missing snapshot and empty snapshot stay distinct', async () => {
  for (const sample of [
    { response: Response.json({ ok: false, error: { code: 'OFFLINE', message: 'Remote offline' } }, { status: 503 }), error: true },
    { response: Response.json(page({ local: null, remote: [] })), empty: 'No local snapshot has been shared' },
    { response: Response.json(page({ local: { bundles: [] }, remote: [] })), empty: 'No third-party plugins in this snapshot' },
  ]) {
    const rt = runtime({ fetchImpl: async () => sample.response });
    const runner = mountPage(rt); runner.commit(); await runner.settle();
    if (sample.error) {
      assert.equal(named(runner.tree, 'EmptyState').length, 0, 'failure is not a successful empty result');
      const feedback = named(runner.tree, 'Feedback')[0];
      assert.equal(feedback.props.notice.error.code, 'OFFLINE');
      assert.equal(content(feedback.props.action), 'Try again');
    } else {
      assert.equal(named(runner.tree, 'EmptyState')[0].props.title, 'No plugins installed on this remote host');
      role(runner.tree, 'tab')[1].props.onClick(); runner.render();
      assert.equal(named(runner.tree, 'EmptyState')[0].props.title, sample.empty);
    }
    runner.unmount();
  }
});

test('row actions are compact, state-aware and hide uninstall inside an accessible overflow', () => {
  const rt = runtime();
  const { PluginRow, normalizePlugin, Button, Overflow, messages } = rt.client.__test;
  const base = { remote: [], busy: '', t: (key) => messages.en[key], onInstall() {}, onToggle() {}, onRemove() {} };
  const remote = PluginRow({ ...base, plugin: normalizePlugin(plugin(), 'remote') });
  assert.equal(remote.type, 'li');
  assert.equal(ofType(remote, Button).length, 1);
  assert.equal(content(ofType(remote, Button)[0]), 'Disable');
  assert.equal(ofType(remote, Overflow).length, 1);
  const protectedRow = PluginRow({ ...base, plugin: normalizePlugin(plugin({ removable: false }), 'remote') });
  assert.equal(ofType(protectedRow, Overflow).length, 0);
  const local = PluginRow({ ...base, plugin: normalizePlugin(plugin(), 'local') });
  assert.equal(ofType(local, Button)[0].props.kind, 'primary');
  assert.equal(content(ofType(local, Button)[0]), 'Install on remote');
  const locked = PluginRow({ ...base, busy: 'install:@local/theme', plugin: normalizePlugin(plugin(), 'local') });
  assert.equal(ofType(locked, Button)[0].props.disabled, true);
  assert.equal(ofType(locked, Button)[0].props.loading, true);
  assert.equal(locked.props['aria-busy'], true);
});

test('overflow supports keyboard open, focus, Escape restore, blur dismissal and explicit remove', () => {
  const rt = runtime();
  const { Overflow, Button } = rt.client.__test;
  const removed = [];
  const focused = [];
  const runner = rt.mount(Overflow, { plugin: plugin(), disabled: false, t: (key) => key, onRemove: (value) => removed.push(value.name) });
  ofType(runner.tree, Button)[0].props.buttonRef.current = { focus: () => focused.push('trigger') };
  runner.commit();
  runner.tree.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }); runner.render();
  role(runner.tree, 'menu')[0].props.ref.current = { querySelector: () => ({ focus: () => focused.push('item') }) };
  runner.commit();
  assert.equal(focused.at(-1), 'item');
  assert.equal(ofType(runner.tree, Button)[0].props['aria-expanded'], true);
  runner.tree.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); runner.render();
  assert.equal(focused.at(-1), 'trigger');
  assert.equal(role(runner.tree, 'menu').length, 0);
  ofType(runner.tree, Button)[0].props.onClick(); runner.render();
  role(runner.tree, 'menuitem')[0].props.onClick(); runner.render();
  assert.deepEqual(removed, ['@local/theme']);
  ofType(runner.tree, Button)[0].props.onClick(); runner.render();
  runner.tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); runner.render();
  assert.equal(role(runner.tree, 'menu').length, 0);
});

test('native modal names and describes risk, focuses Cancel, restores focus and blocks dismissal while busy', () => {
  const rt = runtime();
  const { ConfirmationDialog, Button, messages } = rt.client.__test;
  const events = [];
  const props = { dialog: { kind: 'builds', plugin: plugin(), builds: ['trusted-build'] }, busy: false,
    t: (key) => messages.en[key], onCancel: () => events.push('cancel'), onConfirm: () => events.push('confirm') };
  const runner = rt.mount(ConfirmationDialog, props);
  assert.equal(runner.tree.type, 'dialog');
  assert.equal(runner.tree.props['aria-modal'], true);
  assert.ok(all(runner.tree, (node) => node.props.id === runner.tree.props['aria-labelledby']).length);
  assert.ok(all(runner.tree, (node) => node.props.id === runner.tree.props['aria-describedby']).length);
  assert.match(content(runner.tree), /persistent permission/);
  assert.match(content(runner.tree), /trusted-build/);
  runner.tree.props.ref.current = { ownerDocument: { activeElement: { isConnected: true, focus: () => events.push('restore') } },
    showModal: () => events.push('show'), close: () => events.push('close') };
  ofType(runner.tree, Button)[0].props.buttonRef.current = { focus: () => events.push('focus-cancel') };
  runner.commit();
  assert.deepEqual(events, ['show', 'focus-cancel']);
  runner.tree.props.onCancel({ preventDefault() {} });
  assert.equal(events.at(-1), 'cancel');
  runner.render({ ...props, busy: true });
  runner.tree.props.onCancel({ preventDefault() {} });
  assert.equal(events.filter((value) => value === 'cancel').length, 1);
  assert.ok(ofType(runner.tree, Button).every((node) => node.props.disabled));
  runner.unmount();
  assert.deepEqual(events.slice(-2), ['close', 'restore']);
});

test('pending builds never approve automatically; cancel stops and explicit confirm passes only returned build names', async () => {
  const requests = [];
  const rt = runtime({ fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return Response.json(url.endsWith('/page') ? page({ remote: [] })
      : options.body.includes('approvedBuilds') ? { ok: true, result: { application: 'restart-required' } }
        : { ok: true, result: { application: 'not-applied', pendingBuilds: ['theme-build'] } });
  } });
  const runner = mountPage(rt); runner.commit(); await runner.settle();
  role(runner.tree, 'tab')[1].props.onClick(); runner.render();
  named(runner.tree, 'PluginRow')[0].props.onInstall(named(runner.tree, 'PluginRow')[0].props.plugin);
  await runner.settle();
  assert.equal(requests.filter((item) => item.url.endsWith('/install')).length, 1);
  let dialog = named(runner.tree, 'ConfirmationDialog')[0];
  assert.deepEqual(plain(dialog.props.dialog.builds), ['theme-build']);
  dialog.props.onCancel(); runner.render();
  assert.equal(named(runner.tree, 'ConfirmationDialog').length, 0);
  named(runner.tree, 'PluginRow')[0].props.onInstall(named(runner.tree, 'PluginRow')[0].props.plugin);
  await runner.settle();
  dialog = named(runner.tree, 'ConfirmationDialog')[0];
  dialog.props.onConfirm(); await runner.settle();
  const installs = requests.filter((item) => item.url.endsWith('/install'));
  assert.equal(installs.length, 3);
  assert.equal('approvedBuilds' in installs[0].body, false);
  assert.deepEqual(installs[2].body.approvedBuilds, ['theme-build']);
  assert.equal(installs[2].body.spec, '@local/theme@2.0.0');
  assert.notEqual(installs[1].body.requestId, installs[2].body.requestId);
  assert.equal(named(runner.tree, 'ConfirmationDialog').length, 0);
  assert.match(named(runner.tree, 'Feedback')[1].props.notice.detail, /Restart the remote Host/);
  runner.unmount();
});

test('remove requires confirmation and synchronously guards duplicate submission', async () => {
  const calls = [];
  const gate = deferred();
  const refreshed = deferred();
  let reads = 0;
  const rt = runtime({ fetchImpl: async (url) => {
    calls.push(url);
    if (url.endsWith('/remove')) return gate.promise;
    return ++reads === 1 ? Response.json(page()) : refreshed.promise;
  } });
  const runner = mountPage(rt); runner.commit(); await runner.settle();
  const row = named(runner.tree, 'PluginRow')[0];
  row.props.onRemove(row.props.plugin); runner.render();
  assert.equal(calls.some((url) => url.endsWith('/remove')), false);
  const dialog = named(runner.tree, 'ConfirmationDialog')[0];
  dialog.props.onConfirm(); dialog.props.onConfirm(); runner.render();
  assert.equal(calls.filter((url) => url.endsWith('/remove')).length, 1);
  assert.equal(named(runner.tree, 'ConfirmationDialog')[0].props.busy, true);
  gate.resolve(Response.json({ ok: true, result: { application: 'applied' } }));
  await runner.settle();
  assert.equal(named(runner.tree, 'ConfirmationDialog')[0].props.busy, true, 'keep focus inside the dialog until controls unlock');
  refreshed.resolve(Response.json(page({ remote: [] })));
  await runner.settle();
  assert.equal(named(runner.tree, 'ConfirmationDialog').length, 0);
  assert.equal(named(runner.tree, 'Feedback')[1].props.notice.message, 'Remote plugin updated.');
  runner.unmount();
});

test('operation failures remain visible after a successful refresh and stale reads cannot replace post-mutation rows', async () => {
  const stale = deferred();
  let reads = 0;
  const rt = runtime({ fetchImpl: async (url) => {
    if (url.endsWith('/page')) {
      reads += 1;
      if (reads === 2) return stale.promise;
      return Response.json(page({ remote: [plugin({ title: reads > 2 ? 'Fresh result' : 'Original' })] }));
    }
    return Response.json({ ok: false, result: { application: 'failed', items: [{ name: 'theme', ok: false, code: 'DENIED', message: 'Cannot disable' }] }, error: { code: 'DENIED', message: 'Cannot disable' } });
  } });
  const runner = mountPage(rt); runner.commit(); await runner.settle();
  [...rt.timers.values()][0]();
  const row = named(runner.tree, 'PluginRow')[0];
  row.props.onToggle(row.props.plugin); await runner.settle();
  assert.equal(named(runner.tree, 'PluginRow')[0].props.plugin.title, 'Fresh result');
  stale.resolve(Response.json(page({ remote: [plugin({ title: 'Stale result' })] })));
  await runner.settle();
  assert.equal(named(runner.tree, 'PluginRow')[0].props.plugin.title, 'Fresh result');
  const notice = named(runner.tree, 'Feedback')[1].props.notice;
  assert.equal(notice.error.code, 'DENIED');
  assert.equal(notice.items[0].message, 'Cannot disable');
  [...rt.timers.values()][0](); await runner.settle();
  assert.equal(named(runner.tree, 'Feedback')[1].props.notice.error.code, 'DENIED');
  runner.unmount();
});

test('refresh errors retain stale rows; polling pauses for dialogs or hidden pages and unmount discards late reads', async () => {
  const gate = deferred();
  let count = 0;
  const rt = runtime({ fetchImpl: async () => {
    count += 1;
    if (count === 1) return Response.json(page());
    if (count === 2) throw new Error('offline');
    return gate.promise;
  } });
  const runner = mountPage(rt); runner.commit(); await runner.settle();
  const poll = [...rt.timers.values()][0];
  rt.document.hidden = true; poll(); assert.equal(count, 1);
  rt.document.hidden = false;
  const row = named(runner.tree, 'PluginRow')[0];
  row.props.onRemove(row.props.plugin); runner.render(); poll(); assert.equal(count, 1);
  named(runner.tree, 'ConfirmationDialog')[0].props.onCancel(); runner.render(); poll(); await runner.settle();
  assert.equal(named(runner.tree, 'PluginRow').length, 1);
  assert.match(named(runner.tree, 'Feedback')[0].props.notice.detail, /last loaded list/);
  poll(); runner.unmount();
  const updates = runner.updates;
  gate.resolve(Response.json(page({ remote: [] }))); await flush();
  assert.equal(runner.updates, updates);
  assert.equal(rt.timers.size, 0);
});

test('unapplied outcomes and transport failures never show installation success', async () => {
  for (const sample of [
    { result: { ok: true, result: { application: 'not-applied' } }, expected: 'The change has not been applied.', kind: 'warning' },
    { result: { ok: false, result: { application: 'cancelled' } }, expected: 'The plugin operation did not fully complete.', kind: 'error' },
    { error: new Error('Request interrupted'), expected: 'The plugin operation failed.', kind: 'error' },
  ]) {
    const rt = runtime({ fetchImpl: async (url) => {
      if (url.endsWith('/page')) return Response.json(page({ remote: [] }));
      if (sample.error) throw sample.error;
      return Response.json(sample.result);
    } });
    const runner = mountPage(rt); runner.commit(); await runner.settle();
    role(runner.tree, 'tab')[1].props.onClick(); runner.render();
    const row = named(runner.tree, 'PluginRow')[0];
    row.props.onInstall(row.props.plugin); await runner.settle();
    const notice = named(runner.tree, 'Feedback')[1].props.notice;
    assert.ok(notice.message.startsWith(sample.expected));
    assert.equal(notice.kind, sample.kind);
    assert.doesNotMatch(notice.message, /installation completed/);
    runner.unmount();
  }
});

test('localized unified controls use theme tokens, native dialog ownership and no old card UI or private imports', () => {
  const { messages, Button, styles } = runtime().client.__test;
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zh).sort());
  for (const value of Object.values(messages.zh)) assert.equal(typeof value, 'string');
  const button = Button({ children: 'Refresh', loading: true, disabled: true });
  assert.equal(button.props.type, 'button');
  assert.equal(button.props['aria-busy'], true);
  assert.equal(button.props.disabled, true);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /--dsw-alias-/);
  assert.match(styles, /max-width:640px/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(/i);
  assert.doesNotMatch(source, /PluginCard|localStorage|document\.body|require\(['"]@deepseek-ai/);
  assert.equal((source.match(/window\.location\.assign/g) || []).length, 1, 'all return actions share the embedded-aware control');
});
