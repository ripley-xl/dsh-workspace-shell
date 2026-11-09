import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { getEventListeners } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLocalRuntimeService } from '../../packages/shell/src/host/local-runtimes.js';

const VERSION = '0.2.1-rc.5';
const WEB_CWD_PATCH = fileURLToPath(new URL('../../packages/guest/cordis.patch.yml', import.meta.url));
const TUI_VERSION = '0.18.0';
const TEMP_PREFIX = path.join(os.tmpdir(), 'dsh-local-runtimes-');
const SECRET = 'private-token-never-report';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function processHandle({ outcome, stdout = Readable.from([]), onTerminate } = {}) {
  const done = deferred();
  const handle = {
    stdout,
    stderr: Readable.from([]),
    done: done.promise,
    terminateCalls: 0,
    terminate() {
      handle.terminateCalls += 1;
      stdout.push(null);
      onTerminate?.();
      done.resolve(outcome ?? { exitCode: 0, signal: null });
    },
    async waitForExit() {
      await done.promise;
      return true;
    },
  };
  return handle;
}

function terminalHandle({ output = new Readable({ read() {} }), onTerminate } = {}) {
  const done = deferred();
  const handle = {
    output,
    done: done.promise,
    writes: [],
    sizes: [],
    terminateCalls: 0,
    async write(data) { handle.writes.push(data); },
    async resize(cols, rows) { handle.sizes.push([cols, rows]); },
    async terminate() {
      handle.terminateCalls += 1;
      output.push(null);
      onTerminate?.();
      done.resolve({ exitCode: 0, signal: null });
    },
  };
  return handle;
}

function fakeSubprocess() {
  const calls = { resolve: [], spawn: [], terminal: [] };
  const state = {
    calls,
    version: VERSION,
    webUrl: `http://127.0.0.1:45123/?tkn=${SECRET}`,
    webHandles: [],
    terminalHandles: [],
    async resolveExecutable(command) {
      calls.resolve.push(command);
      return '/usr/local/bin/dsh';
    },
    spawn(spec) {
      calls.spawn.push(spec);
      if (spec.argv.includes('--version')) {
        const handle = processHandle({ stdout: Readable.from([`${state.version}\n`]) });
        queueMicrotask(() => handle.terminate());
        return handle;
      }
      const handle = processHandle({ stdout: Readable.from([`dsh web: ${state.webUrl}\n`]) });
      state.webHandles.push(handle);
      return handle;
    },
    async spawnTerminal(spec) {
      calls.terminal.push(spec);
      const handle = terminalHandle();
      state.terminalHandles.push(handle);
      return handle;
    },
  };
  return state;
}

function pendingWebSubprocess() {
  const subprocess = fakeSubprocess();
  const output = new Readable({ read() {} });
  const originalSpawn = subprocess.spawn;
  subprocess.spawn = (spec) => {
    if (spec.argv.includes('--version')) return originalSpawn(spec);
    subprocess.calls.spawn.push(spec);
    const handle = processHandle({ stdout: output });
    subprocess.webHandles.push(handle);
    return handle;
  };
  return { subprocess, output };
}

function deferredWebSubprocess() {
  const subprocess = fakeSubprocess();
  const output = new Readable({ read() {} });
  const done = deferred();
  const exitCheck = deferred();
  const exitCheckStarted = deferred();
  const spawned = deferred();
  const originalSpawn = subprocess.spawn;
  let deferredSpawn = true;
  subprocess.spawn = (spec) => {
    if (spec.argv.includes('--version') || !deferredSpawn) return originalSpawn(spec);
    deferredSpawn = false;
    subprocess.calls.spawn.push(spec);
    const handle = {
      stdout: output,
      stderr: Readable.from([]),
      done: done.promise,
      terminateCalls: 0,
      terminate() {
        handle.terminateCalls += 1;
        output.push(null);
      },
      waitForExit() {
        exitCheckStarted.resolve();
        return exitCheck.promise;
      },
    };
    subprocess.webHandles.push(handle);
    spawned.resolve(handle);
    return handle;
  };
  return { subprocess, output, done, exitCheck, exitCheckStarted, spawned };
}

