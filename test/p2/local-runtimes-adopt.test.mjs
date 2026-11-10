import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createLocalRuntimeService } from '../../packages/shell/src/host/local-runtimes.js';

const VERSION = '0.2.1-rc.5';
const TEMP_PREFIX = path.join(os.tmpdir(), 'dsh-local-runtimes-adopt-');
const FIRST_URL = 'http://127.0.0.1:45123/?tkn=first-token';
const NEXT_URL = 'http://127.0.0.1:46001/?tkn=second-token';
const DISCOVERED_URL = 'http://127.0.0.1:47002/?tkn=discovered-token';
const FIRST_PID = 43_210;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeSubprocess() {
  const calls = { resolve: [], spawn: [], terminal: [] };
  const done = deferred();
  const output = new Readable({ read() {} });
  const state = {
    calls,
    done,
    output,
    webHandles: [],
    version: VERSION,
    webUrl: FIRST_URL,
    async resolveExecutable(command) {
      calls.resolve.push(command);
      return '/usr/local/bin/dsh';
    },
    spawn(spec) {
      calls.spawn.push(spec);
      if (spec.argv.includes('--version')) {
        const probeDone = deferred();
        const handle = {
          stdout: Readable.from([`${state.version}\n`]),
          stderr: Readable.from([]),
          done: probeDone.promise,
          terminate() { probeDone.resolve({ exitCode: 0, signal: null }); },
        };
        queueMicrotask(() => handle.terminate());
        return handle;
      }
      const handle = {
        pid: FIRST_PID,
        stdout: output,
        stderr: Readable.from([]),
        done: done.promise,
        terminateCalls: 0,
        terminate() {
          handle.terminateCalls += 1;
          output.push(null);
          done.resolve({ exitCode: 0, signal: null });
        },
        async waitForExit() {
          await done.promise;
          return true;
        },
      };
      state.webHandles.push(handle);
      return handle;
    },
  };
  return state;
}

function fakeDiscovery() {
  const state = {
    cards: [],
    calls: 0,
    async listHostCards({ home }) {
      state.calls += 1;
      assert.equal(typeof home, 'string');
      return { hosts: state.cards.map((card) => ({ ...card })), skipped: [] };
    },
  };
  return state;
}

