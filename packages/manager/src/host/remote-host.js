import { EventEmitter } from 'node:events';
import { DEFAULT_PROFILE_ID, instanceProfileId, instanceRuntimeMatches, matchesProfile, normalizeProfileId } from './profiles.js';
import { RemoteClient } from './remote-client.js';
import { syncRemote } from './remote-sync.js';
import { SshRemoteError } from './ssh/errors.js';

const START_MODES = new Set(['auto', 'reuse-only', 'start-only']);

function instanceUnavailable(message, details) {
  return new SshRemoteError('REMOTE_INSTANCE_UNAVAILABLE', message, { details });
}

export class RemoteHostConnection extends EventEmitter {
  constructor({ channel, controller, version, buildId, runtimeId, workspace, patch, fetchImpl, profileId, startMode = 'auto' }) {
    super();
    this.channel = channel;
    this.controller = controller;
    this.version = version;
    this.buildId = buildId;
    this.runtimeId = runtimeId;
    this.workspace = workspace;
    this.patch = patch;
    this.fetchImpl = fetchImpl;
    this.profileId = normalizeProfileId(profileId ?? DEFAULT_PROFILE_ID);
    this.startMode = START_MODES.has(startMode) ? startMode : 'auto';
    this.gateway = null;
    this.client = null;
    this.instanceId = null;
    // Set only when this connection itself asked the controller to start a
    // Host. Callers use it to stop an orphan instance after a failed start.
    this.startedInstanceId = null;
    this.clientLeaseId = null;
    this.heartbeatTimer = null;
    this.closed = false;
    this.onChannelClose = () => this.handleChannelClose();
    channel.once('close', this.onChannelClose);
  }

  get browserUrl() {
    return this.client?.browserUrl ?? null;
  }

  async openInternal() {
    const listed = await this.controller.list({ version: this.version, buildId: this.buildId, profileId: this.profileId });
    let instance = listed.instances.find((candidate) => candidate.health?.healthy
      && matchesProfile(candidate, this.profileId)
      && instanceRuntimeMatches(candidate.instance, this.runtimeId))?.instance;
    if (instance && instanceProfileId(instance) !== this.profileId) {
      throw instanceUnavailable('The remote controller returned an instance for another profile.', {
        profileId: this.profileId,
        instanceId: instance.instanceId,
      });
    }
    if (!instance && this.startMode === 'reuse-only') {
      throw instanceUnavailable('No healthy remote instance exists for this profile.', { profileId: this.profileId });
    }
    if (!instance && this.startMode === 'start-only' && listed.instances.some((candidate) => candidate.health?.healthy && matchesProfile(candidate, this.profileId))) {
      throw instanceUnavailable('Another remote instance is already active for this profile.', { profileId: this.profileId });
    }
    if (!instance) {
      const started = await this.controller.start({
        version: this.version,
        buildId: this.buildId,
        workspace: this.workspace,
        patch: this.patch,
        profileId: this.profileId,
      });
      instance = started.instance;
      this.startedInstanceId = instance.instanceId;
      if (instanceProfileId(instance) !== this.profileId) {
        throw instanceUnavailable('The started remote instance does not match the requested profile.', {
          profileId: this.profileId,
          instanceId: instance.instanceId,
        });
      }
    }

    const attached = await this.controller.attach({
      instanceId: instance.instanceId,
      version: this.version,
      buildId: this.buildId,
      profileId: this.profileId,
    });
    if (attached.instance && instanceProfileId(attached.instance) !== this.profileId) {
      throw instanceUnavailable('The attached remote instance does not match the requested profile.', {
        profileId: this.profileId,
        instanceId: instance.instanceId,
      });
    }
    this.instanceId = instance.instanceId;
    this.clientLeaseId = attached.clientLeaseId;

    this.gateway = this.channel.createLoopbackGateway({ remotePort: attached.instance.endpoint.port });
    await this.gateway.listen();
    const gatewayUrl = new URL(this.gateway.url);
    gatewayUrl.hostname = '127.0.0.1';
    this.client = new RemoteClient({
      authenticatedUrl: attached.authenticatedUrl,
      gatewayOrigin: gatewayUrl.origin,
      ...this.fetchImpl ? { fetchImpl: this.fetchImpl } : {},
    });
    const status = await this.client.request('/api/ssh-remote/status');
    if (!status?.ok || status.role !== 'remote') {
      throw new Error('The remote host did not load the SSH Remote status plugin.');
    }

    this.heartbeatTimer = setInterval(() => {
      void this.controller.heartbeat({
        instanceId: this.instanceId,
        clientLeaseId: this.clientLeaseId,
      }).catch((error) => this.emit('heartbeatError', error));
    }, 10_000);
    this.heartbeatTimer.unref?.();
    return this;
  }

  async open() {
    try {
      return await this.openInternal();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  sync(input) {
    if (!this.client) throw new Error('The remote host is not connected.');
    return syncRemote(this.client, input);
  }

  handleChannelClose() {
    clearInterval(this.heartbeatTimer);
    this.client?.close();
    this.emit('close');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    this.channel.off('close', this.onChannelClose);
    if (!this.channel.closed && this.instanceId && this.clientLeaseId) {
      await this.controller.release({
        instanceId: this.instanceId,
        clientLeaseId: this.clientLeaseId,
      }).catch(() => {});
    }
    this.client?.close();
    await this.gateway?.close();
  }
}