async function writeJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value)}\n`, 'utf8');
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(TEMP_PREFIX);
  const home = path.join(root, 'home');
  const profiles = path.join(home, 'profiles');
  const current = path.join(profiles, 'current');
  const web = path.join(profiles, 'web');
  const tui = path.join(profiles, 'tui');
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd, { recursive: true });
  await writeJson(path.join(current, 'package.json'), { name: 'current', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  await writeJson(path.join(web, 'package.json'), { name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  await writeJson(path.join(tui, 'package.json'), { name: 'tui', dsh: { profile: { bundles: ['@deepseek-harness-tui/dsh-tui'] } } });
  await writeJson(path.join(tui, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), { name: '@deepseek-harness-tui/dsh-tui', version: TUI_VERSION });
  const subprocess = options.subprocess ?? fakeSubprocess();
  let nextId = 0;
  const service = createLocalRuntimeService({
    subprocess,
    profileContext: { name: 'current', dir: current, home, cwd },
    ...(options.currentDshVersion !== undefined ? { currentDshVersion: options.currentDshVersion } : {}),
    ...(options.upgrades !== undefined ? { upgrades: options.upgrades } : {}),
    ...(options.versionCheckTtlMs !== undefined ? { versionCheckTtlMs: options.versionCheckTtlMs } : {}),
    startupTimeoutMs: options.startupTimeoutMs ?? 50,
    graceMs: 5,
    terminalBytes: options.terminalBytes,
    idFactory: options.idFactory ?? (() => `runtime-${++nextId}`),
  });
  t.after(async () => {
    await service.dispose().catch(() => {});
    assert.equal(path.isAbsolute(root), true);
    assert.equal(root.startsWith(TEMP_PREFIX), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, home, profiles, current, web, tui, cwd, subprocess, service };
}

async function expectCode(action, code) {
  await assert.rejects(Promise.resolve().then(action), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for terminal output.');
}

test('catalog lists only declared candidates and current profile requires the local workspace', async (t) => {
  const { service } = await fixture(t);
  const value = await service.catalog();
  assert.equal(value.currentProfile, 'current');
  assert.deepEqual(value.profiles.map((profile) => [profile.id, profile.isCurrent, profile.web, profile.tui]), [
    ['current', true, true, false], ['tui', false, false, true], ['web', false, true, false],
  ]);
  assert.deepEqual(value.profiles.map((profile) => [profile.id, profile.tuiFlavor]), [
    ['current', null], ['tui', 'dsh-tui'], ['web', null],
  ]);
  assert.deepEqual(value.runtimes, []);
  await expectCode(() => service.openWeb({ profileId: 'current', ownerId: 'owner', confirmIndependentHost: true }), 'CURRENT_PROFILE_USE_LOCAL');
  await expectCode(() => service.openTui({ profileId: 'current', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true }), 'CURRENT_PROFILE_USE_LOCAL');
});

test('first start requires independent Host confirmation without claiming external discovery', async (t) => {
  const { service, subprocess } = await fixture(t);
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner' }), 'INDEPENDENT_HOST_CONFIRMATION_REQUIRED');
  assert.equal(subprocess.calls.spawn.length, 0);
});

test('Web reuses only the same owner Host and rejects cross-owner URL access', async (t) => {
  const { service, subprocess } = await fixture(t);
  const first = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  const again = await service.openWeb({ profileId: 'web', ownerId: 'owner' });
  assert.deepEqual(again, first);
  assert.deepEqual(service.attachWeb({ runtimeId: first.runtimeId, ownerId: 'owner' }), first);
  await expectCode(() => service.attachWeb({ runtimeId: first.runtimeId, ownerId: 'other-owner' }), 'RUNTIME_OWNER_MISMATCH');
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'other-owner' }), 'PROFILE_HOST_CONFLICT');
  assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
  const web = subprocess.calls.spawn.find((spec) => !spec.argv.includes('--version'));
  assert.deepEqual(web.argv, ['/usr/local/bin/dsh', '--profile', 'web', '--patch', WEB_CWD_PATCH, '--no-open', '--host', '127.0.0.1', '--port', '0']);
  assert.equal(path.isAbsolute(web.argv[web.argv.indexOf('--patch') + 1]), true);
  assert.equal(web.argv.indexOf('--patch') < web.argv.indexOf('--no-open'), true);
  assert.equal((await fs.stat(WEB_CWD_PATCH)).isFile(), true);
  assert.equal(web.env.DSH_TUI_BACKEND, undefined);
  assert.equal(web.env.DSH_TUI_WORKSPACE_TARGET, undefined);
  assert.equal(web.env.DSH_TUI_DISABLE_TERMINAL_IMAGES, undefined);
  assert.equal(web.env.DSH_TUI_DISABLE_EXTENDED_KEYS, undefined);
  assert.equal(web.stdio.stdin, 'ignore');
  const catalog = await service.catalog();
  assert.equal(catalog.runtimes[0].id, first.runtimeId);
  assert.equal(catalog.runtimes[0].phase, 'running');
  assert.equal(catalog.runtimes[0].source, 'local');
  assert.equal(JSON.stringify(catalog).includes(SECRET), false);
  assert.equal(JSON.stringify(catalog).includes('url'), false);
  await expectCode(() => service.stop({ runtimeId: first.runtimeId, ownerId: 'other-owner' }), 'RUNTIME_OWNER_MISMATCH');
  await service.stop({ runtimeId: first.runtimeId, ownerId: 'owner' });
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
  await expectCode(() => service.attachWeb({ runtimeId: first.runtimeId, ownerId: 'owner' }), 'RUNTIME_NOT_ACTIVE');
});

test('CLI version is recorded on the runtime instead of gating startup', async (t) => {
  const subprocess = fakeSubprocess();
  subprocess.version = '0.2.2-rc.1';
  const { service, subprocess: calls } = await fixture(t, { subprocess });
  const opened = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  assert.equal(calls.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
  const catalog = await service.catalog();
  assert.equal(catalog.runtimes[0].dshVersion, '0.2.2-rc.1');
  assert.equal(catalog.runtimes[0].upgradeAvailable, false, 'no upgrade service means no button');
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
});

test('a failed or malformed version probe only hides the version', async (t) => {
  const subprocess = fakeSubprocess();
  const originalSpawn = subprocess.spawn;
  subprocess.spawn = (spec) => {
    if (spec.argv.includes('--version')) {
      const handle = processHandle({ stdout: Readable.from(['not a version\n']) });
      queueMicrotask(() => handle.terminate());
      return handle;
    }
    return originalSpawn(spec);
  };
  const { service } = await fixture(t, { subprocess });
  const opened = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  assert.equal((await service.catalog()).runtimes[0].dshVersion, null);
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
});

test('TUI requires both a declared candidate and an exact installed manifest', async (t) => {
  const { service, tui, subprocess } = await fixture(t);
  await fs.writeFile(path.join(tui, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.0.0' }));
  await expectCode(() => service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true }), 'TUI_NOT_INSTALLED');
  assert.equal(subprocess.calls.terminal.length, 0);
  await writeJson(path.join(tui, 'package.json'), { name: 'tui', dsh: { profile: { bundles: [] } } });
  await expectCode(() => service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true }), 'TUI_NOT_INSTALLED');
});

test('profile traversal and symlink escapes are rejected', async (t) => {
  const { service, root, profiles } = await fixture(t);
  await expectCode(() => service.openWeb({ profileId: '../web', ownerId: 'owner', confirmIndependentHost: true }), 'PROFILE_NOT_FOUND');
  const outside = path.join(root, 'outside');
  await writeJson(path.join(outside, 'package.json'), { name: 'outside', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  await fs.symlink(outside, path.join(profiles, 'escape'), 'dir');
  await expectCode(() => service.openWeb({ profileId: 'escape', ownerId: 'owner', confirmIndependentHost: true }), 'PROFILE_NOT_FOUND');
});

test('TUI uses exact terminal argv/env and owner-gated write and resize', async (t) => {
  const { service, subprocess, cwd, home } = await fixture(t);
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd, cols: 80, rows: 24, confirmIndependentHost: true });
  const spec = subprocess.calls.terminal[0];
  assert.deepEqual(spec.argv, ['/usr/local/bin/dsh', '--profile', 'tui']);
  const actualCwd = await fs.realpath(cwd);
  assert.equal(spec.cwd, actualCwd);
  assert.equal(spec.env.DSH_TUI_BACKEND, 'dsh');
  assert.equal(spec.env.DSH_TUI_WORKSPACE_TARGET, actualCwd);
  assert.equal(spec.env.DSH_TUI_DISABLE_TERMINAL_IMAGES, '1');
  assert.equal(spec.env.DSH_TUI_DISABLE_EXTENDED_KEYS, '1');
  assert.deepEqual(spec.env, {
    DSH_HOME: home,
    DSH_TUI_BACKEND: 'dsh',
    DSH_TUI_WORKSPACE_TARGET: actualCwd,
    DSH_TUI_DISABLE_TERMINAL_IMAGES: '1',
    DSH_TUI_DISABLE_EXTENDED_KEYS: '1',
  });
  assert.equal(spec.terminalType, 'xterm-256color');
  await service.writeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', data: 'pwd\n' });
  await service.resizeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', cols: 120, rows: 40 });
  const handle = subprocess.terminalHandles[0];
  assert.deepEqual(handle.writes, ['pwd\n']);
  assert.deepEqual(handle.sizes, [[120, 40]]);
  await expectCode(() => service.writeTerminal({ runtimeId: opened.runtimeId, ownerId: 'other', data: 'x' }), 'RUNTIME_OWNER_MISMATCH');
});

test('Pi TUI uses the official launcher, exact package version, and no other TUI environment', async (t) => {
  const { service, subprocess, profiles, cwd, home } = await fixture(t);
  const packageName = '@xmoon76/dsh-pi-tui';
  await writeJson(path.join(profiles, 'pi', 'package.json'), {
    name: 'pi', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', `${packageName}@0.5.5`] } },
  });
  await writeJson(path.join(profiles, 'pi', 'node_modules', '@xmoon76', 'dsh-pi-tui', 'package.json'), {
    name: packageName, version: '0.5.5',
  });
  const listed = await service.catalog();
  assert.deepEqual(listed.profiles.find((profile) => profile.id === 'pi'), {
    id: 'pi', isCurrent: false, web: false, tui: true, tuiFlavor: 'pi-tui',
  });
  const opened = await service.openTui({ profileId: 'pi', ownerId: 'owner', cwd, cols: 80, rows: 24, confirmIndependentHost: true });
  const spec = subprocess.calls.terminal[0];
  assert.deepEqual(spec.argv, ['/usr/local/bin/dsh', '--profile', 'pi']);
  assert.deepEqual(spec.env, { DSH_HOME: home });
  assert.equal('HOME' in spec.env, false);
  assert.equal('DSH_TUI_BACKEND' in spec.env, false);
  assert.equal('DSH_TUI_WORKSPACE_TARGET' in spec.env, false);
  assert.equal('DSH_TUI_DISABLE_TERMINAL_IMAGES' in spec.env, false);
  assert.equal('DSH_TUI_DISABLE_EXTENDED_KEYS' in spec.env, false);
  assert.equal('DSH_TUI_SKIP_UPDATE' in spec.env, false);
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal((await service.catalog({ ownerId: 'owner' })).runtimes[0].phase, 'exited');
});

test('generic TUI uses an editable argv command without a fixed package version', async (t) => {
  const { service, subprocess, profiles, cwd, home } = await fixture(t);
  await writeJson(path.join(profiles, 'custom', 'package.json'), {
    name: 'custom', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@example/My-TUI@1.2.3'] } },
  });
  const originalResolve = subprocess.resolveExecutable.bind(subprocess);
  subprocess.resolveExecutable = async (command, ...args) => command === 'dsh-custom' ? '/opt/custom-tui' : originalResolve(command, ...args);
  const listed = await service.catalog();
  assert.deepEqual(listed.profiles.find((profile) => profile.id === 'custom'), {
    id: 'custom', isCurrent: false, web: false, tui: true, tuiFlavor: 'generic-tui',
  });
  const opened = await service.openTui({
    profileId: 'custom', ownerId: 'owner', cwd, cols: 80, rows: 24, confirmIndependentHost: true,
    command: 'dsh-custom --profile custom --title "two words"',
  });
  const spec = subprocess.calls.terminal[0];
  assert.deepEqual(spec.argv, ['/opt/custom-tui', '--profile', 'custom', '--title', 'two words']);
  assert.deepEqual(spec.env, { DSH_HOME: home });
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
});

test('Pi TUI rejects a different installed package version before terminal allocation', async (t) => {
  const { service, subprocess, profiles, cwd } = await fixture(t);
  const packageName = '@xmoon76/dsh-pi-tui';
  await writeJson(path.join(profiles, 'pi-old', 'package.json'), {
    name: 'pi-old', dsh: { profile: { bundles: [packageName] } },
  });
  await writeJson(path.join(profiles, 'pi-old', 'node_modules', '@xmoon76', 'dsh-pi-tui', 'package.json'), {
    name: packageName, version: '0.5.4',
  });
  await expectCode(() => service.openTui({ profileId: 'pi-old', ownerId: 'owner', cwd, cols: 80, rows: 24, confirmIndependentHost: true }), 'TUI_NOT_INSTALLED');
  assert.equal(subprocess.calls.terminal.length, 0);
});

test('a dual-TUI declaration stays visible in catalog but startup fails with TUI_PROFILE_CONFLICT', async (t) => {
  const { service, subprocess, profiles, cwd } = await fixture(t);
  await writeJson(path.join(profiles, 'conflict', 'package.json'), {
    name: 'conflict',
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base',
      '@deepseek-harness-tui/dsh-tui',
      '@xmoon76/dsh-pi-tui',
    ] } },
  });
  const listed = await service.catalog();
  assert.deepEqual(listed.profiles.find((profile) => profile.id === 'conflict'), {
    id: 'conflict', isCurrent: false, web: false, tui: true, tuiFlavor: null,
  });
  await expectCode(() => service.openTui({ profileId: 'conflict', ownerId: 'owner', cwd, cols: 80, rows: 24, confirmIndependentHost: true }), 'TUI_PROFILE_CONFLICT');
  assert.equal(subprocess.calls.terminal.length, 0);
});

test('TUI creates independent concurrent instances for each open without profile or cwd deduplication', async (t) => {
  const { service, subprocess, root, cwd, home } = await fixture(t);
  const otherCwd = path.join(root, 'other-work');
  await fs.mkdir(otherCwd);
  const [first, second] = await Promise.all([
    service.openTui({ profileId: 'tui', ownerId: 'owner', cwd, cols: 80, rows: 24, confirmIndependentHost: true }),
    service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: otherCwd, cols: 80, rows: 24, confirmIndependentHost: true }),
  ]);
  const third = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd, cols: 80, rows: 24, confirmIndependentHost: true });
  assert.equal(new Set([first.runtimeId, second.runtimeId, third.runtimeId]).size, 3);
  assert.equal(subprocess.calls.terminal.length, 3);
  const actualCwds = await Promise.all([fs.realpath(cwd), fs.realpath(otherCwd)]);
  const spawnedCwds = subprocess.calls.terminal.map((spec) => spec.cwd);
  assert.deepEqual(spawnedCwds.sort(), [...actualCwds, actualCwds[0]].sort());
  for (const spec of subprocess.calls.terminal) assert.equal(spec.env.DSH_HOME, home);
  await service.stop({ runtimeId: second.runtimeId, ownerId: 'owner' });
  const phases = new Map((await service.catalog({ ownerId: 'owner' })).runtimes.map((record) => [record.id, record.phase]));
  assert.equal(phases.get(first.runtimeId), 'running');
  assert.equal(phases.get(second.runtimeId), 'exited');
  assert.equal(phases.get(third.runtimeId), 'running');
});

test('split UTF-8 output retains ANSI and multibyte characters', async (t) => {
  const { service, subprocess } = await fixture(t);
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  const output = subprocess.terminalHandles[0].output;
  const input = Buffer.from('\u001b[31mA🙂漢字\u001b[0m');
  for (const byte of input) output.push(Buffer.from([byte]));
  await waitFor(async () => (await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' })).chunks
    .map((chunk) => chunk.data).join('').length === input.toString('utf8').length);
  const value = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(value.chunks.map((chunk) => chunk.data).join(''), input.toString('utf8'));
  assert.equal(value.loss, false);
  assert.equal(value.nextSeq > 0, true);
});

test('terminal ring reports loss and bounds retained output', async (t) => {
  const { service, subprocess } = await fixture(t, { terminalBytes: 16 });
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  subprocess.terminalHandles[0].output.push('1234567890');
  subprocess.terminalHandles[0].output.push('abcdefghij');
  await waitFor(async () => (await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' })).chunks
    .map((chunk) => chunk.data).join('').includes('567890abcdefghij'));
  const value = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(value.loss, true);
  assert.equal(value.chunks.map((chunk) => chunk.data).join(''), '567890abcdefghij');
});

test('write and resize enforce byte and dimension limits', async (t) => {
  const { service } = await fixture(t);
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  await expectCode(() => service.writeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', data: 'x'.repeat(64 * 1024 + 1) }), 'INVALID_INPUT');
  for (const [cols, rows] of [[0, 24], [1001, 24], [80, 0], [80, 501]]) {
    await expectCode(() => service.resizeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', cols, rows }), 'INVALID_INPUT');
  }
});

test('observer failures do not break notification or terminal cleanup', async (t) => {
  const { service, subprocess } = await fixture(t);
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  let called = 0;
  service.subscribeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' }, () => { throw new Error('observer'); });
  const off = service.subscribeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' }, () => { called += 1; });
  subprocess.terminalHandles[0].output.push('x');
  await waitFor(() => called > 0);
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  off();
  assert.equal(called > 0, true);
});

test('public or credentialed Web URLs fail without leaking output', async (t) => {
  for (const webUrl of [`https://example.com/?tkn=${SECRET}`, `http://127.0.0.1/?tkn=${SECRET}`, `http://user:pass@127.0.0.1:45123/?tkn=${SECRET}`]) {
    const subprocess = fakeSubprocess();
    subprocess.webUrl = webUrl;
    const { service } = await fixture(t, { subprocess });
    await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true }), 'WEB_STARTUP_FAILED');
    try {
      await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
    } catch (error) {
      assert.equal(error.message.includes(SECRET), false);
    }
  }
});