function hostCard(overrides = {}) {
  const now = new Date().toISOString();
  return {
    instanceId: 'b'.repeat(32),
    hostKey: 'runtime-1',
    profile: 'web',
    profileId: 'web',
    pid: 51_234,
    port: 46_001,
    url: NEXT_URL,
    supervised: false,
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
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
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd, { recursive: true });
  await writeJson(path.join(current, 'package.json'), { name: 'current', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  await writeJson(path.join(web, 'package.json'), { name: 'web', dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } });
  const subprocess = options.subprocess ?? fakeSubprocess();
  const discovery = options.hostDiscovery ?? fakeDiscovery();
  let nextId = 0;
  const service = createLocalRuntimeService({
    subprocess,
    profileContext: { name: 'current', dir: current, home, cwd },
    hostDiscovery: discovery,
    restartPollMs: options.restartPollMs ?? 5,
    restartWaitMs: options.restartWaitMs ?? 500,
    startupTimeoutMs: 2_000,
    graceMs: 5,
    idFactory: () => `runtime-${++nextId}`,
  });
  t.after(async () => {
    await service.dispose().catch(() => {});
    assert.equal(root.startsWith(TEMP_PREFIX), true);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, home, profiles, current, web, cwd, subprocess, discovery, service };
}

async function openWeb(service, subprocess) {
  const opening = service.openWeb({ profileId: 'web', ownerId: 'owner', confirmIndependentHost: true });
  subprocess.output.push(`dsh web: ${subprocess.webUrl}\n`);
  return opening;
}

async function expectCode(action, code) {
  await assert.rejects(Promise.resolve().then(action), (error) => {
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    return true;
  });
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

test('a spawned Web Host carries its record id as the host key', async (t) => {
  const { service, subprocess, home } = await fixture(t);
  const opened = await openWeb(service, subprocess);
  assert.equal(opened.runtimeId, 'runtime-1');
  assert.equal(opened.url, FIRST_URL);
  const spec = subprocess.calls.spawn.find((item) => !item.argv.includes('--version'));
  assert.equal(spec.env.DSH_WORKSPACE_HOST_KEY, opened.runtimeId);
  assert.equal(spec.env.DSH_HOME, home);
  // The existing environment cleanup is unchanged.
  assert.equal(spec.env.DSH_TUI_BACKEND, undefined);
  assert.equal(spec.env.DSH_TUI_WORKSPACE_TARGET, undefined);
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
});

test('a Web Host that exits on its own is adopted from a replacement card', async (t) => {
  const { service, subprocess, discovery } = await fixture(t);
  const opened = await openWeb(service, subprocess);
  subprocess.done.resolve({ exitCode: 0, signal: null });
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'restarting', 'restarting');
  // No replacement card yet: the record keeps waiting.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await service.catalog()).runtimes[0].phase, 'restarting');
  discovery.cards.push(hostCard());
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'running', 'running');
  assert.equal(discovery.calls >= 2, true);
  assert.deepEqual(await service.attachWeb({ runtimeId: opened.runtimeId, ownerId: 'owner' }), {
    runtimeId: 'runtime-1',
    url: NEXT_URL,
  });
  const row = (await service.catalog({ ownerId: 'owner' })).runtimes.find((item) => item.id === 'runtime-1');
  assert.equal(row.phase, 'running');
  assert.equal(row.exit, undefined);
  // Reopening the same profile answers with the replacement URL.
  assert.deepEqual(await service.openWeb({ profileId: 'web', ownerId: 'owner' }), {
    runtimeId: 'runtime-1',
    url: NEXT_URL,
  });
  // The adopted card belongs to the record, so it is not a discovered row.
  assert.equal((await service.catalog()).runtimes.some((item) => item.source === 'discovered'), false);
  await expectCode(() => service.attachWeb({ runtimeId: opened.runtimeId, ownerId: 'other-owner' }), 'RUNTIME_OWNER_MISMATCH');
});

test('an adopted Host that restarts again is re-read from its card before attach', async (t) => {
  const { service, subprocess, discovery } = await fixture(t);
  const opened = await openWeb(service, subprocess);
  subprocess.done.resolve({ exitCode: 0, signal: null });
  discovery.cards.push(hostCard());
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'running', 'running');
  assert.equal((await service.attachWeb({ runtimeId: opened.runtimeId, ownerId: 'owner' })).url, NEXT_URL);
  // The adopted Host restarts a second time; nothing tells the Shell directly.
  const third = 'http://127.0.0.1:47010/?tkn=third-token';
  discovery.cards.splice(0, discovery.cards.length, hostCard({ pid: 52_345, port: 47_010, url: third }));
  assert.deepEqual(await service.attachWeb({ runtimeId: opened.runtimeId, ownerId: 'owner' }), {
    runtimeId: 'runtime-1',
    url: third,
  });
  const row = (await service.catalog({ ownerId: 'owner' })).runtimes.find((item) => item.id === 'runtime-1');
  assert.equal(row.phase, 'running');
  // The adopted record keeps the card, so it never turns into a discovered row.
  assert.equal((await service.catalog()).runtimes.some((item) => item.source === 'discovered'), false);
});

test('a Web Host without a replacement card settles on exited after the wait', async (t) => {
  const { service, subprocess } = await fixture(t, { restartWaitMs: 40, restartPollMs: 5 });
  const opened = await openWeb(service, subprocess);
  subprocess.done.resolve({ exitCode: 0, signal: null });
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'restarting', 'restarting');
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'exited', 'exited');
  const row = (await service.catalog()).runtimes[0];
  assert.deepEqual(row.exit, { exitCode: 0, signal: null });
  await expectCode(() => service.attachWeb({ runtimeId: opened.runtimeId, ownerId: 'owner' }), 'RUNTIME_NOT_ACTIVE');
});

test('a card carrying the old pid is not a replacement', async (t) => {
  const { service, subprocess, discovery } = await fixture(t, { restartWaitMs: 40, restartPollMs: 5 });
  await openWeb(service, subprocess);
  discovery.cards.push(hostCard({ pid: FIRST_PID }));
  subprocess.done.resolve({ exitCode: 0, signal: null });
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'exited', 'exited');
});

test('dispose cancels the restart wait without signalling the dead Host', async (t) => {
  const { service, subprocess } = await fixture(t, { restartWaitMs: 60_000, restartPollMs: 10 });
  await openWeb(service, subprocess);
  subprocess.done.resolve({ exitCode: 0, signal: null });
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'restarting', 'restarting');
  const started = Date.now();
  await service.dispose();
  assert.equal(Date.now() - started < 2_000, true);
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
  assert.equal(subprocess.webHandles[0].terminateCalls, 0);
});

