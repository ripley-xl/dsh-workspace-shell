import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { DSH_VERSION } from '../../../controller/src/constants.js';
import { openControllerSession } from '../../../packages/manager/src/host/controller-session.js';
import { openRemoteHost } from '../../../packages/manager/src/host/open-remote-host.js';
import { RuntimeCatalog } from '../../../packages/manager/src/host/runtime-catalog.js';
import { SshRemoteService } from '../../../packages/manager/src/host/service.js';
import { ConnectionStore } from '../../../packages/manager/src/host/store.js';
import { connectResolvedSsh } from '../../../packages/manager/src/host/ssh/connection.js';
import { appendKnownHostKey } from '../../../packages/manager/src/host/ssh/known-hosts.js';
import { memoryStorage } from '../../p1/service/helpers.mjs';

const execute = promisify(execFile);
const VM_NAME = 'dsh-ssh-remote-p0';
const enabled = process.env.DSH_SSH_REMOTE_P2_VM === '1';

function scalar(output, key) {
  const match = output.match(new RegExp(`^${key} (.+)$`, 'mu'));
  if (!match) throw new Error(`Missing ${key} in the fixed Lima SSH configuration.`);
  return match[1];
}

async function prepareConfig(directory) {
  const knownHosts = path.join(directory, 'known_hosts');
  const configFile = path.join(os.homedir(), '.lima', VM_NAME, 'ssh.config');
  const alias = `lima-${VM_NAME}`;
  const { stdout } = await execute('ssh', ['-G', '-F', configFile, alias], { encoding: 'utf8', timeout: 10_000 });
  const config = {
    alias,
    globalKnownHostsFiles: [],
    hostname: scalar(stdout, 'hostname'),
    identityAgent: null,
    identityFiles: [scalar(stdout, 'identityfile')],
    port: Number(scalar(stdout, 'port')),
    strictHostKeyChecking: 'yes',
    user: scalar(stdout, 'user'),
    userKnownHostsFiles: [knownHosts],
  };
  const hostKey = await execute('limactl', ['shell', VM_NAME, '--', 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { encoding: 'utf8', timeout: 15_000 });
  const [keyType, encodedKey] = hostKey.stdout.trim().split(/\s+/u);
  await appendKnownHostKey(knownHosts, {
    hostname: config.hostname,
    key: Buffer.from(encodedKey, 'base64'),
    keyType,
    port: config.port,
  });
  return config;
}

test('fixed Lima VM: sync preview protects conflicts and unmanaged fields', { skip: !enabled, timeout: 600_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-p2-preview-'));
  const config = await prepareConfig(directory);
  const store = await new ConnectionStore(memoryStorage()).open();
  const catalog = new RuntimeCatalog();
  const secret = `p2-preview-only-${process.pid}`;
  let record;
  let stopped = false;
  const controllerSession = async (options) => {
    const channel = await connectResolvedSsh(config, { signal: options.signal, interactive: false, background: options.background });
    try {
      return await openControllerSession({ ...options, channel });
    } catch (error) {
      await channel.close().catch(() => {});
      throw error;
    }
  };
  const service = new SshRemoteService({
    store,
    catalog,
    localVersion: () => DSH_VERSION,
    localReturnUrl: 'http://127.0.0.1:54542',
    settings: { describe: () => [
      { ns: 'ui-theme', schema: { properties: { preference: { type: 'string' } } }, value: { preference: 'dark' }, user: { preference: 'dark' } },
      {
        ns: 'include:llm-deepseek',
        schema: { properties: { apiKeyEnv: { default: 'SSH_REMOTE_P2_API_KEY', 'x-cordis': { role: 'credential-ref' } } } },
        value: { apiKeyEnv: 'SSH_REMOTE_P2_API_KEY' }, user: {},
      },
    ] },
    credentials: {
      resolve: async () => ({ value: secret, source: 'test' }),
      describe: async () => ({ configured: true, writable: true }),
    },
    openControllerSession: controllerSession,
    openRemoteHost: (options) => openRemoteHost({ ...options, config }),
  });
  t.after(async () => {
    if (record && store.get(record.id) && !stopped) {
      const pending = service.runtime(record.id).operation;
      await service.disconnect(record.id).catch(() => {});
      await pending?.catch(() => {});
      const instanceId = store.get(record.id)?.lastInstanceId;
      if (instanceId) await service.stop(record.id, { instanceId }).catch(() => {});
    }
    await service.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  record = await store.upsert({
    hostAlias: config.alias,
    pluginTemplate: [],
    syncPolicy: { allSupported: true },
  });
  await service.connect(record.id);
  const host = service.runtime(record.id).host;
  await host.client.post('/api/ssh-remote/settings/update', { ns: 'ui-theme', patch: { preference: 'light', fontSize: 17 } });

  const preview = await service.previewSync(record.id);
  assert.equal(preview.requiresConfirmation, true);
  assert.ok(preview.preservedFields.some((field) => field.ns === 'ui-theme' && field.path.join('.') === 'fontSize'));
  const credential = preview.operations.find((operation) => operation.type === 'credential');
  assert.deepEqual(credential.configured, { local: true, remote: true });
  assert.equal(JSON.stringify(preview).includes(secret), false);

  await assert.rejects(service.sync(record.id), (error) => error.code === 'SYNC_CONFIRMATION_REQUIRED');
  const confirmed = await service.sync(record.id, { allowConflicts: true });
  assert.equal(confirmed.ok, true);
  const described = await host.client.post('/api/ssh-remote/settings/describe', {});
  const theme = described.descriptors.find((descriptor) => descriptor.ns === 'ui-theme' || descriptor.ns.endsWith(':ui-theme'));
  assert.equal(theme.value.preference, 'dark');
  assert.equal(theme.value.fontSize, 17);

  await service.stop(record.id, { instanceId: host.instanceId });
  stopped = true;
  assert.equal(store.get(record.id).lastInstanceId, null);
  t.diagnostic(`preview, conflict confirmation and stop passed for ${host.instanceId}`);
});

test('fixed Lima VM: first all-supported sync creates a 0600 backup and does not replay', { skip: !enabled, timeout: 600_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-all-supported-'));
  const config = await prepareConfig(directory);
  const store = await new ConnectionStore(memoryStorage()).open();
  const catalog = new RuntimeCatalog();
  const secret = `all-supported-only-${process.pid}`;
  let record;
  let instanceId;
  let stopped = false;
  const controllerSession = async (options) => {
    const channel = await connectResolvedSsh(config, { signal: options.signal, interactive: false, background: options.background });
    try {
      return await openControllerSession({ ...options, channel });
    } catch (error) {
      await channel.close().catch(() => {});
      throw error;
    }
  };
  const service = new SshRemoteService({
    store,
    catalog,
    localVersion: () => DSH_VERSION,
    localReturnUrl: 'http://127.0.0.1:54542',
    settings: { describe: () => [
      { ns: 'ui-theme', schema: { properties: { preference: { type: 'string' } } }, value: { preference: 'dark' }, user: { preference: 'dark' } },
      {
        ns: 'include:llm-deepseek',
        schema: { properties: { apiKeyEnv: { default: 'SSH_REMOTE_P2_API_KEY', 'x-cordis': { role: 'credential-ref' } } } },
        value: { apiKeyEnv: 'SSH_REMOTE_P2_API_KEY' }, user: {},
      },
      { ns: 'include:working-directory', schema: {}, value: { cwd: '/Users/local/project' }, user: { cwd: '/Users/local/project' } },
    ] },
    credentials: {
      resolve: async () => ({ value: secret, source: 'test' }),
      describe: async () => ({ configured: true, writable: true }),
    },
    openControllerSession: controllerSession,
    openRemoteHost: (options) => openRemoteHost({ ...options, config }),
  });
  let backups = 0;
  service.createRemoteBackup = async (client) => {
    backups += 1;
    const response = await client.post('/api/ssh-remote/sync/backup', { profile: 'web' });
    return response.backup;
  };
  t.after(async () => {
    if (record && store.get(record.id) && !stopped) {
      const pending = service.runtime(record.id).operation;
      await service.disconnect(record.id).catch(() => {});
      await pending?.catch(() => {});
      const savedId = store.get(record.id)?.lastInstanceId;
      if (savedId) await service.stop(record.id, { instanceId: savedId }).catch(() => {});
    }
    await service.close();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const artifact = await catalog.select({
    version: DSH_VERSION,
    target: { platform: 'linux', arch: 'x64', libc: 'glibc' },
  });
  const seed = await openRemoteHost({
    config,
    artifactPath: artifact.artifactPath,
    sha256: artifact.sha256,
    version: DSH_VERSION,
    buildId: artifact.buildId,
    runtimeId: artifact.runtimeId,
    localReturnUrl: 'http://127.0.0.1:54542',
  });
  instanceId = seed.host.instanceId;
  await seed.host.client.post('/api/ssh-remote/settings/update', { ns: 'ui-theme', patch: { preference: 'light', fontSize: 17 } });
  await seed.host.close();
  await seed.channel.close();

  record = await store.upsert({ hostAlias: config.alias, syncPolicy: { allSupported: true } });
  await store.update(record.id, (current) => ({ ...current, lastInstanceId: instanceId, lastServerVersion: DSH_VERSION, lastBuildId: artifact.buildId }));
  const connected = await service.connect(record.id);
  assert.equal(connected.sync.ok, true);
  assert.equal(backups, 1);
  assert.equal(connected.sync.requiresMerge, true);
  assert.deepEqual(connected.sync.mergeReasons, ['remote-user-settings']);
  assert.equal(connected.sync.backup.profile, 'web');
  assert.ok(connected.sync.backup.id);
  assert.ok(connected.sync.backup.path);
  assert.ok(connected.sync.backup.createdAt);
  assert.equal(JSON.stringify(connected.sync).includes(secret), false);
  const mode = await service.runtime(record.id).channel.exec({ command: 'stat', args: ['-c', '%a', connected.sync.backup.path] });
  assert.equal(mode.stdout.trim(), '600');

  const host = service.runtime(record.id).host;
  const described = await host.client.post('/api/ssh-remote/settings/describe', {});
  const theme = described.descriptors.find((descriptor) => descriptor.ns === 'ui-theme' || descriptor.ns.endsWith(':ui-theme'));
  assert.equal(theme.value.preference, 'dark');
  assert.equal(theme.value.fontSize, 17);
  const credentials = await host.client.post('/api/ssh-remote/credentials/describe', { refs: ['SSH_REMOTE_P2_API_KEY'] });
  assert.equal(credentials.credentials.SSH_REMOTE_P2_API_KEY.configured, true);

  await service.disconnect(record.id);
  await service.connect(record.id);
  assert.equal(backups, 1);
  await service.stop(record.id, { instanceId });
  stopped = true;
  t.diagnostic(`all-supported backup and stop passed for ${instanceId}`);
});