test('terminal provider failures are converted to safe errors without raw output', async (t) => {
  const { service, subprocess } = await fixture(t);
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  subprocess.terminalHandles[0].write = async () => { throw new Error(SECRET); };
  await expectCode(() => service.writeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', data: 'x' }), 'INVALID_INPUT');
  try {
    await service.writeTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', data: 'x' });
  } catch (error) {
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.cause, undefined);
  }
});

test('startup timeout terminates a late terminal handle', async (t) => {
  const subprocess = fakeSubprocess();
  subprocess.spawnTerminal = async (spec) => {
    subprocess.calls.terminal.push(spec);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const handle = terminalHandle();
    subprocess.terminalHandles.push(handle);
    return handle;
  };
  // The timeout must clear the version probe even on a loaded machine, then
  // catch the terminal handle that arrives afterwards.
  const { service, subprocess: calls } = await fixture(t, { subprocess, startupTimeoutMs: 40 });
  await expectCode(() => service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true }), 'STARTUP_TIMEOUT');
  assert.equal(calls.terminalHandles[0].terminateCalls, 1);
});

test('shared Web startup isolates waiter aborts and stops only after the last pending waiter cancels', async (t) => {
  const { subprocess, output } = pendingWebSubprocess();
  const { service } = await fixture(t, { subprocess });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true, signal: firstController.signal });
  const second = service.openWeb({ profileId: 'web', ownerId: 'owner', signal: secondController.signal });
  await waitFor(() => subprocess.webHandles.length === 1);
  firstController.abort();
  await expectCode(() => first, 'OPERATION_CANCELLED');
  assert.equal(getEventListeners(firstController.signal, 'abort').length, 0);
  assert.equal(subprocess.webHandles[0].terminateCalls, 0);
  output.push(`dsh web: ${subprocess.webUrl}\n`);
  const opened = await second;
  assert.equal(opened.runtimeId, 'runtime-1');
  secondController.abort();
  assert.equal(getEventListeners(secondController.signal, 'abort').length, 0);
  assert.equal(subprocess.webHandles[0].terminateCalls, 0);
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(subprocess.webHandles[0].terminateCalls, 1);
});

