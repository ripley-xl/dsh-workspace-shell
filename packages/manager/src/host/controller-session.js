import { connectSsh } from './ssh/connection.js';
import { bootstrapRemoteRuntime, findInstalledRemoteRuntime, RemoteControllerClient } from './remote-controller.js';
import { SshRemoteError } from './ssh/errors.js';
import { probeRemoteTarget } from './target-probe.js';

export async function openControllerSession(options) {
  const channel = options.channel ?? await connectSsh(options.alias, {
    signal: options.signal,
    interactive: options.interactive,
    background: options.background,
    authCallbacks: options.authCallbacks,
    hostKeyVerifier: options.hostKeyVerifier,
  });
  try {
    const target = await probeRemoteTarget(channel, { signal: options.signal });
    const artifact = await options.catalog.select({
      version: options.version,
      buildId: options.buildId,
      target,
      signal: options.signal,
    });
    let installed = await findInstalledRemoteRuntime(channel, {
      runtimeId: artifact.runtimeId,
      version: artifact.dshVersion,
      buildId: artifact.buildId,
      sha256: artifact.sha256,
      signal: options.signal,
    }).catch(() => null);
    if (!installed) {
      installed = await bootstrapRemoteRuntime(channel, {
        artifactPath: artifact.artifactPath,
        sha256: artifact.sha256,
        version: artifact.dshVersion,
        signal: options.signal,
      });
    }
    if (installed.runtime.dshVersion !== artifact.dshVersion || installed.runtime.buildId !== artifact.buildId) {
      throw new SshRemoteError('REMOTE_VERSION_MISMATCH', 'The installed runtime does not match the selected local build.');
    }
    const controller = new RemoteControllerClient({
      channel,
      executable: installed.executable,
      root: installed.root,
    });
    return { channel, controller, installed, artifact, target };
  } catch (error) {
    if (!options.channel) await channel.close().catch(() => {});
    throw error;
  }
}
