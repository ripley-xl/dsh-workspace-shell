import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  createHostRestart, helperSource, readReceipt, receiptFile, restartPayload, restartEnvironment,
  rewritePort, cooldownRemaining, restartError,
} from '../../packages/guest/src/host/host-restart.js';

const identity = {
  pid: 4242,
  port: 61599,
  url: 'http://127.0.0.1:61599/?token=t',
  argv: ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--profile', 'web', '--port', '0'],
  cwd: '/tmp',
  env: { DSH_HOME: '/tmp/home' },
};

test('rewritePort keeps other arguments and replaces every --port form', () => {
  assert.deepEqual(rewritePort(['node', 'bin.js', '--port', '0'], 4321), ['node', 'bin.js', '--port', '4321']);
  assert.deepEqual(rewritePort(['node', 'bin.js', '--port=0', '--x'], 4321), ['node', 'bin.js', '--port=4321', '--x']);
  assert.deepEqual(rewritePort(['node', 'bin.js'], 4321), ['node', 'bin.js', '--port', '4321']);
  assert.deepEqual(rewritePort(['node', '--port', '1', '--port', '2'], 9), ['node', '--port', '9', '--port', '9']);
  assert.deepEqual(rewritePort(['node', '--port', '9'], 0), ['node', '--port', '0'], '0 means "let the OS pick" for the fallback replay');
  assert.throws(() => rewritePort(['node'], -1), (error) => error.code === 'HOST_RESTART_INVALID_PORT');
  assert.throws(() => rewritePort('node', 1), (error) => error.code === 'HOST_RESTART_INVALID_ARGV');
});

test('restartEnvironment drops boot-only variables', () => {
  const env = restartEnvironment({ DSH_HOME: '/h', DSH_SESSION_ID: 's', DSH_WEB_URL: 'u', DSH_SHELL: '1', ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' });
  assert.deepEqual(env, { DSH_HOME: '/h', PATH: '/bin' });
});

test('receipt reading tolerates missing, corrupt and foreign files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-restart-receipt-'));
  try {
    const file = receiptFile(root);
    assert.equal(readReceipt(file), null);
    writeFileSync(file, '{not json');
    assert.equal(readReceipt(file), null);
    writeFileSync(file, JSON.stringify({ ok: true }));
    assert.equal(readReceipt(file), null, 'a receipt without a timestamp cannot drive a cooldown');
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ok: true, port: 1 }));
    assert.equal(readReceipt(file).ok, true);
    assert.equal(readReceipt(receiptFile(root)).port, 1);
    assert.throws(() => receiptFile('relative'), (error) => error.code === 'HOST_RESTART_INVALID_PROFILE_DIR');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cooldownRemaining counts down from the receipt', () => {
  const now = Date.parse('2026-11-10T00:00:05.000Z');
  assert.equal(cooldownRemaining({ at: '2026-11-10T00:00:00.000Z' }, now, 10_000), 5_000);
  assert.equal(cooldownRemaining({ at: '2026-11-10T00:00:00.000Z' }, now, 1_000), 0);
  assert.equal(cooldownRemaining(null, now), 0);
  assert.equal(cooldownRemaining({ at: 'nonsense' }, now), 0);
});

