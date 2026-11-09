import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as tabStateModule from '../../../packages/shell/src/tab-state.js';

const { createTabState } = tabStateModule;
const spec = (overrides = {}) => ({ kind: 'profile-ui', key: 'remote-a', title: 'Remote A', profileId: 'remote-a', ...overrides });
const tab = (state, id) => state.getSnapshot().tabs.find((item) => item.id === id);
const fields = ['id', 'kind', 'key', 'title', 'profileId', 'phase', 'identity', 'closable', 'error'];
const launcherSpec = (overrides = {}) => ({ kind: 'launcher', key: 'launcher-1', title: '新建工作区', ...overrides });

test('the ESM factory has no runtime imports and survives the simple concatenation transform', async () => {
  assert.deepEqual(Object.keys(tabStateModule), ['createTabState']);
  const source = await readFile(new URL('../../../packages/shell/src/tab-state.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:import|require)\s*[(]/);
  const concatenated = source.replace(/^export /gm, '');
  assert.doesNotMatch(concatenated, /^\s*(import|export)\s/m);
  const context = {};
  for (const name of ['window', 'document', 'Host', 'PTY', 'fetch']) {
    Object.defineProperty(context, name, { get() { throw new Error(`Unexpected runtime access: ${name}`); } });
  }
  const isolated = vm.runInNewContext(`${concatenated}\ncreateTabState()`, context);
  const opened = isolated.reserve({ kind: 'terminal', key: 'term', title: 'Terminal' });
  isolated.setPhase(opened.id, opened.identity, 'ready');
  isolated.retry(opened.id);
  isolated.close(opened.id);
  isolated.dispose();
  assert.equal(isolated.getSnapshot().tabs.length, 1);
});

test('default construction exposes only the stable immutable Local record', () => {
  const state = createTabState();
  assert.deepEqual(Object.keys(state).sort(), ['getSnapshot', 'subscribe', 'reserve', 'replace', 'move', 'activate', 'setPhase', 'retry', 'close', 'isCurrent', 'dispose'].sort());
  const snapshot = state.getSnapshot();
  assert.deepEqual(snapshot.tabs.map((item) => ({ ...item, identity: undefined })), [
    { id: 'local', kind: 'profile-ui', key: 'local', title: '本地', phase: 'ready', identity: undefined, closable: false },
  ]);
  assert.equal(snapshot.activeId, 'local');
  assert.equal(Object.keys(snapshot.tabs[0]).includes('generation'), false);
  assert.equal(state.getSnapshot(), snapshot);
  assert.equal(state.isCurrent('local', snapshot.tabs[0].identity), true);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(snapshot.tabs[0].identity), true);
});

test('profile UI requests without a known matching profileId reserve distinct nonlocal records', () => {
  for (const options of [undefined, {}, { localProfileId: undefined }, { localProfileId: 'home' }]) {
    const state = createTabState(options);
    const local = state.getSnapshot().tabs[0];
    const first = state.reserve({ kind: 'profile-ui', key: 'profile-a', title: 'Profile A' });
    const second = state.reserve({ kind: 'profile-ui', key: 'profile-b', title: 'Profile B', profileId: undefined });
    assert.equal(first.local, false);
    assert.equal(second.local, false);
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.id, local.id);
    assert.notEqual(second.id, first.id);
    assert.equal(typeof first.identity, 'object');
    assert.notEqual(first.identity, local.identity);
    assert.notEqual(first.identity, second.identity);
    assert.equal(state.getSnapshot().tabs.length, 3);
    assert.equal(state.getSnapshot().tabs[0], local);
    assert.equal(state.getSnapshot().activeId, second.id);
    assert.equal(tab(state, first.id).phase, 'opening');
    const again = state.reserve({ kind: 'profile-ui', key: 'profile-a', title: 'Profile A' });
    assert.deepEqual(again, { ...first, created: false });
    assert.equal(state.getSnapshot().activeId, first.id);
  }
});

test('matching profile UI requests select Local without creating, renaming, or allocating an ID', () => {
  let allocations = 0;
  const state = createTabState({ localProfileId: 'home', localTitle: 'Home', makeId: () => `id-${++allocations}` });
  const initialLocal = state.getSnapshot().tabs[0];
  state.reserve(spec());
  const result = state.reserve(spec({ key: 'different-key', title: 'Ignore rename', profileId: 'home' }));
  assert.deepEqual(result, { id: 'local', identity: initialLocal.identity, created: false, local: true });
  assert.equal(state.getSnapshot().activeId, 'local');
  assert.equal(state.getSnapshot().tabs[0], initialLocal);
  assert.equal(initialLocal.profileId, 'home');
  assert.equal(initialLocal.title, 'Home');
  assert.equal(state.getSnapshot().tabs.length, 2);
  assert.equal(allocations, 1);
  for (const kind of ['terminal', 'browser', 'launcher']) {
    const external = state.reserve(spec({ kind, profileId: 'home' }));
    assert.equal(external.local, false);
    assert.equal(external.created, true);
  }
});

