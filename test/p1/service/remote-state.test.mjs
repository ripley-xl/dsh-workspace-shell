import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyPreferenceSync, planPreferenceSync } from '../../../packages/manager/src/host/remote-state.js';

async function home(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pref-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'profiles', 'desktop'), { recursive: true });
  await mkdir(path.join(root, 'storages', 'dsh-composer-plus'), { recursive: true });
  await mkdir(path.join(root, 'storages', 'dsh-composer-plus', 'running'), { recursive: true });
  return root;
}

test('preference sync takes settings files and leaves state behind', async (t) => {
  const root = await home(t);
  await writeFile(path.join(root, 'profiles', 'desktop', '.dsh-open-market-user.json'), '{"settings":{"sidebarMarket":"off"}}');
  await writeFile(path.join(root, 'profiles', 'desktop', '.dsh-market-cache.json'), '{}');
  await writeFile(path.join(root, 'storages', 'dsh-composer-plus', 'assistant-switch.json'), '{"on":false}');
  await writeFile(path.join(root, 'storages', 'dsh-composer-plus', 'active.json'), '{"sessionId":"s1"}');
  await writeFile(path.join(root, 'storages', 'dsh-composer-plus', 'secrets.json'), '{"token":"x"}');
  const plan = await planPreferenceSync({ home: root });
  assert.deepEqual(plan.files.map((file) => file.target).sort(), [
    'profiles/desktop/.dsh-open-market-user.json',
    'storages/dsh-composer-plus/assistant-switch.json',
  ]);
});

test('applying preferences backs the remote file up before replacing it', async () => {
  const calls = [];
  const channel = {
    async exec(request) { calls.push(['exec', String(request.args?.[1] ?? '')]); return { code: 0, stdout: '', stderr: '' }; },
    async upload(local, remote) { calls.push(['upload', remote]); },
  };
  const result = await applyPreferenceSync(channel, {
    files: [{ target: 'storages/dsh-composer-plus/assistant-switch.json', text: '{"on":false}' }],
  });
  assert.deepEqual(result.synced, ['storages/dsh-composer-plus/assistant-switch.json']);
  assert.ok(calls.some(([kind, line]) => kind === 'exec' && line.includes('bak-sync-')));
  assert.ok(calls.some(([kind, remote]) => kind === 'upload' && remote === '$HOME/.dsh/storages/dsh-composer-plus/assistant-switch.json'));
});
