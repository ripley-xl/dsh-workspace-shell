import test from 'node:test';
import assert from 'node:assert/strict';
import { React, mount, flushEffects } from './react-harness.mjs';
import { createWorkspaceSelection } from '../../../packages/shell/src/entry.js';

function observable(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(value) { snapshot = value; for (const listener of [...listeners]) listener(); },
  };
}

function fixture() {
  const key = 'conversation.hero.workspace';
  const listeners = new Set();
  let version = 0;
  const Original = (props) => React.createElement('div', {
    'data-original': true,
    'data-selected-id': props.selectedId,
    onClick: props.onPick,
  });
  const entry = { component: Original };
  const record = { spec: { kind: 'single', scope: 'root' }, entries: [entry] };
  const notify = () => {
    version++;
    queueMicrotask(() => { for (const listener of [...listeners]) listener(); });
  };
  const core = {
    records: new Map([[key, record]]),
    isLive(candidate) { return record.entries.includes(candidate); },
    markDirty() { notify(); },
  };
  const slots = {
    _core: core,
    entriesOfSlot: () => record.entries.slice(0, 1),
    subscribe(_key, listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const workspaces = observable({ items: [
    { workspaceId: 'one', path: '/workspace-one' },
    { workspaceId: 'two', path: '/workspace-two' },
  ] });
  const useWorkspaces = (selector) => selector(React.useSyncExternalStore(workspaces.subscribe, workspaces.getSnapshot));
  const selection = createWorkspaceSelection(React, slots);
  function Host(props) {
    React.useSyncExternalStore((listener) => slots.subscribe(key, listener), () => version);
    const current = record.entries[0];
    return React.createElement(current.component, props);
  }
  return { Original, entry, record, notify, workspaces, useWorkspaces, selection, Host };
}

test('workspace selection observes owner selectedId and resolves only the matching Workspace path', async (t) => {
  const f = fixture();
  const onPick = () => {};
  const app = await mount(t, f.Host, { selectedId: 'one', useWorkspaces: f.useWorkspaces, onPick });
  assert.equal(f.selection.getSnapshot(), '/workspace-one');
  assert.equal(app.root.findByProps({ 'data-original': true }).props['data-selected-id'], 'one');
  assert.equal(app.root.findByProps({ 'data-original': true }).props.onClick, onPick);
  await app.update({ selectedId: 'two', useWorkspaces: f.useWorkspaces, onPick });
  assert.equal(f.selection.getSnapshot(), '/workspace-two');
  await flushEffects(() => f.workspaces.set({ items: [
    { workspaceId: 'one', path: '/workspace-one' },
    { workspaceId: 'two', path: '/workspace-moved' },
  ] }));
  assert.equal(f.selection.getSnapshot(), '/workspace-moved');
  await app.update({ useWorkspaces: f.useWorkspaces, onPick });
  assert.equal(f.selection.getSnapshot(), null);
  await app.update({ selectedId: 'missing', useWorkspaces: f.useWorkspaces, onPick });
  assert.equal(f.selection.getSnapshot(), null);
  await app.unmount();
  assert.equal(f.selection.getSnapshot(), null);
  await flushEffects(() => f.selection.dispose());
  assert.equal(f.entry.component, f.Original);
});

test('workspace selection leaves the original component usable without the global hook', async (t) => {
  const f = fixture();
  const app = await mount(t, f.Host, { selectedId: 'one' });
  assert.equal(app.root.findAllByProps({ 'data-original': true }).length, 1);
  assert.equal(f.selection.getSnapshot(), null);
  await flushEffects(() => f.selection.dispose());
  assert.equal(f.entry.component, f.Original);
});

test('workspace selection follows entry replacement but never removes a foreign wrapper', async (t) => {
  const f = fixture();
  const app = await mount(t, f.Host, { selectedId: 'one', useWorkspaces: f.useWorkspaces });
  const Replacement = (props) => React.createElement('div', { 'data-replacement': true, 'data-selected-id': props.selectedId });
  const replacement = { component: Replacement };
  f.record.entries = [replacement];
  await flushEffects(() => f.notify());
  assert.equal(f.entry.component, f.Original);
  assert.equal(f.selection.getSnapshot(), '/workspace-one');
  assert.equal(app.root.findAllByProps({ 'data-replacement': true }).length, 1);
  const Foreign = () => React.createElement('div', { 'data-foreign': true });
  replacement.component = Foreign;
  await flushEffects(() => f.notify());
  assert.equal(f.selection.getSnapshot(), null);
  assert.equal(replacement.component, Foreign);
  f.selection.dispose();
  assert.equal(replacement.component, Foreign);
});
