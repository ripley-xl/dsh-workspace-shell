import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLocalRuntimeService } from '../../../packages/shell/src/host/local-runtimes.js';
import { createTuiProvider } from '../../../packages/shell/src/tui-provider.js';
import { startTerminalDocument } from '../../../packages/shell/src/terminal-document.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const until = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await flush(); }
  throw new Error('Timed out waiting for terminal acknowledgement.');
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
class Events {
  listeners = new Map();
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, event = {}) { for (const callback of [...(this.listeners.get(type) || [])]) callback(event); }
}
class Port {
  sent = [];
  closed = false;
  closeCalls = 0;
  start() {}
  postMessage(data) {
    if (this.closed) return;
    this.sent.push(data);
    queueMicrotask(() => { if (!this.peer.closed) this.peer.onmessage?.({ data }); });
  }
  close() { this.closed = true; this.closeCalls++; if (this.throwClose) throw Error('close'); }
}
const pair = () => { const port1 = new Port(); const port2 = new Port(); port1.peer = port2; port2.peer = port1; return { port1, port2 }; };
const location = (native) => native ? { protocol: 'dsh-app:', host: 'shell', origin: 'null' } : { protocol: 'https:', host: 'shell.example', origin: 'https://shell.example' };
const origin = (win) => win.location.protocol === 'dsh-app:' ? 'dsh-app://' + win.location.host : win.location.origin;
const clock = (target) => {
  let sequence = 0;
  const timers = new Map();
  const frames = new Map();
  target.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; };
  target.clearTimeout = (id) => { timers.delete(id); };
  target.requestAnimationFrame = (fn) => { const id = ++sequence; frames.set(id, fn); return id; };
  target.cancelAnimationFrame = (id) => { frames.delete(id); };
  return {
    timers, frames,
    runTimer() { const [id, task] = timers.entries().next().value; timers.delete(id); task.fn(); return task.delay; },
    runFrames() { const tasks = [...frames.values()]; frames.clear(); for (const fn of tasks) fn(); },
  };
};
const childEnvironment = ({ parent, native = false, autoAck = false, hidden = () => false } = {}) => {
  const window = new Events();
  window.location = location(native);
  window.parent = parent || {};
  const time = clock(window);
  const terms = [];
  const observers = [];
  const addons = [];
  const box = { width: 800, height: 400, cols: 100, rows: 30 };
  const element = { getBoundingClientRect: () => hidden() ? { width: 0, height: 0 } : box };
  const status = { textContent: '' };
  const document = { getElementById: (id) => id === 'terminal' ? element : id === 'status' ? status : null };
  window.Terminal = class {
    constructor(options) { this.options = options; this.cols = options.cols; this.rows = options.rows; this.writes = []; this.acks = []; this.focused = 0; this.disposed = 0; this.resets = 0; terms.push(this); }
    loadAddon(addon) { this.addon = addon; addon.terminal = this; }
    open(value) { this.element = value; }
    onData(callback) { this.input = callback; return { dispose: () => { this.inputDisposed = true; if (this.throwDataDispose) throw Error('data dispose'); } }; }
    write(data, ack) { if (this.throwWrite) throw Error('secret write'); this.writes.push(data); if (autoAck) queueMicrotask(ack); else this.acks.push(ack); }
    focus() { this.focused++; }
    resize(cols, rows) { this.cols = cols; this.rows = rows; }
    reset() { this.resets++; }
    dispose() { this.disposed++; if (this.throwDispose) throw Error('terminal dispose'); }
  };
  window.FitAddon = { FitAddon: class {
    constructor() { this.fits = 0; addons.push(this); }
    fit() { this.fits++; this.terminal.cols = box.cols; this.terminal.rows = box.rows; }
  } };
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = 0; observers.push(this); }
    observe(value) { this.element = value; }
    disconnect() { this.disconnected++; if (this.throwDisconnect) throw Error('observer'); }
  };
  const lifecycle = startTerminalDocument(window, document);
  return { window, document, lifecycle, time, terms, observers, addons, box, status, element };
};
const harness = (options = {}) => {
  const window = new Events();
  window.location = location(options.native);
  window.AbortController = AbortController;
  const time = clock(window);
  const channels = [];
  window.MessageChannel = class { constructor() { const value = pair(); channels.push(value); return value; } };
  const frames = [];
  const document = { createElement(tag) {
    assert.equal(tag, 'iframe');
    const frame = new Events();
    frame.style = {};
    frame.attributes = {};
    frame.setAttribute = (key, value) => { frame.attributes[key] = value; };
    frame.removed = 0;
    frame.remove = () => { frame.removed++; if (frame.throwRemove) throw Error('remove'); frame.child.window.emit('pagehide'); if (frame.parentNode) frame.parentNode.removeChild(frame); };
    frame.child = childEnvironment({ parent: window, native: options.native, autoAck: options.autoAck, hidden: () => frame.style.display === 'none' });
    frame.posts = [];
    frame.contentWindow = frame.child.window;
    frame.contentWindow.postMessage = (data, targetOrigin, ports) => { frame.posts.push({ data, targetOrigin, ports }); queueMicrotask(() => frame.child.window.emit('message', { data, ports, origin: origin(window), source: window })); };
    frames.push(frame);
    return frame;
  } };
  const container = {
    children: [],
    appendChild(frame) { this.children.push(frame); frame.parentNode = this; },
    removeChild(frame) { this.children = this.children.filter((item) => item !== frame); frame.parentNode = null; frame.child.window.emit('pagehide'); },
  };
  const calls = [];
  const handlers = options.api || {};
  const api = async (path, input, signal) => {
    calls.push({ path, input, signal });
    if (handlers[path]) return handlers[path](input, signal);
    if (path === '/tui/open') return { runtimeId: 'runtime-secret' };
    if (path === '/terminal/read') return { chunks: [{ seq: input.afterSeq + 1, data: 'output-' + (input.afterSeq + 1) }], nextSeq: input.afterSeq + 1, firstSeq: 1, loss: false, phase: 'running' };
    return {};
  };
  const provider = createTuiProvider({ document, window, api, ownerId: 'owner-secret', locale: options.locale || 'en' });
  const cancellation = new AbortController();
  let ready = 0;
  let exits = 0;
  const errors = [];
  const input = { profileId: options.profileId || 'profile-a', cwd: options.cwd || '/work', confirmIndependentHost: true };
  let handle;
  const open = (extra = {}) => {
    handle = provider.open({ ...input, ...extra }, { container, signal: cancellation.signal, onReady: () => { ready++; return options.onReady?.(); }, onError: (code) => { errors.push(code); return options.onError?.(); }, onExit: () => { exits++; return options.onExit?.(); } });
    return handle;
  };
  const load = async () => { frames[0].emit('load'); await flush(); frames[0].child.time.runFrames(); await flush(); };
  const ack = async () => { frames[0].child.terms[0].acks.shift()(); await flush(); };
  return { window, time, frames, channels, container, calls, api, provider, cancellation, input, errors, open, load, ack, get ready() { return ready; }, get exits() { return exits; }, get handle() { return handle; }, get child() { return frames[0].child; }, get term() { return frames[0].child.terms[0]; } };
};
const ofPath = (h, path) => h.calls.filter((call) => call.path === path);
const boot = async (options) => { const h = harness(options); h.open(); await h.load(); return h; };