test('Local cannot close, retry, replace, move, or leave ready even with its current identity', () => {
  const state = createTabState({ localProfileId: 'home' });
  const before = state.getSnapshot();
  const identity = before.tabs[0].identity;
  assert.equal(state.close('local'), false);
  assert.equal(state.retry('local'), null);
  assert.equal(state.replace('local', launcherSpec({ profileId: 'home' })), null);
  for (const phase of ['opening', 'ready', 'error']) assert.equal(state.setPhase('local', identity, phase, 'FAILED'), false);
  assert.equal(state.getSnapshot(), before);
});

test('each supported nonlocal kind reserves an opening record with a unique identity object', () => {
  const state = createTabState({ localProfileId: 'home' });
  const seen = new Set([state.getSnapshot().tabs[0].identity]);
  for (const kind of ['profile-ui', 'terminal', 'browser']) {
    const result = state.reserve(spec({ kind }));
    assert.deepEqual(Object.keys(result).sort(), ['created', 'id', 'identity', 'local']);
    assert.equal(Object.hasOwn(result, 'generation'), false);
    assert.equal(result.created, true);
    assert.equal(result.local, false);
    assert.equal(typeof result.identity, 'object');
    assert.equal(Object.isFrozen(result.identity), true);
    assert.equal(seen.has(result.identity), false);
    seen.add(result.identity);
    assert.equal(tab(state, result.id).phase, 'opening');
    assert.equal(tab(state, result.id).identity, result.identity);
    assert.equal(tab(state, result.id).closable, true);
    assert.equal(state.getSnapshot().activeId, result.id);
  }
  assert.equal(new Set(state.getSnapshot().tabs.map((item) => item.id)).size, 4);
});

test('launcher records are ready, closable, provider-free, and deduplicated by key', () => {
  const state = createTabState();
  const result = state.reserve(launcherSpec());
  assert.equal(result.created, true);
  assert.equal(tab(state, result.id).kind, 'launcher');
  assert.equal(tab(state, result.id).phase, 'ready');
  assert.equal(Object.hasOwn(tab(state, result.id), 'profileId'), false);
  assert.equal(state.getSnapshot().activeId, result.id);
  assert.equal(state.isCurrent(result.id, result.identity), true);
  const again = state.reserve(launcherSpec());
  assert.deepEqual(again, { ...result, created: false });
  assert.equal(state.getSnapshot().tabs.length, 2);
  assert.equal(state.close(result.id), true);
  assert.equal(state.getSnapshot().activeId, 'local');
  assert.equal(state.getSnapshot().tabs.length, 1);
});

test('ordinary activation preserves all record identities', () => {
  const state = createTabState();
  const a = state.reserve(spec());
  const b = state.reserve(spec({ kind: 'browser' }));
  state.setPhase(a.id, a.identity, 'ready');
  const records = state.getSnapshot().tabs;
  for (const id of ['local', a.id, b.id, 'local']) {
    assert.equal(state.activate(id), true);
    assert.equal(state.getSnapshot().activeId, id);
    assert.equal(state.getSnapshot().tabs, records);
  }
  const before = state.getSnapshot();
  assert.equal(state.activate('missing'), false);
  assert.equal(state.activate('local'), true);
  assert.equal(state.getSnapshot(), before);
});

test('same kind and key deduplicate and select without replacing metadata or identity', () => {
  let ids = 0;
  const state = createTabState({ makeId: () => `id-${++ids}` });
  const first = state.reserve(spec());
  state.setPhase(first.id, first.identity, 'ready');
  const original = tab(state, first.id);
  state.activate('local');
  const again = state.reserve(spec({ title: 'Changed', profileId: 'different-profile' }));
  assert.deepEqual(again, { ...first, created: false });
  assert.equal(tab(state, first.id), original);
  assert.equal(state.getSnapshot().activeId, first.id);
  assert.equal(state.getSnapshot().tabs.length, 2);
  assert.equal(ids, 1);
});