test('the last pending Web waiter aborts and cleans the shared startup', async (t) => {
  const { subprocess } = pendingWebSubprocess();
  const { service } = await fixture(t, { subprocess });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true, signal: firstController.signal });
  const second = service.openWeb({ profileId: 'web', ownerId: 'owner', signal: secondController.signal });
  await waitFor(() => subprocess.webHandles.length === 1);
  firstController.abort();
  await expectCode(() => first, 'OPERATION_CANCELLED');
  assert.equal(getEventListeners(firstController.signal, 'abort').length, 0);
  assert.equal(subprocess.webHandles[0].terminateCalls, 0);
  secondController.abort();
  await expectCode(() => second, 'OPERATION_CANCELLED');
  assert.equal(getEventListeners(secondController.signal, 'abort').length, 0);
  await waitFor(() => subprocess.webHandles[0].terminateCalls === 1);
  assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
});

test('failed Web startup reserves the profile until done and the exit check complete', async (t) => {
  const { subprocess, output, done, exitCheck, exitCheckStarted, spawned } = deferredWebSubprocess();
  const { service } = await fixture(t, { subprocess, startupTimeoutMs: 60_000 });
  const opening = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  const failed = expectCode(() => opening, 'WEB_STARTUP_FAILED');
  const handle = await spawned.promise;
  output.push('dsh web: https://example.com/\n');
  await exitCheckStarted.promise;
  assert.equal(handle.terminateCalls, 1);
  const assertReserved = async () => {
    assert.equal((await service.catalog()).runtimes[0].phase, 'stopping');
    await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner' }), 'RUNTIME_NOT_ACTIVE');
    assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
  };
  await assertReserved();
  done.resolve({ exitCode: 1, signal: null });
  await done.promise;
  await assertReserved();
  exitCheck.resolve(true);
  await failed;
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
  const reopened = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  assert.equal(reopened.runtimeId, 'runtime-2');
  assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 2);
});

