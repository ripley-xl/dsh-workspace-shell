import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendRemotePatch, missingPatchEntries, parsePatchEntries, planPatchSync, readLocalProfilePatch,
} from '../../../packages/manager/src/host/remote-config.js';

const LOCAL = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: dsh-opencode-go
- id: workspace-shell
  name: dsh-workspace-shell
`;

const REMOTE = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light
`;

test('patch entries are split on top-level ids and keep their bodies', () => {
  const entries = parsePatchEntries(LOCAL);
  assert.deepEqual(entries.map((entry) => entry.id), ['ui-theme', 'agent-default-model', 'workspace-shell']);
  assert.match(entries[1].block, /provider: dsh-opencode-go/u);
  assert.equal(parsePatchEntries('').length, 0);
});

test('machine-specific entries are skipped, not copied', () => {
  const local = `${LOCAL}- id: plugin-manager\n  name: "@deepseek-ai/dsh-plugin-manager"\n  config:\n    pnpmCommand: /Users/me/.dsh/bin/pnpm11\n`;
  const plan = planPatchSync({ localText: local, remoteText: REMOTE });
  assert.deepEqual(plan.append.map((entry) => entry.id), ['agent-default-model']);
  assert.deepEqual(plan.skipped, [
    { id: 'workspace-shell', reason: 'desktop-only' },
    { id: 'plugin-manager', reason: 'machine-specific' },
  ]);
});

test('only missing, non-Desktop entries are aligned', () => {
  const missing = missingPatchEntries({ localText: LOCAL, remoteText: REMOTE });
  assert.deepEqual(missing.map((entry) => entry.id), ['agent-default-model']);
});

test('a local profile patch is read from the DSH home and missing files read as empty', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'remote-config-home-'));
  try {
    assert.equal(await readLocalProfilePatch(home, 'web'), '');
    const dir = path.join(home, 'profiles', 'web');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'cordis.patch.yml'), LOCAL);
    assert.equal(await readLocalProfilePatch(home, 'web'), LOCAL);
    await assert.rejects(readLocalProfilePatch(home, '../escape'), (error) => error.code === 'INVALID_REQUEST');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function fakeChannel(overrides = {}) {
  const calls = [];
  const uploads = [];
  const channel = {
    calls,
    uploads,
    async exec(request) {
    if (String(request.args?.[1] ?? '').includes('printf %s "$HOME"')) return { code: 0, stdout: '/home/user', stderr: '' };
      calls.push(request);
      const script = String(request.args?.[1] ?? '');
      if (request.command === 'sh' && script.startsWith('cp ')) return { code: 0, stdout: '', stderr: '' };
      if (request.command === 'mv') return { code: 0, stdout: '', stderr: '' };
      if (request.command === '/usr/bin/node') return { code: overrides.dumpConfigCode ?? 0, stdout: '[]\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async upload(local, remote) {
      uploads.push({ local, remote });
      return undefined;
    },
  };
  return channel;
}

test('missing entries are uploaded and the Host loader validates the result', async () => {
  const channel = fakeChannel();
  const entries = missingPatchEntries({ localText: LOCAL, remoteText: REMOTE });
  const result = await appendRemotePatch(channel, {
    argv: ['/usr/bin/node', '/usr/bin/dsh'],
    profileId: 'web',
    remoteText: REMOTE,
    entries,
    stamp: 'test1',
  });
  assert.deepEqual(result.appended, ['agent-default-model']);
  assert.equal(result.error, null);
  assert.equal(channel.uploads.length, 1, 'the merged file is uploaded once');
  assert.match(channel.uploads[0].remote, /cordis\.patch\.yml\.sync-test1$/u);
  assert.ok(channel.calls.some((call) => call.command === '/usr/bin/node' && call.args.includes('--dump-config')));
});

test('a rejected merge restores the backup and reports the reason', async () => {
  const channel = fakeChannel({ dumpConfigCode: 1 });
  const entries = missingPatchEntries({ localText: LOCAL, remoteText: REMOTE });
  const result = await appendRemotePatch(channel, {
    argv: ['/usr/bin/node', '/usr/bin/dsh'], profileId: 'web', remoteText: REMOTE, entries, stamp: 'test2',
  });
  assert.deepEqual(result.appended, []);
  assert.match(result.error, /rejected/u);
  const copies = channel.calls.filter((call) => call.command === 'sh' && String(call.args?.[1] ?? '').startsWith('cp '));
  assert.equal(copies.length, 2, 'one backup, then one restore');
  assert.match(copies[1].args[1], /cordis\.patch\.yml'? 2>\/dev\/null/u, 'the restore targets the live file');
});
