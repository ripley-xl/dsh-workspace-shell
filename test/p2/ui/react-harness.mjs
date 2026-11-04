import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import { act, create } from 'react-test-renderer';

// This harness runs React effects and reconciliation. It deliberately does not
// emulate browser layout, Electron rendering, SSH, or the local application UI.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
export { React, act };

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function flushEffects(callback = () => {}) {
  await act(async () => { await callback(); });
}

export function createContainer() {
  return {
    children: [],
    appendChild(element) {
      if (element.parentNode) element.parentNode.removeChild(element);
      this.children.push(element);
      element.parentNode = this;
      return element;
    },
    removeChild(element) {
      const index = this.children.indexOf(element);
      assert.notEqual(index, -1, 'Removing an element must target its current container');
      this.children.splice(index, 1);
      element.parentNode = null;
      return element;
    },
  };
}

export function createDesktopHarness(options = {}) {
  const elements = [];
  const containers = [];
  const openListeners = new Map();
  const calls = { acquire: [], release: [], subscribe: [], unsubscribe: [], external: [] };
  const bridge = {
    async acquire(workspace) {
      calls.acquire.push(workspace);
      const sequence = calls.acquire.length;
      return options.acquire ? options.acquire(workspace, sequence)
        : { lease: `lease-${sequence}`, partition: `persist:guest-${sequence}` };
    },
    async release(lease) {
      calls.release.push(lease);
      return options.release?.(lease);
    },
    onOpenRequested(lease, listener) {
      calls.subscribe.push(lease);
      openListeners.set(lease, listener);
      return () => {
        calls.unsubscribe.push(lease);
        openListeners.delete(lease);
      };
    },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'webview', 'Only the Desktop guest boundary is mocked');
      const element = {
        attributes: {}, style: {}, parentNode: null,
        listeners: new Map(), loadCalls: [],
        load: options.loadURL ?? (() => Promise.resolve()),
        setAttribute(name, value) { this.attributes[name] = String(value); },
        addEventListener(name, listener) {
          if (!this.listeners.has(name)) this.listeners.set(name, new Set());
          this.listeners.get(name).add(listener);
        },
        removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); },
        emit(name, event = {}) {
          for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
        },
        loadURL(url) { this.loadCalls.push(url); return this.load(url, this); },
        remove() { this.parentNode?.removeChild(this); },
      };
      elements.push(element);
      return element;
    },
  };
  function createNodeMock() {
    const container = createContainer();
    containers.push(container);
    return container;
  }
  return { bridge, document, elements, containers, calls, openListeners, createNodeMock };
}

export async function loadReactManagerClient(options = {}) {
  const desktop = options.desktop ?? createDesktopHarness();
  const eventSources = [];
  const requests = [];
  const assignments = [];
  const clipboard = [];
  class EventSource {
    constructor(url, init) {
      this.url = url;
      this.init = init;
      this.listeners = new Map();
      this.closed = false;
      eventSources.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, value) {
      assert.equal(this.closed, false, 'An already closed event source cannot deliver new events');
      const event = { data: typeof value === 'string' ? value : JSON.stringify(value) };
      if (type === 'message') this.onmessage?.(event);
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }
    close() { this.closed = true; }
  }
  const window = {
    dshDesktop: { browser: desktop.bridge },
    location: { assign(url) { assignments.push(url); } },
    open(...args) { desktop.calls.external.push(args); return {}; },
    navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } },
    ...options.window,
  };
  const fetch = async (url, init) => {
    requests.push({ url, init });
    assert.equal(typeof options.fetch, 'function', `Unexpected HTTP request: ${url}`);
    return options.fetch(url, init);
  };
  let definition;
  window.__ModuleLoader__ = { load(value) { definition = value; } };
  const context = vm.createContext({
    window, document: desktop.document, navigator: window.navigator, fetch, EventSource,
    console, URL, Response, Request, Headers, AbortController,
    setTimeout, clearTimeout, queueMicrotask,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const source = await readFile(new URL('../../../packages/shell/client.js', import.meta.url), 'utf8');
  vm.runInContext(source, context, { filename: 'packages/shell/client.js' });
  assert.equal(typeof definition?.factory, 'function', 'Client must register its real factory');
  const manager = definition.factory((id) => {
    if (id === 'react') return React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`Unexpected Client dependency: ${id}`);
  });
  return { manager, desktop, window, eventSources, requests, assignments, clipboard };
}

export async function mount(t, Component, props = {}, desktop = createDesktopHarness()) {
  let renderer;
  let unmounted = false;
  await act(async () => {
    renderer = create(React.createElement(Component, props), { createNodeMock: desktop.createNodeMock });
  });
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(async () => { renderer.unmount(); });
  };
  t.after(unmount);
  return {
    get root() { return renderer.root; },
    toJSON: () => renderer.toJSON(),
    async update(nextProps) {
      await act(async () => { renderer.update(React.createElement(Component, nextProps)); });
    },
    unmount,
  };
}

export function textContent(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node?.children ?? []).map(textContent).join('');
}

export function buttonByName(root, name) {
  const matches = root.findAll((node) => node.type === 'button'
    && (node.props['aria-label'] ?? textContent(node)) === name);
  assert.equal(matches.length, 1, `Expected one button named ${JSON.stringify(name)}, found ${matches.length}`);
  return matches[0];
}

export async function click(node) {
  assert.notEqual(node.props.disabled, true, 'Cannot click a disabled control');
  assert.equal(typeof node.props.onClick, 'function');
  await flushEffects(() => node.props.onClick());
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