test('deduplication does not restart errors and separates exact kind/key pairs', () => {
  const state = createTabState();
  const first = state.reserve(spec({ kind: 'terminal', key: 'same' }));
  state.setPhase(first.id, first.identity, 'error');
  const failed = tab(state, first.id);
  assert.equal(state.reserve(spec({ kind: 'terminal', key: 'same' })).identity, first.identity);
  assert.equal(tab(state, first.id), failed);
  const otherKind = state.reserve(spec({ kind: 'browser', key: 'same' }));
  const otherKey = state.reserve(spec({ kind: 'terminal', key: 'same:other' }));
  assert.notEqual(otherKind.id, first.id);
  assert.notEqual(otherKey.id, first.id);
  assert.equal(state.getSnapshot().tabs.length, 4);
});

test('public records and tickets whitelist metadata without reading extra URL/token/handle inputs', () => {
  const state = createTabState({ localProfileId: 'home', url: 'secret-local-url', token: 'secret-local-token' });
  const input = spec({ id: 'injected', generation: 99, phase: 'ready', closable: false, error: { token: 'secret' } });
  for (const key of ['url', 'token', 'handle']) {
    Object.defineProperty(input, key, { enumerable: true, get() { throw new Error(`Must not read ${key}`); } });
  }
  const result = state.reserve(input);
  const record = tab(state, result.id);
  assert.equal(record.phase, 'opening');
  assert.equal(record.closable, true);
  assert.notEqual(record.id, 'injected');
  assert.equal(Object.hasOwn(record, 'generation'), false);
  assert.equal(Object.hasOwn(record, 'error'), false);
  for (const item of state.getSnapshot().tabs) assert.ok(Object.keys(item).every((key) => fields.includes(key)));
  input.title = 'Mutated';
  input.profileId = 'Mutated';
  assert.equal(record.title, 'Remote A');
  assert.equal(record.profileId, 'remote-a');
  assert.doesNotMatch(JSON.stringify([state.getSnapshot(), result]), /secret|injected|Mutated/);
});

test('identity objects carry no data and cannot leak URL, handle, or secret metadata', () => {
  const state = createTabState();
  const values = [
    state.getSnapshot().tabs[0].identity,
    state.reserve(spec()).identity,
    state.reserve(launcherSpec({ key: 'launcher-b' })).identity,
  ];
  for (const identity of values) {
    assert.deepEqual(Object.keys(identity), []);
    assert.equal(Object.isFrozen(identity), true);
  }
  assert.doesNotMatch(JSON.stringify(state.getSnapshot()), /url|token|handle|secret|generation/i);
  assert.equal(new Set(values).size, values.length);
});

test('failure metadata keeps only a copied immutable code and never publishes error messages or handles', () => {
  const state = createTabState();
  const result = state.reserve(spec());
  const error = Object.assign(new Error('https://private/?token=secret'), { code: 'CONNECT_FAILED', url: 'secret-url', token: 'secret-token', handle: { secret: true } });
  state.setPhase(result.id, result.identity, 'error', error);
  error.code = 'MUTATED';
  assert.deepEqual(tab(state, result.id).error, { code: 'CONNECT_FAILED' });
  assert.equal(Object.isFrozen(tab(state, result.id).error), true);
  assert.doesNotMatch(JSON.stringify(state.getSnapshot()), /secret|MUTATED/);
  for (const unsafe of [undefined, null, new Error('secret'), { code: 'http://private/?token=secret' }, { code: 'X'.repeat(65) }, { code: {} }, { get code() { throw new Error('secret'); } }]) {
    const identity = state.retry(result.id);
    assert.equal(Object.hasOwn(tab(state, result.id), 'error'), false);
    assert.equal(state.setPhase(result.id, identity, 'error', unsafe), true);
    assert.deepEqual(tab(state, result.id).error, { code: 'TAB_FAILED' });
  }
});

test('snapshots, tab arrays, records, tickets, identities, and nested error metadata are immutable', () => {
  const state = createTabState();
  const initial = state.getSnapshot();
  const result = state.reserve(spec());
  const opening = state.getSnapshot();
  state.setPhase(result.id, result.identity, 'error', 'FAILED');
  const failed = state.getSnapshot();
  for (const object of [initial, initial.tabs, ...initial.tabs, initial.tabs[0].identity, result, result.identity, opening, opening.tabs, ...opening.tabs, failed, failed.tabs, ...failed.tabs, tab(state, result.id).error]) {
    assert.equal(Object.isFrozen(object), true);
  }
  assert.throws(() => { initial.activeId = 'changed'; }, TypeError);
  assert.throws(() => { opening.tabs.push({}); }, TypeError);
  assert.throws(() => { opening.tabs[1].phase = 'changed'; }, TypeError);
  assert.throws(() => { result.identity = Object.freeze({}); }, TypeError);
  assert.throws(() => { tab(state, result.id).error.code = 'CHANGED'; }, TypeError);
  assert.equal(initial.tabs.length, 1);
  assert.equal(opening.tabs[1].phase, 'opening');
  assert.equal(Object.hasOwn(opening.tabs[1], 'error'), false);
});

