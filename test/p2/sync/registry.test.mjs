import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareVersions, createLatestVersionCache, fetchLatestVersion, isNewerVersion,
} from '../../../packages/shell/src/host/registry.js';

test('compareVersions follows semver precedence including prerelease and build metadata', () => {
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2'), -1);
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.1'), 1);
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.2'), -1);
  assert.equal(compareVersions('0.2.2-rc.2', '0.2.2-rc.1'), 1);
  assert.equal(compareVersions('0.2.2-rc.10', '0.2.2-rc.9'), 1, 'numeric identifiers compare numerically');
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.1+build.9'), 0, 'build metadata is ignored');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1, 'a shorter prerelease ranks lower');
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1, 'numeric ranks below alphanumeric');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0, 'a leading v is tolerated');
  assert.equal(compareVersions('not-a-version', 'not-a-version'), 0);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

test('isNewerVersion only answers true for two known versions', () => {
  assert.equal(isNewerVersion('0.2.2', '0.2.2-rc.1'), true);
  assert.equal(isNewerVersion('0.2.2-rc.1', '0.2.2'), false);
  assert.equal(isNewerVersion('0.2.2', '0.2.2'), false);
  assert.equal(isNewerVersion('0.2.2', null), false);
  assert.equal(isNewerVersion(null, '0.2.1'), false);
  assert.equal(isNewerVersion('garbage', '0.2.1'), false);
});

function jsonResponse(value, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return value; } };
}

test('fetchLatestVersion asks the npm registry for dist-tags.latest', async () => {
  const calls = [];
  const latest = await fetchLatestVersion('@deepseek-ai/dsh', {
    timeoutMs: 250,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ 'dist-tags': { latest: '0.2.2-rc.2' } });
    },
  });
  assert.equal(latest, '0.2.2-rc.2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://registry.npmjs.org/%40deepseek-ai%2Fdsh');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(typeof calls[0].options.signal, 'object');
});

test('fetchLatestVersion returns null on every failure shape', async () => {
  const cases = [
    async () => { throw new Error('offline token=secret'); },
    async () => jsonResponse({ error: 'not found' }, { ok: false, status: 404 }),
    async () => jsonResponse({}),
    async () => jsonResponse({ 'dist-tags': { latest: 42 } }),
    async () => ({ ok: true, async json() { throw new Error('bad json'); } }),
  ];
  for (const fake of cases) {
    assert.equal(await fetchLatestVersion('dsh-context', { fetch: fake, timeoutMs: 200 }), null);
  }
  assert.equal(await fetchLatestVersion('bad name with spaces', { fetch: async () => jsonResponse({}) }), null);
  assert.equal(await fetchLatestVersion('x', { fetch: 'not a function' }), null);
});

test('fetchLatestVersion aborts and returns null after the timeout', async () => {
  let observedSignal;
  const started = Date.now();
  const latest = await fetchLatestVersion('dsh-context', {
    timeoutMs: 30,
    fetch: (url, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  assert.equal(latest, null);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - started < 1_000);
});

test('fetchLatestVersion honors a caller abort signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const latest = await fetchLatestVersion('dsh-context', {
    timeoutMs: 500,
    signal: controller.signal,
    fetch: () => { called = true; return Promise.resolve(jsonResponse({ 'dist-tags': { latest: '1.0.0' } })); },
  });
  assert.equal(latest, null);
  assert.equal(called, false, 'an already-aborted caller never starts a request');
});

test('createLatestVersionCache reuses results within the TTL and refetches after it', async () => {
  let now = 1_000;
  let requests = 0;
  const cache = createLatestVersionCache({
    now: () => now,
    ttlMs: 10_000,
    fetch: async () => { requests += 1; return jsonResponse({ 'dist-tags': { latest: `1.0.${requests}` } }); },
  });
  assert.equal(await cache.latest('dsh-context'), '1.0.1');
  assert.equal(await cache.latest('dsh-context'), '1.0.1');
  assert.equal(requests, 1);
  now += 9_999;
  assert.equal(await cache.latest('dsh-context'), '1.0.1');
  assert.equal(requests, 1);
  now += 1;
  assert.equal(await cache.latest('dsh-context'), '1.0.2');
  assert.equal(requests, 2);
});

test('createLatestVersionCache shares one in-flight request and caches null', async () => {
  let resolveRequest;
  let requests = 0;
  const cache = createLatestVersionCache({
    fetch: () => {
      requests += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  });
  const first = cache.latest('dsh-context');
  const second = cache.latest('dsh-context');
  resolveRequest(jsonResponse({ 'dist-tags': { latest: '2.0.0' } }));
  assert.deepEqual(await Promise.all([first, second]), ['2.0.0', '2.0.0']);
  assert.equal(requests, 1);

  const failing = createLatestVersionCache({ fetch: async () => { requests += 1; throw new Error('offline'); } });
  assert.equal(await failing.latest('dsh-context'), null);
  assert.equal(await failing.latest('dsh-context'), null);
  assert.equal(requests, 2, 'a null result is cached for the TTL');
});

test('clear drops cached versions and pending requests', async () => {
  let now = 0;
  let requests = 0;
  const cache = createLatestVersionCache({ now: () => now, fetch: async () => { requests += 1; return jsonResponse({ 'dist-tags': { latest: '1.0.0' } }); } });
  await cache.latest('dsh-context');
  cache.clear();
  await cache.latest('dsh-context');
  assert.equal(requests, 2);
  assert.throws(() => createLatestVersionCache({ ttlMs: -1 }), /ttlMs/u);
  assert.throws(() => createLatestVersionCache({ now: 5 }), /now/u);
});
