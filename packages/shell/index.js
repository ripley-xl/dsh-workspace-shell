import { defineTool } from '@deepseek-ai/dsh-tools';
import { createLocalRuntimeService } from './src/host/local-runtimes.js';
import { registerShellRoutes } from './src/host/routes.js';
import { registerWorkspaceRuntimeTool } from './src/host/runtime-tool.js';
import { apply as registerSessionHost, inject as sessionHostInject } from './session-host/index.js';
import { resolveLocalDshVersion } from './src/host/local-version.js';
import { apply as registerSshRemote, inject as sshRemoteInject } from './ssh-remote/src/host/index.js';

export const inject = [...new Set(['connection', 'profileContext', 'subprocess', 'tools', ...sessionHostInject])];

export async function apply(ctx) {
  await registerSessionHost(ctx);
  const expectedVersion = resolveLocalDshVersion(ctx.profileContext) ?? '0.0.0-unknown';
  const service = createLocalRuntimeService({ subprocess: ctx.subprocess, profileContext: ctx.profileContext, expectedVersion });
  ctx.provide('workspaceLocalRuntimes', service);
  ctx.effect(() => () => service.dispose(), 'workspace-owned local runtimes');
  ctx.effect(() => registerShellRoutes(ctx, service), 'workspace HTTP routes');
  ctx.effect(() => registerWorkspaceRuntimeTool(ctx, service, { defineTool }), 'workspace_runtime');
  // SSH remote is part of this plugin but only needs a subset of services; mount it
  // lazily so a profile without them still gets the workspace tabs and session host.
  ctx.effect(() => {
    const fiber = ctx.inject(sshRemoteInject, (scope) => registerSshRemote(scope));
    return () => fiber.dispose();
  }, 'SSH remote component');
}
