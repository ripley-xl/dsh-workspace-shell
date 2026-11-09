import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareVersions,
  createLatestVersionCache,
  fetchLatestVersion,
  isNewerVersion,
} from '../../../packages/manager/src/host/registry.js';

test('compareVersions follows SemVer, including prerelease precedence', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2'), -1);
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.1'), 1);
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.2'), -1);
  assert.equal(compareVersions('0.2.2-rc.2', '0.2.2-rc.10'), -1);
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.1'), 0);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha'), 1);
  // Build metadata is ignored.
  assert.equal(compareVersions('1.0.0+build.9', '1.0.0+build.1'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.throws(() => compareVersions('nope', '1.0.0'), TypeError);
  assert.throws(() => compareVersions('1.0', '1.0.0'), TypeError);
});

test('isNewerVersion only answers true for a strictly newer valid version', () => {
  assert.equal(isNewerVersion('2.0.0', '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', '2.0.0'), false);
  assert.equal(isNewerVersion('0.2.2', '0.2.2-rc.1'), true);
  assert.equal(isNewerVersion('0.2.2-rc.1', '0.2.2-rc.2'), false);
  assert.equal(isNewerVersion('not-a-version', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', undefined), false);
  assert.equal(isNewerVersion(null, '1.0.0'), false);
});

test('fetchLatestVersion reads dist-tags.latest from the npm registry', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ 'dist-tags': { latest: '1.2.3' } });
  };
  const version = await fetchLatestVersion('@deepseek-ai/dsh', { fetch });
  assert.equal(version, '1.2.3');
  assert.equal(calls.length, 1);
  // The package name is URL-encoded exactly once as a path segment.
  assert.equal(calls[0].url, 'https://registry.npmjs.org/%40deepseek-ai%2Fdsh');
  assert.equal(calls[0].options.headers.accept, 'application/json');
});

test('fetchLatestVersion turns every failure into null', async () => {
  const failures = [
    async () => { throw new Error('socket closed'); },
    async () => ({ ok: false, status: 404, async json() { return {}; } }),
    async () => Response.json({ 'dist-tags': {} }),
    async () => Response.json({ 'dist-tags': { latest: 'not-semver' } }),
    async () => ({ ok: true, async json() { throw new Error('truncated body'); } }),
  ];
  for (const fetch of failures) {
    assert.equal(await fetchLatestVersion('example', { fetch }), null);
  }
  assert.equal(await fetchLatestVersion('', { fetch: async () => Response.json({}) }), null);
  assert.equal(await fetchLatestVersion('example', { fetch: null }), null);
  // An already-aborted signal never reaches the network.
  const controller = new AbortController();
  controller.abort();
  let called = false;
  assert.equal(await fetchLatestVersion('example', {
    fetch: async () => { called = true; return Response.json({}); },
    signal: controller.signal,
  }), null);
  assert.equal(called, false);
});

test('fetchLatestVersion resolves null instead of hanging when the request times out', async () => {
  const fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  assert.equal(await fetchLatestVersion('example', { fetch, timeoutMs: 5 }), null);
});

test('createLatestVersionCache caches hits, shares in-flight lookups and clears', async () => {
  let requests = 0;
  let clock = 1_000;
  const fetch = async () => {
    requests += 1;
    return Response.json({ 'dist-tags': { latest: '3.0.0' } });
  };
  const cache = createLatestVersionCache({ fetch, ttlMs: 100, now: () => clock });
  assert.equal(await cache.latest('pkg'), '3.0.0');
  assert.equal(await cache.latest('pkg'), '3.0.0');
  assert.equal(requests, 1);
  clock += 99;
  assert.equal(await cache.latest('pkg'), '3.0.0');
  assert.equal(requests, 1);
  clock += 2;
  assert.equal(await cache.latest('pkg'), '3.0.0');
  assert.equal(requests, 2);

  const [first, second] = await Promise.all([cache.latest('other'), cache.latest('other')]);
  assert.equal(first, '3.0.0');
  assert.equal(second, '3.0.0');
  assert.equal(requests, 3);

  cache.clear();
  assert.equal(await cache.latest('pkg'), '3.0.0');
  assert.equal(requests, 4);
});
