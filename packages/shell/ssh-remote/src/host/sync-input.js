import { isDeepStrictEqual } from 'node:util';

import { SshRemoteError } from './ssh/errors.js';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new SshRemoteError('CONFIG_SYNC_PARTIAL', `${label} is not JSON serializable.`);
  }
}

function withoutSecretPaths(value, secrets = []) {
  if (!plainObject(value)) throw new SshRemoteError('CONFIG_SYNC_PARTIAL', 'A selected settings value must be an object.');
  const result = cloneJson(value, 'settings value');
  for (const secret of secrets) {
    if (!Array.isArray(secret?.path) || secret.path.length === 0 || !secret.path.every((part) => typeof part === 'string')) continue;
    let parent = result;
    for (const part of secret.path.slice(0, -1)) {
      if (!plainObject(parent?.[part]) && !Array.isArray(parent?.[part])) {
        parent = undefined;
        break;
      }
      parent = parent[part];
    }
    if (parent && Object.hasOwn(parent, secret.path.at(-1))) delete parent[secret.path.at(-1)];
  }
  return result;
}

function namespaceBase(ns) {
  return ns.split(':').at(-1);
}

function descriptorFor(descriptors, namespace) {
  return descriptors.find((descriptor) => descriptor.ns === namespace)
    ?? descriptors.find((descriptor) => namespaceBase(descriptor.ns) === namespaceBase(namespace));
}

function exactPluginSpec(plugin) {
  if (!plugin.version) return plugin.spec;
  const versionAt = plugin.spec.lastIndexOf('@');
  if (versionAt > 0) {
    if (plugin.spec.slice(versionAt + 1) !== plugin.version) {
      throw new SshRemoteError('PLUGIN_TEMPLATE_PARTIAL', `Plugin ${plugin.spec} has conflicting spec and version fields.`);
    }
    return plugin.spec;
  }
  return `${plugin.spec}@${plugin.version}`;
}

const INFRASTRUCTURE_NAMESPACES = new Set([
  'working-directory', 'workspace', 'workspaces', 'worktree', 'worktrees',
  'storage', 'storage-json', 'storage-domain', 'plugin-manager', 'config-editor',
  'credentials', 'credentials-controller', 'authorization', 'subprocess',
  'bash', 'pwsh', 'terminal', 'terminal-bash', 'terminal-pwsh', 'pty', 'jobs', 'jobs-local',
  'sandbox', 'sandbox-local', 'sandbox-policy', 'fs', 'fs-local', 'filesystem', 'fs-sandbox',
  'fs-observation-policy', 'shell-env', 'attachment-local', 'spill-local', 'spill-store',
  'file-upload', 'mcp', 'mcp-resources', 'plugin-console', 'plugin-market', 'plugin-inventory',
  'plugin-package-inventory-deepseek', 'dshmarket', 'open-market',
  'skills-manager', 'session-persistence-jsonl', 'session-query-sqlite', 'session-projection',
  'session-projection-cache', 'webserver', 'web-runtime', 'web-startup', 'cordis-host-runner',
  'cordis-client-runner', 'modules', 'client-hmr', 'connection', 'api-remotes',
  'ui-plugin-manager', 'ui-settings-plugins', 'ui-settings-plugin-inventory',
  'deepseek-account', 'llm-deepseek-account',
]);
const LOCAL_DIRECTORY_FIELD = /^(?:cwd|currentCwd|currentWorkingDirectory|workingDirectory|defaultDirectory|defaultWorkspace|workspaceDirectory|workspacePath|currentWorkspacePath|homeDir|rootDir)$/u;
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function supportedNamespace(ns) {
  if (typeof ns !== 'string') return false;
  const base = namespaceBase(ns).toLowerCase();
  return !INFRASTRUCTURE_NAMESPACES.has(base)
    && !/(?:^|-)(?:runtime|storage|plugin-manager|plugin-market|plugin-console|plugin-inventory)(?:-|$)/u.test(base);
}

function localValue(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(text) || /^~[\\/]/u.test(text) || /^file:/iu.test(text)) return true;
  if (/^https?:\/\//iu.test(text)) {
    try {
      return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(text).hostname);
    } catch {
      return false;
    }
  }
  return false;
}