test('subscriptions observe committed changes only and no-ops retain snapshot identity', () => {
  const state = createTabState();
  const snapshots = [];
  state.subscribe(() => snapshots.push(state.getSnapshot()));
  assert.deepEqual(snapshots, []);
  const result = state.reserve(spec());
  const opening = state.getSnapshot();
  assert.equal(snapshots[0], opening);
  state.reserve(spec());
  state.activate('missing');
  state.close('missing');
  state.retry('missing');
  state.move(result.id, 1);
  state.move('missing', 0);
  state.setPhase(result.id, Object.freeze({}), 'ready');
  state.setPhase(result.id, result.identity, 'opening');
  state.replace('missing', spec());
  assert.equal(state.getSnapshot(), opening);
  assert.equal(snapshots.length, 1);
  state.setPhase(result.id, result.identity, 'ready');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1], state.getSnapshot());
});

test('closing the active tab returns to Local while closing an inactive tab preserves selection', () => {
  const state = createTabState();
  const a = state.reserve(spec());
  const b = state.reserve(spec({ key: 'b' }));
  const bRecord = tab(state, b.id);
  assert.equal(state.close(a.id), true);
  assert.equal(state.getSnapshot().activeId, b.id);
  assert.equal(tab(state, b.id), bRecord);
  assert.equal(state.isCurrent(a.id, a.identity), false);
  assert.equal(state.close(a.id), false);
  assert.equal(state.close(b.id), true);
  assert.equal(state.getSnapshot().activeId, 'local');
  assert.equal(state.getSnapshot().tabs.length, 1);
});

test('close and reopen with an intentionally reused ID cannot accept an old ready or error callback', () => {
  const state = createTabState({ makeId: () => 'reused-id' });
  const first = state.reserve(spec());
  state.close(first.id);
  const second = state.reserve(spec());
  assert.equal(first.id, second.id);
  assert.notEqual(second.identity, first.identity);
  const before = state.getSnapshot();
  assert.equal(state.isCurrent(first.id, first.identity), false);
  assert.equal(state.setPhase(first.id, first.identity, 'ready'), false);
  assert.equal(state.setPhase(first.id, first.identity, 'error', 'STALE'), false);
  assert.equal(state.getSnapshot(), before);
  assert.equal(state.setPhase(second.id, second.identity, 'ready'), true);
});

test('only opening-to-ready/error and ready-to-error transitions are permitted', () => {
  const state = createTabState();
  const result = state.reserve(spec());
  for (const phase of ['opening', 'closed', '', undefined, null, {}, 1]) assert.equal(state.setPhase(result.id, result.identity, phase), false);
  assert.equal(state.setPhase(result.id, result.identity, 'ready'), true);
  const ready = state.getSnapshot();
  assert.equal(state.setPhase(result.id, result.identity, 'ready'), false);
  assert.equal(state.setPhase(result.id, result.identity, 'opening'), false);
  assert.equal(state.getSnapshot(), ready);
  assert.equal(state.setPhase(result.id, result.identity, 'error', 'FAILED'), true);
  assert.equal(tab(state, result.id).phase, 'error');
});

test('failure wins whether it arrives before or after ready and the first error remains final', () => {
  for (const initiallyReady of [false, true]) {
    const state = createTabState();
    const result = state.reserve(spec());
    if (initiallyReady) state.setPhase(result.id, result.identity, 'ready');
    assert.equal(state.setPhase(result.id, result.identity, 'error', 'FIRST_FAILURE'), true);
    const failed = state.getSnapshot();
    assert.equal(state.setPhase(result.id, result.identity, 'ready'), false);
    assert.equal(state.setPhase(result.id, result.identity, 'error', 'SECOND_FAILURE'), false);
    assert.equal(state.getSnapshot(), failed);
    assert.deepEqual(tab(state, result.id).error, { code: 'FIRST_FAILURE' });
  }
});

