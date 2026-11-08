import { defineTool } from '@deepseek-ai/dsh-tools';
import { Service } from '@deepseek-ai/cordis';
import { Group } from '@deepseek-ai/cordis-plugin-loader';
import { createLocalRuntimeService } from './src/host/local-runtimes.js';
import { registerShellRoutes } from './src/host/routes.js';
import { createTabOrderStore } from './src/host/tab-order-store.js';
import { registerWorkspaceRuntimeTool } from './src/host/runtime-tool.js';
import { apply as registerSessionHost, inject as sessionHostInject } from './session-host/index.js';

export const inject = [...new Set(['connection', 'profileContext', 'subprocess', 'tools', ...sessionHostInject])];

// Tab order is a preference, not a lifecycle dependency: the storage service is
// looked up lazily so a profile without a storage backend still starts the Shell.
const storageDomainOf = (ctx) => {
  try {
    return typeof ctx.get === 'function' ? ctx.get('storageDomain', false) : undefined;
  } catch {
    return undefined;
  }
};

export async function apply(ctx) {
  await registerSessionHost(ctx);
  const service = createLocalRuntimeService({ subprocess: ctx.subprocess, profileContext: ctx.profileContext, expectedVersion: '0.2.1-rc.5' });
  ctx.provide('workspaceLocalRuntimes', service);
  ctx.effect(() => () => service.dispose(), 'workspace-owned local runtimes');
  const tabOrder = createTabOrderStore({ getStorageDomain: () => storageDomainOf(ctx) });
  ctx.effect(() => registerShellRoutes(ctx, service, { tabOrder }), 'workspace HTTP routes');
  ctx.effect(() => registerWorkspaceRuntimeTool(ctx, service, { defineTool }), 'workspace_runtime');
}

export default class WorkspaceShell extends Group {
  static inject = inject;
  async update(config) {
    // Older profiles used an empty object for the frame entry.
    return super.update(Array.isArray(config) ? config : [{ id: 'ssh-remote', name: '@local/dsh-ssh-remote', config: {} }]);
  }
  async *[Service.init]() {
    await apply(this.ctx);
    yield* super[Service.init]();
  }
}