function schemaBranches(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  return [schema, ...['anyOf', 'oneOf', 'allOf'].flatMap((key) => Array.isArray(schema[key]) ? schema[key] : [])];
}

function schemaProperty(schema, key) {
  for (const branch of schemaBranches(schema)) {
    if (branch.properties?.[key]) return branch.properties[key];
    if (branch.additionalProperties && typeof branch.additionalProperties === 'object') return branch.additionalProperties;
  }
  return undefined;
}

function schemaItem(schema) {
  for (const branch of schemaBranches(schema)) {
    if (branch.items && typeof branch.items === 'object' && !Array.isArray(branch.items)) return branch.items;
  }
  return undefined;
}

function supportedConfig(value, schema, key) {
  if (LOCAL_DIRECTORY_FIELD.test(key) || schema?.['x-cordis']?.hidden === true) return { supported: false };
  if (localValue(value)) return { supported: false };
  if (Array.isArray(value)) {
    const items = [];
    const itemSchema = schemaItem(schema);
    for (const item of value) {
      const result = supportedConfig(item, itemSchema, '');
      if (result.supported) items.push(result.value);
    }
    return value.length > 0 && items.length === 0 ? { supported: false } : { supported: true, value: items };
  }
  if (plainObject(value)) {
    if (typeof value.__jsExpr === 'string') return { supported: false };
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      const item = supportedConfig(child, schemaProperty(schema, childKey), childKey);
      if (item.supported) result[childKey] = item.value;
    }
    return Object.keys(value).length > 0 && Object.keys(result).length === 0
      ? { supported: false }
      : { supported: true, value: result };
  }
  return { supported: true, value };
}

function addCredentialRef(refs, value) {
  if (typeof value === 'string' && CREDENTIAL_REF.test(value)) refs.add(value);
}

function discoverSchemaCredentials(schema, value, refs) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;
  addCredentialRef(refs, schema.credentialRef);
  addCredentialRef(refs, schema.env);
  if (schema['x-cordis']?.role === 'credential-ref') {
    addCredentialRef(refs, schema.default);
    addCredentialRef(refs, value);
  }
  for (const branch of schemaBranches(schema)) {
    if (branch.properties) {
      for (const [key, child] of Object.entries(branch.properties)) {
        if (['credentialref', 'env'].includes(key.toLowerCase())) {
          addCredentialRef(refs, child.default);
          addCredentialRef(refs, value?.[key]);
        }
        discoverSchemaCredentials(child, value?.[key], refs);
      }
    }
    if (branch.items) {
      const values = Array.isArray(value) ? value : [undefined];
      for (const item of values) discoverSchemaCredentials(branch.items, item, refs);
    }
    if (branch.additionalProperties && plainObject(value)) {
      for (const child of Object.values(value)) discoverSchemaCredentials(branch.additionalProperties, child, refs);
    }
  }
}

export function discoverCredentialRefs(descriptors) {
  const refs = new Set();
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    if (!supportedNamespace(descriptor.ns)) continue;
    discoverSchemaCredentials(descriptor.schema, descriptor.value, refs);
  }
  return [...refs].sort();
}

function officialBundleStates(bundles) {
  return (Array.isArray(bundles) ? bundles : [])
    .filter((bundle) => bundle.official === true && bundle.optional === true
      && bundle.availability !== 'missing' && typeof bundle.name === 'string')
    .map((bundle) => ({
      name: bundle.name,
      version: typeof bundle.version === 'string' ? bundle.version : null,
      enabled: bundle.enabled === true,
    }));
}

