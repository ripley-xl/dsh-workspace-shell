import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { connectResolvedSsh, connectSsh } from './ssh/connection.js';
import { bootstrapRemoteRuntime, findInstalledRemoteRuntime, RemoteControllerClient } from './remote-controller.js';
import { RemoteHostConnection } from './remote-host.js';
import { DEFAULT_PROFILE_ID, normalizeProfileId } from './profiles.js';

function loopbackBaseUrl(value) {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('The local return URL must use a loopback host.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The local return URL must use HTTP or HTTPS.');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.origin;
}

export function statusPluginPatch({ runtimeRoot, hostAlias, localReturnUrl, dshVersion }) {
  const statusPackage = posix.join(runtimeRoot, 'plugins', 'status', 'index.js');
  const guestPackage = posix.join(runtimeRoot, 'plugins', 'guest', 'index.js');
  return [
    '- insert:',
    '    - id: ssh-remote-status',
    `      name: ${JSON.stringify(statusPackage)}`,
    '      config:',
    `        hostAlias: ${JSON.stringify(hostAlias)}`,
    `        localReturnUrl: ${JSON.stringify(loopbackBaseUrl(localReturnUrl))}`,
    `        dshVersion: ${JSON.stringify(dshVersion)}`,
    '    - id: workspace-guest',
    `      name: ${JSON.stringify(guestPackage)}`,
    '      config: {}',
    '',
  ].join('\n');
}

/**
 * Writes the per-connection status-plugin overlay into the remote runtime tmp
 * directory and returns its absolute path. Every Host start needs this overlay:
 * without it the remote Host has no `/api/ssh-remote/status` endpoint, so the
 * attach performed right after the start cannot succeed.
 */
export async function writeStatusPluginPatch(channel, { installed, hostAlias, localReturnUrl, dshVersion, signal }) {
  if (typeof installed?.executable !== 'string' || typeof installed?.root !== 'string') {
    throw new Error('The remote runtime installation is incomplete.');
  }
  const runtimeRoot = posix.dirname(posix.dirname(installed.executable));
  const patch = posix.join(installed.root, 'tmp', `status-${randomUUID()}.yml`);
  const patchResult = await channel.exec({
    command: 'tee',
    args: [patch],
    input: statusPluginPatch({ runtimeRoot, hostAlias, localReturnUrl, dshVersion }),
    signal,
  });
  if (patchResult.code !== 0) throw new Error('Could not install the remote status plugin patch.');
  return patch;
}

export async function openRemoteHost(options) {
  const connectionOptions = {
    signal: options.signal,
    authCallbacks: options.authCallbacks,
    hostKeyVerifier: options.hostKeyVerifier,
  };
  const owned = options.channel === undefined;
  const channel = options.channel
    ?? (options.config
      ? await connectResolvedSsh(options.config, connectionOptions)
      : await connectSsh(options.alias, connectionOptions));
  try {
    let installed = options.runtimeId
      ? await findInstalledRemoteRuntime(channel, {
        runtimeId: options.runtimeId,
        version: options.version,
        buildId: options.buildId,
        sha256: options.sha256,
        signal: options.signal,
      }).catch(() => null)
      : null;
    if (!installed) {
      installed = await bootstrapRemoteRuntime(channel, {
        artifactPath: options.artifactPath,
        sha256: options.sha256,
        version: options.version,
        signal: options.signal,
      });
    }
    const controller = new RemoteControllerClient({
      channel,
      executable: installed.executable,
      root: installed.root,
    });
    const patch = await writeStatusPluginPatch(channel, {
      installed,
      hostAlias: options.config?.alias ?? options.alias,
      localReturnUrl: options.localReturnUrl,
      dshVersion: options.version,
      signal: options.signal,
    });

    const host = new RemoteHostConnection({
      channel,
      controller,
      version: options.version,
      buildId: options.buildId,
      runtimeId: options.runtimeId,
      workspace: installed.home,
      patch,
      fetchImpl: options.fetchImpl,
      profileId: normalizeProfileId(options.profileId ?? DEFAULT_PROFILE_ID),
    });
    await host.open();
    return { host, channel, controller, installed, owned };
  } catch (error) {
    if (owned) await channel.close();
    throw error;
  }
}