test('retry preserves kind, key, and title but rotates the identity and clears the error', () => {
  const state = createTabState();
  const first = state.reserve(spec());
  state.setPhase(first.id, first.identity, 'error', 'FAILED');
  const failed = tab(state, first.id);
  const other = state.reserve(spec({ kind: 'browser' }));
  const next = state.retry(first.id);
  const retried = tab(state, first.id);
  assert.equal(typeof next, 'object');
  assert.notEqual(next, first.identity);
  assert.notEqual(next, other.identity);
  assert.equal(retried.id, failed.id);
  assert.equal(retried.key, failed.key);
  assert.equal(retried.title, failed.title);
  assert.equal(retried.profileId, failed.profileId);
  assert.equal(retried.phase, 'opening');
  assert.equal(retried.identity, next);
  assert.equal(Object.hasOwn(retried, 'error'), false);
  assert.equal(state.getSnapshot().activeId, other.id);
  assert.equal(state.isCurrent(first.id, first.identity), false);
  assert.equal(state.setPhase(first.id, first.identity, 'ready'), false);
  assert.equal(state.setPhase(first.id, first.identity, 'error'), false);
  assert.equal(state.setPhase(first.id, next, 'ready'), true);
});

test('retry of an opening or ready record rotates identity without changing the ID', () => {
  let ids = 0;
  const state = createTabState({ makeId: () => `id-${++ids}` });
  const first = state.reserve(spec());
  const openingIdentity = state.retry(first.id);
  assert.notEqual(openingIdentity, first.identity);
  state.setPhase(first.id, openingIdentity, 'ready');
  const readyIdentity = state.retry(first.id);
  assert.notEqual(readyIdentity, openingIdentity);
  assert.equal(tab(state, first.id).phase, 'opening');
  assert.equal(ids, 1);
  assert.equal(state.retry('missing'), null);
});

test('isCurrent requires both an existing ID and the exact frozen identity object', () => {
  const state = createTabState();
  const result = state.reserve(spec());
  assert.equal(state.isCurrent(result.id, result.identity), true);
  for (const value of [undefined, null, NaN, 0, 1, 'identity', Object.freeze({}), { ...result.identity }, result.identity, tab(state, result.id)]) {
    if (value === result.identity) continue;
    assert.equal(state.isCurrent(result.id, value), false);
    assert.equal(state.setPhase(result.id, value, 'ready'), false);
  }
  assert.equal(state.isCurrent('missing', undefined), false);
  assert.equal(state.isCurrent('missing', result.identity), false);
  state.setPhase(result.id, result.identity, 'error');
  assert.equal(state.isCurrent(result.id, result.identity), true, 'Current describes identity, not readiness');
});

test('replace converts only the current launcher, keeping ID, position, and selection while rotating every lifecycle field', () => {
  const state = createTabState();
  const before = state.reserve(spec({ kind: 'terminal', key: 'tui-a' }));
  const launcher = state.reserve(launcherSpec());
  const after = state.reserve(spec({ kind: 'browser', key: 'web-a' }));
  state.activate(launcher.id);
  const original = tab(state, launcher.id);
  const position = state.getSnapshot().tabs.findIndex((item) => item.id === launcher.id);
  const pending = state.replace(launcher.id, spec({ title: 'Remote A', profileId: 'remote-a' }));
  assert.equal(pending.id, launcher.id);
  assert.equal(pending.created, true);
  assert.equal(pending.local, false);
  assert.notEqual(pending.identity, original.identity);
  const replaced = tab(state, launcher.id);
  assert.equal(replaced.id, original.id);
  assert.equal(replaced.identity, pending.identity);
  assert.equal(replaced.kind, 'profile-ui');
  assert.equal(replaced.key, 'remote-a');
  assert.equal(replaced.title, 'Remote A');
  assert.equal(replaced.profileId, 'remote-a');
  assert.equal(replaced.phase, 'opening');
  assert.equal(replaced.closable, true);
  assert.equal(state.getSnapshot().activeId, launcher.id);
  const order = state.getSnapshot().tabs.map((item) => item.id);
  assert.deepEqual(order, ['local', before.id, launcher.id, after.id]);
  assert.equal(state.getSnapshot().tabs.indexOf(replaced), position);
  assert.equal(state.isCurrent(launcher.id, original.identity), false);
  assert.equal(state.setPhase(launcher.id, original.identity, 'ready'), false);
  assert.equal(state.setPhase(launcher.id, pending.identity, 'ready'), true);
});