test('pre-aborted Web callers and same-turn reopen preserve startup cleanup fencing', async (t) => {
  const { subprocess, done, exitCheck, exitCheckStarted, spawned } = deferredWebSubprocess();
  const { service } = await fixture(t, { subprocess, startupTimeoutMs: 60_000 });
  const controller = new AbortController();
  const opening = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true, signal: controller.signal });
  const failed = expectCode(() => opening, 'OPERATION_CANCELLED');
  const handle = await spawned.promise;
  const preAborted = new AbortController();
  preAborted.abort();
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner', signal: preAborted.signal }), 'OPERATION_CANCELLED');
  assert.equal(handle.terminateCalls, 0);
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'other-owner' }), 'PROFILE_HOST_CONFLICT');
  controller.abort();
  assert.throws(() => service.openWeb({ profileId: 'web', ownerId: 'owner' }), (error) => {
    assert.equal(error.code, 'RUNTIME_NOT_ACTIVE');
    return true;
  });
  assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
  await exitCheckStarted.promise;
  assert.equal((await service.catalog()).runtimes[0].phase, 'stopping');
  exitCheck.resolve(true);
  done.resolve({ exitCode: 0, signal: 'SIGTERM' });
  await failed;
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
});

test('a failed Web exit check stays stopping after startup settles until done', async (t) => {
  const { subprocess, output, done, exitCheck, exitCheckStarted, spawned } = deferredWebSubprocess();
  const { service } = await fixture(t, { subprocess, startupTimeoutMs: 60_000 });
  const opening = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  const failed = expectCode(() => opening, 'WEB_STARTUP_FAILED');
  await spawned.promise;
  output.push('dsh web: https://example.com/\n');
  await exitCheckStarted.promise;
  exitCheck.reject(new Error('exit check failed'));
  await failed;
  assert.equal((await service.catalog()).runtimes[0].phase, 'stopping');
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner' }), 'RUNTIME_NOT_ACTIVE');
  assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
  done.resolve({ exitCode: 1, signal: null });
  await done.promise;
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
  const reopened = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  assert.equal(reopened.runtimeId, 'runtime-2');
});

test('a stopping Web Host is not reused for a new same-owner view', async (t) => {
  const { service, subprocess } = await fixture(t);
  const opened = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  const stopping = service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner' }), 'RUNTIME_NOT_ACTIVE');
  await stopping;
  assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
});

test('completed Web survives caller abort and concurrent opens deduplicate', async (t) => {
  const { service, subprocess } = await fixture(t);
  const controller = new AbortController();
  const [first, second] = await Promise.all([
    service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true }),
    service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true }),
  ]);
  assert.equal(first.runtimeId, second.runtimeId);
  assert.equal(subprocess.calls.spawn.filter((spec) => !spec.argv.includes('--version')).length, 1);
  controller.abort();
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner', signal: controller.signal }), 'OPERATION_CANCELLED');
  assert.equal(subprocess.webHandles[0].terminateCalls, 0);
  await expectCode(() => service.openTui({ profileId: 'web', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true }), 'PROFILE_HOST_CONFLICT');
});