export async function buildSyncInput(record, {
  descriptors,
  resolveCredential,
  describeCredential,
  credentialDescriptors = {},
  includeCredentialValues = true,
  bundles = [],
}) {
  const officialNames = new Set(officialBundleStates(bundles).map((bundle) => bundle.name));
  const legacyTemplate = Array.isArray(record.pluginTemplate) ? record.pluginTemplate : [];
  const plugins = legacyTemplate.filter((plugin) => !/^dsh-workspace-shell-status(?:@|$)/u.test(plugin.spec)
    && !officialNames.has(specIdentity(exactPluginSpec(plugin)).name)).map((plugin) => ({
    spec: exactPluginSpec(plugin),
    ...plugin.approvedBuilds ? { approvedBuilds: [...plugin.approvedBuilds] } : {},
    ...plugin.pendingBuilds ? { pendingBuilds: [...plugin.pendingBuilds] } : {},
    ...plugin.registry !== undefined ? { registry: plugin.registry } : {},
  }));
  const allSupported = record.syncPolicy.allSupported !== false;
  const settings = [];
  if (allSupported) {
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      if (!supportedNamespace(descriptor.ns)) continue;
      const source = descriptor.user === undefined ? descriptor.value : descriptor.user;
      if (!plainObject(source)) continue;
      const withoutSecrets = withoutSecretPaths(source, descriptor.secrets);
      const result = supportedConfig(withoutSecrets, descriptor.schema, '');
      if (result.supported && plainObject(result.value) && Object.keys(result.value).length > 0) {
        settings.push({ ns: descriptor.ns, patch: result.value });
      }
    }
  }
  const credentials = [];
  const refs = allSupported ? discoverCredentialRefs(descriptors) : [];
  for (const ref of refs) {
    const info = credentialDescriptors[ref] ?? await describeCredential?.(ref);
    if (info && info.configured !== true) continue;
    if (!includeCredentialValues) {
      credentials.push({ ref });
      continue;
    }
    let resolved;
    try {
      resolved = await resolveCredential(ref);
    } catch {
      throw new SshRemoteError('CREDENTIAL_UNAVAILABLE', `Could not resolve configured credential ${ref} locally.`);
    }
    if (typeof resolved?.value !== 'string' || resolved.value.length === 0) {
      throw new SshRemoteError('CREDENTIAL_UNAVAILABLE', `Configured credential ${ref} is unavailable locally.`);
    }
    credentials.push({ ref, value: resolved.value });
  }
  return { plugins, officialBundles: officialBundleStates(bundles), settings, credentials, credentialRefs: refs };
}

const MAX_PREVIEW_FIELDS = 1024;
const MAX_PREVIEW_OPERATIONS = 512;
const MAX_PREVIEW_VALUE_BYTES = 2048;

function pathValue(root, path) {
  let current = root;
  for (const part of path) {
    if ((current === null || typeof current !== 'object') || !Object.hasOwn(current, part)) return { present: false };
    current = current[part];
  }
  return { present: true, value: current };
}

function flatten(value, path = [], result = []) {
  if (plainObject(value) && Object.keys(value).length > 0) {
    for (const [key, item] of Object.entries(value)) flatten(item, [...path, key], result);
  } else {
    result.push({ path, value });
  }
  return result;
}

function previewValue(value) {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_PREVIEW_VALUE_BYTES) {
    return { truncated: true, bytes: Buffer.byteLength(serialized) };
  }
  return value;
}

function pathsEqual(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function pathCovered(path, managedPaths) {
  return managedPaths.some((managed) => managed.length <= path.length && pathsEqual(managed, path.slice(0, managed.length)));
}

function settingsOperation(setting, remoteDescriptors, budget) {
  const remote = descriptorFor(remoteDescriptors, setting.ns);
  if (!remote) {
    return {
      type: 'settings', ns: setting.ns, action: 'blocked', ok: false,
      code: 'SETTINGS_NAMESPACE_UNAVAILABLE', fields: [], preservedFields: [], wouldChange: true,
    };
  }
  let remoteValue;
  let remoteUser;
  try {
    remoteValue = withoutSecretPaths(remote.value ?? {}, remote.secrets);
    remoteUser = remote.user === undefined ? {} : withoutSecretPaths(remote.user, remote.secrets);
  } catch {
    return {
      type: 'settings', ns: setting.ns, remoteNs: remote.ns, action: 'blocked', ok: false,
      code: 'SETTINGS_DESCRIPTOR_INVALID', fields: [], preservedFields: [], wouldChange: true,
    };
  }
  const managed = flatten(setting.patch);
  const fields = [];
  const conflicts = [];
  for (const item of managed) {
    if (budget.fields >= MAX_PREVIEW_FIELDS) {
      budget.truncated = true;
      break;
    }
    budget.fields += 1;
    const remoteItem = pathValue(remoteValue, item.path);
    const userItem = pathValue(remoteUser, item.path);
    const equal = remoteItem.present && isDeepStrictEqual(remoteItem.value, item.value);
    const conflict = !equal && userItem.present && !isDeepStrictEqual(userItem.value, item.value);
    const field = {
      ns: setting.ns,
      path: item.path,
      localValue: previewValue(item.value),
      remoteValue: remoteItem.present ? previewValue(remoteItem.value) : null,
      remotePresent: remoteItem.present,
      status: equal ? 'same' : remoteItem.present ? 'changed' : 'added',
      conflict,
    };
    fields.push(field);
    if (conflict) conflicts.push({ type: 'settings', ns: setting.ns, path: item.path, code: 'REMOTE_USER_VALUE_DIFFERS' });
  }
  const managedPaths = managed.map((item) => item.path);
  const preservedFields = [];
  for (const item of flatten(remoteValue)) {
    if (pathCovered(item.path, managedPaths)) continue;
    if (budget.preserved >= MAX_PREVIEW_FIELDS) {
      budget.truncated = true;
      break;
    }
    budget.preserved += 1;
    preservedFields.push({ ns: setting.ns, path: item.path });
  }
  return {
    type: 'settings',
    ns: setting.ns,
    remoteNs: remote.ns,
    remoteRevision: typeof remote.revision === 'number' ? remote.revision : null,
    action: 'update',
    ok: true,
    wouldChange: fields.some((field) => field.status !== 'same'),
    preservesUnmanagedFields: true,
    fields,
    preservedFields,
    conflicts,
  };
}

function specIdentity(spec) {
  const versionAt = spec.lastIndexOf('@');
  if (versionAt > 0) return { name: spec.slice(0, versionAt), version: spec.slice(versionAt + 1) };
  return { name: spec, version: null };
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))] : [];
}

