import { randomUUID } from 'node:crypto';

function failure(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function syncRemotePlugins(client, plugins) {
  const items = [];
  let restartRequired = false;
  for (const plugin of plugins) {
    try {
      const response = await client.post('/api/ssh-remote/plugins/install', {
        spec: plugin.spec,
        requestId: plugin.requestId ?? randomUUID(),
        ...plugin.approvedBuilds ? { approvedBuilds: plugin.approvedBuilds } : {},
        ...plugin.registry !== undefined ? { registry: plugin.registry } : {},
      });
      const result = response.result;
      const failed = !response.ok || result.application === 'failed' || result.application === 'cancelled';
      const pendingBuilds = result.pendingBuilds ?? [];
      restartRequired ||= result.application === 'restart-required';
      items.push({
        spec: plugin.spec,
        ok: !failed && pendingBuilds.length === 0,
        application: result.application,
        pendingBuilds,
        ...failed ? { error: result.error?.diagnostic || 'remote plugin installation failed' } : {},
      });
    } catch (error) {
      items.push({ spec: plugin.spec, ok: false, error: failure(error) });
    }
  }
  return { ok: items.every((item) => item.ok), restartRequired, items };
}

export async function syncRemoteSettings(client, settings) {
  const items = [];
  for (const setting of settings) {
    try {
      await client.post('/api/ssh-remote/settings/update', {
        ns: setting.ns,
        patch: setting.patch,
        expectedRevision: setting.expectedRevision,
      });
      items.push({ ns: setting.ns, ok: true });
    } catch (error) {
      items.push({ ns: setting.ns, ok: false, error: failure(error) });
    }
  }
  return { ok: items.every((item) => item.ok), items };
}

export async function syncRemoteCredentials(client, credentials) {
  const items = [];
  for (const credential of credentials) {
    try {
      await client.post('/api/ssh-remote/credentials/set', {
        ref: credential.ref,
        value: credential.value,
      });
      items.push({ ref: credential.ref, ok: true });
    } catch (error) {
      items.push({ ref: credential.ref, ok: false, error: failure(error) });
    }
  }
  return { ok: items.every((item) => item.ok), items };
}

export async function syncRemote(client, input) {
  const plugins = await syncRemotePlugins(client, input.plugins ?? []);
  if (plugins.restartRequired) return { ok: false, restartRequired: true, plugins };
  const [settings, credentials] = await Promise.all([
    syncRemoteSettings(client, input.settings ?? []),
    syncRemoteCredentials(client, input.credentials ?? []),
  ]);
  return {
    ok: plugins.ok && settings.ok && credentials.ok,
    restartRequired: false,
    plugins,
    settings,
    credentials,
  };
}