test('replace rejects non-launcher, Local, missing, and malformed targets without publishing', () => {
  const state = createTabState();
  const terminal = state.reserve(spec({ kind: 'terminal', key: 'tui' }));
  const launcher = state.reserve(launcherSpec());
  const before = state.getSnapshot();
  for (const [id, input] of [[terminal.id, spec()], ['local', spec()], ['missing', spec()]]) {
    assert.equal(state.replace(id, input), null);
    assert.equal(state.getSnapshot(), before);
  }
  for (const input of [null, { kind: 'unsupported', key: 'k', title: 't' }, { kind: 'browser', key: '', title: 't' }, { kind: 'browser', key: 'k' }, { kind: 'browser', key: 'k', title: 't', profileId: null }]) {
    assert.throws(() => state.replace(launcher.id, input), TypeError);
    assert.equal(state.getSnapshot(), before);
  }
  const replaced = state.replace(launcher.id, spec());
  assert.equal(replaced.id, launcher.id);
  assert.equal(state.getSnapshot().tabs.find((item) => item.id === terminal.id).identity, terminal.identity);
});

test('replace can target another launcher or be followed by retry and close', () => {
  const state = createTabState();
  const launcher = state.reserve(launcherSpec());
  const converted = state.replace(launcher.id, spec({ kind: 'browser', key: 'web' }));
  assert.equal(state.replace(launcher.id, spec({ key: 'other' })), null);
  const retried = state.retry(launcher.id);
  assert.notEqual(retried, converted.identity);
  assert.equal(tab(state, launcher.id).phase, 'opening');
  assert.equal(tab(state, launcher.id).kind, 'browser');
  assert.equal(state.close(launcher.id), true);
  assert.equal(state.getSnapshot().tabs.length, 1);
});

test('move reorders only the array and preserves IDs, identities, records, and selection', () => {
  const state = createTabState();
  const a = state.reserve(spec());
  const b = state.reserve(spec({ kind: 'browser', key: 'b' }));
  const c = state.reserve(launcherSpec());
  state.activate(b.id);
  const records = state.getSnapshot().tabs;
  const identities = records.map((item) => item.identity);
  assert.equal(state.move(c.id, 0), true);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.id), [c.id, 'local', a.id, b.id]);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.identity), [identities[3], identities[0], identities[1], identities[2]]);
  assert.equal(state.getSnapshot().tabs[0], records[3]);
  assert.equal(state.getSnapshot().activeId, b.id);
  assert.equal(state.move('local', 3), true);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.id), [c.id, a.id, b.id, 'local']);
  assert.equal(state.getSnapshot().activeId, b.id);
  for (const item of state.getSnapshot().tabs) assert.ok(state.isCurrent(item.id, item.identity));
});

test('move is a no-op for identity, unknown IDs, and out-of-range or non-integer targets', () => {
  const state = createTabState();
  const a = state.reserve(spec());
  const b = state.reserve(spec({ key: 'b' }));
  assert.equal(state.move(a.id, 0), true);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.id), [a.id, 'local', b.id]);
  const snapshot = state.getSnapshot();
  for (const [id, index] of [['missing', 0], [a.id, -1], [a.id, 3], [a.id, 1.5], [a.id, NaN], [a.id, '1'], [a.id, null], [a.id, undefined], [a.id, Infinity], [null, 0], [a.id, {}]]) {
    assert.equal(state.move(id, index), false);
    assert.equal(state.getSnapshot(), snapshot);
  }
  assert.equal(state.move(b.id, 2), true);
  assert.equal(state.getSnapshot(), snapshot);
});

test('move of a single-launcher snapshot and repeated swaps keep the array permutation stable', () => {
  const state = createTabState();
  const a = state.reserve(spec());
  const b = state.reserve(spec({ key: 'b' }));
  assert.equal(state.move(a.id, 1), true);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.id), ['local', a.id, b.id]);
  assert.equal(state.move(a.id, 2), true);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.id), ['local', b.id, a.id]);
  assert.equal(state.move(a.id, 1), true);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.id), ['local', a.id, b.id]);
  assert.equal(state.move(b.id, 1), true);
  assert.deepEqual(state.getSnapshot().tabs.map((item) => item.id), ['local', b.id, a.id]);
  assert.equal(state.move(b.id, 2), true);
  assert.equal(state.getSnapshot().tabs[2].id, b.id);
});