function allowsTarget(values, target) {
  if (!Array.isArray(values) || values.length === 0) return true;
  if (values.includes(`!${target}`)) return false;
  const positive = values.filter((value) => typeof value === 'string' && !value.startsWith('!'));
  return positive.length === 0 || positive.includes(target);
}

function pluginIncompatibility(plugin, bundle, target, dshVersion) {
  const incompatible = [
    ...Array.isArray(bundle?.incompatible) ? bundle.incompatible : [],
    ...Array.isArray(bundle?.error?.incompatible) ? bundle.error.incompatible : [],
  ];
  if (incompatible.length > 0 || bundle?.error?.code === 'incompatible-version') {
    return { code: 'PLUGIN_VERSION_INCOMPATIBLE', incompatible: previewValue(incompatible) };
  }
  const engine = bundle?.engines?.dsh;
  if (typeof engine === 'string' && /^[0-9A-Za-z][0-9A-Za-z.-]*$/u.test(engine) && dshVersion && engine !== dshVersion) {
    return { code: 'PLUGIN_VERSION_INCOMPATIBLE', required: engine, actual: dshVersion };
  }
  if (target && (!allowsTarget(bundle?.os, target.platform) || !allowsTarget(bundle?.cpu, target.arch) || !allowsTarget(bundle?.libc, target.libc))) {
    return {
      code: 'PLUGIN_PLATFORM_INCOMPATIBLE',
      required: previewValue({ os: bundle?.os ?? null, cpu: bundle?.cpu ?? null, libc: bundle?.libc ?? null }),
      actual: target,
    };
  }
  return null;
}

function pluginOperation(plugin, remoteBundles, target, dshVersion) {
  const identity = specIdentity(plugin.spec);
  const bundle = remoteBundles.find((item) => item.name === identity.name);
  const approvedBuilds = stringArray(plugin.approvedBuilds);
  const pendingBuilds = stringArray(bundle?.pendingBuilds ?? bundle?.packageResult?.pendingBuilds ?? plugin.pendingBuilds)
    .filter((name) => !approvedBuilds.includes(name));
  const incompatibility = pluginIncompatibility(plugin, bundle, target, dshVersion);
  const currentVersion = typeof bundle?.version === 'string' ? bundle.version : null;
  const base = {
    type: 'plugin',
    spec: plugin.spec,
    name: identity.name,
    action: 'install',
    currentVersion,
    targetVersion: identity.version,
    versionChange: Boolean(identity.version && currentVersion && identity.version !== currentVersion),
    wouldChange: !bundle || bundle.installed === false || bundle.enabled === false || Boolean(identity.version && identity.version !== currentVersion),
    pendingBuilds,
    approvedBuilds,
  };
  if (incompatibility) return { ...base, action: 'blocked', ok: false, ...incompatibility };
  if (pendingBuilds.length > 0) return { ...base, action: 'blocked', ok: false, code: 'PLUGIN_BUILD_APPROVAL_REQUIRED' };
  return { ...base, ok: true };
}

