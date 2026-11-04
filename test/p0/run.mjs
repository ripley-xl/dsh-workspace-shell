import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { connectResolvedSsh } from '../../packages/shell/ssh-remote/src/host/ssh/connection.js';
import { appendKnownHostKey } from '../../packages/shell/ssh-remote/src/host/ssh/known-hosts.js';
import { openRemoteHost } from '../../packages/shell/ssh-remote/src/host/open-remote-host.js';
import { RemoteControllerClient } from '../../packages/shell/ssh-remote/src/host/remote-controller.js';
import { RemoteHostConnection } from '../../packages/shell/ssh-remote/src/host/remote-host.js';

const execute = promisify(execFile);
const VM_NAME = 'dsh-ssh-remote-p0';

function scalar(output, key) {
  const match = output.match(new RegExp(`^${key} (.+)$`, 'mu'));
  if (!match) throw new Error(`Missing ${key} in the Lima SSH configuration.`);
  return match[1];
}

async function vmConfig(knownHostsFile) {
  const configFile = path.join(os.homedir(), '.lima', VM_NAME, 'ssh.config');
  const { stdout } = await execute('ssh', ['-G', '-F', configFile, `lima-${VM_NAME}`], { encoding: 'utf8', timeout: 10_000 });
  return {
    alias: `lima-${VM_NAME}`,
    globalKnownHostsFiles: [],
    hostname: scalar(stdout, 'hostname'),
    identityAgent: null,
    identityFiles: [scalar(stdout, 'identityfile')],
    port: Number(scalar(stdout, 'port')),
    strictHostKeyChecking: 'yes',
    user: scalar(stdout, 'user'),
    userKnownHostsFiles: [knownHostsFile],
  };
}

async function prepareConfig(directory) {
  const knownHosts = path.join(directory, 'known_hosts');
  const config = await vmConfig(knownHosts);
  const { stdout } = await execute('limactl', ['shell', VM_NAME, '--', 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], { encoding: 'utf8', timeout: 15_000 });
  const [keyType, encodedKey] = stdout.trim().split(/\s+/u);
  await appendKnownHostKey(knownHosts, {
    hostname: config.hostname,
    key: Buffer.from(encodedKey, 'base64'),
    keyType,
    port: config.port,
  });
  return config;
}

async function settingsNamespace(client, name) {
  const response = await client.post('/api/ssh-remote/settings/describe', {});
  const descriptor = response.descriptors.find((entry) => entry.ns === name || entry.ns.endsWith(`:${name}`));
  if (!descriptor) throw new Error(`Remote settings namespace is missing: ${name}`);
  return descriptor.ns;
}

async function main() {
  if (process.env.DSH_SSH_REMOTE_P0_VM !== '1') {
    throw new Error('Set DSH_SSH_REMOTE_P0_VM=1 to use the isolated dsh-ssh-remote-p0 VM.');
  }
  const dshVersion = process.env.DSH_SSH_REMOTE_DSH_VERSION;
  if (typeof dshVersion !== 'string' || dshVersion.length === 0) throw new Error('Set DSH_SSH_REMOTE_DSH_VERSION to the DSH version the remote host should install.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-p0-e2e-'));
  const config = await prepareConfig(directory);
  const localReturnUrl = process.env.DSH_SSH_REMOTE_LOCAL_URL ?? 'http://127.0.0.1:54542';
  let active;
  let report = { ok: false, checks: [] };
  const check = (name, details = {}) => {
    report.checks.push({ name, ...details });
    process.stdout.write(`PASS ${name}\n`);
  };

  try {
    active = await openRemoteHost({
      alias: config.alias,
      config,
      version: dshVersion,
      buildId: `npm:${dshVersion}`,
      localReturnUrl,
    });
    const { host, channel, controller, installed } = active;
    assert.equal(installed.runtime.dshVersion, dshVersion);
    assert.equal(installed.runtime.buildId, `npm:${dshVersion}`);
    assert.equal(host.instanceId !== null, true);
    check('version-matched runtime and remote status plugin', {
      dshVersion,
      instanceId: host.instanceId,
    });

    const html = await host.client.request('/');
    assert.match(String(html), /__DSH_BOOT__|<html/iu);
    check('authenticated remote Web page through SSH gateway');

    const credentialRef = 'SSH_REMOTE_P0_API_KEY';
    const credentialReport = await host.sync({
      credentials: [{ ref: credentialRef, value: `p0-only-${process.pid}` }],
    });
    assert.equal(credentialReport.credentials.ok, true);
    assert.equal(JSON.stringify(credentialReport).includes(`p0-only-${process.pid}`), false);
    report.credentials = credentialReport.credentials;
    check('API Key written to remote credentials without disclosure');

    const pluginReport = await host.sync({
      plugins: [{ spec: '@nonamelego/dsh-catppuccin@0.6.5' }],
    });
    report.plugins = pluginReport.plugins;
    assert.equal(pluginReport.plugins.ok, true);
    assert.equal(pluginReport.restartRequired, false);
    check('existing theme plugin installed through remote plugin manager');

    const themeNamespace = await settingsNamespace(host.client, 'ui-theme');
    const catppuccinNamespace = await settingsNamespace(host.client, 'dsh-catppuccin');
    const settingsReport = await host.sync({
      settings: [
        { ns: themeNamespace, patch: { preference: 'dark', fontSize: 14 } },
        { ns: catppuccinNamespace, patch: { flavor: 'catppuccin-mocha', autoCheck: false } },
      ],
    });
    report.settings = settingsReport.settings;
    assert.equal(settingsReport.settings.ok, true);
    check('theme and plugin configuration synchronized');

    const originalInstanceId = host.instanceId;
    await channel.close();
    check('SSH transport closed while remote instance remained managed by Supervisor');

    const reconnectedChannel = await connectResolvedSsh(config, { readyTimeoutMs: 15_000 });
    const reconnectedController = new RemoteControllerClient({ channel: reconnectedChannel, executable: installed.executable, root: installed.root });
    const reconnectedHost = new RemoteHostConnection({
      channel: reconnectedChannel,
      controller: reconnectedController,
      version: dshVersion,
      buildId: `npm:${dshVersion}`,
      workspace: installed.home,
    });
    await reconnectedHost.open();
    assert.equal(reconnectedHost.instanceId, originalInstanceId);
    const remoteStatus = await reconnectedHost.client.request('/api/ssh-remote/status');
    assert.equal(remoteStatus.role, 'remote');
    check('reconnected to the original healthy instance', { instanceId: originalInstanceId });

    await reconnectedHost.close();
    await reconnectedController.stop({ instanceId: originalInstanceId });
    await reconnectedChannel.close();
    check('remote instance stopped cleanly');

    report = { ...report, ok: true };
  } catch (error) {
    report.error = { message: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${report.error.message}\n`);
  } finally {
    if (active) {
      await active.host.close().catch(() => {});
      if (!active.channel.closed) await active.channel.close().catch(() => {});
    }
    await fs.rm(directory, { recursive: true, force: true });
    const output = path.resolve('artifacts', 'p0-report.json');
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }

  if (!report.ok) throw new Error(`P0 failed; see ${path.resolve('artifacts', 'p0-report.json')}`);
  process.stdout.write('P0 PASSED\n');
}

await main();