test('dispose terminates owned processes and preserves terminal output and exit metadata', async (t) => {
  const { service, subprocess } = await fixture(t);
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  subprocess.terminalHandles[0].output.push('final-output');
  await waitFor(async () => (await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' })).nextSeq > 0);
  await service.dispose();
  assert.equal(subprocess.terminalHandles[0].terminateCalls, 1);
  const value = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(value.chunks.map((chunk) => chunk.data).join(''), 'final-output');
  assert.equal(value.phase, 'exited');
  assert.deepEqual(value.exit, { exitCode: 0, signal: null });
  await expectCode(() => service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true }), 'SERVICE_DISPOSED');
});

test('TUI accepts a versioned manifest through a package link outside the profile', async (t) => {
  const { service, root, tui } = await fixture(t);
  const linked = path.join(tui, 'node_modules', '@deepseek-harness-tui', 'dsh-tui');
  const external = path.join(root, 'external-tui');
  await fs.rename(linked, external);
  await fs.symlink(external, linked, 'dir');
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  assert.equal(opened.runtimeId, 'runtime-1');
});

test('Web readiness drains stdout and only explicit TUI environment differences remain', async (t) => {
  const previousMarker = process.env.DSH_TUI_START_MARKER;
  const previousSecret = process.env.OTHER_RUNTIME_SECRET;
  process.env.DSH_TUI_START_MARKER = 'parent-marker';
  process.env.OTHER_RUNTIME_SECRET = SECRET;
  t.after(() => {
    if (previousMarker === undefined) delete process.env.DSH_TUI_START_MARKER;
    else process.env.DSH_TUI_START_MARKER = previousMarker;
    if (previousSecret === undefined) delete process.env.OTHER_RUNTIME_SECRET;
    else process.env.OTHER_RUNTIME_SECRET = previousSecret;
  });
  const subprocess = fakeSubprocess();
  const output = new Readable({ read() {} });
  const originalSpawn = subprocess.spawn;
  subprocess.spawn = (spec) => {
    if (spec.argv.includes('--version')) return originalSpawn(spec);
    subprocess.calls.spawn.push(spec);
    const handle = processHandle({ stdout: output });
    subprocess.webHandles.push(handle);
    return handle;
  };
  const { service } = await fixture(t, { subprocess });
  const opening = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  output.push(`${'a\n'.repeat(40_000)}dsh web: ${subprocess.webUrl}\n`);
  await opening;
  assert.equal(output.destroyed, false);
  output.push('later-output\n');
  output.push(null);
  const spec = subprocess.calls.spawn.find((item) => !item.argv.includes('--version'));
  assert.equal(spec.env.DSH_TUI_START_MARKER, undefined);
  assert.equal('OTHER_RUNTIME_SECRET' in spec.env, false);
});

test('post-readiness long lines are drained without destroying stdout', async (t) => {
  const subprocess = fakeSubprocess();
  const output = new Readable({ read() {} });
  const originalSpawn = subprocess.spawn;
  subprocess.spawn = (spec) => {
    if (spec.argv.includes('--version')) return originalSpawn(spec);
    subprocess.calls.spawn.push(spec);
    const handle = processHandle({ stdout: output });
    subprocess.webHandles.push(handle);
    return handle;
  };
  const { service } = await fixture(t, { subprocess });
  const opening = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  output.push(`dsh web: ${subprocess.webUrl}\n`);
  const opened = await opening;
  output.push(`${'x'.repeat(128 * 1024)}\n`);
  output.push('later\n');
  assert.equal(output.destroyed, false);
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(subprocess.webHandles[0].terminateCalls, 1);
});

test('a readiness chunk with a long tail is drained without destroying stdout', async (t) => {
  const subprocess = fakeSubprocess();
  const output = new Readable({ read() {} });
  const originalSpawn = subprocess.spawn;
  subprocess.spawn = (spec) => {
    if (spec.argv.includes('--version')) return originalSpawn(spec);
    subprocess.calls.spawn.push(spec);
    const handle = processHandle({ stdout: output });
    subprocess.webHandles.push(handle);
    return handle;
  };
  const { service } = await fixture(t, { subprocess });
  const opening = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  output.push(`dsh web: ${subprocess.webUrl}\n${'y'.repeat(128 * 1024)}`);
  const opened = await opening;
  output.push('after-tail\n');
  assert.equal(output.destroyed, false);
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(subprocess.webHandles[0].terminateCalls, 1);
});

