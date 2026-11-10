import { createDiagnosticReport, formatDiagnosticReport } from './diagnostics.js';
import { PortForwardManager } from './ports.js';
import { SshRemoteError } from './ssh/errors.js';

function connectedRuntime(service, hostId) {
  const runtime = service.runtime(hostId);
  // The shared SSH channel is the whole transport in guest mode: there is no
  // controller-hosted `runtime.host` to require any more.
  if (!runtime.channel || runtime.channel.closed) {
    throw new SshRemoteError('HOST_NOT_CONNECTED', 'The SSH host is not connected.');
  }
  return runtime;
}

function publishPorts(service, runtime) {
  runtime.portForwards = runtime.portManager?.list() ?? [];
  service.publish(runtime.hostId);
}

function manager(service, hostId) {
  const runtime = connectedRuntime(service, hostId);
  if (runtime.portManager && !runtime.portManager.closed) return runtime.portManager;
  const ports = new PortForwardManager(runtime.channel);
  runtime.portManager = ports;
  const publish = () => publishPorts(service, runtime);
  ports.on('change', publish);
  ports.on('forwardError', publish);
  publish();
  return ports;
}

export function listPortForwards(service, hostId) {
  return service.runtime(hostId).portManager?.list() ?? [];
}

export async function addPortForward(service, hostId, input) {
  const forward = await manager(service, hostId).add(input);
  publishPorts(service, service.runtime(hostId));
  return forward;
}

export async function removePortForward(service, hostId, id) {
  const runtime = connectedRuntime(service, hostId);
  if (!runtime.portManager) return null;
  const result = await runtime.portManager.remove(id);
  publishPorts(service, runtime);
  return result;
}

export async function createRemoteDiagnosticReport(service, hostId) {
  service.store.require(hostId);
  const runtime = service.runtime(hostId);
  const logs = [];
  const instanceId = runtime.instanceId ?? runtime.host?.instanceId;
  if (runtime.controller && instanceId) {
    for (const stream of ['host', 'supervisor']) {
      try {
        const page = await runtime.controller.logs({ instanceId, stream, limit: 32 * 1024 });
        logs.push({ stream, text: page.text, hasMore: page.hasMore, nextOffset: page.nextOffset });
      } catch (error) {
        logs.push({ stream, error });
      }
    }
  }
  const report = createDiagnosticReport({
    localVersion: await service.localVersion(),
    host: service.publicConnection(hostId),
    instance: runtime.host ? {
      instanceId: runtime.host.instanceId,
      dshVersion: runtime.host.version,
      buildId: runtime.host.buildId,
    } : null,
    phase: runtime.phase,
    syncReport: runtime.sync,
    controllerLogs: logs,
    error: runtime.error,
  });
  return { ok: true, report, text: formatDiagnosticReport(report) };
}