test('helper source parses as a runnable script and embeds the payload', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-restart-helper-'));
  try {
    const payload = restartPayload({ identity, receipt: path.join(root, 'receipt.json'), ack: path.join(root, 'ack.json'), log: path.join(root, 'log') });
    const file = path.join(root, 'helper.cjs');
    writeFileSync(file, helperSource(payload));
    execFileSync(process.execPath, ['--check', file]);
    const source = readFileSync(file, 'utf8');
    assert.match(source, /dsh web: /u, 'the replacement is recognised by its startup line');
    assert.match(source, /--port", "61599|--port","61599|--port', '61599/u);
    assert.equal(payload.port, 61599);
    assert.deepEqual(payload.argvPort, ['/usr/bin/node', '/opt/dsh/lib/bin.js', '--profile', 'web', '--port', '61599']);
    assert.deepEqual(payload.argvEphemeral.slice(-2), ['--port', '0']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function service(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-restart-service-'));
  const spawned = [];
  const value = createHostRestart({
    profileDir: root,
    identity,
    tmpdir: root,
    spawn: (file, args, options) => {
      spawned.push({ file, args, options });
      // The helper acknowledges as soon as it is alive; do that a tick later.
      const request = args[0];
      const ack = request.replace(/\.helper\.cjs$/u, '.ack.json');
      setTimeout(() => writeFileSync(ack, '{"at":0}'), 20);
      return { pid: 999, unref() {} };
    },
    busy: () => ({ tasks: 0, jobs: 0 }),
    ...overrides,
  });
  return { root, spawned, value };
}

test('restart dispatches one detached helper and waits for its ack', async () => {
  const { root, spawned, value } = service();
  try {
    const result = await value.restart({ mode: 'now' });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'now');
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].options.detached, true);
    assert.match(spawned[0].args[0], /\.helper\.cjs$/u);
    const helper = readFileSync(spawned[0].args[0], 'utf8');
    assert.match(helper, /boot\.ack/u);
    assert.equal(statSync(spawned[0].args[0]).mode & 0o777, 0o600);
    // The helper file is written before the spawn, so a missing ack still leaves evidence.
    assert.equal(value.status().cooldownMs > 0, true);
  } finally {
    value.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart refuses while cooling down, when disabled, and when busy', async () => {
  const disabled = service({ allowRestart: false });
  try {
    await assert.rejects(disabled.value.restart({ mode: 'now' }), (error) => error.code === 'HOST_RESTART_DISABLED');
  } finally {
    disabled.value.dispose();
    rmSync(disabled.root, { recursive: true, force: true });
  }

  const busy = service({ busy: () => ({ tasks: 2, jobs: 1 }) });
  try {
    await assert.rejects(busy.value.restart({ mode: 'now' }), (error) => error.code === 'HOST_RESTART_BUSY');
    assert.equal(busy.spawned.length, 0);
    const forced = await busy.value.restart({ mode: 'now', force: true });
    assert.equal(forced.ok, true);
  } finally {
    busy.value.dispose();
    rmSync(busy.root, { recursive: true, force: true });
  }

  const cooling = service();
  try {
    await cooling.value.restart({ mode: 'now' });
    await assert.rejects(cooling.value.restart({ mode: 'now' }), (error) => error.code === 'HOST_RESTART_COOLDOWN');
  } finally {
    cooling.value.dispose();
    rmSync(cooling.root, { recursive: true, force: true });
  }
});

test('a helper that never acknowledges reports unavailability instead of hanging', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-restart-ack-'));
  let nowMs = 0;
  const value = createHostRestart({
    profileDir: root, identity, tmpdir: root,
    now: () => nowMs,
    timers: {
      setInterval, clearInterval,
      setTimeout: (callback, ms, ...args) => { nowMs += ms; setImmediate(callback, ...args); return 0; },
    },
    spawn: () => ({ pid: 1, unref() {} }),
    busy: () => ({ tasks: 0, jobs: 0 }),
  });
  try {
    // The ack wait loop advances the injected clock until the deadline passes.
    await assert.rejects(value.restart({ mode: 'now' }), (error) => error.code === 'HOST_RESTART_UNAVAILABLE');
  } finally {
    value.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('wait mode polls until the Host is idle, then dispatches once', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-restart-wait-'));
  let busyCount = 2;
  let tick;
  const spawned = [];
  const value = createHostRestart({
    profileDir: root, identity, tmpdir: root,
    busy: () => ({ tasks: busyCount, jobs: 0 }),
    timers: {
      setInterval: (callback) => { tick = callback; return { unref() {} }; },
      clearInterval: () => { tick = null; },
      setTimeout: (callback) => { setImmediate(callback); return 0; },
    },
    spawn: (file, args) => {
      spawned.push(args[0]);
      const ack = args[0].replace(/\.helper\.cjs$/u, '.ack.json');
      setTimeout(() => writeFileSync(ack, '{"at":0}'), 5);
      return { pid: 7, unref() {} };
    },
  });
  try {
    const started = await value.restart({ mode: 'wait' });
    assert.equal(started.mode, 'waiting');
    assert.equal(spawned.length, 0);
    await tick();
    assert.equal(spawned.length, 0, 'still busy, still waiting');
    busyCount = 0;
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawned.length, 1);
    assert.equal(value.status().wait.state, 'idle');
  } finally {
    value.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancel stops a pending wait', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-restart-cancel-'));
  const value = createHostRestart({
    profileDir: root, identity, tmpdir: root,
    busy: () => ({ tasks: 1, jobs: 0 }),
    timers: { setInterval: () => ({ unref() {} }), clearInterval: () => {}, setTimeout: (callback) => { setImmediate(callback); return 0; } },
    spawn: () => ({ pid: 1, unref() {} }),
  });
  try {
    await value.restart({ mode: 'wait' });
    assert.equal(value.status().wait.state, 'waiting');
    const cancelled = await value.restart({ mode: 'cancel' });
    assert.equal(cancelled.cancelled, true);
    assert.equal(value.status().wait.state, 'idle');
  } finally {
    value.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the helper kills the old Host, relaunches it, and the replacement outlives the helper', async () => {
  const { createRequire } = await import('node:module');
  const { spawn } = await import('node:child_process');
  const { readFileSync: read } = await import('node:fs');
  const helperRequire = createRequire(import.meta.url);
  const { createServer } = helperRequire('node:net');
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const root = mkdtempSync(path.join(os.tmpdir(), 'host-restart-helper-e2e-'));
  const fakeHost = path.join(root, 'fake-host.cjs');
  writeFileSync(fakeHost, `
const http = require('node:http');
const index = process.argv.indexOf('--port');
const port = Number(process.argv[index + 1]);
const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
server.listen(port, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + port + '/?token=t'));
setInterval(() => console.log('alive ' + Date.now()), 100);
setInterval(() => {}, 1000);
`);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const responds = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch { return false; }
  };
  let oldHost;
  let replacementPid = null;
  try {
    oldHost = spawn(process.execPath, [fakeHost, '--port', String(port)], { cwd: root, stdio: 'ignore', detached: false });
    for (let i = 0; i < 50 && !(await responds()); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await responds(), true, 'fake host is up before the restart');
    const receipt = path.join(root, 'receipt.json');
    const payload = restartPayload({
      identity: { pid: oldHost.pid, port, url: `http://127.0.0.1:${port}/`, argv: [process.execPath, fakeHost], cwd: root },
      receipt, ack: path.join(root, 'ack.json'), log: path.join(root, 'helper.log'),
    });
    const helper = path.join(root, 'helper.cjs');
    writeFileSync(helper, helperSource(payload));
    const run = spawn(process.execPath, [helper], { stdio: 'ignore' });
    const exitCode = await new Promise((resolve) => run.once('exit', resolve));
    assert.equal(exitCode, 0);
    assert.equal(alive(oldHost.pid), false, 'the old Host is gone');
    const written = JSON.parse(read(receipt, 'utf8'));
    assert.equal(written.ok, true, `helper reported: ${read(path.join(root, 'helper.log'), 'utf8')}`);
    assert.equal(written.port, port, 'the replacement kept the port');
    replacementPid = written.pid;
    assert.equal(await responds(), true);
    // Regression: the replacement must not die when the helper's stdio closes.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(alive(replacementPid), true, 'the replacement survives the helper exit');
    assert.equal(await responds(), true);
  } finally {
    try { oldHost?.kill('SIGKILL'); } catch { /* already gone */ }
    if (replacementPid) { try { process.kill(replacementPid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