async function hostBackedProvider(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-provider-host-'));
  const home = path.join(root, 'home');
  const current = path.join(home, 'profiles', 'current');
  const profile = path.join(home, 'profiles', 'tui');
  const cwd = path.join(root, 'work');
  await fs.mkdir(current, { recursive: true }); await fs.mkdir(cwd, { recursive: true });
  const write = async (filename, value) => { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, JSON.stringify(value)); };
  await write(path.join(current, 'package.json'), { name: 'current', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  await write(path.join(profile, 'package.json'), { name: 'tui', dsh: { profile: { bundles: ['@deepseek-harness-tui/dsh-tui'] } } });
  await write(path.join(profile, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), { name: '@deepseek-harness-tui/dsh-tui', version: '0.18.0' });
  const terminalDone = deferred();
  let terminal;
  const subprocess = {
    async resolveExecutable() { return '/usr/local/bin/dsh'; },
    spawn(spec) {
      assert.equal(spec.argv.at(-1), '--version');
      return { stdout: Readable.from(['0.2.1-rc.5\n']), stderr: Readable.from([]), done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true; } };
    },
    async spawnTerminal() {
      terminal = {
        output: new Readable({ read() {} }), done: terminalDone.promise,
        async write() {}, async resize() {},
        async terminate() { terminal.output.push(null); terminalDone.resolve({ exitCode: 0, signal: null }); },
      };
      return terminal;
    },
  };
  const service = createLocalRuntimeService({ subprocess, profileContext: { name: 'current', dir: current, home, cwd }, expectedVersion: '0.2.1-rc.5', graceMs: 5, idFactory: () => 'runtime-host-exit' });
  let startupError;
  let startupResult;
  const h = await boot({ profileId: 'tui', cwd, api: {
    '/tui/open': async (input, signal) => { try { startupResult = await service.openTui({ ...input, signal }); return startupResult; } catch (error) { startupError = error; throw error; } },
    '/terminal/read': (input) => service.readTerminal(input),
    '/runtime/stop': (input) => service.stop(input),
  } });
  t.after(async () => {
    await h.handle.dispose(); await service.dispose().catch(() => {});
    assert.equal(root.startsWith(path.join(os.tmpdir(), 'dsh-provider-host-')), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { h, service, terminalDone, exit() { terminal.output.push(null); terminalDone.resolve({ exitCode: 0, signal: null }); }, get startupError() { return startupError; }, get startupResult() { return startupResult; } };
}

test('both modules are import-free ESM and survive the script concatenation transform', async () => {
  for (const [file, name] of [['tui-provider.js', 'createTuiProvider'], ['terminal-document.js', 'startTerminalDocument']]) {
    const source = await readFile(new URL('../../../packages/shell/src/' + file, import.meta.url), 'utf8');
    const script = source.replace(/^export /gm, '');
    assert.doesNotMatch(script, /^\s*(import|export)\s/m);
    assert.doesNotMatch(source, /\b(?:require|import|fetch)\s*\(|executeJavaScript/);
    assert.equal(typeof vm.runInNewContext(script + '\n' + name), 'function');
    if (file === 'terminal-document.js') assert.doesNotMatch(source, new RegExp('runtimeId|ownerId|XMLHttpRequest|innerHTML|/tui/|/terminal/'));
  }
});

test('independent Host confirmation is required before creating any iframe or API call', async () => {
  const h = harness();
  assert.throws(() => h.open({ confirmIndependentHost: false }), { code: 'TUI_CONFIRM_REQUIRED' });
  assert.throws(() => h.open({ profileId: '' }), { code: 'TUI_INVALID_SPEC' });
  assert.equal(h.frames.length, 0);
  assert.equal(h.calls.length, 0);
});

test('fixed same-origin iframe transfers one port with explicit origin and no runtime identity', async () => {
  for (const native of [false, true]) {
    const h = await boot({ native });
    const frame = h.frames[0];
    assert.equal(frame.src, '/api/workspace-shell/terminal');
    assert.deepEqual(frame.attributes, { sandbox: 'allow-scripts allow-same-origin' });
    assert.equal(frame.style.width, '100%');
    assert.equal(frame.style.height, '100%');
    assert.equal(frame.style.border, '0');
    assert.equal(frame.posts[0].targetOrigin, native ? 'dsh-app://shell' : 'https://shell.example');
    assert.equal(frame.posts[0].ports.length, 1);
    assert.doesNotMatch(JSON.stringify(frame.posts[0].data), new RegExp('owner|runtime|profile|HostURL|/work'));
    frame.emit('load');
    await flush();
    assert.equal(h.channels.length, 1);
    assert.equal(ofPath(h, '/tui/open').length, 1);
    await h.handle.dispose();
  }
});

test('child accepts only its parent and exact self origin, once, including dsh-app origins', () => {
  for (const native of [false, true]) {
    const child = childEnvironment({ native });
    const channel = pair();
    const event = { data: { type: 'workspace-shell-terminal-init', version: 1 }, ports: [channel.port2], origin: origin(child.window), source: child.window.parent };
    child.window.emit('message', { ...event, source: {} });
    child.window.emit('message', { ...event, origin: 'https://evil.example' });
    child.window.emit('message', { ...event, origin: 'null' });
    child.window.emit('message', { ...event, data: { type: 'wrong', version: 1 } });
    assert.equal(child.terms.length, 0);
    child.window.emit('message', event);
    child.window.emit('message', { ...event, ports: [pair().port2] });
    assert.equal(child.terms.length, 1);
    child.lifecycle.dispose();
  }
});

test('Host startup uses immediate child dimensions and onReady waits for the first output ACK', async () => {
  const h = harness();
  h.open();
  assert.equal(h.calls.length, 0);
  h.frames[0].emit('load');
  await flush();
  assert.equal(ofPath(h, '/tui/open').length, 1);
  h.child.time.runFrames();
  await flush();
  assert.deepEqual(ofPath(h, '/tui/open')[0].input, { profileId: 'profile-a', ownerId: 'owner-secret', cwd: '/work', cols: 100, rows: 30, confirmIndependentHost: true });
  assert.equal(h.ready, 0);
  assert.equal(h.term.options.disableStdin, true);
  assert.deepEqual(h.term.writes, ['output-1']);
  await h.ack();
  assert.equal(h.ready, 1);
  assert.equal(h.term.options.disableStdin, false);
  assert.equal(h.term.focused, 0);
  await h.handle.dispose();
});

test('initially hidden zero-size surfaces use positive initial dimensions without fitting or stealing focus', async () => {
  const h = harness();
  h.open().setVisible(false);
  h.handle.focus();
  await h.load();
  const opened = ofPath(h, '/tui/open')[0];
  assert.equal(opened.input.cols, 80);
  assert.equal(opened.input.rows, 24);
  assert.equal(h.child.addons[0].fits, 0);
  await h.ack();
  assert.equal(h.term.options.disableStdin, true);
  assert.equal(h.term.focused, 0);
  h.handle.setVisible(true);
  await flush();
  h.child.time.runFrames();
  await flush();
  assert.equal(ofPath(h, '/terminal/resize').length, 1);
  assert.equal(h.term.focused, 0);
  await h.handle.dispose();
});

test('visibility changes retain the same iframe and PTY with active/inactive polling intervals', async () => {
  const h = await boot();
  await h.ack();
  assert.equal([...h.time.timers.values()][0].delay, 80);
  const frame = h.frames[0];
  h.handle.setVisible(false);
  await flush();
  assert.equal([...h.time.timers.values()][0].delay, 500);
  assert.equal(h.term.options.disableStdin, true);
  h.handle.setVisible(true);
  await flush();
  assert.equal([...h.time.timers.values()][0].delay, 80);
  h.handle.focus();
  await flush();
  assert.equal(h.term.focused, 1);
  assert.equal(h.frames[0], frame);
  assert.equal(ofPath(h, '/tui/open').length, 1);
  assert.equal(ofPath(h, '/runtime/stop').length, 0);
  await h.handle.dispose();
});

test('both child and parent gate hidden input, focus, and resize', async () => {
  const h = await boot();
  await h.ack();
  h.handle.setVisible(false);
  await flush();
  h.term.input('ignored');
  h.channels[0].port2.postMessage({ type: 'input', data: 'also ignored' });
  h.channels[0].port2.postMessage({ type: 'resize', cols: 120, rows: 40 });
  h.handle.focus();
  h.handle.resize();
  h.child.observers[0].callback();
  h.child.time.runFrames();
  await flush();
  assert.equal(ofPath(h, '/terminal/write').length, 0);
  assert.equal(ofPath(h, '/terminal/resize').length, 0);
  assert.equal(h.term.focused, 0);
  assert.equal(h.child.addons[0].fits, 2);
  await h.handle.dispose();
});

test('large Unicode pastes split at UTF-8 64KiB boundaries and writes remain serial and ordered', async () => {
  const gate = deferred();
  let writes = 0;
  const h = await boot({ api: { '/terminal/write': () => ++writes === 1 ? gate.promise : {} } });
  await h.ack();
  const input = 'a'.repeat(65535) + '😀中文'.repeat(9000) + '\r\n\u0003tail';
  h.term.input(input);
  await flush();
  assert.equal(ofPath(h, '/terminal/write').length, 1);
  gate.resolve({});
  await flush();
  const chunks = ofPath(h, '/terminal/write').map((call) => call.input.data);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks.join(''), input);
  for (const chunk of chunks) { assert.ok(Buffer.byteLength(chunk, 'utf8') <= 65536); assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/); }
  const childChunks = h.channels[0].port2.sent.filter((message) => message.type === 'input').map((message) => message.data);
  assert.equal(childChunks.join(''), input);
  assert.ok(childChunks.every((chunk) => Buffer.byteLength(chunk) <= 65536));
  await h.handle.dispose();
});

test('dispose drops queued input so a completed in-flight write cannot send another chunk', async () => {
  const gate = deferred();
  const h = await boot({ api: { '/terminal/write': () => gate.promise } });
  await h.ack();
  h.term.input('a'.repeat(150000));
  await flush();
  assert.equal(ofPath(h, '/terminal/write').length, 1);
  const disposed = h.handle.dispose();
  assert.equal(h.container.children.length, 0);
  gate.resolve({});
  await disposed;
  await flush();
  assert.equal(ofPath(h, '/terminal/write').length, 1);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
});

test('one output batch stays in flight until exact ACK, then the cursor advances', async () => {
  const h = await boot();
  assert.equal(ofPath(h, '/terminal/read').length, 1);
  assert.equal(h.time.timers.size, 0);
  h.channels[0].port2.postMessage({ type: 'ack', id: 999 });
  await flush();
  assert.equal(h.time.timers.size, 0);
  await h.ack();
  assert.equal(h.time.runTimer(), 80);
  await flush();
  assert.equal(ofPath(h, '/terminal/read').length, 2);
  assert.equal(ofPath(h, '/terminal/read')[1].input.afterSeq, 1);
  h.channels[0].port2.postMessage({ type: 'ack', id: 1 });
  await flush();
  assert.equal(h.time.timers.size, 0);
  assert.deepEqual(h.term.writes, ['output-1', 'output-2']);
  await h.handle.dispose();
});

test('output loss resets the emulator and leaves a persistent gap warning without injecting input', async () => {
  let reads = 0;
  const h = await boot({ api: { '/terminal/read': () => ++reads === 1
    ? { chunks: [{ seq: 10, data: '\u001b[31mtail' }], nextSeq: 10, firstSeq: 10, loss: true, phase: 'running' }
    : { chunks: [], nextSeq: 10, firstSeq: 10, loss: false, phase: 'running' } } });
  assert.equal(h.term.resets, 1);
  assert.match(h.child.status.textContent, /Output was lost; resize/);
  assert.deepEqual(h.term.writes, ['\u001b[31mtail']);
  await h.ack();
  h.time.runTimer();
  await flush();
  await h.ack();
  assert.match(h.child.status.textContent, /Output was lost/);
  assert.equal(ofPath(h, '/terminal/write').length, 0);
  assert.equal(h.ready, 1);
  await h.handle.dispose();
});

test('normal and error exits preserve final output and surface, disable input, and stop polling', async () => {
  for (const phase of ['exited', 'error']) {
    const h = await boot({ api: { '/terminal/read': () => ({ chunks: [{ seq: 1, data: 'final output' }], nextSeq: 1, firstSeq: 1, loss: false, phase, exit: { exitCode: 7, secret: 'never sent' } }) } });
    assert.equal(h.container.children.length, 1);
    assert.equal(h.ready, 0);
    await h.ack();
    assert.equal(h.ready, 1);
    assert.equal(h.term.options.disableStdin, true);
    assert.match(h.child.status.textContent, phase === 'error' ? /Process failed/ : /Process exited/);
    assert.match(h.child.status.textContent, /7/);
    assert.equal(h.time.timers.size, 0);
    h.term.input('no');
    h.handle.focus();
    await flush();
    assert.equal(h.container.children.length, 1);
    assert.equal(h.term.disposed, 0);
    assert.equal(ofPath(h, '/terminal/write').length, 0);
    assert.equal(ofPath(h, '/runtime/stop').length, 0);
    assert.deepEqual(h.errors, []);
    assert.doesNotMatch(JSON.stringify(h.channels[0].port1.sent), /runtime-secret|owner-secret|never sent/);
    await h.handle.dispose();
  }
});

test('normal exit code zero notifies once after first ready while abnormal exit stays diagnostic', async () => {
  const order = [];
  const h = await boot({
    onReady() { order.push('ready'); }, onExit() { order.push('exit'); },
    api: { '/terminal/read': () => ({ chunks: [{ seq: 1, data: 'done' }], nextSeq: 1, phase: 'exited', exit: { exitCode: 0, signal: null } }) },
  });
  assert.equal(h.ready, 0); assert.equal(h.exits, 0);
  await h.ack();
  assert.equal(h.ready, 1); assert.equal(h.exits, 1); assert.deepEqual(order, ['ready', 'exit']);
  await h.handle.dispose(); assert.equal(h.exits, 1);
  const abnormal = await boot({ api: { '/terminal/read': () => ({ chunks: [{ seq: 1, data: 'failed' }], nextSeq: 1, phase: 'error', exit: { exitCode: 0, signal: null } }) } });
  await abnormal.ack();
  assert.equal(abnormal.exits, 0); assert.equal(abnormal.container.children.length, 1);
  assert.match(abnormal.child.status.textContent, /Process failed/);
  await abnormal.handle.dispose();
});

test('real Host exit metadata reaches Provider and maps back to renderer code zero', async (t) => {
  const fixture = await hostBackedProvider(t);
  const { h, service, terminalDone, exit } = fixture;
  await until(() => h.term?.acks.length > 0 || h.errors.length > 0); assert.ok(!fixture.startupError); assert.deepEqual(fixture.startupResult, { runtimeId: 'runtime-host-exit' }); assert.deepEqual(h.errors, []); await h.ack(); assert.equal(h.ready, 1);
  exit();
  await flush();
  const batch = await service.readTerminal({ runtimeId: 'runtime-host-exit', ownerId: 'owner-secret', afterSeq: 0 });
  assert.equal(batch.phase, 'exited');
  assert.deepEqual(batch.exit, { exitCode: 0, signal: null });
  h.time.runTimer(); await flush(); await until(() => h.term.acks.length > 0); await h.ack();
  assert.equal(h.exits, 1);
  const message = h.channels[0].port1.sent.find((item) => item.type === 'exit');
  assert.equal(message.code, 0); assert.equal('exitCode' in message, false);
  await h.handle.dispose();
});

test('aborted startup removes the iframe immediately and stops a late runtime once without its aborted signal', async () => {
  const acquire = deferred();
  const stopped = deferred();
  const h = await boot({ api: { '/tui/open': () => acquire.promise, '/runtime/stop': () => stopped.promise } });
  const opened = ofPath(h, '/tui/open')[0];
  h.cancellation.abort();
  assert.equal(h.container.children.length, 0);
  assert.equal(opened.signal.aborted, true);
  const first = h.handle.dispose();
  assert.equal(h.handle.dispose(), first);
  let done = false;
  first.then(() => { done = true; });
  acquire.resolve({ runtimeId: 'late-runtime' });
  await flush();
  assert.equal(done, false);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
  assert.deepEqual(ofPath(h, '/runtime/stop')[0].input, { runtimeId: 'late-runtime', ownerId: 'owner-secret' });
  assert.equal(ofPath(h, '/runtime/stop')[0].signal, undefined);
  stopped.resolve({});
  await first;
  assert.equal(h.ready, 0);
  assert.equal(ofPath(h, '/terminal/read').length, 0);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
});

test('dispose during an in-flight read ignores late output and consumes late rejection', async () => {
  for (const reject of [false, true]) {
    const gate = deferred();
    const h = await boot({ api: { '/terminal/read': () => gate.promise } });
    const disposed = h.handle.dispose();
    if (reject) gate.reject(Error('late secret')); else gate.resolve({ chunks: [{ seq: 1, data: 'too late' }], nextSeq: 1, phase: 'running' });
    await disposed;
    await flush();
    assert.deepEqual(h.term.writes, []);
    assert.equal(h.ready, 0);
    assert.equal(h.errors.length, 0);
    assert.equal(ofPath(h, '/runtime/stop').length, 1);
  }
});

test('already aborted or pre-load disposal never opens a Host runtime', async () => {
  for (const aborted of [true, false]) {
    const h = harness();
    if (aborted) h.cancellation.abort();
    const handle = h.open();
    await handle.dispose();
    h.frames[0].emit('load');
    await flush();
    assert.equal(h.calls.length, 0);
    assert.equal(h.channels.length, 0);
    assert.equal(h.container.children.length, 0);
  }
});

test('startup preserves allowlisted safety codes without exposing raw errors or output', async () => {
  for (const code of ['TUI_PROFILE_CONFLICT', 'PROFILE_HOST_CONFLICT', 'TUI_NOT_INSTALLED', 'VERSION_MISMATCH']) {
    const h = await boot({ api: { '/tui/open': () => Promise.reject(Object.assign(Error(`https://host/?token=secret ${code}`), { code })) } });
    await h.handle.dispose();
    assert.deepEqual(h.errors, [code]);
    assert.equal(h.container.children.length, 0);
    assert.doesNotMatch(JSON.stringify(h.errors), /https|token|secret/);
  }
  const h = await boot({ api: { '/tui/open': () => Promise.reject(Object.assign(Error('private output'), { code: 'https://host/?token=secret' })) } });
  await h.handle.dispose();
  assert.deepEqual(h.errors, ['TUI_OPEN_FAILED']);
});

test('startup failure uses only a safe code and cleanup survives a throwing error observer', async () => {
  const h = await boot({ api: { '/tui/open': () => Promise.reject(Error('https://host/?token=secret')) }, onError() { throw Error('observer'); } });
  await h.handle.dispose();
  assert.deepEqual(h.errors, ['TUI_OPEN_FAILED']);
  assert.equal(h.container.children.length, 0);
  assert.equal(h.term.disposed, 1);
  assert.equal(h.child.observers[0].disconnected, 1);
});

test('read, write, and resize rejections are consumed and reported as safe codes', async () => {
  for (const operation of ['read', 'write', 'resize']) {
    const h = await boot({ api: { ['/terminal/' + operation]: () => Promise.reject(Error('secret ' + operation)) } });
    if (operation !== 'read') {
      await h.ack();
      if (operation === 'write') h.term.input('x');
      else { h.channels[0].port2.postMessage({ type: 'resize', cols: 110, rows: 35 }); }
      await flush();
    }
    await h.handle.dispose();
    assert.deepEqual(h.errors, ['TUI_' + operation.toUpperCase() + '_FAILED']);
    assert.equal(h.container.children.length, 0);
    assert.equal(ofPath(h, '/runtime/stop').length, 1);
  }
});

test('child coalesces ResizeObserver callbacks, ignores zero-size and hidden fits, and clamps dimensions', async () => {
  const h = await boot();
  await h.ack();
  h.child.box.cols = 2000;
  h.child.box.rows = 800;
  h.child.observers[0].callback();
  h.child.observers[0].callback();
  assert.equal(h.child.time.frames.size, 1);
  h.child.time.runFrames();
  await flush();
  assert.equal(h.term.cols, 1000);
  assert.equal(h.term.rows, 500);
  assert.deepEqual(ofPath(h, '/terminal/resize').at(-1).input, { runtimeId: 'runtime-secret', ownerId: 'owner-secret', cols: 1000, rows: 500 });
  const fits = h.child.addons[0].fits;
  h.child.box.width = 0;
  h.child.observers[0].callback();
  h.child.time.runFrames();
  await flush();
  assert.equal(h.child.addons[0].fits, fits);
  h.handle.setVisible(false);
  await flush();
  h.child.observers[0].callback();
  assert.equal(h.child.time.frames.size, 0);
  await h.handle.dispose();
});

test('cleanup is idempotent and continues through throwing DOM, port, observer, terminal, and stop cleanup', async () => {
  const h = await boot({ api: { '/runtime/stop': () => Promise.reject(Error('stop failed')) } });
  await h.ack();
  h.frames[0].throwRemove = true;
  h.term.throwDispose = true;
  h.term.throwDataDispose = true;
  h.child.observers[0].throwDisconnect = true;
  h.channels[0].port1.throwClose = true;
  h.channels[0].port2.throwClose = true;
  const first = h.handle.dispose();
  assert.equal(h.handle.dispose(), first);
  await first;
  assert.equal(h.container.children.length, 0);
  assert.equal(h.term.disposed, 1);
  assert.equal(h.term.inputDisposed, true);
  assert.equal(h.child.observers[0].disconnected, 1);
  assert.equal(h.time.timers.size, 0);
  assert.equal(h.child.time.frames.size, 0);
  assert.equal(h.channels[0].port1.closed, true);
  assert.equal(h.channels[0].port2.closed, true);
  assert.equal(h.channels[0].port1.closeCalls, 1);
  assert.equal(h.channels[0].port2.closeCalls, 1);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
});

test('xterm write failure reports a safe document error and releases the PTY', async () => {
  const gate = deferred();
  const h = await boot({ api: { '/terminal/read': () => gate.promise } });
  h.term.throwWrite = true;
  gate.resolve({ chunks: [{ seq: 1, data: 'x' }], nextSeq: 1, phase: 'running' });
  await flush();
  await h.handle.dispose();
  assert.deepEqual(h.errors, ['TUI_DOCUMENT_FAILED']);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
});

test('throwing ready observers do not interrupt polling or introduce late focus', async () => {
  const h = await boot({ onReady() { throw Error('observer'); } });
  h.handle.focus();
  await h.ack();
  assert.equal(h.ready, 1);
  assert.equal(h.term.focused, 0);
  assert.equal(h.time.timers.size, 1);
  assert.deepEqual(h.errors, []);
  await h.handle.dispose();
});

test('invalid output cursors and oversized batches fail rather than queueing unbounded output', async () => {
  for (const result of [
    { chunks: [{ seq: 2, data: 'x' }], nextSeq: 1, phase: 'running' },
    { chunks: [{ seq: 1, data: 'x'.repeat(1048577) }], nextSeq: 1, phase: 'running' },
    { chunks: [], nextSeq: -1, phase: 'running' },
  ]) {
    const h = await boot({ api: { '/terminal/read': () => result } });
    await h.handle.dispose();
    assert.deepEqual(h.errors, ['TUI_READ_FAILED']);
    assert.deepEqual(h.term.writes, []);
    assert.equal(ofPath(h, '/terminal/read').length, 1);
  }
});

test('hidden startup does not depend on suspended animation frames', async () => {
  const h = harness();
  h.open().setVisible(false);
  h.frames[0].emit('load');
  await flush();
  assert.equal(ofPath(h, '/tui/open').length, 1);
  assert.equal(ofPath(h, '/tui/open')[0].input.cols, 80);
  assert.equal(h.child.addons[0].fits, 0);
  await h.handle.dispose();
});

test('visible startup reports initial dimensions without waiting for animation frames', async () => {
  const h = harness();
  h.open();
  h.frames[0].emit('load');
  await flush();
  assert.equal(ofPath(h, '/tui/open').length, 1);
  await h.handle.dispose();
});

test('invalid and duplicate ready dimensions cannot create a second runtime', async () => {
  const h = harness();
  h.open();
  h.frames[0].emit('load');
  await flush();
  for (const value of [{ cols: 0, rows: 24 }, { cols: 80, rows: 0 }, { cols: 1001, rows: 24 }, { cols: 80, rows: 501 }, { cols: 80.5, rows: 24 }]) {
    h.channels[0].port2.postMessage({ type: 'ready', ...value });
  }
  await flush();
  assert.equal(ofPath(h, '/tui/open').length, 1);
  h.child.time.runFrames();
  await flush();
  h.channels[0].port2.postMessage({ type: 'ready', cols: 120, rows: 40 });
  await flush();
  assert.equal(ofPath(h, '/tui/open').length, 1);
  assert.equal(ofPath(h, '/terminal/read').length, 1);
  await h.handle.dispose();
});

test('resize RPCs are serial, coalesce to the latest grid, and pause while hidden', async () => {
  const gate = deferred();
  let requests = 0;
  const h = await boot({ api: { '/terminal/resize': () => ++requests === 1 ? gate.promise : {} } });
  await h.ack();
  for (const cols of [110, 120, 130]) h.channels[0].port2.postMessage({ type: 'resize', cols, rows: 40 });
  await flush();
  assert.equal(ofPath(h, '/terminal/resize').length, 1);
  assert.equal(ofPath(h, '/terminal/resize')[0].input.cols, 110);
  h.handle.setVisible(false);
  await flush();
  gate.resolve({});
  await flush();
  assert.equal(ofPath(h, '/terminal/resize').length, 1);
  h.handle.setVisible(true);
  await flush();
  assert.equal(ofPath(h, '/terminal/resize').length, 2);
  assert.equal(ofPath(h, '/terminal/resize')[1].input.cols, 130);
  await h.handle.dispose();
});

test('an in-flight read is never duplicated by visibility changes', async () => {
  const second = deferred();
  let reads = 0;
  const h = await boot({ api: { '/terminal/read': () => ++reads === 1
    ? { chunks: [], nextSeq: 0, firstSeq: 1, loss: false, phase: 'running' } : second.promise } });
  await h.ack();
  h.time.runTimer();
  await flush();
  for (const visible of [false, true, false, true]) h.handle.setVisible(visible);
  await flush();
  assert.equal(ofPath(h, '/terminal/read').length, 2);
  assert.equal(h.time.timers.size, 0);
  second.resolve({ chunks: [], nextSeq: 0, firstSeq: 1, loss: false, phase: 'running' });
  await flush();
  assert.equal(h.time.timers.size, 0);
  await h.ack();
  assert.equal(h.time.timers.size, 1);
  await h.handle.dispose();
});

test('async observer and cleanup rejection are observed without preventing cleanup', async () => {
  const h = await boot({ onReady: () => Promise.reject(Error('async observer')) });
  await h.ack();
  h.term.dispose = () => { h.term.disposed++; return Promise.reject(Error('async terminal cleanup')); };
  await h.handle.dispose();
  await flush();
  assert.equal(h.term.disposed, 1);
  assert.equal(h.container.children.length, 0);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
});

test('missing terminal assets or failed DOM attachment report safe errors without starting Host resources', async () => {
  const missing = harness();
  missing.open();
  missing.child.window.Terminal = undefined;
  await missing.load();
  await missing.handle.dispose();
  assert.deepEqual(missing.errors, ['TUI_DOCUMENT_FAILED']);
  assert.equal(missing.calls.length, 0);
  const dom = harness();
  dom.container.appendChild = () => { throw Error('secret DOM'); };
  const handle = dom.open();
  await handle.dispose();
  assert.deepEqual(dom.errors, ['TUI_DOCUMENT_FAILED']);
  assert.equal(dom.calls.length, 0);
});

test('channel send failure disposes an existing runtime and reports only its safe error code', async () => {
  const h = await boot();
  await h.ack();
  h.channels[0].port1.postMessage = () => { throw Error('secret transport'); };
  h.handle.resize();
  await h.handle.dispose();
  assert.deepEqual(h.errors, ['TUI_CHANNEL_FAILED']);
  assert.equal(ofPath(h, '/runtime/stop').length, 1);
  assert.equal(h.container.children.length, 0);
});

test('Chinese status keeps gap and exit information without rendering terminal data as HTML', async () => {
  const h = await boot({ locale: 'zh', api: { '/terminal/read': () => ({ chunks: [{ seq: 5, data: '<img src=x onerror=alert(1)>' }], nextSeq: 5, firstSeq: 5, loss: true, phase: 'exited', exit: { exitCode: 0, signal: null } }) } });
  await h.ack();
  assert.match(h.child.status.textContent, /进程已退出/);
  assert.match(h.child.status.textContent, /部分输出已丢失/);
  assert.doesNotMatch(h.child.status.textContent, /<img/);
  assert.equal(h.term.writes[0], '<img src=x onerror=alert(1)>');
  await h.handle.dispose();
});