test('dispose keeps the final immutable snapshot and makes all retained writes and subscriptions inert', () => {
  const state = createTabState();
  const { reserve, replace, move, activate, setPhase, retry, close, isCurrent } = state;
  let calls = 0;
  const unsubscribe = state.subscribe(() => { calls += 1; });
  const result = reserve(spec());
  const launcher = reserve(launcherSpec());
  const final = state.getSnapshot();
  state.dispose();
  state.dispose();
  assert.equal(reserve(spec()), null);
  assert.equal(reserve(null), null);
  assert.equal(replace(launcher.id, spec()), null);
  assert.equal(move(result.id, 0), false);
  assert.equal(activate('local'), false);
  assert.equal(setPhase(result.id, result.identity, 'ready'), false);
  assert.equal(setPhase(result.id, result.identity, 'error'), false);
  assert.equal(retry(result.id), null);
  assert.equal(close(result.id), false);
  assert.equal(close('local'), false);
  assert.equal(isCurrent(result.id, result.identity), false);
  assert.equal(isCurrent('local', final.tabs[0].identity), false);
  const lateUnsubscribe = state.subscribe(() => { calls += 1; });
  lateUnsubscribe();
  lateUnsubscribe();
  unsubscribe();
  unsubscribe();
  assert.equal(state.getSnapshot(), final);
  assert.equal(calls, 2);
});

test('subscriber exceptions do not escape, skip other subscribers, or roll back committed state', () => {
  const state = createTabState();
  const seen = [];
  state.subscribe(() => { throw new Error('Subscriber failed'); });
  state.subscribe(() => seen.push(state.getSnapshot()));
  state.subscribe(() => { throw new Error('Another subscriber failed'); });
  state.subscribe(() => seen.push(state.getSnapshot()));
  let result;
  assert.doesNotThrow(() => { result = state.reserve(spec()); });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], state.getSnapshot());
  assert.equal(seen[1], state.getSnapshot());
  assert.equal(state.isCurrent(result.id, result.identity), true);
  assert.doesNotThrow(() => state.setPhase(result.id, result.identity, 'ready'));
  assert.equal(seen.length, 4);
});

test('unsubscribe is idempotent and duplicate callback registrations remain independent', () => {
  const state = createTabState();
  let calls = 0;
  const callback = () => { calls += 1; };
  const first = state.subscribe(callback);
  const second = state.subscribe(callback);
  state.reserve(spec());
  assert.equal(calls, 2);
  first();
  first();
  state.activate('local');
  assert.equal(calls, 3);
  second();
  second();
  state.reserve(spec());
  assert.equal(calls, 3);
});

test('removing or adding subscriptions during notification has deterministic boundaries', () => {
  const state = createTabState();
  const calls = [];
  let removeSecond;
  let removeFirst;
  removeFirst = state.subscribe(() => {
    calls.push('first');
    removeFirst();
    removeSecond();
    state.subscribe(() => calls.push('added'));
  });
  removeSecond = state.subscribe(() => calls.push('removed'));
  state.reserve(spec());
  assert.deepEqual(calls, ['first']);
  state.activate('local');
  assert.deepEqual(calls, ['first', 'added']);
});

test('dispose during notification stops remaining callbacks and leaves the committed snapshot readable', () => {
  const state = createTabState();
  let calls = 0;
  state.subscribe(() => state.dispose());
  state.subscribe(() => { calls += 1; });
  const result = state.reserve(spec());
  assert.equal(calls, 0);
  assert.equal(state.getSnapshot().activeId, result.id);
  assert.equal(state.isCurrent(result.id, result.identity), false);
});

test('disposal from a publish observer during replace cannot leave a converted record', () => {
  const state = createTabState();
  const launcher = state.reserve(launcherSpec());
  const observed = [];
  const unsubscribe = state.subscribe(() => {
    observed.push(state.getSnapshot());
    state.dispose();
  });
  const result = state.replace(launcher.id, spec());
  // The publication already happened; the caller's ticket is still returned for bookkeeping.
  assert.equal(result.id, launcher.id);
  const committed = observed[0].tabs.find((item) => item.id === launcher.id);
  assert.equal(committed.kind, 'profile-ui');
  assert.equal(state.isCurrent(launcher.id, result.identity), false);
  unsubscribe();
});

test('factory and subscription validation reject malformed whitelisted options', () => {
  for (const localProfileId of [null, '', ' ', 3, {}, 'p'.repeat(257)]) assert.throws(() => createTabState({ localProfileId }), TypeError);
  for (const localTitle of [null, '', '\t', 3, {}, 't'.repeat(257)]) assert.throws(() => createTabState({ localTitle }), TypeError);
  for (const makeId of [null, 'id', 3, {}]) assert.throws(() => createTabState({ makeId }), TypeError);
  assert.throws(() => createTabState(null), TypeError);
  const state = createTabState();
  for (const listener of [undefined, null, {}, 'callback']) assert.throws(() => state.subscribe(listener), TypeError);
});