test('catalog skips invalid candidates and exposes owner-scoped stop permission', async (t) => {
  const { service, root, profiles, cwd } = await fixture(t);
  await fs.mkdir(path.join(profiles, 'invalid'));
  const outside = path.join(root, 'outside');
  await writeJson(path.join(outside, 'package.json'), { name: 'outside', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  await fs.symlink(outside, path.join(profiles, 'alias'), 'dir');
  const listed = await service.catalog();
  assert.equal(listed.defaultCwd, cwd);
  assert.equal(listed.profiles.some((profile) => profile.id === 'web'), true);
  assert.equal(listed.profiles.some((profile) => profile.id === 'invalid'), false);
  assert.equal(listed.profiles.some((profile) => profile.id === 'alias'), false);
  assert.equal(listed.warnings.length >= 1, true);
  const opened = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  const owned = await service.catalog({ ownerId: 'owner' });
  const other = await service.catalog({ ownerId: 'other' });
  assert.equal(owned.runtimes[0].canStop, true);
  assert.equal(other.runtimes[0].canStop, false);
  assert.equal(JSON.stringify(owned).includes('ownerId'), false);
  assert.equal(JSON.stringify(owned).includes('url'), false);
});

test('immediate TUI exit drains final output before exposing exited state', async (t) => {
  const subprocess = fakeSubprocess();
  subprocess.spawnTerminal = async (spec) => {
    subprocess.calls.terminal.push(spec);
    const handle = terminalHandle();
    const done = deferred();
    handle.done = done.promise;
    subprocess.terminalHandles.push(handle);
    queueMicrotask(() => {
      handle.output.push('last-chunk');
      handle.output.push(null);
      done.resolve({ exitCode: 0, signal: null });
    });
    return handle;
  };
  const { service } = await fixture(t, { subprocess });
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  await waitFor(async () => (await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' })).phase === 'exited');
  const value = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(value.chunks.map((chunk) => chunk.data).join(''), 'last-chunk');
  assert.equal(value.phase, 'exited');
});

test('dispose returns the same completion promise for every caller', async (t) => {
  const { service } = await fixture(t);
  await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  const first = service.dispose();
  const second = service.dispose();
  assert.equal(first, second);
  await Promise.all([first, second]);
});

test('one caller cancellation does not cancel the shared version probe', async (t) => {
  const { service, subprocess, profiles } = await fixture(t);
  await writeJson(path.join(profiles, 'web-two', 'package.json'), { name: 'web-two', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  const gate = deferred();
  subprocess.resolveExecutable = async () => gate.promise;
  const first = new AbortController();
  const openingA = service.openWeb({ profileId: 'web', ownerId: 'a', confirmIndependentHost: true, signal: first.signal });
  const openingB = service.openWeb({ profileId: 'web-two', ownerId: 'b', confirmIndependentHost: true });
  first.abort();
  await expectCode(() => openingA, 'OPERATION_CANCELLED');
  gate.resolve('/usr/local/bin/dsh');
  await openingB;
});

test('small UTF-8 rings retain valid tails without permanent loss on later reads', async (t) => {
  const { service, subprocess } = await fixture(t, { terminalBytes: 24 });
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  subprocess.terminalHandles[0].output.push('abc🙂defghijklmnopqrstuvwxyz');
  await waitFor(async () => (await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' })).nextSeq > 0);
  const first = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(first.loss, true);
  assert.equal(Buffer.byteLength(first.chunks.map((chunk) => chunk.data).join(''), 'utf8') <= 24, true);
  const cursor = first.nextSeq;
  subprocess.terminalHandles[0].output.push('Z');
  await waitFor(async () => (await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' })).nextSeq > cursor);
  const next = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', afterSeq: cursor });
  assert.equal(next.loss, false);
  assert.equal(next.chunks.map((chunk) => chunk.data).join(''), 'Z');
});

test('a continuous cursor without truncation does not report loss', async (t) => {
  const { service, subprocess } = await fixture(t);
  const opened = await service.openTui({ profileId: 'tui', ownerId: 'owner', cwd: '/tmp', cols: 80, rows: 24, confirmIndependentHost: true });
  subprocess.terminalHandles[0].output.push('abc');
  await waitFor(async () => (await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' })).nextSeq > 0);
  const current = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  const previous = await service.readTerminal({ runtimeId: opened.runtimeId, ownerId: 'owner', afterSeq: current.firstSeq - 1 });
  assert.equal(previous.loss, false);
});

test('runtime id collisions fail without replacing the existing record', async (t) => {
  const { service, profiles } = await fixture(t, { idFactory: () => 'same-id' });
  await writeJson(path.join(profiles, 'web-two', 'package.json'), { name: 'web-two', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  const first = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  await expectCode(() => service.openWeb({ profileId: 'web-two', ownerId: 'owner', confirmIndependentHost: true }), 'RUNTIME_ID_CONFLICT');
  assert.equal((await service.catalog()).runtimes[0].id, first.runtimeId);
});

test('active runtime count is bounded', async (t) => {
  const { service, profiles } = await fixture(t);
  for (let index = 0; index < 17; index += 1) {
    await writeJson(path.join(profiles, `web-${index}`, 'package.json'), { name: `web-${index}`, dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  }
  for (let index = 0; index < 16; index += 1) {
    await service.openWeb({ profileId: `web-${index}`, ownerId: 'owner', confirmIndependentHost: true });
  }
  await expectCode(() => service.openWeb({ profileId: 'web-16', ownerId: 'owner', confirmIndependentHost: true }), 'RUNTIME_LIMIT_REACHED');
});

function fakeUpgrades({ latestDshVersion = '0.2.2-rc.1', alignPending = null, dshUpgradeAllowed = true, failCheck = false } = {}) {
  const calls = [];
  const states = new Map();
  return {
    calls,
    states,
    async check(input) {
      calls.push({ method: 'check', input });
      if (failCheck) throw Object.assign(new Error('private registry failure'), { code: 'UPGRADE_PROFILE_UNAVAILABLE', safe: true });
      return { latestDshVersion, alignPending, dshUpgradeAllowed };
    },
    start(input) {
      calls.push({ method: 'start', input });
      const key = input.runtimeId ? `runtime:${input.runtimeId}` : `current:${input.profileId}`;
      if (states.has(key)) throw Object.assign(new Error('private busy detail'), { code: 'UPGRADE_BUSY', safe: true });
      states.set(key, { phase: 'running', step: 'backup' });
      return { started: true, upgrade: { phase: 'running', step: 'backup' } };
    },
    state({ profileId, runtimeId }) {
      return states.get(runtimeId ? `runtime:${runtimeId}` : `current:${profileId}`) ?? null;
    },
  };
}

test('catalog exposes the current Host version and probes upgrades once per version', async (t) => {
  const upgrades = fakeUpgrades();
  const { service } = await fixture(t, { currentDshVersion: '0.2.1-rc.5', upgrades });
  const first = await service.catalog();
  assert.equal(first.currentHost.current, true);
  assert.equal(first.currentHost.profileId, 'current');
  assert.equal(first.currentHost.dshVersion, '0.2.1-rc.5');
  assert.equal(first.currentHost.checking, true);
  assert.equal(first.currentHost.upgradeAvailable, false, 'no button while the probe is pending');
  await waitFor(async () => (await service.catalog()).currentHost.checking === false);
  const ready = await service.catalog();
  assert.equal(ready.currentHost.latestDshVersion, '0.2.2-rc.1');
  assert.equal(ready.currentHost.upgradeAvailable, true);
  assert.equal(upgrades.calls.filter((call) => call.method === 'check' && call.input.profileId === 'current').length, 1, 'the version probe is cached');

  const started = await service.upgrade({ ownerId: 'owner' });
  assert.deepEqual(started, { started: true, upgrade: { phase: 'running', step: 'backup' } });
  const start = upgrades.calls.find((call) => call.method === 'start');
  assert.equal(start.input.profileId, 'current');
  assert.equal(start.input.runtimeId, null);
  assert.equal(start.input.dshVersion, '0.2.1-rc.5');
  assert.equal(start.input.stopHost, null);
  assert.deepEqual((await service.catalog()).currentHost.upgrade, { phase: 'running', step: 'backup' });
  await expectCode(() => service.upgrade({ ownerId: 'bad owner' }), 'INVALID_INPUT');
});

test('a failed version probe hides the button without failing the catalog', async (t) => {
  const upgrades = fakeUpgrades({ failCheck: true });
  const { service } = await fixture(t, { currentDshVersion: '0.2.1-rc.5', upgrades });
  await waitFor(async () => (await service.catalog()).currentHost.checking === false);
  const value = await service.catalog();
  assert.equal(value.currentHost.upgradeAvailable, false);
  assert.equal(JSON.stringify(value).includes('private registry failure'), false);
});

test('upgrade targets a managed Web runtime with its recorded version and stop callback', async (t) => {
  const upgrades = fakeUpgrades({ latestDshVersion: null, alignPending: false });
  const { service } = await fixture(t, { upgrades });
  const opened = await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  const catalog = await service.catalog();
  assert.equal(catalog.runtimes[0].dshVersion, VERSION);
  await waitFor(async () => (await service.catalog()).runtimes[0].checking === false);
  assert.equal((await service.catalog()).runtimes[0].upgradeAvailable, false, 'no newer version means no button');
  await expectCode(() => service.upgrade({ runtimeId: opened.runtimeId, ownerId: 'other-owner' }), 'RUNTIME_OWNER_MISMATCH');
  const started = await service.upgrade({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal(started.started, true);
  const start = upgrades.calls.find((call) => call.method === 'start');
  assert.equal(start.input.profileId, 'web');
  assert.equal(start.input.runtimeId, opened.runtimeId);
  assert.equal(start.input.dshVersion, VERSION);
  assert.equal(typeof start.input.stopHost, 'function');
  await expectCode(() => service.upgrade({ runtimeId: opened.runtimeId, ownerId: 'owner' }), 'UPGRADE_BUSY');
  assert.deepEqual((await service.catalog()).runtimes[0].upgrade, { phase: 'running', step: 'backup' });
  await start.input.stopHost();
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
});

test('upgrade is unavailable when no upgrade service is configured', async (t) => {
  const { service } = await fixture(t);
  await expectCode(() => service.upgrade({ ownerId: 'owner' }), 'UPGRADE_RUNTIME_UNAVAILABLE');
  const value = await service.catalog();
  assert.equal(value.currentHost.current, true, 'the version row still renders');
  assert.equal(value.currentHost.dshVersion, null);
  assert.equal(value.currentHost.upgradeAvailable, false);
});

test('desktop alignment alone offers the sync action on the web row', async (t) => {
  const upgrades = fakeUpgrades({ latestDshVersion: '0.2.1-rc.5', alignPending: true });
  const { service } = await fixture(t, { upgrades });
  await service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  await waitFor(async () => (await service.catalog()).runtimes[0].checking === false);
  const value = await service.catalog();
  assert.equal(value.runtimes[0].alignPending, true);
  assert.equal(value.runtimes[0].latestDshVersion, '0.2.1-rc.5');
  assert.equal(value.runtimes[0].upgradeAvailable, true, 'alignment alone shows the button');
});

test('a Desktop app CLI never offers the DSH upgrade action', async (t) => {
  const upgrades = fakeUpgrades({ dshUpgradeAllowed: false, alignPending: false });
  const { service } = await fixture(t, { upgrades, currentDshVersion: '0.2.1-rc.5' });
  await waitFor(async () => (await service.catalog()).currentHost.checking === false);
  const value = await service.catalog();
  assert.equal(value.currentHost.latestDshVersion, '0.2.2-rc.1');
  assert.equal(value.currentHost.upgradeAvailable, false, 'a newer npm release does not apply to the app CLI');
  const aligned = fakeUpgrades({ dshUpgradeAllowed: false, alignPending: true });
  const second = await fixture(t, { upgrades: aligned });
  await second.service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  await waitFor(async () => (await second.service.catalog()).runtimes[0].checking === false);
  assert.equal((await second.service.catalog()).runtimes[0].upgradeAvailable, true, 'plugin alignment stays available');
});

test('a stopped Web profile is listed with its alignment state and upgrades without a Host', async (t) => {
  const upgrades = fakeUpgrades({ latestDshVersion: VERSION, alignPending: true });
  const { service } = await fixture(t, { currentDshVersion: VERSION, upgrades });
  await waitFor(async () => {
    const catalog = await service.catalog();
    const row = catalog.runtimes.find((item) => item.profileId === 'web' && item.phase === 'stopped');
    return Boolean(row) && row.checking === false;
  });
  const catalog = await service.catalog();
  const row = catalog.runtimes.find((item) => item.profileId === 'web' && item.phase === 'stopped');
  assert.equal(row.id, 'profile:web');
  assert.equal(row.canStop, false);
  assert.equal(row.dshVersion, VERSION);
  assert.equal(row.alignPending, true);
  assert.equal(row.upgradeAvailable, true, 'a pending desktop alignment offers the sync action');

  const started = await service.upgrade({ ownerId: 'owner', profileId: 'web' });
  assert.deepEqual(started, { started: true, upgrade: { phase: 'running', step: 'backup' } });
  const start = upgrades.calls.find((call) => call.method === 'start');
  assert.equal(start.input.profileId, 'web');
  assert.equal(start.input.runtimeId, null);
  assert.equal(start.input.dshVersion, VERSION);
  assert.equal(start.input.stopHost, null, 'a stopped profile has no Host to stop');

  await expectCode(() => service.upgrade({ ownerId: 'owner', profileId: 'tui' }), 'PROFILE_NOT_FOUND');
  await expectCode(() => service.upgrade({ ownerId: 'owner', profileId: '../web' }), 'PROFILE_NOT_FOUND');
});
