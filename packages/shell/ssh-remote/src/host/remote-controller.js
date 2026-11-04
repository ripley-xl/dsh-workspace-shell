import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './profiles.js';
import { SshRemoteError } from './ssh/errors.js';

const PROTOCOL_VERSION = 1;

function absolutePath(value, name) {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
    throw new TypeError(`${name} must be an absolute POSIX path.`);
  }
  return posix.normalize(value);
}

export class RemoteControllerClient {
  constructor({ channel, executable, root }) {
    this.channel = channel;
    this.executable = absolutePath(executable, 'controller executable');
    this.root = absolutePath(root, 'controller root');
    this.profileSupport = null;
  }

  async call(command, args = [], options = {}) {
    const requestId = randomUUID();
    const response = await this.channel.execJson({
      command: this.executable,
      args: [command, ...args, '--root', this.root, '--request-id', requestId],
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      payload: {},
      ...options,
    }, options);
    if (!response.ok) {
      throw new SshRemoteError(response.error?.code ?? 'REMOTE_OPERATION_FAILED',
        response.error?.message ?? 'The remote controller operation failed.',
        { details: response.error?.details });
    }
    return response.result;
  }

  probe() {
    return this.call('probe');
  }

  supportsProfiles() {
    this.profileSupport ??= this.call('profiles').then(() => true, () => false);
    return this.profileSupport;
  }

  async profileArgs(profileId) {
    if (profileId === undefined || profileId === null) return [];
    const profile = normalizeProfileId(profileId);
    if (await this.supportsProfiles()) return ['--profile', profile];
    if (profile === DEFAULT_PROFILE_ID) return [];
    throw new SshRemoteError('REMOTE_PROFILE_UNSUPPORTED', 'The remote controller does not support non-default Web profiles.');
  }

  async profiles({ dshHome } = {}) {
    const home = dshHome === undefined ? null : absolutePath(dshHome, 'remote DSH home');
    const result = await this.call('profiles', [...home ? ['--dsh-home', home] : []]);
    return result && typeof result === 'object' ? result : { profiles: [] };
  }

  async list({ version, buildId, profileId } = {}) {
    return this.call('list', [
      ...version ? ['--expected-version', version] : [],
      ...buildId ? ['--expected-build-id', buildId] : [],
      ...await this.profileArgs(profileId),
    ]);
  }

  async start({ version, buildId, workspace, patch, profileId }) {
    const profile = normalizeProfileId(profileId ?? DEFAULT_PROFILE_ID);
    return this.call('start', [
      '--version', version,
      '--expected-build-id', buildId,
      '--workspace', workspace,
      ...await this.profileArgs(profile),
      ...patch ? ['--patch', patch] : [],
    ], { timeoutMs: 120_000 });
  }

  async attach({ instanceId, version, buildId, clientLeaseId, profileId }) {
    return this.call('attach', [
      '--instance-id', instanceId,
      '--expected-version', version,
      '--expected-build-id', buildId,
      ...await this.profileArgs(profileId),
      ...clientLeaseId ? ['--client-lease-id', clientLeaseId] : [],
    ]);
  }

  heartbeat({ instanceId, clientLeaseId }) {
    return this.call('heartbeat', ['--instance-id', instanceId, '--client-lease-id', clientLeaseId]);
  }

  release({ instanceId, clientLeaseId }) {
    return this.call('release', ['--instance-id', instanceId, '--client-lease-id', clientLeaseId]);
  }

  stop({ instanceId }) {
    return this.call('stop', ['--instance-id', instanceId], { timeoutMs: 120_000 });
  }

  logs({ instanceId, stream = 'host', offset = 0, limit = 32 * 1024 }) {
    return this.call('logs', [
      '--instance-id', instanceId,
      '--stream', stream,
      '--offset', String(offset),
      '--limit', String(limit),
    ]);
  }
}