test('stopping a restarting Host cancels the wait and ends the record', async (t) => {
  const { service, subprocess } = await fixture(t, { restartWaitMs: 60_000, restartPollMs: 10 });
  const opened = await openWeb(service, subprocess);
  subprocess.done.resolve({ exitCode: 0, signal: null });
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'restarting', 'restarting');
  await service.stop({ runtimeId: opened.runtimeId, ownerId: 'owner' });
  assert.equal((await service.catalog()).runtimes[0].phase, 'exited');
  assert.equal(subprocess.webHandles[0].terminateCalls, 0);
});

test('catalog lists discovered Hosts and attachDiscovered opens their card', async (t) => {
  const { service, subprocess, discovery } = await fixture(t);
  const opened = await openWeb(service, subprocess);
  const ownedCard = 'd'.repeat(32);
  const externalCard = 'e'.repeat(32);
  discovery.cards.push(
    hostCard({ instanceId: ownedCard, hostKey: opened.runtimeId }),
    // A stray Desktop card (an older build mounted the Guest there by mistake)
    // must never become a manageable row.
    hostCard({ instanceId: 'a'.repeat(32), hostKey: 'profile:desktop', profile: 'desktop', profileId: 'desktop', pid: 62_222, port: 47_003 }),
    hostCard({
      instanceId: externalCard,
      hostKey: 'profile:standalone',
      pid: 61_111,
      port: 47_002,
      url: DISCOVERED_URL,
    }),
  );
  const rows = (await service.catalog({ ownerId: 'owner' })).runtimes;
  assert.equal(rows.some((row) => row.id === `host:${ownedCard}`), false, 'an owned card is not a second row');
  const discovered = rows.filter((row) => row.source === 'discovered');
  assert.deepEqual(discovered, [{
    id: `host:${externalCard}`,
    kind: 'web',
    profileId: 'web',
    source: 'discovered',
    phase: 'running',
    owned: false,
    canStop: false,
    attachable: true,
  }]);
  assert.equal(JSON.stringify(discovered).includes('url'), false);
  assert.equal(JSON.stringify(discovered).includes('discovered-token'), false);
  assert.deepEqual(await service.attachDiscovered({ instanceId: externalCard, ownerId: 'owner' }), {
    runtimeId: `host:${externalCard}`,
    url: DISCOVERED_URL,
  });
  await expectCode(() => service.attachDiscovered({ instanceId: externalCard, ownerId: 'bad owner' }), 'INVALID_INPUT');
  await expectCode(() => service.attachDiscovered({ instanceId: 'not-an-instance', ownerId: 'owner' }), 'INVALID_INPUT');
  await expectCode(() => service.attachDiscovered({ instanceId: 'f'.repeat(32), ownerId: 'owner' }), 'RUNTIME_NOT_FOUND');
  // Discovered Hosts are never stoppable or upgradable through owned records.
  await expectCode(() => service.stop({ runtimeId: `host:${externalCard}`, ownerId: 'owner' }), 'RUNTIME_NOT_FOUND');
  await expectCode(() => service.upgrade({ runtimeId: `host:${externalCard}`, ownerId: 'owner' }), 'UPGRADE_RUNTIME_UNAVAILABLE');
  await service.dispose();
  assert.equal(subprocess.webHandles.length, 1, 'only the Shell-spawned Host has a handle');
  assert.equal(subprocess.webHandles[0].terminateCalls, 1, 'dispose stops the owned Host, never the discovered one');
  const after = (await service.catalog()).runtimes;
  assert.equal(after.find((row) => row.id === 'runtime-1').phase, 'exited');
  // The discovered Host is still live and listed; dispose did not touch it.
  assert.equal(after.some((row) => row.id === `host:${externalCard}`), true);
});

test('restart polling keeps running when discovery fails or returns junk', async (t) => {
  const discovery = {
    calls: 0,
    async listHostCards() {
      discovery.calls += 1;
      if (discovery.calls === 1) throw new Error('private discovery failure');
      return { hosts: [null, { hostKey: 'runtime-1' }], skipped: [] };
    },
  };
  const { service, subprocess } = await fixture(t, { hostDiscovery: discovery, restartWaitMs: 40, restartPollMs: 5 });
  await openWeb(service, subprocess);
  subprocess.done.resolve({ exitCode: 0, signal: null });
  await waitFor(async () => (await service.catalog()).runtimes[0].phase === 'exited', 'exited');
  assert.equal(discovery.calls >= 2, true);
});
