import { defineTool } from '@deepseek-ai/dsh-tools';
import { Service } from '@deepseek-ai/cordis';
import { Group } from '@deepseek-ai/cordis-plugin-loader';
import { createLocalRuntimeService } from './src/host/local-runtimes.js';
import { createProfileUpgradeService } from './src/host/profile-upgrade.js';
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

// The running Web Host version comes from the plugin-manager bundle inventory;
// an absent or older plugin-manager simply means "unknown", never a failure.
async function currentDshVersion(ctx) {
  let manager;
  try { manager = typeof ctx.get === 'function' ? ctx.get('pluginManager', false) : undefined; } catch { manager = undefined; }
  if (!manager || typeof manager.listBundles !== 'function') return null;
  const bundles = await manager.listBundles();
  const available = (Array.isArray(bundles) ? bundles : []).filter((bundle) => bundle
    && bundle.enabled !== false
    && bundle.availability !== 'missing'
    && typeof bundle.version === 'string'
    && bundle.version.length > 0);
  return available.find((bundle) => bundle.name === '@deepseek-ai/dsh-web-app')?.version
    ?? available.find((bundle) => bundle.name === '@deepseek-ai/dsh-base')?.version
    ?? null;
}

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
  // The upgrade executor needs the real subprocess service; a Host that only
  // stubs the dependency still gets the runtime catalog and version display.
  const upgrades = typeof ctx.subprocess?.resolveExecutable === 'function' && typeof ctx.subprocess?.spawn === 'function'
    ? createProfileUpgradeService({
      subprocess: ctx.subprocess,
      profileContext: ctx.profileContext,
      fetch: typeof fetch === 'function' ? fetch : undefined,
    })
    : undefined;
  const service = createLocalRuntimeService({
    subprocess: ctx.subprocess,
    profileContext: ctx.profileContext,
    currentDshVersion: () => currentDshVersion(ctx),
    upgrades,
  });
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