export async function findInstalledRemoteRuntime(channel, options) {
  const homeResult = await channel.exec({ command: 'printenv', args: ['HOME'], signal: options.signal });
  if (homeResult.code !== 0) return null;
  const home = absolutePath(homeResult.stdout.trim(), 'remote HOME');
  const root = absolutePath(options.root ?? posix.join(home, '.dsh', 'ssh-remote'), 'remote root');
  if (typeof options.runtimeId !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/u.test(options.runtimeId)) return null;
  const runtimeRoot = posix.join(root, 'servers', options.runtimeId);
  const executable = posix.join(runtimeRoot, 'bin', 'dsh-ssh-remote-controller');
  const executableCheck = await channel.exec({ command: 'test', args: ['-x', executable], signal: options.signal });
  if (executableCheck.code !== 0) return null;

  const manifestResult = await channel.exec({ command: 'cat', args: [posix.join(runtimeRoot, 'manifest.json')], signal: options.signal });
  if (manifestResult.code !== 0) return null;
  let manifest;
  try {
    manifest = JSON.parse(manifestResult.stdout);
  } catch {
    return null;
  }
  if (manifest.runtimeId !== options.runtimeId || manifest.dshVersion !== options.version || manifest.buildId !== options.buildId) {
    return null;
  }
  const receiptResult = await channel.exec({ command: 'cat', args: [posix.join(runtimeRoot, 'install-receipt.json')], signal: options.signal });
  if (receiptResult.code !== 0) return null;
  try {
    if (JSON.parse(receiptResult.stdout).installMode !== 'npm') return null;
  } catch {
    return null;
  }
  return { home, root, executable, runtime: manifest, alreadyInstalled: true };
}

const SKIPPED_UPLOAD_DIRECTORIES = new Set(['node_modules', 'artifacts', '.cache', '.build', '.git']);

async function uploadDirectory(channel, localRoot, remoteRoot, signal) {
  await channel.exec({ command: 'mkdir', args: ['-p', '--', remoteRoot], signal });
  const entries = await readdir(localRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED_UPLOAD_DIRECTORIES.has(entry.name)) continue;
    const localPath = posix.join(localRoot, entry.name);
    const remotePath = posix.join(remoteRoot, entry.name);
    if (entry.isDirectory()) {
      await uploadDirectory(channel, localPath, remotePath, signal);
    } else if (entry.isFile()) {
      await channel.upload(localPath, remotePath, { signal });
    }
  }
}

/**
 * Install the remote runtime by running npm on the remote host. The controller
 * sources and plugin files are tiny and upload over SFTP; DSH itself is fetched
 * from the registry with the local DSH version pinned. A missing Node.js or npm,
 * or an unreachable registry, surfaces as a structured error for the user.
 */
export async function bootstrapRemoteRuntime(channel, options) {
  const homeResult = await channel.exec({ command: 'printenv', args: ['HOME'] });
  if (homeResult.code !== 0) throw new SshRemoteError('REMOTE_PLATFORM_UNSUPPORTED', 'Could not determine the remote home directory.');
  const home = absolutePath(homeResult.stdout.trim(), 'remote HOME');
  const root = absolutePath(options.root ?? posix.join(home, '.dsh', 'ssh-remote'), 'remote root');
  const bootstrapId = randomUUID();
  const temporary = posix.join(root, 'tmp');
  const remoteBootstrap = posix.join(temporary, `bootstrap-${bootstrapId}`);
  const controllerSource = fileURLToPath(new URL('../../controller/', import.meta.url));
  const pluginsSource = fileURLToPath(new URL('../../plugins/', import.meta.url));
  const guestCwdSource = fileURLToPath(new URL('../../../guest-cwd/', import.meta.url));
  try {
    await channel.exec({ command: 'mkdir', args: ['-p', '--', remoteBootstrap], signal: options.signal });
    await uploadDirectory(channel, controllerSource, posix.join(remoteBootstrap, 'controller'), options.signal);
    await uploadDirectory(channel, pluginsSource, posix.join(remoteBootstrap, 'plugins'), options.signal);
    await uploadDirectory(channel, guestCwdSource, posix.join(remoteBootstrap, 'plugins', 'guest-cwd'), options.signal);
    const requestId = randomUUID();
    const response = await channel.execJson({
      command: 'node',
      args: [
        posix.join(remoteBootstrap, 'controller', 'src', 'cli.js'),
        'install',
        '--mode', 'npm',
        '--dsh-version', options.version,
        '--controller-source', posix.join(remoteBootstrap, 'controller'),
        '--plugins-source', posix.join(remoteBootstrap, 'plugins'),
        '--root', root,
        '--request-id', requestId,
      ],
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      payload: {},
      signal: options.signal,
      timeoutMs: 900_000,
    });
    if (!response.ok) {
      throw new SshRemoteError(response.error?.code ?? 'REMOTE_INSTALL_FAILED',
        response.error?.message ?? 'Remote runtime installation failed.', { details: response.error?.details });
    }
    return {
      home,
      root,
      executable: posix.join(response.result.path, 'bin', 'dsh-ssh-remote-controller'),
      runtime: response.result.runtime,
      alreadyInstalled: response.result.alreadyInstalled,
    };
  } finally {
    await channel.exec({ command: 'rm', args: ['-rf', '--', remoteBootstrap] }).catch(() => {});
  }
}
