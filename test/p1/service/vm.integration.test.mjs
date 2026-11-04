import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { DSH_VERSION } from '../../../packages/shell/ssh-remote/controller/src/constants.js';
import { openControllerSession } from '../../../packages/shell/ssh-remote/src/host/controller-session.js';
import { openRemoteHost } from '../../../packages/shell/ssh-remote/src/host/open-remote-host.js';
import { RuntimeCatalog } from '../../../packages/shell/ssh-remote/src/host/runtime-catalog.js';
import { SshRemoteService } from '../../../packages/shell/ssh-remote/src/host/service.js';
import { ConnectionStore } from '../../../packages/shell/ssh-remote/src/host/store.js';
import { connectResolvedSsh } from '../../../packages/shell/ssh-remote/src/host/ssh/connection.js';
import { appendKnownHostKey } from '../../../packages/shell/ssh-remote/src/host/ssh/known-hosts.js';
import { memoryStorage, waitForPhase } from './helpers.mjs';

const execute = promisify(execFile);
const VM_NAME = 'dsh-ssh-remote-p0';
const enabled = process.env.DSH_SSH_REMOTE_P1_VM === '1';

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

function runtimeClientPost(runtime, path, body) {
  return runtime.host.client.post(path, body);
}

test('fixed Lima VM: manager connects, synchronizes, reconnects and stops', { skip: !enabled, timeout: 600_000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-p1-service-'));
  const config = await prepareConfig(directory);
  const store = await new ConnectionStore(memoryStorage()).open();
  const catalog = new RuntimeCatalog();
  let record;
  let stopped = false;
  const controllerSession = async (options) => {
    const channel = await connectResolvedSsh(config, {
      signal: options.signal,
      interactive: false,
      background: options.background,
    });
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
    settings: { describe: () => [{ ns: 'ui-theme', value: { preference: 'dark', fontSize: 14 } }] },
    credentials: { resolve: async (ref) => ({ value: `p1-only-${process.pid}-${ref}`, source: 'test' }) },
    localBundles: async () => [
      { name: '@nonamelego/dsh-catppuccin', version: '0.6.5', official: false, optional: false, availability: 'profile', installed: true, enabled: true },
      { name: '@deepseek-ai/dsh-experimental-terminal-bundle', version: DSH_VERSION, official: true, optional: true, availability: 'installation', installed: false, enabled: true },
    ],
    openControllerSession: controllerSession,
    openRemoteHost: (options) => openRemoteHost({ ...options, config }),
    reconnectDelay: () => 50,
    maxReconnectAttempts: 3,
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
    name: 'Fixed P1 Lima',
    hostAlias: config.alias,
    syncPolicy: { appearance: true, modelNamespaces: [], credentialRefs: ['SSH_REMOTE_P1_API_KEY'] },
  });
  const connected = await service.connect(record.id);
  assert.equal(connected.ok, true);
  assert.equal(connected.sync.ok, true);
  assert.match(connected.browserUrl, /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\//u);
  assert.equal(JSON.stringify(await service.status()).includes(connected.browserUrl), false);
  assert.equal(JSON.stringify(connected.sync).includes(`p1-only-${process.pid}`), false);
  const runtime = service.runtime(record.id);
  const html = await runtime.host.client.request('/');
  assert.match(String(html), /__DSH_BOOT__|<html/iu);
  assert.match(String(html), /ssh-remote-status/u, 'The remote Client boot graph must include the status plugin.');
  const clientModuleAddress = String(html).match(/[^\s"']*dsh-workspace-shell-status\/client\.js[^\s"']*/u)?.[0]?.replaceAll('&amp;', '&');
  assert.ok(clientModuleAddress, 'The remote HTML must publish the status Client module address.');
  const remoteClientSource = await runtime.host.client.request(clientModuleAddress, { maxBytes: 16 * 1024 * 1024 });
  assert.match(String(remoteClientSource), /ssh-remote-plugins/u, 'The remote Client module must contain the plugin management page.');

  const pluginPage = await runtimeClientPost(runtime, '/api/ssh-remote/plugins/page', {});
  const localTheme = pluginPage.local.bundles.find((plugin) => plugin.name === '@nonamelego/dsh-catppuccin');
  assert.equal(localTheme.spec, '@nonamelego/dsh-catppuccin@0.6.5');
  const installTheme = await runtimeClientPost(runtime, '/api/ssh-remote/plugins/install', { spec: localTheme.spec, requestId: 'p2-plugin-install' });
  assert.equal(installTheme.result.application, 'applied', JSON.stringify(installTheme.result));
  const afterInstall = await runtimeClientPost(runtime, '/api/ssh-remote/plugins/page', {});
  assert.equal(afterInstall.remote.some((plugin) => plugin.name === localTheme.name && plugin.installed && plugin.enabled), true);
  const disabled = await runtimeClientPost(runtime, '/api/ssh-remote/plugins/set-enabled', { name: localTheme.name, enabled: false });
  assert.equal(disabled.result.application, 'applied', JSON.stringify(disabled.result));
  const afterDisable = await runtimeClientPost(runtime, '/api/ssh-remote/plugins/page', {});
  assert.equal(afterDisable.remote.some((plugin) => plugin.name === localTheme.name && plugin.enabled), false);
  const removed = await runtimeClientPost(runtime, '/api/ssh-remote/plugins/remove', { name: localTheme.name });
  assert.equal(removed.result.application, 'applied', JSON.stringify(removed.result));
  const afterRemove = await runtimeClientPost(runtime, '/api/ssh-remote/plugins/page', {});
  assert.equal(afterRemove.remote.some((plugin) => plugin.name === localTheme.name && plugin.installed), false);
  t.diagnostic(`verified local snapshot, one-click install, disable and removal for ${localTheme.name}`);

  const listed = await runtime.controller.list();
  const endpoint = listed.instances.find((entry) => entry.instance.instanceId === runtime.host.instanceId)?.instance.endpoint;
  assert.ok(endpoint?.port);
  const forward = await service.addPort(record.id, { remotePort: endpoint.port, localPort: 0, name: 'p2-web-check' });
  assert.equal(forward.state, 'active');
  assert.equal(service.publicConnection(record.id).portForwards[0].id, forward.id);
  const forwardedResponse = await fetch(`http://127.0.0.1:${forward.localPort}/`, { redirect: 'manual' });
  await forwardedResponse.body?.cancel();
  assert.equal(forwardedResponse.status, 401, 'The forwarded endpoint must preserve DSH browser authentication.');
  const removedForward = await service.removePort(record.id, forward.id);
  assert.equal(removedForward.state, 'closed');

  const diagnostic = await service.diagnostics(record.id);
  assert.equal(diagnostic.report.controllerLogs.length, 2);
  assert.equal(JSON.stringify(diagnostic).includes(connected.browserUrl), false);
  assert.equal(JSON.stringify(diagnostic).includes(`p1-only-${process.pid}`), false);
  assert.match(diagnostic.text, /SSH Remote diagnostic report/u);
  t.diagnostic(`verified port forwarding and diagnostic export for ${runtime.host.instanceId}`);

  const second = await openRemoteHost({
    alias: config.alias,
    config,
    artifactPath: runtime.artifact.artifactPath,
    sha256: runtime.artifact.sha256,
    runtimeId: runtime.artifact.runtimeId,
    version: runtime.artifact.dshVersion,
    buildId: runtime.artifact.buildId,
    localReturnUrl: 'http://127.0.0.1:54542',
  });
  try {
    assert.equal(second.host.instanceId, runtime.host.instanceId);
    const secondStatus = await second.host.client.request('/api/ssh-remote/status');
    assert.equal(secondStatus.role, 'remote');
    const leases = await second.controller.list();
    const shared = leases.instances.find((entry) => entry.instance.instanceId === runtime.host.instanceId);
    assert.equal(shared?.clientCount, 2);
  } finally {
    await second.host.close();
    await second.channel.close();
  }
  const firstStatus = await runtime.host.client.request('/api/ssh-remote/status');
  assert.equal(firstStatus.ok, true);
  t.diagnostic(`verified two independent clients shared ${runtime.host.instanceId} without termination`);
  const originalId = connected.host.instanceId;
  const originalChannel = service.runtime(record.id).channel;
  t.diagnostic(`connected and synchronized instance ${originalId}`);

  const again = await service.connect(record.id);
  assert.equal(again.host.instanceId, originalId);
  const reconnecting = waitForPhase(service, record.id, 'reconnecting', 120_000);
  await originalChannel.close();
  await reconnecting;
  await waitForPhase(service, record.id, 'connected', 120_000);
  assert.equal(service.runtime(record.id).host.instanceId, originalId);
  t.diagnostic(`reconnected to original instance ${originalId}`);

  await service.disconnect(record.id);
  assert.equal(store.get(record.id).lastInstanceId, originalId);
  await service.stop(record.id, { instanceId: originalId });
  stopped = true;
  assert.equal(store.get(record.id).lastInstanceId, null);
  assert.equal(service.publicConnection(record.id).phase, 'idle');

  const verification = await controllerSession({ catalog, version: DSH_VERSION, signal: new AbortController().signal });
  try {
    const listed = await verification.controller.list();
    const target = listed.instances.find((entry) => entry.instance.instanceId === originalId);
    assert.equal(target?.health.healthy, false);
  } finally {
    await verification.channel.close();
  }
  t.diagnostic(`stopped and verified instance ${originalId}`);
});
