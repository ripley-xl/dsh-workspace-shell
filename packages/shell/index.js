import { defineTool } from '@deepseek-ai/dsh-tools';
import { Service } from '@deepseek-ai/cordis';
import { Group } from '@deepseek-ai/cordis-plugin-loader';
import { createLocalRuntimeService } from './src/host/local-runtimes.js';
import { createWorkspacePreferencesStore } from './src/host/workspace-preferences-store.js';
import { registerShellRoutes } from './src/host/routes.js';
import { registerWorkspaceRuntimeTool } from './src/host/runtime-tool.js';
import { removeContextAds } from './src/host/context-ads.js';
import { apply as registerSessionHost, inject as sessionHostInject } from './session-host/index.js';

export const inject = [...new Set(['connection', 'profileContext', 'subprocess', 'tools', ...sessionHostInject])];

// Tab preferences are not a lifecycle dependency: the storage service is
// looked up lazily so a profile without a storage backend still starts the Shell.
const storageDomainOf = (ctx) => {
  try {
    return typeof ctx.get === 'function' ? ctx.get('storageDomain', false) : undefined;
  } catch {
    return undefined;
  }
};

export async function apply(ctx) {
  // dsh-context ships sponsor cards inside its own Client bundle. Remove them
  // when that plugin is installed; an absent plugin is an ordinary no-op.
  removeContextAds({
    profileContext: ctx.profileContext,
    logger: ctx.logger,
    clientModules: (() => {
      try { return ctx.get('clientModules', false); } catch { return undefined; }
    })(),
  });
  await registerSessionHost(ctx);
  const service = createLocalRuntimeService({ subprocess: ctx.subprocess, profileContext: ctx.profileContext, expectedVersion: '0.2.1-rc.5' });
  ctx.provide('workspaceLocalRuntimes', service);
  ctx.effect(() => () => service.dispose(), 'workspace-owned local runtimes');
  const preferences = createWorkspacePreferencesStore({ getStorageDomain: () => storageDomainOf(ctx) });
  ctx.effect(() => () => preferences.dispose(), 'workspace tab preferences');
  ctx.effect(() => registerShellRoutes(ctx, service, { preferences }), 'workspace HTTP routes');
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