test('reserve and replace validate kinds and bounded nonblank text before mutation or ID allocation', () => {
  let allocations = 0;
  const state = createTabState({ makeId: () => `id-${++allocations}` });
  const launcher = state.reserve(launcherSpec());
  const initial = state.getSnapshot();
  const invalid = [undefined, null, [], '', 1, {}, ...['profile', 'Terminal', '', null, 1, {}].map((kind) => spec({ kind }))];
  for (const field of ['key', 'title', 'profileId']) {
    for (const value of [null, '', ' \n\t', 0, NaN, Infinity, {}, []]) invalid.push(spec({ [field]: value }));
  }
  invalid.push(spec({ key: undefined }), spec({ title: undefined }), spec({ key: 'k'.repeat(1025) }), spec({ title: 't'.repeat(257) }), spec({ profileId: 'p'.repeat(257) }));
  for (const input of invalid) {
    assert.throws(() => state.reserve(input), TypeError);
    assert.equal(state.getSnapshot(), initial);
    assert.throws(() => state.replace(launcher.id, input), TypeError);
    assert.equal(state.getSnapshot(), initial);
  }
  assert.equal(allocations, 1);
  const before = state.getSnapshot();
  const result = state.reserve(spec());
  assert.equal(result.created, true);
  assert.equal(before.tabs[0], initial.tabs[0]);
});

test('maximum text boundaries are accepted without coercion or key normalization', () => {
  const state = createTabState({ localProfileId: 'p'.repeat(256), localTitle: 't'.repeat(256) });
  const result = state.reserve(spec({ kind: 'terminal', key: 'k'.repeat(1024), title: 't'.repeat(256), profileId: undefined }));
  assert.equal(tab(state, result.id).key.length, 1024);
  assert.equal(Object.hasOwn(tab(state, result.id), 'profileId'), false);
  const spaced = state.reserve(spec({ key: ' a ', title: ' A ' }));
  const plain = state.reserve(spec({ key: 'a', title: 'A' }));
  assert.notEqual(spaced.id, plain.id);
  assert.equal(tab(state, spaced.id).key, ' a ');
  assert.equal(tab(state, spaced.id).title, ' A ');
});

test('deterministic makeId collisions cannot overwrite Local or any existing tab', () => {
  const values = ['local', 'duplicate', 'duplicate', 'local:1:1', 'duplicate:3:1'];
  const state = createTabState({ makeId: () => values.shift() });
  const local = state.getSnapshot().tabs[0];
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    const result = state.reserve(spec({ key: `key-${i}` }));
    assert.notEqual(result.id, 'local');
    records.push(tab(state, result.id));
    assert.equal(state.getSnapshot().tabs[0], local);
    assert.deepEqual(state.getSnapshot().tabs.slice(1), records);
  }
  assert.equal(new Set(state.getSnapshot().tabs.map((item) => item.id)).size, 6);
  assert.equal(new Set(state.getSnapshot().tabs.map((item) => item.identity)).size, 6);
});

test('invalid or throwing ID generators fail without publishing or replacing records', () => {
  for (const value of [undefined, null, '', ' ', 1, {}, 'x'.repeat(257)]) {
    const state = createTabState({ makeId: () => value });
    const initial = state.getSnapshot();
    assert.throws(() => state.reserve(spec()), TypeError);
    assert.equal(state.getSnapshot(), initial);
  }
  const state = createTabState({ makeId: () => { throw new Error('ID generation failed'); } });
  const initial = state.getSnapshot();
  assert.throws(() => state.reserve(spec()), /ID generation failed/);
  assert.equal(state.getSnapshot(), initial);
});

test('disposal from an injected ID generator or error accessor cannot publish a late write', () => {
  let state;
  state = createTabState({ makeId: () => { state.dispose(); return 'late'; } });
  const initial = state.getSnapshot();
  assert.equal(state.reserve(spec()), null);
  assert.equal(state.getSnapshot(), initial);
  const other = createTabState();
  const result = other.reserve(spec());
  const before = other.getSnapshot();
  assert.equal(other.setPhase(result.id, result.identity, 'error', { get code() { other.dispose(); return 'LATE'; } }), false);
  assert.equal(other.getSnapshot(), before);
});

test('a hostile spec accessor cannot install a record over a launcher that closed mid-validation', () => {
  let state;
  state = createTabState({ makeId: () => 'launcher-1' });
  const launcher = state.reserve(launcherSpec());
  const input = spec();
  Object.defineProperty(input, 'profileId', {
    enumerable: true,
    get() { state.close(launcher.id); return 'remote-a'; },
  });
  const result = state.replace(launcher.id, input);
  assert.equal(result, null);
  assert.equal(state.getSnapshot().tabs.some((item) => item.id === launcher.id), false);
  assert.equal(state.getSnapshot().tabs.length, 1);
});