function officialOperation(plugin, remoteBundles, target, dshVersion) {
  const remote = remoteBundles.find((bundle) => bundle.name === plugin.name);
  const base = {
    type: 'official-plugin',
    name: plugin.name,
    version: plugin.version,
    localEnabled: plugin.enabled,
    remoteEnabled: remote?.enabled === true,
    remotePresent: Boolean(remote),
    action: plugin.enabled ? 'enable' : 'disable',
    wouldChange: remote?.enabled !== plugin.enabled,
  };
  if (!remote) return { ...base, action: 'blocked', ok: false, code: 'OFFICIAL_PLUGIN_UNAVAILABLE' };
  const incompatibility = pluginIncompatibility(plugin, remote, target, dshVersion);
  if (incompatibility) return { ...base, action: 'blocked', ok: false, ...incompatibility };
  return { ...base, ok: true };
}

function credentialInfo(collection, ref) {
  if (Array.isArray(collection)) return collection.find((item) => item?.ref === ref);
  return collection?.[ref];
}

function credentialOperation(credential, localCredentials, remoteCredentials) {
  const local = credentialInfo(localCredentials, credential.ref);
  const remote = credentialInfo(remoteCredentials, credential.ref);
  const base = {
    type: 'credential',
    ref: credential.ref,
    action: 'set',
    configured: { local: local?.configured === true, remote: remote?.configured === true },
    comparison: 'configured-only',
    wouldChange: remote?.configured === true ? null : true,
  };
  if (local?.configured !== true) return { ...base, action: 'blocked', ok: false, code: 'CREDENTIAL_UNAVAILABLE' };
  if (remote?.writable === false) return { ...base, action: 'blocked', ok: false, code: 'CREDENTIAL_READ_ONLY' };
  return { ...base, ok: true };
}

export async function buildSyncPreview(record, options) {
  const input = await buildSyncInput(record, {
    descriptors: options.descriptors,
    describeCredential: options.describeCredential,
    credentialDescriptors: options.localCredentials,
    includeCredentialValues: false,
    bundles: options.bundles,
  });
  const remoteDescriptors = Array.isArray(options.remoteDescriptors) ? options.remoteDescriptors : [];
  const remoteBundles = Array.isArray(options.remoteBundles) ? options.remoteBundles : [];
  const budget = { fields: 0, preserved: 0, truncated: false };
  const allOperations = [
    ...input.officialBundles.map((plugin) => officialOperation(plugin, remoteBundles, options.target, options.dshVersion)),
    ...input.plugins.map((plugin) => pluginOperation(plugin, remoteBundles, options.target, options.dshVersion)),
    ...input.settings.map((setting) => settingsOperation(setting, remoteDescriptors, budget)),
    ...input.credentials.map((credential) => credentialOperation(credential, options.localCredentials, options.remoteCredentials)),
  ];
  const conflicts = allOperations.flatMap((operation) => operation.conflicts ?? []);
  const operations = allOperations.slice(0, MAX_PREVIEW_OPERATIONS);
  const truncated = budget.truncated || allOperations.length > operations.length;
  return {
    schemaVersion: 1,
    operations,
    fields: operations.filter((operation) => operation.type === 'settings').flatMap((operation) => operation.fields),
    conflicts: conflicts.slice(0, MAX_PREVIEW_OPERATIONS),
    preservedFields: operations.filter((operation) => operation.type === 'settings').flatMap((operation) => operation.preservedFields),
    preservesUnmanagedFields: true,
    credentialComparison: 'configured-only',
    requiresConfirmation: conflicts.length > 0,
    canSync: allOperations.every((operation) => operation.ok),
    truncated,
    summary: {
      operations: allOperations.length,
      changes: allOperations.filter((operation) => operation.wouldChange === true).length,
      unknown: allOperations.filter((operation) => operation.wouldChange === null).length,
      conflicts: conflicts.length,
      blocked: allOperations.filter((operation) => !operation.ok).length,
      preservedFields: allOperations.reduce((count, operation) => count + (operation.preservedFields?.length ?? 0), 0),
    },
  };
}

