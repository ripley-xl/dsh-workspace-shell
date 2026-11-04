import { defineTool } from '@deepseek-ai/dsh-tools';
import { Service } from '@deepseek-ai/cordis';
import { Group } from '@deepseek-ai/cordis-plugin-loader';
import { createLocalRuntimeService } from './src/host/local-runtimes.js';
import { registerShellRoutes } from './src/host/routes.js';
import { registerWorkspaceRuntimeTool } from './src/host/runtime-tool.js';
import { apply as registerSessionHost, inject as sessionHostInject } from './session-host/index.js';

export const inject = [...new Set(['connection', 'profileContext', 'subprocess', 'tools', ...sessionHostInject])];

export async function apply(ctx) {
  await registerSessionHost(ctx);
  const service = createLocalRuntimeService({ subprocess: ctx.subprocess, profileContext: ctx.profileContext, expectedVersion: '0.2.1-rc.5' });
  ctx.provide('workspaceLocalRuntimes', service);
  ctx.effect(() => () => service.dispose(), 'workspace-owned local runtimes');
  ctx.effect(() => registerShellRoutes(ctx, service), 'workspace HTTP routes');
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
